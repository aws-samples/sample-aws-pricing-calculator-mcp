// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Regression tests for the Database Savings Plans eligibility/term gap:
 *
 *   AWS Database Savings Plans are only sold on Gen 7+ instance families
 *   (m7g/r7g, m8g/r8g, m9g, ...). T-class (t3, t4g) and anything Gen 6 or
 *   older (m5, r5, m6, r6, ...) are NOT eligible at all, on any RDS/Aurora
 *   engine. They are also only sold as a 1-year term — there is no 3-year
 *   Database Savings Plan (LeaseContractLength "3yr" does not exist for
 *   this TermType). The column-form tuple-validity lint (issue #41) can't
 *   catch either violation because the per-instance selector aggregation
 *   only tracks OnDemand/Reserved tuples, so a "Database Savings Plans"
 *   TermType is dropped from the comparison rather than checked against
 *   it — the row saves and rehydrates without error but silently
 *   misprices.
 *
 * Fix: surface this as a hint (not a catalog change, since it applies to
 * every RDS/Aurora engine — curated or not) from two places:
 *   1. get_service_fields (buildFieldsResult) — `pricingModelHint`,
 *      whenever the resolved service code is RDS/Aurora-shaped.
 *   2. add_service (addEntries) — `pricing_model_hint` on the per-entry
 *      result, only when the submitted config actually set TermType to
 *      "Database Savings Plans".
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

// A minimal RDS-shaped columnFormIPM def — enough for extractInputFields /
// validateConfigKeys to accept a "columnFormIPM" top-level key.
const fakeManifest = new Map([
  ['amazonRDSMySQLDB', { key: 'amazonRDSMySQLDB', name: 'Amazon RDS for MySQL' }],
  ['amazonRdsBackup', { key: 'amazonRdsBackup', name: 'RDS' }],
  ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda' }],
]);
const fakeDef = {
  serviceCode: 'amazonRDSMySQLDB',
  version: '1.0',
  templates: [{ id: 'rdsForMySQL' }],
};
const fakeLambdaDef = { serviceCode: 'aWSLambda', version: '1.0', templates: [{ id: 'lambda' }] };
const fakeBackupDef = { serviceCode: 'amazonRdsBackup', version: '1.0', templates: [{ id: 'rdsBackup' }] };

function stubAwsClient() {
  const stub = {
    PARTITIONS: { aws: { contract: '' } },
    resolvePartition: () => 'aws',
    loadManifest: async () => fakeManifest,
    loadRegionList: async () => null,
    findService: (m, k) => m.get(k),
    fetchServiceDefinition: async (_m, code) => {
      if (code === 'amazonRDSMySQLDB') return fakeDef;
      if (code === 'aWSLambda') return fakeLambdaDef;
      if (code === 'amazonRdsBackup') return fakeBackupDef;
      return null;
    },
    extractInputFields: (def) => {
      if (def === fakeDef) {
        return [{ id: 'columnFormIPM', type: 'columnFormIPM', subType: 'columnFormIPM', label: 'Instance', row: [] }];
      }
      if (def === fakeLambdaDef) {
        return [{ id: 'numberOfRequests', type: 'frequency', subType: 'frequency', label: 'Requests' }];
      }
      return [];
    },
    enrichFieldsWithMetadata: async (_d, fields) => fields,
    searchServices: () => [],
    saveEstimate: async () => ({ shareableUrl: 'https://calculator.aws/#/estimate?id=abc', estimateId: 'abc' }),
  };
  require.cache[AWS_CLIENT_PATH] = { id: AWS_CLIENT_PATH, filename: AWS_CLIENT_PATH, loaded: true, exports: stub };
  return stub;
}

const rdsConfigWithSavingsPlans = () => ({
  region: 'us-east-1',
  description: 'prod db',
  columnFormIPM: {
    value: [{
      'Instance Type': { value: 'db.t3.small' },
      TermType: { value: 'Database Savings Plans' },
    }],
  },
});

const rdsConfigOnDemand = () => ({
  region: 'us-east-1',
  description: 'prod db',
  columnFormIPM: {
    value: [{
      'Instance Type': { value: 'db.r7g.large' },
      TermType: { value: 'OnDemand' },
    }],
  },
});

describe('isRdsFamilyService / DATABASE_SAVINGS_PLANS_HINT export shape', () => {
  beforeEach(reset);

  it('matches RDS and Aurora engine codes, excludes backup/outposts flavours', () => {
    stubAwsClient();
    const { isRdsFamilyService } = require('../lib/mcp/handler-helpers');
    for (const code of [
      'amazonRDSMySQLDB', 'amazonRDSPostgreSQLDB', 'amazonRDSForSQLServer',
      'amazonRdsForOracle', 'amazonRdsForDb2', 'amazonRDSMariaDB',
      'amazonAuroraMySQLCompatible', 'amazonRDSAuroraPostgreSQLCompatibleDB',
    ]) {
      assert.equal(isRdsFamilyService(code), true, `${code} should match the RDS family`);
    }
    for (const code of [
      'amazonRdsBackup', 'rdsBackup', 'amazonAuroraBackup', 'auroraBackup',
      'amazonRdsForOutposts', 'aWSLambda', 'amazonS3Standard', undefined, null,
    ]) {
      assert.equal(isRdsFamilyService(code), false, `${code} should NOT match the RDS family`);
    }
  });
});

describe('buildFieldsResult — pricingModelHint (get_service_fields)', () => {
  beforeEach(reset);

  it('includes the Database Savings Plans hint for an RDS engine, curated catalog or not', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const { buildFieldsResult } = createHandlerHelpers({ catalog: new Map() });

    const out = await buildFieldsResult({ key: 'amazonRDSMySQLDB', name: 'Amazon RDS for MySQL' }, 'aws');
    assert.ok(out, 'expected a result');
    assert.match(out.pricingModelHint, /Database Savings Plans/);
    assert.match(out.pricingModelHint, /Gen 7\+/);
    assert.match(out.pricingModelHint, /1-year term/);
    assert.match(out.pricingModelHint, /no 3-year/i);
  });

  it('omits the hint for a non-RDS service', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const { buildFieldsResult } = createHandlerHelpers({ catalog: new Map() });

    const out = await buildFieldsResult({ key: 'aWSLambda', name: 'AWS Lambda' }, 'aws');
    assert.equal(out.pricingModelHint, undefined);
  });

  it('omits the hint for an RDS-named service with no instance/TermType selector (backup)', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const { buildFieldsResult } = createHandlerHelpers({ catalog: new Map() });

    const out = await buildFieldsResult({ key: 'amazonRdsBackup', name: 'RDS' }, 'aws');
    assert.equal(out.pricingModelHint, undefined);
  });
});

