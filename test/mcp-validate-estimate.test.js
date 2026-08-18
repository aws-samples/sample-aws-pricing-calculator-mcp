// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the validate_estimate MCP tool's internal helpers.
 *
 * validate_estimate composes lintEstimate (build payload + run static
 * linter). We exercise the helper directly — same pattern as
 * mcp-build-estimate.test.js. Network paths stubbed via require.cache.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AWS_CLIENT_PATH = require.resolve('../lib/aws/aws-client');
const VALIDATION_PATH = require.resolve('../lib/lint/validation');
const REHYDRATE_FETCH_PATH = require.resolve('../lib/lint/can-rehydrate-fetch');
const SURFACEABILITY_PATH = require.resolve('../lib/aws/surfaceability');
const ESTIMATE_BUILDER_PATH = require.resolve('../lib/aws/estimate-builder');
const HANDLER_HELPERS_PATH = require.resolve('../lib/mcp/handler-helpers');
const MCP_SERVER_PATH = require.resolve('../mcp-server.js');

function reset() {
  delete require.cache[AWS_CLIENT_PATH];
  delete require.cache[VALIDATION_PATH];
  delete require.cache[REHYDRATE_FETCH_PATH];
  delete require.cache[SURFACEABILITY_PATH];
  delete require.cache[ESTIMATE_BUILDER_PATH];
  delete require.cache[HANDLER_HELPERS_PATH];
  delete require.cache[MCP_SERVER_PATH];
  delete require.cache[require.resolve('../lib/store/estimate-store')];
  delete require.cache[require.resolve('../lib/lint/catalog')];
}

const fakeManifest = new Map([
  ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda' }],
]);

const lambdaPctWithSurfaceableField = {
  serviceCode: 'aWSLambda',
  version: '1.0',
  templates: [{ id: 'lambdaWithoutFreeTier' }],
  inputSections: [{
    components: [
      { id: 'numberOfRequests', subType: 'frequency', label: 'Number of requests',
        displayInConfigSummary: true, validations: { required: true } },
      { id: 'durationOfEachRequest', subType: 'numericInput', label: 'Duration',
        displayInConfigSummary: false },
    ],
  }],
};

function stubAwsClient(def = lambdaPctWithSurfaceableField) {
  const stub = {
    PARTITIONS: { aws: { contract: '' }, 'aws-iso': { contract: 'iso' } },
    resolvePartition: () => 'aws',
    loadManifest: async () => fakeManifest,
    findService: (m, k) => m.get(k),
    fetchServiceDefinition: async (_m, code) => (code === 'aWSLambda' ? def : null),
    extractInputFields: () => [
      { id: 'numberOfRequests', type: 'frequency', subType: 'frequency', label: 'Number of requests', validations: { required: true } },
    ],
    enrichFieldsWithMetadata: async (_d, fields) => fields,
    searchServices: () => [],
    fetchEstimate: async () => ({}),
    estimateToMarkdown: () => '',
    saveEstimate: async () => ({ shareableUrl: 'x', estimateId: 'x' }),
  };
  require.cache[AWS_CLIENT_PATH] = { exports: stub };
  return stub;
}

describe('validate_estimate helpers', () => {
  beforeEach(() => {
    reset();
    process.env.ESTIMATES_STORE = 'memory';
  });

  it('lintEstimate: returns blob + lint verdict for a healthy estimate', async () => {
    stubAwsClient();
    const { __test } = require('../mcp-server.js');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const eb = new EstimateBuilder('test', 'aws');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });

    const { blob, lintResult } = await __test.lintEstimate(eb);
    assert.ok(blob.services, 'should produce a saved-blob shape');
    assert.notEqual(lintResult.status, 'read-only', 'healthy lambda must not lint read-only');
  });

  it('lintEstimate: surfaces read-only verdict without saving', async () => {
    stubAwsClient();
    // Stub canRehydrateFetch directly — the linter's per-predicate
    // logic has its own tests; here we just need the lintEstimate
    // wrapper to surface the verdict honestly.
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

    const { lintResult } = await __test.lintEstimate(eb);
    assert.equal(lintResult.status, 'read-only');
    assert.ok(lintResult.services.length > 0);
  });
});
