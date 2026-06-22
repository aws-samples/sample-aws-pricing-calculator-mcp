#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Falsifiable test of "do we need a catalog entry for service X?"
 *
 * For each un-cataloged active service, builds a config from PCT
 * surfaceability alone (no catalog hints), saves it via the same path
 * the agent would use, and probes the saved URL via the DOM cost
 * oracle. Classifies each service as:
 *
 *   pct-sufficient   — saved cleanly, rendered priced cost
 *                      → catalog entry NOT needed
 *   needs-catalog    — saved/lint clean but rendered $0
 *                      → catalog entry NEEDED (PCT alone misleads)
 *   lint-fail        — preflight refused (read-only verdict)
 *                      → catalog entry NEEDED (which predicate failed?)
 *   save-fail        — save API refused
 *                      → catalog entry NEEDED (validation/shape issue)
 *   skip             — sub-service-selector parent / inactive / has
 *                      catalog already / columnFormIPM (matrix shape
 *                      not auto-inferable from PCT)
 *
 * Two volume modes:
 *   default     — value '1' for numeric/frequency. Some free-tier
 *                 services will render $0 even though PCT was correct.
 *   --high      — value '1000000' for numeric/frequency. Pushes past
 *                 most free tiers. Run BOTH for confidence: default
 *                 catches "free tier zero" false negatives, --high
 *                 catches "PCT structurally sufficient" true positives.
 *
 * Usage:
 *   node scripts/diagnose-service.js                    # all un-cataloged
 *   node scripts/diagnose-service.js <code>...          # specific services
 *   node scripts/diagnose-service.js --high             # high-volume probe
 *   node scripts/diagnose-service.js --concurrency N    # default 2
 *   node scripts/diagnose-service.js --limit N          # cap services probed
 *   node scripts/diagnose-service.js --out PATH         # results dir
 *
 * Exit code: always 0 — the diagnostic doesn't gate anything.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadManifest, fetchServiceDefinition } = require('../lib/aws/aws-client');
const { suggestConfigFromPCT } = require('../lib/aws/pct-config');
const { fetchCostFromDOM } = require('../lib/dom-cost');
const EstimateBuilder = require('../lib/aws/estimate-builder');

const REPO_ROOT = path.join(__dirname, '..');
const CATALOG_DIR = path.join(REPO_ROOT, 'catalog', 'services');
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'docs', 'diagnose');
const MIN_PRICED_USD = 0.01;

