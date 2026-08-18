#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Author-catalog driver — deterministic CLI for catalog authoring.
 *
 * Each subcommand maps to one numbered step in `catalog/README.md`'s
 * "Adding a new service" workflow and emits structured JSON to stdout.
 * The script does NOT make subjective decisions: trap prose, the
 * verified-status bump, and "is this good enough?" all stay with the
 * human in the loop.
 *
 * Usage:
 *   node scripts/author-catalog.js <subcommand> <serviceCode> [options]
 *
 * Subcommands:
 *   resolve     Validate serviceCode; surface alternatives if missing.
 *   generate    Generate stub via generate-catalog-stub.js if absent.
 *   pad         Suggest minimalConfig padding from surfaceability.
 *               --apply writes; default prints the suggested diff.
 *   preflight   Schema validate + offline rehydration lint.
 *   save        Real save via build_estimate + import_estimate round-trip.
 *   verify      Bump status to verified after browser confirmation.
 *   status      Report current catalog entry state.
 *
 * Exit codes:
 *   0   ok / structured failure (check json.ok)
 *   2   usage error (missing args, unknown subcommand)
 *   3   subcommand crashed (unhandled exception)
 *
 * stdout: a single JSON object per invocation. Errors go to stderr.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CATALOG_DIR = path.join(REPO_ROOT, 'catalog', 'services');
const SCHEMA_PATH = path.join(REPO_ROOT, 'catalog', 'schema.json');

function emit(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(exitCode);
}

