// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for extractCostsFromSavedBlob (issue #47).
 *
 * get_estimate_cost re-shares an estimate through the calculator UI so the
 * calculator persists computed costs, then reads the saved blob's costs
 * with this pure extractor. Validated against a real costed read-API
 * response (test/fixtures/saved-with-costs.json — a 12-group estimate) and
 * a synthetic ungrouped/upfront case. Offline; no browser, no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { extractCostsFromSavedBlob } = require('../lib/aws/aws-client');

const grouped = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'saved-with-costs.json'), 'utf8'),
);

describe('extractCostsFromSavedBlob', () => {
  it('reads totals and derives the 12-month total from a real grouped blob', () => {
    const r = extractCostsFromSavedBlob(grouped);
    assert.equal(r.monthlyCost, 199.98);
    assert.equal(r.upfrontCost, 0);
    assert.equal(r.twelveMonthCost, 2399.76, '12-month = upfront + 12 x monthly');
    assert.ok(r.pricingAsOf, 'pricing_as_of comes from metaData.createdOn');
    assert.equal(r.rowsComplete, true);
  });

  it('flattens every group line with its own cost (no pagination)', () => {
    const r = extractCostsFromSavedBlob(grouped);
    assert.equal(r.rows.length, 12, 'all 12 group lines present');
    assert.equal(r.rows[0].group, 'Group 01');
    assert.equal(r.rows[0].service, 'Amazon RDS for PostgreSQL');
    assert.equal(r.rows[0].monthly, 15.93);
    assert.ok(r.rows[0].config, 'per-line configSummary is carried');
    assert.ok(Math.abs(r.rowsTotal - r.monthlyCost) < 0.01,
      `rowsTotal ${r.rowsTotal} should equal monthlyCost ${r.monthlyCost}`);
  });

  it('handles an ungrouped blob with an upfront commitment', () => {
    const r = extractCostsFromSavedBlob({
      services: {
        's1': {
          serviceCode: 'ec2Enhancement', serviceName: 'Amazon EC2',
          regionName: 'US East (N. Virginia)', description: 'web',
          configSummary: 'm7g.large', serviceCost: { monthly: 10, upfront: 120 },
        },
      },
      groups: {},
      totalCost: { monthly: 10, upfront: 120 },
      metaData: { createdOn: '2026-10-16T00:00:00.000Z' },
    });
    assert.equal(r.monthlyCost, 10);
    assert.equal(r.upfrontCost, 120);
    assert.equal(r.twelveMonthCost, 240, '12-month includes the whole upfront (120 + 12*10)');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].group, null);
    assert.equal(r.rows[0].upfront, 120);
  });

  it('is null-safe on an empty/garbage blob', () => {
    const r = extractCostsFromSavedBlob(null);
    assert.equal(r.monthlyCost, null);
    assert.equal(r.upfrontCost, null);
    assert.equal(r.twelveMonthCost, null);
    assert.deepEqual(r.rows, []);
    assert.equal(r.rowsTotal, null);
  });
});