function parseArgs(argv) {
  const args = {
    services: [],
    concurrency: DEFAULT_CONCURRENCY,
    highVolume: false,
    limit: null,
    outDir: DEFAULT_OUT_DIR,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' || a === '-c') args.concurrency = parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY;
    else if (a === '--high' || a === '--high-volume') args.highVolume = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || null;
    else if (a === '--out') args.outDir = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); args.help = true; }
    else args.services.push(a);
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/diagnose-service.js [options] [serviceCode...]

  For each un-cataloged active service, build a config from PCT alone,
  save, probe via DOM cost oracle, classify. Writes a markdown report
  + JSON to docs/diagnose/.

  Options:
    --high                Use 1000000 instead of 1 for numeric/frequency
                          values. Pushes past free tier so PCT-structurally-
                          sufficient services don't falsely show as $0.
    -c, --concurrency N   Parallel probes (default: ${DEFAULT_CONCURRENCY})
    --limit N             Cap services probed (for smoke tests)
    --out PATH            Output dir (default: ${DEFAULT_OUT_DIR})
    -h, --help            This help`);
}

function listCatalogedCodes() {
  const out = new Set();
  if (!fs.existsSync(CATALOG_DIR)) return out;
  for (const f of fs.readdirSync(CATALOG_DIR)) {
    if (f.endsWith('.json')) out.add(f.replace(/\.json$/, ''));
  }
  return out;
}

function classifyTargets(manifest, catalogedCodes, requested) {
  // Returns { targets: [{key, name, subType?}], skipped: [{code, reason}] }
  const targets = [];
  const skipped = [];
  const considered = requested.length > 0
    ? requested
    : [...manifest.keys()];

  for (const code of considered) {
    const svc = manifest.get(code);
    if (!svc) { skipped.push({ code, reason: 'not in manifest' }); continue; }
    if (svc.isActive === 'false') { skipped.push({ code, reason: 'isActive=false (use redirect, not catalog)' }); continue; }
    if (svc.subType === 'subServiceSelector') { skipped.push({ code, reason: 'subServiceSelector parent — needs sub-service shape' }); continue; }
    if (catalogedCodes.has(code)) { skipped.push({ code, reason: 'already cataloged' }); continue; }
    targets.push({ key: svc.key, name: svc.name, subType: svc.subType });
  }
  return { targets, skipped };
}

async function diagnoseOne(target, options) {
  const { highVolume } = options;
  const result = {
    serviceCode: target.key,
    serviceName: target.name,
    classification: null,
    detail: null,
    monthlyCost: null,
    fieldsSet: 0,
    fieldsSkipped: 0,
    durationMs: 0,
    url: null,
  };
  const start = Date.now();
  try {
    const manifest = await loadManifest('aws');
    const def = await fetchServiceDefinition(manifest, target.key, 'aws');
    if (!def) {
      result.classification = 'skip';
      result.detail = 'no PCT definition (manifest references it but data fetch returned null)';
      result.durationMs = Date.now() - start;
      return result;
    }

    const { config, surfaceable, skipped: skippedFields } = suggestConfigFromPCT(def, { highVolume });
    result.fieldsSet = surfaceable.length;
    result.fieldsSkipped = skippedFields.length;

    // columnFormIPM and similar opaque shapes — caller must catalog
    if (skippedFields.length > 0 && surfaceable.length === 0) {
      result.classification = 'needs-catalog';
      result.detail = `auto-config blocked: ${skippedFields.map(s => s.id).join(', ')} (${skippedFields[0].reason})`;
      result.durationMs = Date.now() - start;
      return result;
    }

    // Edge case: a service with zero surfaceable fields. Skipping with
    // a reason — we can't meaningfully test "does PCT-only price?" if
    // there's nothing PCT tells us to send.
    if (surfaceable.length === 0) {
      result.classification = 'skip';
      result.detail = 'PCT exposes no surfaceable fields (everything conditional/hidden — needs human judgement)';
      result.durationMs = Date.now() - start;
      return result;
    }

    // Build via the same EstimateBuilder the MCP server uses — exercise
    // the real save path including ec2Enhancement transforms etc.
    const eb = new EstimateBuilder(`diag-${target.key}`, 'aws');
    eb.addService(target.key, config);
    const saved = await eb.export();
    result.url = saved.shareableUrl;

    // Probe the saved URL via the DOM oracle.
    let cost;
    try {
      cost = await fetchCostFromDOM(saved.shareableUrl);
    } catch (err) {
      result.classification = 'save-fail';
      result.detail = `DOM probe error: ${err.message || String(err)}`.slice(0, 200);
      result.durationMs = Date.now() - start;
      return result;
    }

    result.monthlyCost = cost.monthlyCost ?? 0;
    if (result.monthlyCost >= MIN_PRICED_USD) {
      result.classification = 'pct-sufficient';
      result.detail = `${surfaceable.length} fields auto-set, $${result.monthlyCost}/mo`;
    } else {
      result.classification = 'needs-catalog';
      // Was the save itself read-only? configByService gives us hints.
      const configRow = cost.configByService ? [...cost.configByService.values()][0] : null;
      result.detail = configRow
        ? `saved + rendered $0; calculator surfaced: ${configRow.slice(0, 120)}`
        : `saved + rendered $0; calculator's Config Summary is empty`;
    }
  } catch (err) {
    // Hits include validateConfigKeys errors, save API rejections,
    // network blips. All point at "agent would fail without catalog
    // hints" → needs-catalog. We separate save-fail from lint-fail by
    // looking at the message shape; both classifications mean the
    // catalog needs to grow.
    const msg = (err.message || String(err)).slice(0, 200);
    if (/Invalid (field IDs|values)|read-only|HTTP 400|400 Bad Request/i.test(msg)) {
      result.classification = 'lint-fail';
    } else {
      result.classification = 'save-fail';
    }
    result.detail = msg;
  }
  result.durationMs = Date.now() - start;
  return result;
}

async function runPool(targets, concurrency, options) {
  const results = [];
  const queue = targets.slice();
  const total = targets.length;
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const t = queue.shift();
      const r = await diagnoseOne(t, options);
      results.push(r);
      const tag = r.classification.padEnd(15);
      const cost = r.monthlyCost != null ? `$${r.monthlyCost}/mo`.padStart(11) : '           ';
      console.log(`  [${results.length.toString().padStart(3)}/${total}] ${tag} ${cost}  ${r.serviceCode}`);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.classification] = (counts[r.classification] || 0) + 1;
  return counts;
}

