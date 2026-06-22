// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Convenience wrapper around lib/can-rehydrate. Loads the manifest,
 * fetches every per-service definition referenced by the saved blob
 * (parent + sub-service children), and runs canRehydrate.
 *
 * Network-touching — kept separate from lib/can-rehydrate.js so the
 * pure linter's tests can stay offline.
 */

const { canRehydrate } = require('./can-rehydrate');

function collectServiceCodes(savedBlob) {
  const codes = new Set();
  for (const svc of iterateBlobServices(savedBlob)) {
    if (svc.serviceCode) codes.add(svc.serviceCode);
  }
  return codes;
}

// Yield every service the blob carries (top-level, group, and
// sub-service children) — flat, for code/region collection.
function* iterateBlobServices(savedBlob) {
  const tops = Object.values(savedBlob.services || {});
  for (const group of Object.values(savedBlob.groups || {})) {
    tops.push(...Object.values(group.services || {}));
  }
  for (const svc of tops) {
    yield svc;
    for (const child of (svc.subServices || [])) yield child;
  }
}

// Find the first columnFormIPM field carrying a mappingDefinitionName in
// a service definition — the field that drives the selector-aggregation
// fetch for the tuple-validity predicate.
function findColumnFormField(definition) {
  let found = null;
  const walk = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (n.subType === 'columnFormIPM' && n.mappingDefinitionName) { found = n; return; }
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(definition);
  return found;
}

async function canRehydrateFetch({ savedBlob, partition = 'aws', catalog } = {}) {
  if (!savedBlob || typeof savedBlob !== 'object') {
    throw new TypeError('canRehydrateFetch requires a savedBlob object');
  }
  // Lazy-require to allow test-time module replacement via require.cache.
  // nosemgrep: lazy-load-module
  const awsClient = require('../aws/aws-client');
  const manifest = await awsClient.loadManifest(partition);
  const codes = collectServiceCodes(savedBlob);
  const perServiceDefinitions = new Map();
  for (const code of codes) {
    // fetchServiceDefinition throws on HTTP non-200 (and on non-manifest
    // codes). Per-code try/catch so one bad service doesn't abort the
    // whole lint — the linter then surfaces it as 'unknown' (definition
    // unavailable) rather than crashing.
    try {
      const def = await awsClient.fetchServiceDefinition(manifest, code, partition);
      if (def) perServiceDefinitions.set(code, def);
    } catch {
      // Leave the code out of the map — canRehydrate will report
      // status: 'unknown' for it.
    }
  }
  // Region list is best-effort — partition-specific. Skipping when
  // unreachable matches validation.js's preflight behavior, so the
  // lint matches the add-time check.
  let regionList = null;
  try {
    regionList = await awsClient.loadRegionList(partition);
  } catch {
    // unreachable — proceed without; checkInvalidRegion is a no-op.
  }

  // Selector-tuple aggregations are best-effort, same as regionList.
  // For each columnFormIPM service in the blob, fetch the calculator's
  // primary-selector-aggregations.json for that service+region. Any
  // failure leaves the service out of the map → the tuple predicate is
  // a no-op for it. Wrapped in try/catch so a fetch error never aborts
  // the lint.
  const aggregations = new Map();
  try {
    for (const svc of iterateBlobServices(savedBlob)) {
      if (!svc.serviceCode || aggregations.has(svc.serviceCode)) continue;
      const def = perServiceDefinitions.get(svc.serviceCode);
      if (!def) continue;
      const columnFormField = findColumnFormField(def);
      if (!columnFormField) continue;
      // Use the region CODE (always present on every service node, including
      // sub-service children that lack a regionName label). loadSelectorAggregations
      // resolves the code → aggregation Location label internally.
      const region = svc.region;
      if (!region) continue;
      try {
        const tuples = await awsClient.loadSelectorAggregations(def, columnFormField, region);
        if (tuples) aggregations.set(svc.serviceCode, tuples);
      } catch {
        // leave this service out — predicate no-ops for it
      }
    }
  } catch {
    // any structural error — proceed without aggregations
  }

  return canRehydrate({ savedBlob, manifest, perServiceDefinitions, catalog, regionList, aggregations });
}

module.exports = { canRehydrateFetch, collectServiceCodes };
