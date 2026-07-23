const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalog, listVerified } = require('../lib/catalog');
const EstimateBuilder = require('../lib/estimate-builder');
const { fetchEstimate } = require('../lib/aws-client');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog', 'services');
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

async function fetchWithRetry(id, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try { return await fetchEstimate(id); }
    catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

function buildFromMinimal(serviceCode, entry) {
  const eb = new EstimateBuilder(`Catalog roundtrip: ${serviceCode}`);
  // Sub-service parents have minimalConfig keyed by sub-service code.
  if (entry.subServices && entry.subServices.length > 0) {
    for (const [subCode, cfg] of Object.entries(entry.minimalConfig)) {
      eb.addService(subCode, cfg);
    }
  } else {
    eb.addService(serviceCode, entry.minimalConfig);
  }
  return eb;
}

describe('catalog roundtrip', () => {
  if (SKIP_NETWORK) {
    it.skip('SKIP_NETWORK=1; not running', () => {});
    return;
  }

  let catalog;
  before(() => {
    catalog = loadCatalog(CATALOG_DIR, { strict: true });
  });

  // Each verified entry gets its own test, dynamically generated.
  it('has at least one verified entry to test', () => {
    const verified = listVerified(catalog);
    assert.ok(verified.length > 0, 'catalog has no verified entries — nothing to test');
  });

  // Use a single it() that loops, so failures clearly identify which service broke.
  it('every verified entry round-trips with expected shape', async () => {
    const verified = listVerified(catalog);
    const failures = [];

    for (const entry of verified) {
      try {
        const eb = buildFromMinimal(entry.serviceCode, entry);
        const exported = await eb.export();
        const fetched = await fetchWithRetry(exported.estimateId);

        // Shape assertions — all entries must have at least one service entry
        // post-fetch.
        const services = Object.values(fetched.services || {});
        if (services.length === 0) {
          failures.push(`${entry.serviceCode}: fetched estimate has no services`);
          continue;
        }

        const top = services[0];

        // Sub-service parent: assert subServices array shape and child count.
        if (entry.subServices && entry.subServices.length > 0) {
          if (!Array.isArray(top.subServices) || top.subServices.length === 0) {
            failures.push(`${entry.serviceCode}: expected subServices, got ${JSON.stringify(top.subServices)}`);
            continue;
          }
        } else {
          // Plain service: assert serviceCode + estimateFor match the entry.
          //
          // Some catalog entries are `subService`-typed in the manifest even
          // though the catalog models them as plain (single-service) configs
          // (e.g. applicationLoadBalancer, NAT/Transit Gateway). For those the
          // calculator wraps the service in a PARENT envelope on save, so the
          // top-level entry carries the parent's serviceCode/estimateFor and the
          // real service is in top.subServices[]. Match against the top entry OR
          // any of its children so the assertion tracks the service the entry
          // actually declares, not the synthetic parent.
          const candidates = [top, ...(Array.isArray(top.subServices) ? top.subServices : [])];
          const codeOk = candidates.some(c => c.serviceCode === entry.serviceCode);
          if (!codeOk) {
            failures.push(`${entry.serviceCode}: serviceCode mismatch (got ${candidates.map(c => c.serviceCode).join(', ')})`);
          }
          if (entry.templateId) {
            const match = candidates.find(c => c.serviceCode === entry.serviceCode) || top;
            if (match.estimateFor !== entry.templateId) {
              failures.push(`${entry.serviceCode}: estimateFor mismatch (expected ${entry.templateId}, got ${match.estimateFor})`);
            }
          }
        }
      } catch (e) {
        failures.push(`${entry.serviceCode}: threw ${e.message}`);
      }
    }

    assert.deepEqual(failures, [], `Round-trip failures:\n  ${failures.join('\n  ')}`);
  });
});
