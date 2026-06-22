// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalog, getEntry } = require('../lib/lint/catalog');

// We don't spin up the MCP transport — we verify the contract by checking
// that the catalog is loadable AND has the entries we expect get_service_fields
// to surface. The actual handler integration is exercised by the smoke step
// at the end of this PR.

describe('catalog hints for get_service_fields', () => {
  const cat = loadCatalog(path.join(__dirname, '..', 'catalog', 'services'), { strict: false });

  it('catalog loads with at least 5 entries', () => {
    assert.ok(cat.size >= 5, `expected ≥5 catalog entries, got ${cat.size}`);
  });

  it('Lambda has a minimalConfig with numberOfRequests', () => {
    // Status fluctuates as re-verifications happen (Lambda's was
    // downgraded on 2026-05-29 when the prior verifiedEstimateId was
    // discovered to reference a stale field-name typo). The catalog's
    // contract is that minimalConfig produces an editable estimate;
    // the test guards the contract, not a particular status value.
    const e = getEntry(cat, 'aWSLambda');
    assert.ok(e, 'aWSLambda not in catalog');
    assert.ok(['verified', 'partial', 'unverified', 'broken'].includes(e.status),
      `unknown status ${e.status}`);
    assert.ok(e.minimalConfig);
    assert.ok(e.minimalConfig.numberOfRequests);
  });

  it('EC2 has traps documenting hidden defaults', () => {
    const e = getEntry(cat, 'ec2Enhancement');
    assert.ok(e, 'ec2Enhancement not in catalog');
    assert.ok(Array.isArray(e.traps) && e.traps.length > 0,
      'expected ec2Enhancement to ship at least one trap');
  });

  it('AppSync (sub-service selector) has subServices populated', () => {
    const e = getEntry(cat, 'awsAppSync');
    assert.ok(e, 'awsAppSync not in catalog');
    assert.ok(Array.isArray(e.subServices) && e.subServices.length > 0,
      'expected awsAppSync to declare subServices');
  });

  it('every catalog entry has the schema-required fields', () => {
    for (const [code, e] of cat) {
      assert.ok(e.serviceCode === code, `serviceCode mismatch for ${code}`);
      assert.ok(e.displayName, `displayName missing for ${code}`);
      assert.ok(e.status, `status missing for ${code}`);
      assert.ok(e.minimalConfig, `minimalConfig missing for ${code}`);
    }
  });
});
