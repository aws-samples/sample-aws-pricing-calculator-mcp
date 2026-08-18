const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalog, getEntry } = require('../lib/lint/catalog');

const catalog = loadCatalog(path.join(__dirname, '..', 'catalog', 'services'), { strict: false });

describe('runner catalog integration', () => {
  it('Lambda catalog entry has a complete minimalConfig the runner can use directly', () => {
    const e = getEntry(catalog, 'aWSLambda');
    assert.ok(e, 'aWSLambda missing from catalog');
    assert.ok(e.minimalConfig.region, 'minimalConfig.region required');
    assert.ok(e.minimalConfig.numberOfRequests, 'minimalConfig.numberOfRequests required');
  });

  it('AppSync catalog entry has sub-service-keyed minimalConfig', () => {
    const e = getEntry(catalog, 'awsAppSync');
    assert.ok(e);
    // Sub-service shape: top-level keys are child codes, each child has region.
    const childKeys = Object.keys(e.minimalConfig);
    assert.ok(childKeys.length > 0);
    const firstChild = e.minimalConfig[childKeys[0]];
    assert.ok(firstChild.region, `${childKeys[0]} child must have region`);
  });

  it('catalog has at least 5 entries (drift detection)', () => {
    assert.ok(catalog.size >= 5, `expected ≥5 catalog entries, got ${catalog.size}`);
  });
});
