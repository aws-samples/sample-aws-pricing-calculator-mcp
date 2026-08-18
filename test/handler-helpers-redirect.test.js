// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the discovery-time productCodes redirect: annotateSearchResults
 * (search_services post-processing) and maybeBuildProductRedirect
 * (get_service_fields branch). Both consume the same productCodes index
 * built by createHandlerHelpers from the catalog.
 *
 * Sonnet 4.5 experiment 2026-06-03 measured 6→3 tool-call reduction when
 * agents see this redirect at discovery vs only via the post-save lint
 * refusal. These tests pin the contract so the data path doesn't silently
 * drift.
 *
 * Network paths (loadManifest, fetchServiceDefinition) are stubbed via
 * require.cache injection — same pattern as mcp-build-estimate.test.js.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AWS_CLIENT_PATH = require.resolve('../lib/aws/aws-client');
const HANDLER_HELPERS_PATH = require.resolve('../lib/mcp/handler-helpers');

function reset() {
  delete require.cache[AWS_CLIENT_PATH];
  delete require.cache[HANDLER_HELPERS_PATH];
}

// Synthetic catalog mirroring amazonBedrock's productCodes shape.
const CATALOG = new Map();
CATALOG.set('amazonBedrock', {
  serviceCode: 'amazonBedrock',
  displayName: 'Amazon Bedrock',
  status: 'verified',
  traps: ['Bedrock is per-provider, not per-product.'],
  subServices: [
    { serviceCode: 'anthropic', estimateFor: 'anthropic', required: [] },
    {
      serviceCode: 'amazon',
      estimateFor: 'Amazon',
      required: [],
      productCodes: ['titanTextEmbeddingsV2', 'novaPro'],
    },
  ],
});

function stubAwsClient() {
  const fakeManifest = new Map([
    ['titanTextEmbeddingsV2', { key: 'titanTextEmbeddingsV2', name: 'Titan Text Embeddings V2', subType: 'subService' }],
    ['novaPro', { key: 'novaPro', name: 'Nova Pro', subType: 'subService' }],
    ['amazon', { key: 'amazon', name: 'Amazon (Bedrock provider)', subType: 'subService' }],
    ['anthropic', { key: 'anthropic', name: 'Anthropic (Bedrock provider)', subType: 'subService' }],
    ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda' }],
  ]);
  const fakeAmazonDef = {
    serviceCode: 'amazon',
    version: '1.0',
    templates: [{ id: 'Amazon' }],
    inputSections: [{
      components: [
        { id: 'modelSelection', subType: 'select' },
        { id: 'avgInputTokensPerRequest', subType: 'numericInput' },
      ],
    }],
  };
  const stub = {
    PARTITIONS: { aws: { contract: '' } },
    resolvePartition: () => 'aws',
    loadManifest: async () => fakeManifest,
    findService: (m, k) => m.get(k),
    fetchServiceDefinition: async (_m, code) => (code === 'amazon' ? fakeAmazonDef : null),
    extractInputFields: () => [
      { id: 'modelSelection', type: 'input', subType: 'select' },
      { id: 'avgInputTokensPerRequest', type: 'input', subType: 'numericInput' },
    ],
    enrichFieldsWithMetadata: async (_d, fields) => fields,
    searchServices: () => [],
    saveEstimate: async () => ({ shareableUrl: '', estimateId: '' }),
  };
  require.cache[AWS_CLIENT_PATH] = { exports: stub };
  return stub;
}

describe('discovery-time productCodes redirect', () => {
  beforeEach(reset);

  describe('annotateSearchResults', () => {
    it('annotates a hit whose key is in productCodes with redirect_to + note', () => {
      stubAwsClient();
      const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
      const h = createHandlerHelpers({ catalog: CATALOG });
      const out = h.annotateSearchResults([
        { key: 'titanTextEmbeddingsV2', name: 'Titan Text Embeddings V2' },
        { key: 'aWSLambda', name: 'AWS Lambda' },
      ]);
      assert.equal(out[0].redirect_to, 'amazon');
      assert.match(out[0].note, /amazon/);
      assert.match(out[0].note, /amazonBedrock/);
      // Non-product hits are passed through unchanged.
      assert.equal(out[1].redirect_to, undefined);
      assert.equal(out[1].note, undefined);
    });

    it('handles multi-term search shape ({ term: [...hits] })', () => {
      stubAwsClient();
      const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
      const h = createHandlerHelpers({ catalog: CATALOG });
      const out = h.annotateSearchResults({
        titan: [{ key: 'titanTextEmbeddingsV2', name: 'Titan' }],
        lambda: [{ key: 'aWSLambda', name: 'AWS Lambda' }],
      });
      assert.equal(out.titan[0].redirect_to, 'amazon');
      assert.equal(out.lambda[0].redirect_to, undefined);
    });

    it('passes through unchanged when catalog has no productCodes', () => {
      stubAwsClient();
      const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
      const emptyCatalog = new Map();
      const h = createHandlerHelpers({ catalog: emptyCatalog });
      const hits = [{ key: 'titanTextEmbeddingsV2', name: 'Titan' }];
      const out = h.annotateSearchResults(hits);
      // Same array (no shallow copy when there's nothing to do).
      assert.equal(out, hits);
    });
  });

  describe('maybeBuildProductRedirect', () => {
    it('returns redirect envelope for a productCode with provider preview', async () => {
      stubAwsClient();
      const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
      const h = createHandlerHelpers({ catalog: CATALOG });
      const r = await h.maybeBuildProductRedirect({
        svc: { key: 'titanTextEmbeddingsV2', name: 'Titan Text Embeddings V2' },
        partition: 'aws',
      });
      assert.ok(r, 'expected a redirect for titanTextEmbeddingsV2');
      assert.equal(r.status, 'redirect_to_provider');
      assert.equal(r.redirect_to, 'amazon');
      assert.equal(r.parent_service_code, 'amazonBedrock');
      assert.match(r.next_step, /amazon/);
      assert.match(r.next_step, /modelSelection/);
      // Preview should be the provider's fields, not the product's.
      assert.equal(r.preview_fields_for.serviceCode, 'amazon');
      assert.ok(r.preview_fields_for.fields.length >= 1);
    });

    it('returns null for a service that is not a productCode', async () => {
      stubAwsClient();
      const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
      const h = createHandlerHelpers({ catalog: CATALOG });
      const r = await h.maybeBuildProductRedirect({
        svc: { key: 'aWSLambda', name: 'AWS Lambda' },
        partition: 'aws',
      });
      assert.equal(r, null);
    });

    it('returns null for a provider code itself (no recursion)', async () => {
      stubAwsClient();
      const { createHandlerHelpers } = require('../lib/mcp/handler-helpers');
      const h = createHandlerHelpers({ catalog: CATALOG });
      // anthropic is in subServices[].serviceCode, NOT productCodes[].
      // Must not redirect.
      const r = await h.maybeBuildProductRedirect({
        svc: { key: 'anthropic', name: 'Anthropic' },
        partition: 'aws',
      });
      assert.equal(r, null);
    });
  });
});
