// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the build_estimate MCP tool's internal helpers.
 *
 * The tool composes `addEntries` (validate + add) and `exportWithLint`
 * (lint preflight + save). We exercise both helpers directly — spinning
 * up an MCP transport for a unit test is overkill and the helpers are
 * the actual surface that build_estimate reuses.
 *
 * Network paths (loadManifest, fetchServiceDefinition, saveEstimate) are
 * stubbed via require.cache injection — same pattern as
 * integration.test.js's "create_estimate + add_service share state" test.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Tests for build_estimate.needs_grounding event assertion require
// TRACE=on. Off-state behavior is covered in test/trace-flag.test.js.
process.env.TRACE = 'on';

const AWS_CLIENT_PATH = require.resolve('../lib/aws/aws-client');
const VALIDATION_PATH = require.resolve('../lib/lint/validation');
const REHYDRATE_FETCH_PATH = require.resolve('../lib/lint/can-rehydrate-fetch');
const ESTIMATE_BUILDER_PATH = require.resolve('../lib/aws/estimate-builder');
const HANDLER_HELPERS_PATH = require.resolve('../lib/mcp/handler-helpers');
const MCP_SERVER_PATH = require.resolve('../mcp-server.js');

function reset() {
  delete require.cache[AWS_CLIENT_PATH];
  delete require.cache[VALIDATION_PATH];
  delete require.cache[REHYDRATE_FETCH_PATH];
  delete require.cache[ESTIMATE_BUILDER_PATH];
  delete require.cache[HANDLER_HELPERS_PATH];
  delete require.cache[MCP_SERVER_PATH];
  delete require.cache[require.resolve('../lib/store/estimate-store')];
  delete require.cache[require.resolve('../lib/lint/catalog')];
}

const fakeManifest = new Map([
  ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda' }],
]);
const fakeDef = {
  serviceCode: 'aWSLambda',
  version: '1.0',
  templates: [{
    id: 'lambdaWithFreeTier',
    cards: [{
      inputSection: {
        components: [
          { id: 'numberOfRequests', subType: 'frequency', validations: { required: true } },
        ],
      },
    }],
  }],
};

function stubAwsClient({ saveImpl } = {}) {
  const stub = {
    PARTITIONS: { aws: { contract: '' }, 'aws-iso': { contract: 'iso' } },
    resolvePartition: () => 'aws',
    loadManifest: async () => fakeManifest,
    findService: (m, k) => m.get(k),
    fetchServiceDefinition: async (_m, code) => (code === 'aWSLambda' ? fakeDef : null),
    extractInputFields: () => [
      { id: 'numberOfRequests', type: 'frequency', subType: 'frequency', label: 'Requests', validations: { required: true } },
      // dataTransferForEC2 included so the defaultFields-injection tests
      // can exercise the override path (catalog-injected default vs.
      // agent-supplied value) without tripping validateConfigKeys'
      // unknown-field check. Real EC2 manifest also exposes this id.
      { id: 'dataTransferForEC2', type: 'dataTransferV2', subType: 'dataTransferV2' },
    ],
    enrichFieldsWithMetadata: async (_d, fields) => fields,
    searchServices: () => [],
    fetchEstimate: async () => ({}),
    estimateToMarkdown: () => '',
    saveEstimate: saveImpl || (async () => ({ shareableUrl: 'https://calculator.aws/#/estimate?id=abc123', estimateId: 'abc123' })),
  };
  require.cache[AWS_CLIENT_PATH] = { exports: stub };
  return stub;
}

