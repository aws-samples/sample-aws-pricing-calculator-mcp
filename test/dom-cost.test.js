// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for lib/dom-cost.js row parsing.
 *
 * Strategy: parseDetailRows is pure, so the row-shape assumptions are
 * asserted against fixture cell text rather than a live calculator page.
 * No Playwright, no network, so these run under SKIP_NETWORK=1 with the
 * rest of the hermetic suite.
 *
 * Fixtures are taken from real rendered estimates, including the two
 * cases that motivated `rows`: duplicate row labels, and a row that
 * renders $0 while the summary total already includes its cost (issue
 * #13).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseDetailRows, parseUsd } = require('../lib/dom-cost');

// Rendered row layout: Service | Upfront | Monthly | Description | Region | Config
const row = (label, monthly, { upfront = '0.00 USD', desc = '', region = 'US East (N. Virginia)', config = '-' } = {}) =>
  [label, upfront, monthly, desc, region, config];

describe('parseDetailRows', () => {
  it('reads label, monthly, and config from a well-formed row', () => {
    const rows = parseDetailRows([
      row('Amazon EC2', '105.85 USD', { desc: 'App tier', config: 'Tenancy (Shared)' }),
    ]);
    assert.deepEqual(rows, [
      { service: 'Amazon EC2', monthly: 105.85, config: 'Tenancy (Shared)' },
    ]);
  });

  it('keeps every row when two rows share a label', () => {
    // Four ec2Enhancement entries all render as "Amazon EC2". Keyed by
    // label, only the last survives; `rows` must keep all of them.
    const rows = parseDetailRows([
      row('Amazon EC2', '105.85 USD', { desc: '2x c7g.large' }),
      row('Amazon EC2', '178.70 USD', { desc: '3x m7g.large' }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.monthly), [105.85, 178.70]);
  });

  it('preserves document order', () => {
    const rows = parseDetailRows([
      row('C - Storage', '115.00 USD'),
      row('A - Compute', '105.85 USD'),
      row('B - Workers', '178.70 USD'),
    ]);
    assert.deepEqual(rows.map(r => r.service), ['C - Storage', 'A - Compute', 'B - Workers']);
  });

  it('reports a stale $0 row rather than dropping it, so callers can detect an incomplete read', () => {
    // Issue #13: a service row renders $0 until "Update estimate" forces
    // a recompute, while the summary total is already correct. The row
    // has to survive parsing for the rowsTotal-vs-monthlyCost comparison
    // to catch it.
    const rows = parseDetailRows([
      row('Amazon EC2', '284.55 USD'),
      row('Amazon Simple Storage Service (S3)', '0.00 USD'),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].monthly, 0);

    const rowsTotal = rows.reduce((sum, r) => sum + r.monthly, 0);
    const summaryMonthlyCost = 399.55; // includes the S3 line at 115.00
    assert.notEqual(rowsTotal, summaryMonthlyCost);
  });

  it('normalizes an empty config cell to null', () => {
    const [parsed] = parseDetailRows([row('AWS Lambda', '12.50 USD', { config: '-' })]);
    assert.equal(parsed.config, null);
  });

  it('anchors on the first USD cell instead of a fixed column index', () => {
    // Same data with an extra leading column. The label is still the
    // cell before the first USD cell.
    const rows = parseDetailRows([
      ['', 'Amazon EKS', '0.00 USD', '219.00 USD', 'control plane', 'US East (N. Virginia)', '-'],
    ]);
    assert.deepEqual(rows, [{ service: 'Amazon EKS', monthly: 219, config: null }]);
  });

  it('skips the header row', () => {
    assert.deepEqual(
      parseDetailRows([['Service', 'Upfront', 'Monthly', 'Description', 'Region', 'Config summary']]),
      [],
    );
  });

  it('skips rows with fewer than six cells', () => {
    assert.deepEqual(parseDetailRows([['Amazon EC2', '0.00 USD', '10.00 USD']]), []);
  });

  it('skips a row whose first cell is already a USD value, since it has no label', () => {
    assert.deepEqual(
      parseDetailRows([['12.00 USD', '3.00 USD', 'a', 'b', 'c', 'd']]),
      [],
    );
  });

  it('skips a row whose monthly cell does not parse', () => {
    assert.deepEqual(
      parseDetailRows([row('Amazon EC2', 'n/a', { upfront: '0.00 USD', config: 'USD' })]),
      [],
    );
  });

  it('tolerates a non-array entry', () => {
    assert.deepEqual(parseDetailRows([null, undefined, 'nope']), []);
  });

  it('returns an empty array for no input rows', () => {
    assert.deepEqual(parseDetailRows([]), []);
  });
});

describe('parseUsd', () => {
  it('parses a thousands-separated amount', () => {
    assert.equal(parseUsd('1,857.98 USD'), 1857.98);
  });

  it('parses zero', () => {
    assert.equal(parseUsd('0.00 USD'), 0);
  });

  it('returns null for a non-string', () => {
    assert.equal(parseUsd(undefined), null);
  });

  it('returns null when there is no number', () => {
    assert.equal(parseUsd('USD'), null);
  });
});
