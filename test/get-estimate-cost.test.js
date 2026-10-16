// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the get_estimate_cost MCP tool handler (issue #47).
 *
 * The handler re-shares an estimate (dom-cost#fetchPricedEstimateId →
 * Update+Share → new id), reads that id with aws-client#fetchEstimate, and
 * extracts costs with aws-client#extractCostsFromSavedBlob. Playwright +
 * Chromium are an ON-DEMAND dependency, so the handler must detect their
 * absence up front and return a soft cost_available:false envelope.
 *
 * dom-cost is stubbed (checkPlaywrightAvailability + fetchPricedEstimateId)
 * and aws-client's fetchEstimate is overridden (keeping the real
 * extractCostsFromSavedBlob) via require.cache injection — offline.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const MCP_SERVER_PATH = require.resolve('../mcp-server.js');
const DOM_COST_PATH = require.resolve('../lib/dom-cost');
const AWS_CLIENT_PATH = require.resolve('../lib/aws/aws-client');
const REAL_AWS = require('../lib/aws/aws-client');

function freshServer({ availability, pricedId = 'newid123', blob = {}, onShare } = {}) {
  delete require.cache[MCP_SERVER_PATH];
  require.cache[DOM_COST_PATH] = {
    id: DOM_COST_PATH, filename: DOM_COST_PATH, loaded: true,
    exports: {
      checkPlaywrightAvailability: () => availability,
      fetchPricedEstimateId: async (url) => {
        if (onShare) onShare(url);
        return { estimateId: pricedId, shareUrl: `https://calculator.aws/#/estimate?id=${pricedId}` };
      },
      fetchCostFromDOM: async () => { throw new Error('unused'); },
      parseDetailRows: () => [], parseUsd: () => null, classifyPlaywright: () => ({ available: true }),
    },
  };
  // Keep the REAL aws-client (extractCostsFromSavedBlob, etc.), override fetchEstimate only.
  require.cache[AWS_CLIENT_PATH] = {
    id: AWS_CLIENT_PATH, filename: AWS_CLIENT_PATH, loaded: true,
    exports: { ...REAL_AWS, fetchEstimate: async () => blob },
  };
  return require('../mcp-server.js').__test;
}

const parseBody = (res) => JSON.parse(res.content[0].text);
const AVAILABLE = { available: true };

const costedBlob = () => ({
  totalCost: { monthly: 48.02, upfront: 0 },
  metaData: { createdOn: '2026-10-16T08:00:00.000Z' },
  services: {},
  groups: {
    'G1-uuid': {
      name: 'Sizing-01',
      services: {
        's-uuid': {
          serviceName: 'Amazon RDS for SQL server',
          serviceCost: { monthly: 48.02, upfront: 0 },
          configSummary: 'db.t3.small',
        },
      },
    },
  },
});

describe('get_estimate_cost handler (issue #47)', () => {
  beforeEach(() => { process.env.ESTIMATES_STORE = 'memory'; });

  it('playwright missing → soft cost_available:false + install commands', async () => {
    let shared = false;
    const { getEstimateCostHandler } = freshServer({
      availability: { available: false, reason: 'playwright-missing', message: 'x', install: ['npm install playwright', 'npx playwright install chromium'] },
      onShare: () => { shared = true; },
    });
    const res = await getEstimateCostHandler({ estimate_id: 'abc' });
    assert.ok(!res.isError);
    const body = parseBody(res);
    assert.equal(body.cost_available, false);
    assert.equal(body.reason, 'playwright-missing');
    assert.deepEqual(body.install_commands, ['npm install playwright', 'npx playwright install chromium']);
    assert.match(body.next_step, /ask the user/i);
    assert.equal(shared, false, 'must not drive the browser when deps are unavailable');
  });

  it('chromium missing → soft cost_available:false, browser-only install', async () => {
    const { getEstimateCostHandler } = freshServer({
      availability: { available: false, reason: 'chromium-missing', message: 'x', install: ['npx playwright install chromium'] },
    });
    const body = parseBody(await getEstimateCostHandler({ estimate_id: 'abc' }));
    assert.equal(body.cost_available, false);
    assert.equal(body.reason, 'chromium-missing');
  });

  it('available → re-shares, reads the saved blob, returns all totals + complete rows', async () => {
    const { getEstimateCostHandler } = freshServer({ availability: AVAILABLE, pricedId: 'priced777', blob: costedBlob() });
    const res = await getEstimateCostHandler({ estimate_id: 'abc123' });
    assert.ok(!res.isError);
    const body = parseBody(res);
    assert.equal(body.cost_available, true);
    assert.equal(body.monthly_cost, 48.02);
    assert.equal(body.upfront_cost, 0);
    assert.equal(body.total_12_months_cost, 576.24, 'derived = upfront + 12 x monthly');
    assert.equal(body.total_12_months_is_derived, true);
    assert.equal(body.pricing_as_of, '2026-10-16T08:00:00.000Z');
    assert.equal(body.rows_complete, true);
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].group, 'Sizing-01');
    assert.equal(body.priced_estimate_url, 'https://calculator.aws/#/estimate?id=priced777');
    assert.equal(body.currency, 'USD');
    assert.equal(body.source_url, 'https://calculator.aws/#/estimate?id=abc123');
    assert.equal(body.note, undefined);
  });

  it('ESC URL → aws-eusc partition and EUR currency, full URL forwarded', async () => {
    let seenUrl = null;
    const { getEstimateCostHandler } = freshServer({ availability: AVAILABLE, blob: costedBlob(), onShare: (u) => { seenUrl = u; } });
    const escUrl = 'https://pricing.calculator.aws.eu/#/estimate?id=abc';
    const body = parseBody(await getEstimateCostHandler({ estimate_id: escUrl }));
    assert.equal(seenUrl, escUrl, 'full URL forwarded verbatim');
    assert.equal(body.currency, 'EUR');
  });

  it('flags rows-vs-total disagreement', async () => {
    const blob = costedBlob();
    blob.totalCost.monthly = 99.99; // disagree with the single 48.02 row
    const { getEstimateCostHandler } = freshServer({ availability: AVAILABLE, blob });
    const body = parseBody(await getEstimateCostHandler({ estimate_id: 'abc' }));
    assert.equal(body.monthly_cost, 99.99);
    assert.ok(body.note && /authoritative/i.test(body.note));
  });

  it('surfaces a share/browser failure as a tool error', async () => {
    delete require.cache[MCP_SERVER_PATH];
    require.cache[DOM_COST_PATH] = {
      id: DOM_COST_PATH, filename: DOM_COST_PATH, loaded: true,
      exports: {
        checkPlaywrightAvailability: () => AVAILABLE,
        fetchPricedEstimateId: async () => { throw new Error('Share button never became available'); },
        fetchCostFromDOM: async () => ({}), parseDetailRows: () => [], parseUsd: () => null, classifyPlaywright: () => ({ available: true }),
      },
    };
    require.cache[AWS_CLIENT_PATH] = { id: AWS_CLIENT_PATH, filename: AWS_CLIENT_PATH, loaded: true, exports: { ...REAL_AWS, fetchEstimate: async () => ({}) } };
    const { getEstimateCostHandler } = require('../mcp-server.js').__test;
    const res = await getEstimateCostHandler({ estimate_id: 'abc' });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /Could not read estimate cost/);
  });
});