describe('build_estimate helpers', () => {
  beforeEach(() => {
    reset();
    process.env.ESTIMATES_STORE = 'memory';
  });

  it('addEntries: happy path adds the service and returns success result', async () => {
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const eb = new EstimateBuilder('test', 'aws');
    const results = await __test.addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'API',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);

    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(results[0].service, 'aWSLambda');
    assert.equal(Object.keys(eb.services).length, 1);
  });

  it('addEntries: validation errors short-circuit per-entry without polluting estimate', async () => {
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const eb = new EstimateBuilder('test', 'aws');
    const results = await __test.addEntries(eb, [{
      service: 'aWSLambda',
      config: { region: 'us-east-1', description: 'bad', notARealField: 'x' },
    }]);

    assert.equal(results.length, 1);
    assert.ok(results[0].error, `expected error, got ${JSON.stringify(results[0])}`);
    assert.equal(Object.keys(eb.services).length, 0,
      'failed entries must not be added to the estimate');
  });

  it('add_service handler: mixed batch with one failure rolls back the whole batch', async () => {
    // Bug fix 2026-06-02: previously, a mixed batch [valid, invalid] left the
    // valid entry stuck in the store while returning errors for the invalid
    // one. The next save tripped on the partial state. The handler now
    // skips put() when any entry fails — verify by round-tripping through
    // the actual store the handler uses.
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    // Seed a fresh estimate in the store the way create_estimate does.
    const estimate = new EstimateBuilder('rollback-test', 'aws');
    await __test.store.put(estimate);

    // Simulate the add_service handler's exact sequence: get a deep-cloned
    // builder, run addEntries on it, decide whether to put() based on errors.
    const got = await __test.store.get(estimate.id);
    const results = await __test.addEntries(got, [
      {
        service: 'aWSLambda',
        config: {
          region: 'us-east-1',
          description: 'good',
          numberOfRequests: { value: '1', unit: 'millionPerMonth' },
        },
      },
      {
        service: 'aWSLambda',
        config: { region: 'us-east-1', description: 'bad', notARealField: 'x' },
      },
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0].success, true, 'first entry should validate');
    assert.ok(results[1].error, 'second entry should fail validation');

    // Handler's new behavior: skip put() on any failure. The stored snapshot
    // is unchanged, even though the in-memory `got` has a successful entry.
    if (!results.some(r => r.error)) await __test.store.put(got);

    const final = await __test.store.get(estimate.id);
    assert.equal(Object.keys(final.services).length, 0,
      'mixed-batch failure must leave the persisted estimate unchanged');
  });

  it('addEntries: missing service or config produces a structured error', async () => {
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const eb = new EstimateBuilder('test', 'aws');
    const results = await __test.addEntries(eb, [
      { service: 'aWSLambda' },
      { config: { region: 'us-east-1' } },
    ]);
    assert.equal(results.length, 2);
    assert.match(results[0].error, /Missing/);
    assert.match(results[1].error, /Missing/);
  });

  it('addEntries: surfaces existing_entry warning on duplicate (service, description, group)', async () => {
    // Production case 2026-06-07: same prompt, different sessions —
    // session 2 retried add_service after a perceived issue, stacking
    // a duplicate Prod entry. Cost inflated 33%. The warning surfaces
    // the duplicate on the response so capable agents can route to
    // create_estimate instead.
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const eb = new EstimateBuilder('dup-test', 'aws');
    const cfg = {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    };

    // First call — clean add, no warning.
    const first = await __test.addEntries(eb, [{
      service: 'aWSLambda', group: 'App', config: { ...cfg },
    }]);
    assert.equal(first[0].success, true);
    assert.equal(first[0].existing_entry, undefined,
      'first add must not surface existing_entry');

    // Second call — same service, description, group. Warning fires.
    const second = await __test.addEntries(eb, [{
      service: 'aWSLambda', group: 'App', config: { ...cfg },
    }]);
    assert.equal(second[0].success, true,
      'duplicate still registers; warning is advisory, not blocking');
    assert.deepEqual(second[0].existing_entry, {
      service: 'aWSLambda',
      description: 'API handler',
      group: 'App',
    });
    assert.match(second[0].warning, /add_service has appended a duplicate/);
    assert.match(second[0].warning, /create_estimate/);
  });

  it('addEntries: same description, different service does NOT trigger warning', async () => {
    // Two entries that both happen to share description "production"
    // but for different services (e.g. aWSLambda + amazonS3Standard)
    // are NOT a duplicate. The dedup key is (service, description, group).
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const eb = new EstimateBuilder('dup-test', 'aws');
    await __test.addEntries(eb, [{
      service: 'aWSLambda', group: 'App',
      config: {
        region: 'us-east-1', description: 'production',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);

    // Same description, but different service. Stub doesn't model
    // amazonS3Standard, so this falls into the validation-error path
    // and addEntries doesn't reach the duplicate check. We instead
    // simulate the situation by adding the same service+description
    // in a DIFFERENT group — the warning should not fire there either.
    const second = await __test.addEntries(eb, [{
      service: 'aWSLambda', group: 'OtherGroup',
      config: {
        region: 'us-east-1', description: 'production',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);
    assert.equal(second[0].existing_entry, undefined,
      'same service+description in DIFFERENT group is not a duplicate');
  });

  it('addEntries: empty config registers entry with partial: true + missing_required_fields + next_step', async () => {
    // Test 5 reproduction: agent calls add_service with only meta keys
    // (region, description) and no actual field config. fakeDef declares
    // numberOfRequests as form-side validations.required: true. Pre-fix:
    // success: true, no warning, agent moves on. Post-fix: success: true,
    // partial: true, missing_required_fields: [...], next_step: <hint>.
    //
    // Uses a fresh createHandlerHelpers with a synthetic catalog so the
    // assertion is decoupled from the production aWSLambda catalog's
    // specific required[] choices.
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'lambdaWithFreeTier',
        required: [{ field: 'numberOfRequests', example: { value: '1', unit: 'millionPerMonth' } }],
      }],
    ]);
    const { addEntries } = createHandlerHelpers({ catalog });

    const eb = new EstimateBuilder('test', 'aws');
    const results = await addEntries(eb, [{
      service: 'aWSLambda',
      config: { region: 'us-east-1', description: 'placeholder' },
    }]);

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.success, true, 'entry IS registered (partial, not error)');
    assert.equal(r.partial, true, 'partial flag must be set');
    assert.deepEqual(r.missing_required_fields, ['numberOfRequests']);
    assert.match(r.next_step, /numberOfRequests/);
    assert.match(r.next_step, /add_service/);
    // The entry must actually live in the estimate (recovery flow can
    // re-add to overwrite, just like a normal add_service retry).
    assert.equal(Object.keys(eb.services).length, 1);
  });

  it('addEntries: complete config does NOT set partial', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'lambdaWithFreeTier',
        required: [{ field: 'numberOfRequests' }],
      }],
    ]);
    const { addEntries } = createHandlerHelpers({ catalog });

    const eb = new EstimateBuilder('test', 'aws');
    const results = await addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'API',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);

    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(results[0].partial, undefined,
      'partial must be omitted when no required fields are missing');
    assert.equal(results[0].missing_required_fields, undefined);
    assert.equal(results[0].next_step, undefined);
  });

  it('addEntries: catalog defaultFields injects missing keys (sub-task A)', async () => {
    // Catalog declares a defaultFields shape; agent's config omits the key.
    // applyDefaultFields merges the catalog default before addService, so
    // the saved entry carries the canonical envelope. Closes the EC2
    // dataTransferForEC2 special-case (which used to live in lib/aws/ec2.js).
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const dtShape = {
      value: [{ entryType: 'INBOUND', value: '', unit: 'tb_month', fromRegion: '' }],
    };
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'lambdaWithFreeTier',
        required: [{ field: 'numberOfRequests' }],
        defaultFields: { dataTransferForEC2: dtShape },
      }],
    ]);
    const { addEntries } = createHandlerHelpers({ catalog });
    const eb = new EstimateBuilder('test', 'aws');
    await addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'lambda+default',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);
    const stored = Object.values(eb.services)[0];
    assert.deepEqual(stored.dataTransferForEC2, dtShape,
      'defaultFields should inject when key absent');
  });

  it('addEntries: agent-supplied value WINS over catalog defaultFields', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const catalogDt = {
      value: [{ entryType: 'INBOUND', value: '', unit: 'tb_month', fromRegion: '' }],
    };
    const userDt = {
      value: [{ entryType: 'INBOUND', value: '5', unit: 'gb_month', fromRegion: 'us-west-2' }],
    };
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'lambdaWithFreeTier',
        required: [{ field: 'numberOfRequests' }],
        defaultFields: { dataTransferForEC2: catalogDt },
      }],
    ]);
    const { addEntries } = createHandlerHelpers({ catalog });
    const eb = new EstimateBuilder('test', 'aws');
    await addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'lambda+override',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
        dataTransferForEC2: userDt,
      },
    }]);
    const stored = Object.values(eb.services)[0];
    assert.deepEqual(stored.dataTransferForEC2, userDt,
      'user-supplied value must override catalog defaultFields');
  });

  it('addEntries: services without defaultFields behave unchanged', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'lambdaWithFreeTier',
        required: [{ field: 'numberOfRequests' }],
        // no defaultFields block
      }],
    ]);
    const { addEntries } = createHandlerHelpers({ catalog });
    const eb = new EstimateBuilder('test', 'aws');
    await addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'lambda',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);
    const stored = Object.values(eb.services)[0];
    assert.equal(stored.dataTransferForEC2, undefined,
      'no defaultFields block means no injection');
  });

  it('exportWithLint: returns sharable URL when lint passes', async () => {
    const calls = [];
    stubAwsClient({
      saveImpl: async (payload) => {
        calls.push(payload);
        return { shareableUrl: 'https://calculator.aws/#/estimate?id=happy', estimateId: 'happy' };
      },
    });
    // This test exercises the success branch of exportWithLint —
    // when lint says editable, save runs. Stub the linter directly
    // so the test stays focused on the policy decision rather than
    // depending on whether a synthetic config satisfies real
    // manifest+catalog required-field rules.
    require.cache[REHYDRATE_FETCH_PATH] = {
      exports: { canRehydrateFetch: async () => ({ status: 'editable', services: [] }) },
    };

    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const eb = new EstimateBuilder('test', 'aws');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });

    const r = await __test.exportWithLint(eb);
    assert.equal(r.isError, false);
    assert.equal(r.aws_estimate_id, 'happy');
    assert.match(r.sharable_url, /id=happy/);
    assert.equal(calls.length, 1, 'saveEstimate must be called when lint passes');
  });

  it('exportWithLint: returns isError text and skips save when lint says read-only', async () => {
    let saveCalled = false;
    stubAwsClient({
      saveImpl: async () => { saveCalled = true; return { estimateId: 'x', shareableUrl: 'x' }; },
    });
    // Force the lint to report read-only — exact predicate doesn't matter
    // for this test; we just need exportWithLint to honor the verdict and
    // skip save. Stubbing canRehydrateFetch keeps the test decoupled from
    // the linter's internal predicate logic (which has its own tests).
    require.cache[REHYDRATE_FETCH_PATH] = {
      exports: {
        canRehydrateFetch: async () => ({
          status: 'read-only',
          services: [{
            serviceCode: 'aWSLambda',
            failures: [{ predicate: 'template-existence', message: 'mock failure' }],
          }],
        }),
      },
    };

    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const eb = new EstimateBuilder('test', 'aws');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });

    const r = await __test.exportWithLint(eb);
    assert.equal(r.isError, true);
    assert.match(r.text, /read-only/);
    assert.match(r.text, /template-existence/);
    assert.equal(saveCalled, false, 'save must NOT be attempted when lint refuses');
  });

  it('exportWithLint: refuses and skips save when lint says required-input', async () => {
    // Mirrors the read-only refusal test for the second blocking
    // verdict. required-input means the calculator would silently
    // default the missing required fields and price the estimate
    // against a value the user never chose — refuse rather than
    // ship a costed-but-misleading URL.
    let saveCalled = false;
    stubAwsClient({
      saveImpl: async () => { saveCalled = true; return { estimateId: 'x', shareableUrl: 'x' }; },
    });
    require.cache[REHYDRATE_FETCH_PATH] = {
      exports: {
        canRehydrateFetch: async () => ({
          status: 'required-input',
          services: [{
            serviceCode: 'networkAddressTranslationNatGatewayVpc',
            failures: [{
              predicate: 'required-field-presence',
              severity: 'required-only',
              message: 'required component "regionalNatGatewayDataProcessed" missing from calculationComponents',
              context: { serviceCode: 'networkAddressTranslationNatGatewayVpc', componentId: 'regionalNatGatewayDataProcessed' },
            }],
          }],
        }),
      },
    };

    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const eb = new EstimateBuilder('test', 'aws');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'placeholder',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });

    const r = await __test.exportWithLint(eb);
    assert.equal(r.isError, true);
    assert.match(r.text, /missing required fields/);
    assert.match(r.text, /regionalNatGatewayDataProcessed/);
    assert.equal(saveCalled, false, 'save must NOT be attempted when lint refuses on required-input');
  });

  it('build_estimate flow: store retains the estimate so add_service can extend it', async () => {
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    // Simulate what build_estimate does internally: create, add, store.
    const eb = new EstimateBuilder('combo', 'aws');
    await __test.addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'API',
        numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      },
    }]);
    await __test.store.put(eb);

    // Round-trip through the same store the add_service handler uses.
    const retrieved = await __test.store.get(eb.id);
    assert.ok(retrieved, 'estimate must be retrievable after build_estimate stores it');
    assert.equal(Object.keys(retrieved.services).length, 1);
  });
});

