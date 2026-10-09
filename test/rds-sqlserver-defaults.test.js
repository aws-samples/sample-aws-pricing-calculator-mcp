// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Regression guard for GitHub issue #44:
 *   amazonRDSForSQLServer estimates with GP3 storage saved WITHOUT the
 *   gp3Iops / gp3Throughput companion fields rendered a NEGATIVE monthly
 *   cost (-35.98 USD instead of 48.02 USD).
 *
 * Root cause: when storageType is 'General Purpose-GP3' the calculator
 * silently requires gp3Iops (baseline 3000) and gp3Throughput (baseline
 * 125 MiBps). The manifest does NOT mark them validations.required, so
 * neither get_service_fields nor the rehydration lint flagged their
 * absence — and the pricing engine then charged for (0 - 3000) IOPS and
 * (0 - 125) MiBps, driving the whole estimate negative.
 *
 * NOT the bug: estimateFor: 'rdsForOracle'. That is the shared/legacy
 * template id the calculator itself uses for RDS for SQL Server; a
 * correct manual estimate carries the same value.
 *
 * Fix: the curated catalog entry declares these companions under
 * `defaultFields`, which lib/mcp/handler-helpers.js#applyDefaultFields
 * injects into any config that omits them (non-destructively) before the
 * estimate is saved.
 *
 * Offline — asserts the shipped catalog entry's contract and the pure
 * injection helper's behavior. The live 48.02 round-trip is covered by
 * scripts/validate-verified-catalog.js and test/catalog-drift.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalog, getEntry } = require('../lib/lint/catalog');
const { applyDefaultFields } = require('../lib/mcp/handler-helpers');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog', 'services');
const GP3_IOPS = { value: '3000' };
const GP3_THROUGHPUT = { value: '125', unit: 'mbps' };

// The exact config from issue #44 — GP3 selected, companions omitted.
function rawIssueConfig() {
  return {
    region: 'ap-northeast-1',
    description: 'Sizing-01',
    columnFormIPM: {
      value: [{
        'Number of Nodes': { value: '1' },
        'Instance Type': { value: 'db.t3.small' },
        'undefined': { value: { unit: '100', selectedId: '%Utilized/Month' } },
        'Deployment Option': { value: 'Single-AZ' },
        'License Model': { value: 'License included' },
        'Database Edition': { value: 'Express' },
        'TermType': { value: 'OnDemand' },
      }],
    },
    optimize: '0',
    createRDSProxy: '0',
    storageType: 'General Purpose-GP3',
    storageAmount: { value: '20', unit: 'gb|NA' },
    DatabaseInsightsSelected: '0',
  };
}

describe('issue #44 — RDS for SQL Server GP3 companion fields', () => {
  const catalog = loadCatalog(CATALOG_DIR, { strict: true });
  const entry = getEntry(catalog, 'amazonRDSForSQLServer');

  it('ships a verified catalog entry on the shared rdsForOracle template', () => {
    assert.ok(entry, 'amazonRDSForSQLServer catalog entry must exist');
    assert.equal(entry.status, 'verified');
    assert.equal(entry.templateId, 'rdsForOracle',
      "estimateFor 'rdsForOracle' is the correct shared template id for SQL Server, not a mis-mapping");
  });

  it('declares gp3Iops / gp3Throughput defaults in the saved-blob shape', () => {
    assert.ok(entry.defaultFields, 'entry must declare defaultFields');
    assert.deepEqual(entry.defaultFields.gp3Iops, GP3_IOPS);
    assert.deepEqual(entry.defaultFields.gp3Throughput, GP3_THROUGHPUT);
  });

  it('injects the GP3 companions when a config omits them', () => {
    const merged = applyDefaultFields(rawIssueConfig(), entry);
    assert.deepEqual(merged.gp3Iops, GP3_IOPS,
      'gp3Iops must be injected so the GP3 storage line does not price negative');
    assert.deepEqual(merged.gp3Throughput, GP3_THROUGHPUT,
      'gp3Throughput must be injected alongside gp3Iops');
    // Injection must not disturb the rest of the config.
    assert.equal(merged.storageType, 'General Purpose-GP3');
    assert.equal(merged.storageAmount.value, '20');
  });

  it('does not override caller-supplied companion values', () => {
    const config = rawIssueConfig();
    config.gp3Iops = { value: '12000' };
    config.gp3Throughput = { value: '500', unit: 'mbps' };
    const merged = applyDefaultFields(config, entry);
    assert.deepEqual(merged.gp3Iops, { value: '12000' },
      'caller-supplied gp3Iops must win over the catalog default');
    assert.deepEqual(merged.gp3Throughput, { value: '500', unit: 'mbps' },
      'caller-supplied gp3Throughput must win over the catalog default');
  });
});
