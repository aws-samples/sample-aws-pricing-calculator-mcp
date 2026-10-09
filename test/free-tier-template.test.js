// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Regression tests for GitHub issue #40:
 *   AWS Lambda estimates always used the lambdaWithFreeTier template with
 *   no way to exclude the Free Tier, because addEntries derived the
 *   template hint solely from the catalog's static templateId.
 *
 * The fix:
 *   1. a per-entry `estimateFor` override that wins over the catalog hint
 *      (validated against the service's real templates), and
 *   2. detection of a …WithFreeTier / …WithoutFreeTier template pair so
 *      the tool surfaces the choice (freeTierChoice / free_tier_choice)
 *      and the agent asks the user include-vs-exclude.
 *
 * aws-client is stubbed via require.cache injection so these run offline.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AWS_CLIENT_PATH = require.resolve('../lib/aws/aws-client');
const VALIDATION_PATH = require.resolve('../lib/lint/validation');
const ESTIMATE_BUILDER_PATH = require.resolve('../lib/aws/estimate-builder');
const HANDLER_HELPERS_PATH = require.resolve('../lib/mcp/handler-helpers');

function reset() {
  for (const p of [AWS_CLIENT_PATH, VALIDATION_PATH, ESTIMATE_BUILDER_PATH, HANDLER_HELPERS_PATH]) {
    delete require.cache[p];
  }
}

// A Lambda-shaped definition with BOTH templates. The include template
// declares mappingFromTemplate pointing at the exclude variant, exactly
// as the live manifest does.
const fakeManifest = new Map([['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda' }]]);
const fakeDef = {
  serviceCode: 'aWSLambda',
  version: '1.0',
  templates: [
    { id: 'lambdaWithFreeTier', mappingFromTemplate: 'lambdaWithoutFreeTier', title: 'Include Free Tier' },
    { id: 'lambdaWithoutFreeTier', title: 'Without Free Tier' },
  ],
};

function stubAwsClient() {
  const stub = {
    PARTITIONS: { aws: { contract: '' } },
    resolvePartition: () => 'aws',
    loadManifest: async () => fakeManifest,
    loadRegionList: async () => null,
    findService: (m, k) => m.get(k),
    fetchServiceDefinition: async (_m, code) => (code === 'aWSLambda' ? fakeDef : null),
    extractInputFields: () => [
      { id: 'numberOfRequests', type: 'frequency', subType: 'frequency', label: 'Requests' },
    ],
    enrichFieldsWithMetadata: async (_d, fields) => fields,
    searchServices: () => [],
    saveEstimate: async () => ({ shareableUrl: 'https://calculator.aws/#/estimate?id=abc', estimateId: 'abc' }),
  };
  require.cache[AWS_CLIENT_PATH] = { id: AWS_CLIENT_PATH, filename: AWS_CLIENT_PATH, loaded: true, exports: stub };
  return stub;
}

const lambdaCatalog = () => new Map([
  ['aWSLambda', { serviceCode: 'aWSLambda', templateId: 'lambdaWithFreeTier', status: 'verified' }],
]);

const lambdaConfig = () => ({
  region: 'us-east-1',
  description: 'API handler',
  numberOfRequests: { value: '100', unit: 'millionPerMonth' },
});

describe('detectFreeTierChoice (issue #40)', () => {
  beforeEach(reset);

  it('returns the include/exclude pair for a Lambda-shaped def', () => {
    stubAwsClient();
    const { detectFreeTierChoice } = require('../lib/mcp/handler-helpers');
    assert.deepEqual(detectFreeTierChoice(fakeDef), {
      includeFreeTier: 'lambdaWithFreeTier',
      excludeFreeTier: 'lambdaWithoutFreeTier',
    });
  });

  it('returns null when there is no Free Tier template pair', () => {
    stubAwsClient();
    const { detectFreeTierChoice } = require('../lib/mcp/handler-helpers');
    assert.equal(detectFreeTierChoice({ templates: [{ id: 'lambdaWithFreeTier' }] }), null,
      'an include template with no exclude sibling is not a choice');
    assert.equal(detectFreeTierChoice({ templates: [{ id: 'someTemplate' }] }), null);
    assert.equal(detectFreeTierChoice({ templates: [] }), null);
    assert.equal(detectFreeTierChoice(null), null);
  });
});

describe('addEntries — Free Tier template choice (issue #40)', () => {
  beforeEach(() => {
    reset();
    process.env.ESTIMATES_STORE = 'memory';
  });

  it('a per-entry estimateFor override wins over the catalog templateId', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { addEntries } = createHandlerHelpers({ catalog: lambdaCatalog() });

    const eb = new EstimateBuilder('t', 'aws');
    const results = await addEntries(eb, [{
      service: 'aWSLambda',
      estimateFor: 'lambdaWithoutFreeTier',
      config: lambdaConfig(),
    }]);

    assert.equal(results[0].success, true);
    assert.equal(eb.templateHints.get('aWSLambda'), 'lambdaWithoutFreeTier',
      'the override must become the builder template hint');
    // And it must survive into the saved payload's estimateFor.
    const blob = await eb.toAWSPayload();
    assert.equal(Object.values(blob.services)[0].estimateFor, 'lambdaWithoutFreeTier');
    // No advisory once the caller has chosen explicitly.
    assert.equal(results[0].free_tier_choice, undefined);
  });

  it('without an override, defaults to include Free Tier AND surfaces the choice to ask the user', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { addEntries } = createHandlerHelpers({ catalog: lambdaCatalog() });

    const eb = new EstimateBuilder('t', 'aws');
    const results = await addEntries(eb, [{ service: 'aWSLambda', config: lambdaConfig() }]);

    assert.equal(results[0].success, true);
    assert.equal(eb.templateHints.get('aWSLambda'), 'lambdaWithFreeTier',
      'default stays include-Free-Tier for back-compat');
    const ftc = results[0].free_tier_choice;
    assert.ok(ftc, 'a free_tier_choice advisory must be present so the agent asks the user');
    assert.equal(ftc.includeFreeTier, 'lambdaWithFreeTier');
    assert.equal(ftc.excludeFreeTier, 'lambdaWithoutFreeTier');
    assert.match(ftc.action_required, /ask the user/i);
  });

  it('rejects an invalid estimateFor with the list of valid templates', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { addEntries } = createHandlerHelpers({ catalog: lambdaCatalog() });

    const eb = new EstimateBuilder('t', 'aws');
    const results = await addEntries(eb, [{
      service: 'aWSLambda',
      estimateFor: 'lambdaNoSuchTemplate',
      config: lambdaConfig(),
    }]);

    assert.ok(results[0].error, 'an unknown template id must error');
    assert.match(results[0].error, /not a valid template/i);
    assert.match(results[0].error, /lambdaWithFreeTier/);
    assert.match(results[0].error, /lambdaWithoutFreeTier/);
    assert.equal(Object.keys(eb.services).length, 0, 'a bad override must not register the entry');
  });
});
