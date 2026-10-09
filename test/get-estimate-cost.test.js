// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the get_estimate_cost MCP tool handler.
 *
 * The handler hydrates a saved estimate in a headless browser via
 * lib/dom-cost.js. Playwright + Chromium are an ON-DEMAND dependency, so
 * the handler must:
 *   - detect their absence up front and return a soft, actionable
 *     cost_available:false envelope (NOT a hard tool error, NOT a crash
 *     inside chromium.launch()), and
 *   - when present, return the summary monthly_cost and per-row data,
 *     flagging a rows/summary disagreement.
 *
 * lib/dom-cost.js is stubbed via require.cache injection so these run
 * offline (no Playwright, no browser, no network) under SKIP_NETWORK=1.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const MCP_SERVER_PATH = require.resolve('../mcp-server.js');
const DOM_COST_PATH = require.resolve('../lib/dom-cost');

// Rebuild mcp-server against a stubbed lib/dom-cost. The stub must be in
// the require cache BEFORE mcp-server requires it, so we drop the server's
// own cache entry too and let the fresh require pick up the stub.
function freshServerWithDomCostStub(stub) {
  delete require.cache[MCP_SERVER_PATH];
  require.cache[DOM_COST_PATH] = {
    id: DOM_COST_PATH,
    filename: DOM_COST_PATH,
    loaded: true,
    exports: {
      checkPlaywrightAvailability: stub.checkPlaywrightAvailability,
      fetchCostFromDOM: stub.fetchCostFromDOM || (async () => {
        throw new Error('fetchCostFromDOM must not be called when deps are unavailable');
      }),
      classifyPlaywright: () => ({ available: true }),
      parseDetailRows: () => [],
      parseUsd: () => null,
    },
  };
  return require('../mcp-server.js').__test;
}

function parseBody(res) {
  return JSON.parse(res.content[0].text);
}

describe('get_estimate_cost handler', () => {
  beforeEach(() => {
    process.env.ESTIMATES_STORE = 'memory';
  });

  it('playwright module missing → soft cost_available:false with install commands', async () => {
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({
        available: false,
        reason: 'playwright-missing',
        message: 'The Playwright library is not installed.',
        install: ['npm install playwright', 'npx playwright install chromium'],
      }),
    });

    const res = await getEstimateCostHandler({ estimate_id: 'deadbeef' });
    assert.ok(!res.isError, 'dependency-missing must be a soft result, not a hard tool error');
    const body = parseBody(res);
    assert.equal(body.cost_available, false);
    assert.equal(body.reason, 'playwright-missing');
    assert.deepEqual(body.install_commands, ['npm install playwright', 'npx playwright install chromium']);
    assert.match(body.next_step, /ask the user/i);
  });

  it('chromium browser missing → soft cost_available:false, browser-only install', async () => {
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({
        available: false,
        reason: 'chromium-missing',
        message: 'Chromium browser binary is not installed.',
        install: ['npx playwright install chromium'],
      }),
    });

    const res = await getEstimateCostHandler({ estimate_id: 'deadbeef' });
    const body = parseBody(res);
    assert.equal(body.cost_available, false);
    assert.equal(body.reason, 'chromium-missing');
    assert.deepEqual(body.install_commands, ['npx playwright install chromium']);
  });

  it('does not invoke the browser fetch when deps are unavailable', async () => {
    let called = false;
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({ available: false, reason: 'playwright-missing', message: 'x', install: ['npm install playwright'] }),
      fetchCostFromDOM: async () => { called = true; return {}; },
    });
    await getEstimateCostHandler({ estimate_id: 'deadbeef' });
    assert.equal(called, false, 'fetchCostFromDOM must be short-circuited by the preflight');
  });

  it('available → returns summary monthly_cost and per-row data', async () => {
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({ available: true }),
      fetchCostFromDOM: async (url) => ({
        monthlyCost: 48.02,
        rows: [{ service: 'Amazon RDS for SQL server', monthly: 48.02, config: 'db.t3.small' }],
        rowsTotal: 48.02,
        monthlyByService: new Map(),
        configByService: new Map(),
        _url: url,
      }),
    });

    const res = await getEstimateCostHandler({ estimate_id: 'abc123def' });
    assert.ok(!res.isError);
    const body = parseBody(res);
    assert.equal(body.cost_available, true);
    assert.equal(body.monthly_cost, 48.02);
    assert.equal(body.rows_total, 48.02);
    assert.equal(body.rows.length, 1);
    // Bare id is normalized to the standard calculator URL.
    assert.equal(body.source_url, 'https://calculator.aws/#/estimate?id=abc123def');
    assert.equal(body.note, undefined, 'no disagreement note when rows_total matches monthly_cost');
  });

  it('passes a full URL through unchanged (ESC domain preserved)', async () => {
    let seenUrl = null;
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({ available: true }),
      fetchCostFromDOM: async (url) => {
        seenUrl = url;
        return { monthlyCost: 10, rows: [], rowsTotal: null, monthlyByService: new Map(), configByService: new Map() };
      },
    });
    const escUrl = 'https://pricing.calculator.aws.eu/#/estimate?id=abc123';
    await getEstimateCostHandler({ estimate_id: escUrl });
    assert.equal(seenUrl, escUrl, 'a full URL must be forwarded verbatim, not rewritten');
  });

  it('flags a rows-vs-summary disagreement so per-row costs are not trusted', async () => {
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({ available: true }),
      fetchCostFromDOM: async () => ({
        monthlyCost: 399.55,
        rows: [
          { service: 'Amazon EC2', monthly: 284.55, config: null },
          { service: 'Amazon S3', monthly: 0, config: null },
        ],
        rowsTotal: 284.55,
        monthlyByService: new Map(),
        configByService: new Map(),
      }),
    });
    const res = await getEstimateCostHandler({ estimate_id: 'abc123' });
    const body = parseBody(res);
    assert.equal(body.monthly_cost, 399.55);
    assert.ok(body.note && /authoritative/i.test(body.note),
      'a disagreement note must be present when rows_total != monthly_cost');
  });

  it('surfaces a fetch failure as a tool error', async () => {
    const { getEstimateCostHandler } = freshServerWithDomCostStub({
      checkPlaywrightAvailability: () => ({ available: true }),
      fetchCostFromDOM: async () => { throw new Error('rehydration failed: Export disabled'); },
    });
    const res = await getEstimateCostHandler({ estimate_id: 'abc123' });
    assert.ok(res.isError, 'a genuine fetch failure (vs missing deps) is a hard error');
    assert.match(res.content[0].text, /Could not read estimate cost/);
  });
});
