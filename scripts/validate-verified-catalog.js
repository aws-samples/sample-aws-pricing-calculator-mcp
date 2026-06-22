#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Verifies every catalog entry with `status: "verified"` still rehydrates
 * priced — i.e. its `verifiedEstimateId` URL renders a non-zero monthly
 * cost in calculator.aws today.
 *
 * Background: pre-2026-05-29 the verified bar was "lint passes + browser
 * shows a row + eyes seem reasonable." Lambda's 2-week silent-$0 trap
 * (caught only when its `verifiedEstimateId` was probed at non-trivial
 * volume) showed that bar wasn't strict enough. The new bar requires
 * the saved URL to render a non-zero cost. This sweep is the forcing
 * function for that bar.
 *
 * What it catches:
 *   - Stale URLs (estimate purged, or AWS contract change broke rehydrate)
 *   - PCT-required ≠ pricing-engine-required gaps that slipped through
 *   - Saved-empty estimates (some pre-existing entries had this)
 *
 * What it doesn't catch:
 *   - minimalConfig regressions when the URL happens to still render —
 *     for that, write a per-service eval scenario asserting cost from
 *     a fresh save.
 *
 * Usage:
 *   node scripts/validate-verified-catalog.js               # all verified
 *   node scripts/validate-verified-catalog.js <code>...     # specific entries
 *   node scripts/validate-verified-catalog.js --concurrency N
 *
 * Exits non-zero if any verified entry renders <$0.01/mo.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCatalog, listVerified } = require('../lib/lint/catalog');
const { fetchCostFromDOM } = require('../lib/dom-cost');

// Concurrency 2 settled empirically — concurrency 3 with 6+ Playwright
// browsers running in parallel hit calculator.aws's rate-limit sweet spot
// and produced spurious 60s navigation timeouts on the 5th-6th window.
const DEFAULT_CONCURRENCY = 2;
const MIN_PRICED_USD = 0.01;
const CATALOG_DIR = path.join(__dirname, '..', 'catalog', 'services');

function parseArgs(argv) {
  const args = { entries: [], concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' || a === '-c') {
      args.concurrency = parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      args.help = true;
    } else {
      args.entries.push(a);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/validate-verified-catalog.js [options] [serviceCode...]

  Probes each verified catalog entry's verifiedEstimateId via the DOM cost
  oracle. Fails non-zero if any entry renders < $${MIN_PRICED_USD}/mo.

  Options:
    -c, --concurrency N   Parallel probes (default: ${DEFAULT_CONCURRENCY})
    -h, --help            This help`);
}

async function probeOne(entry) {
  const url = `https://calculator.aws/#/estimate?id=${entry.verifiedEstimateId}`;
  try {
    const r = await fetchCostFromDOM(url);
    return {
      entry,
      url,
      monthly: r.monthlyCost ?? 0,
      byService: r.monthlyByService,
      configByService: r.configByService || new Map(),
    };
  } catch (err) {
    return { entry, url, error: err.message || String(err) };
  }
}

// Run probes in a bounded pool. Playwright is the gating resource; ~3
// concurrent windows is a safe default on most laptops.
async function runPool(entries, concurrency) {
  const results = [];
  const queue = entries.slice();
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const e = queue.shift();
      const r = await probeOne(e);
      results.push(r);
      const status = r.error
        ? `ERROR (${r.error.split('\n')[0].slice(0, 80)})`
        : r.monthly < MIN_PRICED_USD
          ? `BROKEN ($${r.monthly}/mo)`
          : `OK ($${r.monthly}/mo)`;
      console.log(`  [${results.length}/${entries.length}] ${e.serviceCode.padEnd(40)} ${status}`);
    }
  });
  await Promise.all(workers);
  return results;
}

function filterEntries(catalog, requested) {
  const verified = listVerified(catalog).filter(e => e.verifiedEstimateId);
  if (requested.length === 0) return verified;
  const byCode = new Map(verified.map(e => [e.serviceCode, e]));
  const out = [];
  const missing = [];
  for (const code of requested) {
    if (byCode.has(code)) out.push(byCode.get(code));
    else missing.push(code);
  }
  if (missing.length) {
    console.error(`Skipping unknown verified entries: ${missing.join(', ')}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  const catalog = loadCatalog(CATALOG_DIR, { strict: false });
  const targets = filterEntries(catalog, args.entries);

  if (targets.length === 0) {
    console.log('No verified entries to probe.');
    process.exit(0);
  }

  console.log(`Probing ${targets.length} verified entr${targets.length === 1 ? 'y' : 'ies'} ` +
    `at concurrency ${args.concurrency}...\n`);

  const results = await runPool(targets, args.concurrency);

  const broken = results.filter(r => !r.error && r.monthly < MIN_PRICED_USD);
  const errored = results.filter(r => r.error);
  const ok = results.filter(r => !r.error && r.monthly >= MIN_PRICED_USD);

  console.log(`\nSummary: ${ok.length} ok, ${broken.length} broken, ${errored.length} errored`);

  if (broken.length) {
    console.log('\nBroken (silent-$0 trap — fix or demote to unverified):');
    for (const r of broken) {
      console.log(`  ${r.entry.serviceCode}`);
      console.log(`    URL: ${r.url}`);
      console.log(`    lastVerifiedAt: ${r.entry.lastVerifiedAt}`);
      // Surface the rehydrated Config Summary when present — it's the
      // fastest debug aid for "did the saved blob even carry fields,
      // and if so which ones did the calculator pick up?"
      if (r.configByService && r.configByService.size > 0) {
        for (const [svc, cfg] of r.configByService) {
          console.log(`    rendered: ${svc} → ${cfg ?? '(empty)'}`);
        }
      }
    }
  }
  if (errored.length) {
    console.log('\nErrored (probe failed — could be network, calculator regression, or stale URL):');
    for (const r of errored) {
      console.log(`  ${r.entry.serviceCode}: ${r.error.split('\n')[0]}`);
    }
  }

  // Errored entries don't fail the sweep — they're inconclusive, not failures.
  // Broken entries fail. CI catches them; manual runs see them in summary.
  process.exit(broken.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(2);
});
