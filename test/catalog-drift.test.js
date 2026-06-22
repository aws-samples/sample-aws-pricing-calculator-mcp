// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Catalog drift detector.
 *
 * Runs every catalog entry's `minimalConfig` (or each sub-service child's
 * config for sub-service-selector parents) through validateConfigKeys
 * against the live PCT. Catches:
 *
 *   1. Field-name typos in `required[].field` / `optional[].field` /
 *      `minimalConfig` keys — validateConfigKeys checks them against
 *      extractInputFields(definition).
 *   2. Value-shape errors (e.g. an object given to a numericInput
 *      field) — validateFieldValue per-field type check.
 *
 * The original catalog authoring workflow used the save+fetch round-trip
 * as its oracle, but the save API is a JSON blob store that accepts
 * arbitrary keys. So a typo'd field name round-tripped cleanly and the
 * entry got marked verified. This test catches that class of drift on
 * every CI run.
 *
 * Network-touching (loads manifest + per-service definitions). Skipped
 * when SKIP_NETWORK=1.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalog } = require('../lib/lint/catalog');
const { validateConfigKeys } = require('../lib/lint/validation');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog', 'services');
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

function isSubServiceShape(minimalConfig) {
  // Sub-service shape: top-level has no `region`, and each value is
  // an object that itself has `region`. Plain shape: top-level has
  // `region`. (Empty objects fall through to plain.)
  if (!minimalConfig || typeof minimalConfig !== 'object') return false;
  if (minimalConfig.region) return false;
  const values = Object.values(minimalConfig);
  if (values.length === 0) return false;
  return values.every(v => v && typeof v === 'object' && 'region' in v);
}

describe('catalog drift', () => {
  if (SKIP_NETWORK) {
    it.skip('SKIP_NETWORK=1; not running', () => {});
    return;
  }

  let catalog;
  before(() => {
    catalog = loadCatalog(CATALOG_DIR, { strict: true });
  });

  it('every catalog entry exists', () => {
    assert.ok(catalog.size >= 5, `expected ≥5 catalog entries, got ${catalog.size}`);
  });

  it('every minimalConfig validates against the live PCT', async () => {
    const failures = [];

    for (const entry of catalog.values()) {
      const { serviceCode, minimalConfig, status } = entry;
      // Only enforce against entries we claim to have verified — partial
      // and unverified entries are documentation-only by design.
      if (status !== 'verified') continue;

      try {
        if (isSubServiceShape(minimalConfig)) {
          // Validate each child's config against the CHILD'S serviceCode
          // (not the parent — the parent is a subServiceSelector and
          // doesn't have its own field set).
          for (const [childCode, childConfig] of Object.entries(minimalConfig)) {
            const r = await validateConfigKeys(childCode, childConfig, 'aws');
            if (r.error) {
              failures.push(`${serviceCode}/${childCode}: ${r.error}`);
            }
          }
        } else {
          const r = await validateConfigKeys(serviceCode, minimalConfig, 'aws');
          if (r.error) {
            failures.push(`${serviceCode}: ${r.error}`);
          }
        }
      } catch (err) {
        failures.push(`${serviceCode}: threw ${err.message}`);
      }
    }

    assert.deepEqual(
      failures,
      [],
      `Catalog drift detected — minimalConfig fields don't match live PCT.\n  ${failures.join('\n  ')}\n\nFix: re-run scripts/probe-catalog-entry.js for the affected service, or update the catalog entry's required[]/minimalConfig to match extractInputFields(definition).`,
    );
  });
});