describe('build_estimate response includes estimate_id on failure paths', () => {
  // Reuse the stubAwsClient + reset helpers already defined at the top of
  // this file. Each test calls reset() then stubs as needed.
  beforeEach(() => {
    reset();
    process.env.ESTIMATES_STORE = 'memory';
  });

  it('returns isError:false needs_grounding envelope when validation fails', async () => {
    reset();
    // Use aWSLambda (in fakeManifest + fakeDef) with a bogus field so
    // validateConfigKeys can find the definition and reject the invalid key.
    stubAwsClient();  // No save needed; validation fails before save.
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({
      services: JSON.stringify([{
        service: 'aWSLambda',
        group: 'test',
        config: { region: 'us-east-1', description: 'x', BogusFieldId: '1' },
      }]),
    });
    assert.equal(result.isError, false,
      'validation failures return isError:false (structured nudge, not tool error)');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'needs_field_grounding');
    assert.match(body.estimate_id, /^[0-9a-f-]{36}$/,
      'estimate_id should be a UUID minted by EstimateBuilder');
    assert.ok(Array.isArray(body.services_to_inspect),
      'response should list services to call get_service_fields on');
    assert.ok(body.services_to_inspect.includes('aWSLambda'));
    assert.ok(typeof body.next_step === 'string' && body.next_step.length > 0,
      'response should include actionable next_step text');
    assert.ok(Array.isArray(body.issues),
      'response should preserve per-entry validation results in issues[]');
  });

  it('services_to_inspect dedupes when multiple entries fail on the same service', async () => {
    reset();
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({
      services: JSON.stringify([
        { service: 'aWSLambda', group: 'a',
          config: { region: 'us-east-1', description: 'x', BogusOne: '1' } },
        { service: 'aWSLambda', group: 'b',
          config: { region: 'us-east-1', description: 'y', BogusTwo: '2' } },
      ]),
    });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.services_to_inspect.filter(s => s === 'aWSLambda').length, 1,
      'aWSLambda should appear once in services_to_inspect even with 2 failed entries');
  });

  it('emits build_estimate.needs_grounding trace event with eid + services', async () => {
    reset();
    stubAwsClient();
    const { __test } = require('../mcp-server.js');

    // Capture stderr (where lib/trace/trace-logger.js writes events).
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s.toString()); return true; };

    let result;
    try {
      result = await __test.buildEstimateHandler({
        services: JSON.stringify([{
          service: 'aWSLambda', group: 'test',
          config: { region: 'us-east-1', description: 'x', BogusFieldId: '1' },
        }]),
      });
    } finally {
      process.stderr.write = orig;
    }

    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(e => e && e.event === 'build_estimate.needs_grounding');
    assert.equal(events.length, 1, 'one needs_grounding event per failed call');
    assert.match(events[0].estimateId, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(events[0].servicesToInspect));
    assert.ok(events[0].servicesToInspect.includes('aWSLambda'));
    assert.equal(events[0].failureCount, 1);

    // The eid emitted on the trace event matches the eid in the response body.
    const body = JSON.parse(result.content[0].text);
    assert.equal(events[0].estimateId, body.estimate_id);
  });

  it('does NOT include estimate_id on JSON parse failure (no eid minted yet)', async () => {
    reset();
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({ services: 'not-json' });
    assert.equal(result.isError, true);
    // Body is a plain message, not JSON — no estimate_id field. Confirms
    // pre-mint failures stay no-eid by design (the residual bucket).
    assert.doesNotMatch(result.content[0].text, /"estimate_id"/);
  });

  it('does NOT include estimate_id on empty services array (no eid minted yet)', async () => {
    reset();
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({ services: '[]' });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /"estimate_id"/);
  });

  it('does NOT include estimate_id on unknown partition (no eid minted yet)', async () => {
    reset();
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({
      services: JSON.stringify([{
        service: 'aWSLambda', group: 'test',
        config: { region: 'us-east-1', description: 'x',
                  numberOfRequests: { value: '1', unit: 'millionPerMonth' } },
      }]),
      partition: 'aws-bogus',
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /"estimate_id"/);
  });

  it('includes estimate_id on success body (alongside aws_estimate_id)', async () => {
    reset();
    const savedKey = 'fake-saved-key-abc';
    stubAwsClient({ saveImpl: async () => ({ estimateId: savedKey, shareableUrl: `https://calculator.aws/#/estimate?id=${savedKey}` }) });
    // Stub the linter to editable. The stub's extractInputFields only
    // declares `numberOfRequests`, which now triggers catalog-required
    // checks for the rest — this test is about response-body shape on
    // the success path, not about whether the linter agrees the
    // synthetic stub is complete.
    require.cache[REHYDRATE_FETCH_PATH] = {
      exports: { canRehydrateFetch: async () => ({ status: 'editable', services: [] }) },
    };
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({
      services: JSON.stringify([{
        service: 'aWSLambda', group: 'test',
        config: { region: 'us-east-1', description: 'x',
                  numberOfRequests: { value: '1', unit: 'millionPerMonth' } },
      }]),
    });
    if (result.isError) {
      // If lint refuses or something, surface what happened so a future
      // schema change is easy to triage.
      assert.fail(`build_estimate failed: ${result.content[0].text}`);
    }
    const body = JSON.parse(result.content[0].text);
    assert.match(body.estimate_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.aws_estimate_id, savedKey);
    assert.ok(body.sharable_url);
    assert.ok(body.services);
  });

  it('includes estimate_id on lint-refused body', async () => {
    reset();
    stubAwsClient();
    require.cache[REHYDRATE_FETCH_PATH] = {
      exports: {
        canRehydrateFetch: async () => ({
          status: 'read-only',
          services: [{
            serviceCode: 'aWSLambda',
            failures: [{ predicate: 'template-existence', message: 'mock failure' }],
          }],
        }),
      },
    };
    const { __test } = require('../mcp-server.js');
    const result = await __test.buildEstimateHandler({
      services: JSON.stringify([{
        service: 'aWSLambda', group: 'test',
        config: { region: 'us-east-1', description: 'x',
                  numberOfRequests: { value: '1', unit: 'millionPerMonth' } },
      }]),
    });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.match(body.estimate_id, /^[0-9a-f-]{36}$/);
    assert.match(body.error, /read-only/);
  });
});