function fail(message, details, exitCode = 0) {
  emit({ ok: false, error: message, details: details || null }, exitCode);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function catalogPath(serviceCode) {
  return path.join(CATALOG_DIR, `${serviceCode}.json`);
}

function readCatalog(serviceCode) {
  const p = catalogPath(serviceCode);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeCatalog(serviceCode, entry) {
  const p = catalogPath(serviceCode);
  fs.writeFileSync(p, JSON.stringify(entry, null, 2) + '\n');
}

// ---------- subcommand: resolve ----------

async function cmdResolve(serviceCode) {
  // Lazy-loads throughout this file are intentional and standard for CLI
  // scripts: each subcommand pays only for what it needs. The scanner's
  // "block other requests" warning doesn't apply — this is a one-shot CLI,
  // not a request handler. nosemgrep: lazy-load-module
  const { loadManifest } = require('../lib/aws/aws-client');

  const manifest = await loadManifest('aws');
  const inManifest = manifest.has(serviceCode);
  const catalogEntry = readCatalog(serviceCode);

  if (inManifest) {
    const meta = manifest.get(serviceCode);
    return emit({
      ok: true,
      subcommand: 'resolve',
      serviceCode,
      data: {
        in_manifest: true,
        manifest_name: meta.name,
        sub_type: meta.subType || null,
        catalog_status: catalogEntry ? catalogEntry.status : null,
      },
    });
  }

  // Not in manifest — surface alternatives by lowercase prefix / substring
  const lower = serviceCode.toLowerCase();
  const alternatives = [...manifest.keys()]
    .filter(k => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase().slice(0, 6)))
    .slice(0, 10);

  return emit({
    ok: false,
    subcommand: 'resolve',
    serviceCode,
    error: `Service '${serviceCode}' not in calculator manifest`,
    data: {
      in_manifest: false,
      alternatives,
      hint: 'Pass one of the alternatives, or pick a different service code from the manifest.',
    },
  });
}

// ---------- subcommand: status ----------

async function cmdStatus(serviceCode) {
  const entry = readCatalog(serviceCode);
  if (!entry) {
    return emit({
      ok: true,
      subcommand: 'status',
      serviceCode,
      data: { exists: false, hint: 'Run `generate` to create a stub.' },
    });
  }
  return emit({
    ok: true,
    subcommand: 'status',
    serviceCode,
    data: {
      exists: true,
      status: entry.status,
      lastVerifiedAt: entry.lastVerifiedAt || null,
      verifiedEstimateId: entry.verifiedEstimateId || null,
      templateId: entry.templateId,
      required_count: (entry.required || []).length,
      optional_count: (entry.optional || []).length,
      traps_count: (entry.traps || []).length,
      sub_services_count: (entry.subServices || []).length,
      minimal_config_keys: Object.keys(entry.minimalConfig || {}),
      // For sub-service-selector parents, list child codes too
      sub_service_codes: (entry.subServices || []).map(s => s.serviceCode),
    },
  });
}

// ---------- subcommand: generate ----------

async function cmdGenerate(serviceCode, flags) {
  const p = catalogPath(serviceCode);
  if (fs.existsSync(p) && !flags.force) {
    return emit({
      ok: true,
      subcommand: 'generate',
      serviceCode,
      data: {
        action: 'skipped',
        reason: 'entry already exists; pass --force to overwrite',
        path: p,
      },
    });
  }
  // Shell out to the generator. Inherits stderr so failures are visible.
  try {
    const args = [path.join(REPO_ROOT, 'scripts', 'generate-catalog-stub.js'), serviceCode, '--write'];
    if (flags.force) args.push('--force');
    execFileSync('node', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    return fail('generate-catalog-stub.js failed', { stderr: err.stderr?.toString() });
  }
  return emit({
    ok: true,
    subcommand: 'generate',
    serviceCode,
    data: {
      action: flags.force ? 'overwritten' : 'created',
      path: p,
      next_step: 'Run `pad` to suggest minimalConfig values, then `preflight` to lint.',
    },
  });
}

// ---------- subcommand: pad ----------

async function cmdPad(serviceCode, flags) {
  const entry = readCatalog(serviceCode);
  if (!entry) return fail(`No catalog entry for '${serviceCode}'. Run \`generate\` first.`);

  // nosemgrep: lazy-load-module
  const { loadManifest, fetchServiceDefinition } = require('../lib/aws/aws-client');
  // nosemgrep: lazy-load-module
  const { buildSurfaceabilityIndex } = require('../lib/aws/surfaceability');
  // nosemgrep: lazy-load-module
  const { suggestValue } = require('../lib/aws/pct-config');

  const manifest = await loadManifest('aws');

  // For sub-service-selector parents, pad the FIRST child's slot.
  // Otherwise pad the top-level minimalConfig.
  const isSubServiceShape = !entry.minimalConfig?.region &&
    Object.values(entry.minimalConfig || {}).every(v => v && typeof v === 'object' && v.region !== undefined);

  let target, codeForSurfaceability;
  if (isSubServiceShape) {
    const childCode = Object.keys(entry.minimalConfig)[0];
    target = entry.minimalConfig[childCode];
    codeForSurfaceability = childCode;
  } else {
    target = entry.minimalConfig || {};
    codeForSurfaceability = serviceCode;
  }

  const def = await fetchServiceDefinition(manifest, codeForSurfaceability, 'aws');
  if (!def) return fail(`No PCT for '${codeForSurfaceability}'`);
  const { fields } = buildSurfaceabilityIndex(def);
  const surfaceable = [...fields.values()].filter(f => f.surfaceable === true && f.label);

  // Suggest values for fields that aren't already in the target.
  // suggestValue returns undefined for columnFormIPM (per-service
  // customization required); fall back to the wrapped-shape stub so
  // the human authoring sees the right shape.
  const suggestions = [];
  for (const f of surfaceable) {
    if (Object.prototype.hasOwnProperty.call(target, f.id)) continue;
    let value = suggestValue(f);
    if (value === undefined && f.subType === 'columnFormIPM') {
      value = { value: [{ /* fill row selectorIds */ }] };
    }
    if (value === undefined) continue;
    suggestions.push({
      field: f.id,
      label: f.label,
      subType: f.subType,
      suggested_value: value,
    });
  }

  if (flags.apply && suggestions.length > 0) {
    for (const s of suggestions) {
      target[s.field] = s.suggested_value;
    }
    writeCatalog(serviceCode, entry);
  }

  return emit({
    ok: true,
    subcommand: 'pad',
    serviceCode,
    data: {
      target_path: isSubServiceShape ? `minimalConfig.${codeForSurfaceability}` : 'minimalConfig',
      surfaceable_count: surfaceable.length,
      already_padded_count: surfaceable.length - suggestions.length,
      suggestions,
      applied: !!flags.apply && suggestions.length > 0,
      hint: flags.apply
        ? null
        : (suggestions.length > 0
          ? 'Pass --apply to write these into the catalog file.'
          : 'minimalConfig is already padded; nothing to do.'),
    },
  });
}

// ---------- subcommand: preflight ----------

async function cmdPreflight(serviceCode) {
  const entry = readCatalog(serviceCode);
  if (!entry) return fail(`No catalog entry for '${serviceCode}'. Run \`generate\` first.`);

  // Schema validation first — no network needed.
  // nosemgrep: lazy-load-module
  const { validateAgainstSchema } = require('../lib/lint/catalog');
  const schemaErrors = validateAgainstSchema(entry);
  if (schemaErrors) {
    return emit({
      ok: false,
      subcommand: 'preflight',
      serviceCode,
      error: 'Schema validation failed; fix the JSON before lint can run.',
      data: { schema_errors: schemaErrors },
    });
  }

  // Build the would-be saved blob from the catalog's minimalConfig and
  // run the static rehydration linter against it. Mirrors what the
  // calculator MCP server's validate_estimate tool does, but here we
  // drive it directly from the catalog entry.
  // nosemgrep: lazy-load-module
  const EstimateBuilder = require('../lib/aws/estimate-builder');
  // nosemgrep: lazy-load-module
  const { canRehydrateFetch } = require('../lib/lint/can-rehydrate-fetch');

  const eb = new EstimateBuilder(`Preflight: ${serviceCode}`);
  let addServiceCode = serviceCode;
  let config = entry.minimalConfig;

  // Sub-service-selector parent: send the FIRST child directly.
  // EstimateBuilder wraps it in the parent envelope on save.
  const isSubServiceShape = !config?.region &&
    Object.values(config || {}).every(v => v && typeof v === 'object' && v.region !== undefined);
  if (isSubServiceShape) {
    const childCode = Object.keys(config)[0];
    addServiceCode = childCode;
    config = config[childCode];
  }

  try {
    eb.addService(addServiceCode, config);
  } catch (err) {
    return fail(`addService failed: ${err.message}`, { addServiceCode, config });
  }

  let lint;
  try {
    const blob = await eb.toAWSPayload();
    lint = await canRehydrateFetch({ savedBlob: blob, partition: 'aws' });
  } catch (err) {
    return fail(`Lint failed: ${err.message}`);
  }

  return emit({
    ok: lint.status !== 'read-only',
    subcommand: 'preflight',
    serviceCode,
    data: {
      schema_valid: true,
      lint_verdict: lint.status,
      lint_services: lint.services,
      hint: lint.status === 'read-only'
        ? 'Catalog config would rehydrate as read-only. Adjust required[] / minimalConfig and re-run.'
        : 'Schema clean and lint editable. Safe to involve the subagent.',
    },
  });
}

// ---------- subcommand: save ----------

async function cmdSave(serviceCode) {
  const entry = readCatalog(serviceCode);
  if (!entry) return fail(`No catalog entry for '${serviceCode}'. Run \`generate\` first.`);

  // nosemgrep: lazy-load-module
  const EstimateBuilder = require('../lib/aws/estimate-builder');
  // nosemgrep: lazy-load-module
  const { fetchEstimate } = require('../lib/aws/aws-client');

  const eb = new EstimateBuilder(`Catalog save: ${serviceCode}`);

  // Same dispatch as preflight: child for sub-service envelope, plain
  // otherwise. For multi-child catalogs we add ALL children so the
  // saved estimate covers the catalog's full minimalConfig.
  const isSubServiceShape = !entry.minimalConfig?.region &&
    Object.values(entry.minimalConfig || {}).every(v => v && typeof v === 'object' && v.region !== undefined);

  // Pass the catalog's templateId as a hint so multi-template services
  // (Cognito tiers, MQ broker types, etc.) route through the curated
  // template rather than field-membership scoring's tie-break. This
  // mirrors mcp-server.js#addEntries, where the same hint is passed for
  // every catalog-driven save in the production path.
  const hint = entry.templateId ? { templateIdHint: entry.templateId } : {};
  if (isSubServiceShape) {
    for (const [childCode, childConfig] of Object.entries(entry.minimalConfig)) {
      eb.addService(childCode, childConfig, hint);
    }
  } else {
    eb.addService(serviceCode, entry.minimalConfig, hint);
  }

  let saved;
  try {
    saved = await eb.export();
  } catch (err) {
    return fail(`Save failed: ${err.message}`);
  }

  // Round-trip: fetch back and confirm shape.
  let fetched, roundTripOk = false, roundTripIssue = null;
  try {
    fetched = await fetchEstimate(saved.estimateId);
    const services = Object.values(fetched.services || {});
    if (services.length === 0) {
      roundTripIssue = 'fetched estimate has no services[]';
    } else {
      const first = services[0];
      if (!first.calculationComponents || Object.keys(first.calculationComponents).length === 0) {
        roundTripIssue = 'fetched service has empty calculationComponents';
      } else {
        roundTripOk = true;
      }
    }
  } catch (err) {
    roundTripIssue = `import_estimate failed: ${err.message}`;
  }

  return emit({
    ok: roundTripOk,
    subcommand: 'save',
    serviceCode,
    data: {
      sharable_url: saved.shareableUrl,
      aws_estimate_id: saved.estimateId,
      round_trip_ok: roundTripOk,
      round_trip_issue: roundTripIssue,
      hint: roundTripOk
        ? `Browser-verify the URL, then bump status to verified and add lastVerifiedAt + verifiedEstimateId: "${saved.estimateId}".`
        : 'Saved, but the round-trip check found an issue. Browser-verify before trusting this entry.',
    },
  });
}

// ---------- subcommand: verify ----------

// Structural guard against accidental verified-bumps. Two prior author
// sessions self-promoted unverified entries to verified after ambiguous
// one-word user replies, despite the SKILL.md gate. The skill's
// instructions weren't binding enough — this subcommand is.
//
// Required flags:
//   --browser-confirmed=yes-all-four   the user explicitly affirms the
//                                      four-condition browser eyeball
//   --estimate-id=<sha1>               the verifiedEstimateId the user
//                                      observed; must match a real save
//
// Without BOTH flags the script refuses to write `verified`. The
// affirmation string is deliberately verbose to make accidental copy-
// paste typos visible.
async function cmdVerify(serviceCode, flags) {
  const entry = readCatalog(serviceCode);
  if (!entry) return fail(`No catalog entry for '${serviceCode}'.`);

  const browserConfirmed = flags['browser-confirmed'];
  const estimateId = flags['estimate-id'];

  if (browserConfirmed !== 'yes-all-four') {
    return emit({
      ok: false,
      subcommand: 'verify',
      serviceCode,
      error: 'Refusing to bump status to verified without explicit --browser-confirmed=yes-all-four.',
      data: {
        required_flags: {
          'browser-confirmed': 'must be exactly the literal "yes-all-four" — affirms all four conditions: row appears with right name, all sent fields visible, editable not read-only, cost non-zero (or zero expected for free-tier).',
          'estimate-id': 'must be the SHA1 verifiedEstimateId the user actually loaded in their browser.',
        },
        hint: 'Ask the user the four-condition question in SKILL.md step 7. Only call this subcommand after they affirm.',
      },
    }, 0);
  }
  if (!estimateId || !/^[a-f0-9]{40}$/.test(estimateId)) {
    return emit({
      ok: false,
      subcommand: 'verify',
      serviceCode,
      error: 'Refusing to bump status to verified without --estimate-id=<40-hex-sha1>.',
      data: { estimate_id_received: estimateId || null },
    }, 0);
  }

  // Schema-validate after the bump so we catch any drift in our own logic.
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const updated = {
    ...entry,
    status: 'verified',
    lastVerifiedAt: today,
    verifiedEstimateId: estimateId,
  };

  // nosemgrep: lazy-load-module
  const { validateAgainstSchema } = require('../lib/lint/catalog');
  const errors = validateAgainstSchema(updated);
  if (errors) {
    return fail('Schema validation failed after applying verify changes.', { errors });
  }

  writeCatalog(serviceCode, updated);

  return emit({
    ok: true,
    subcommand: 'verify',
    serviceCode,
    data: {
      previous_status: entry.status,
      new_status: 'verified',
      lastVerifiedAt: today,
      verifiedEstimateId: estimateId,
      hint: 'Catalog drift test now exercises this entry on every CI run. If a future PCT change breaks rehydration the test will catch it.',
    },
  });
}

// ---------- entry point ----------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    process.stderr.write('Usage: node scripts/author-catalog.js <subcommand> <serviceCode> [options]\n');
    process.exit(2);
  }
  const subcommand = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));
  const serviceCode = positional[0];

  if (!serviceCode && subcommand !== 'help') {
    process.stderr.write(`Subcommand '${subcommand}' requires a serviceCode positional argument.\n`);
    process.exit(2);
  }

  try {
    switch (subcommand) {
      case 'resolve':  return await cmdResolve(serviceCode);
      case 'status':   return await cmdStatus(serviceCode);
      case 'generate': return await cmdGenerate(serviceCode, flags);
      case 'pad':       return await cmdPad(serviceCode, flags);
      case 'preflight': return await cmdPreflight(serviceCode);
      case 'save':      return await cmdSave(serviceCode);
      case 'verify':    return await cmdVerify(serviceCode, flags);
      default:
        process.stderr.write(`Unknown subcommand: '${subcommand}'. Valid: resolve, status, generate, pad, preflight, save, verify.\n`);
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`Crash in subcommand '${subcommand}': ${err.stack || err.message}\n`);
    process.exit(3);
  }
}

main();