function renderMarkdown(results, summary, opts, skipped) {
  const total = results.length;
  const sortedClass = ['pct-sufficient', 'needs-catalog', 'lint-fail', 'save-fail', 'skip'];
  const lines = [];
  lines.push(`# PCT-only diagnostic — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Probes whether each un-cataloged service can be priced from PCT alone (no catalog hints).`);
  lines.push('');
  lines.push(`- Probed: ${total}`);
  lines.push(`- Volume: ${opts.highVolume ? 'high (1000000)' : 'default (1)'}`);
  lines.push(`- Concurrency: ${opts.concurrency}`);
  lines.push(`- Skipped (not probed): ${skipped.length} — sub-service-selector parents, inactive, already cataloged`);
  lines.push('');
  lines.push('## Verdict counts');
  lines.push('');
  lines.push('| Classification | Count | % |');
  lines.push('|---|---|---|');
  for (const cls of sortedClass) {
    const n = summary[cls] || 0;
    const pct = total > 0 ? ((n / total) * 100).toFixed(0) + '%' : '-';
    lines.push(`| \`${cls}\` | ${n} | ${pct} |`);
  }
  lines.push('');
  lines.push('## What each classification means');
  lines.push('');
  lines.push('| Classification | Meaning | Action |');
  lines.push('|---|---|---|');
  lines.push('| `pct-sufficient` | Saved + rendered priced cost from PCT alone | NO catalog entry needed |');
  lines.push('| `needs-catalog` | Saved cleanly but rendered $0 | Catalog entry needed (PCT misleads) |');
  lines.push('| `lint-fail` | Preflight refused | Catalog entry needed (which predicate?) |');
  lines.push('| `save-fail` | Save API refused | Catalog entry needed (shape/validation issue) |');
  lines.push('| `skip` | Skipped — see detail | n/a |');
  lines.push('');

  for (const cls of sortedClass) {
    const subset = results.filter(r => r.classification === cls);
    if (subset.length === 0) continue;
    lines.push(`## ${cls} (${subset.length})`);
    lines.push('');
    lines.push('| Service | Cost | Detail |');
    lines.push('|---|---|---|');
    for (const r of subset.slice(0, 100)) {
      const cost = r.monthlyCost != null ? `$${r.monthlyCost}` : '-';
      const detail = (r.detail || '').replace(/\|/g, '\\|').slice(0, 150);
      lines.push(`| \`${r.serviceCode}\` | ${cost} | ${detail} |`);
    }
    if (subset.length > 100) lines.push(`| ... | | (${subset.length - 100} more truncated) |`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }

  const manifest = await loadManifest('aws');
  const catalogedCodes = listCatalogedCodes();
  const { targets: allTargets, skipped } = classifyTargets(manifest, catalogedCodes, args.services);
  const targets = args.limit ? allTargets.slice(0, args.limit) : allTargets;

  if (targets.length === 0) {
    console.log(`No services to probe. Skipped: ${skipped.length}.`);
    if (args.services.length > 0) {
      for (const s of skipped) console.log(`  ${s.code}: ${s.reason}`);
    }
    process.exit(0);
  }

  console.log(`Probing ${targets.length} services at concurrency ${args.concurrency}, volume=${args.highVolume ? 'high' : 'default'}...`);
  console.log(`Skipped (not probed): ${skipped.length}`);
  console.log('');

  const start = Date.now();
  const results = await runPool(targets, args.concurrency, args);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const summary = summarize(results);

  console.log('');
  console.log(`Done in ${elapsed}s. Verdict counts:`);
  for (const [k, v] of Object.entries(summary).sort()) console.log(`  ${k}: ${v}`);

  // Write artifacts
  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16).replace('-', 'T');
  const suffix = args.highVolume ? '-high' : '';
  const mdPath = path.join(args.outDir, `diagnose-${stamp}${suffix}.md`);
  const jsonPath = path.join(args.outDir, `diagnose-${stamp}${suffix}.json`);

  fs.writeFileSync(mdPath, renderMarkdown(results, summary, args, skipped));
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    options: { highVolume: args.highVolume, concurrency: args.concurrency },
    summary,
    skipped,
    results,
  }, null, 2));

  console.log('');
  console.log(`Markdown: ${mdPath}`);
  console.log(`JSON:     ${jsonPath}`);
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