describe('addEntries — pricing_model_hint (add_service)', () => {
  beforeEach(() => {
    reset();
    process.env.ESTIMATES_STORE = 'memory';
  });

  it('flags an RDS entry that sets TermType to Database Savings Plans', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { addEntries } = createHandlerHelpers({ catalog: new Map() });

    const eb = new EstimateBuilder('t', 'aws');
    const results = await addEntries(eb, [{
      service: 'amazonRDSMySQLDB',
      config: rdsConfigWithSavingsPlans(),
    }]);

    assert.equal(results[0].success, true);
    assert.match(results[0].pricing_model_hint || '', /Database Savings Plans/);
    assert.match(results[0].pricing_model_hint || '', /Gen 7\+/);
    assert.match(results[0].pricing_model_hint || '', /1-year term/);
  });

  it('does not flag an RDS entry on OnDemand/Reserved pricing', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { addEntries } = createHandlerHelpers({ catalog: new Map() });

    const eb = new EstimateBuilder('t', 'aws');
    const results = await addEntries(eb, [{
      service: 'amazonRDSMySQLDB',
      config: rdsConfigOnDemand(),
    }]);

    assert.equal(results[0].success, true);
    assert.equal(results[0].pricing_model_hint, undefined);
  });

  it('does not flag a non-RDS entry even if it mentions the phrase', async () => {
    stubAwsClient();
    const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { addEntries } = createHandlerHelpers({ catalog: new Map() });

    const eb = new EstimateBuilder('t', 'aws');
    const results = await addEntries(eb, [{
      service: 'aWSLambda',
      config: {
        region: 'us-east-1',
        description: 'Database Savings Plans mentioned in free text',
        numberOfRequests: { value: '5', unit: 'millionPerMonth' },
      },
    }]);

    assert.equal(results[0].success, true);
    assert.equal(results[0].pricing_model_hint, undefined);
  });
});
