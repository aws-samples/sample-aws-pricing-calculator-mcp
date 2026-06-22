#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Generate a catalog/services/<serviceCode>.json stub from the live PCT.
 *
 * The catalog plan deliberately does NOT use the PCT alone as the
 * source of truth — the PCT misses hidden requirements that the
 * calculator's frontend silently injects (EC2 needs `tenancy`,
 * `dataTransferForEC2`, `workloadSelection`, etc. even though the
 * PCT marks none of them required). And it can't capture empirical
 * traps (eC2Next-as-readonly, multi-child sub-service envelopes).
 *
 * What this script DOES is the part the PCT can answer correctly:
 *   - field IDs and labels (avoids the `requestDuration` typo class
 *     of bug — generator can't typo what the PCT declares)
 *   - field shapes per subType (numericInput → string,
 *     frequency → {value, unit}, fileSize → {value, unit:
 *     "<size>|<frequency>"}, etc.)
 *   - dropdown enums from options[]
 *   - validations.required → "the PCT says these are required"
 *
 * Output is a STUB. Required from the human afterwards:
 *   - traps[] — empirical knowledge
 *   - status: 'unverified' bumped to 'partial' or 'verified' after
 *     a probe run + browser check
 *   - any optional[] entries the PCT's required list misses (e.g.
 *     EC2's hidden defaults)
 *   - sub-service expansion for parents (the script flags these
 *     and refuses to fill subServices itself)
 *
 * Usage:
 *   node scripts/generate-catalog-stub.js <serviceCode> [--region REGION] [--write]
 *
 * Without --write: prints the JSON to stdout for inspection / diffing.
 * With --write: writes to catalog/services/<serviceCode>.json (refuses
 *   if the file already exists; use --force to overwrite).
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadManifest, fetchServiceDefinition, extractInputFields, enrichFieldsWithMetadata } = require('../lib/aws/aws-client');

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const FLAGS = {
  serviceCode: args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--region'),
  region: getArg('--region') || 'us-east-1',
  write: args.includes('--write'),
  force: args.includes('--force'),
  partition: getArg('--partition') || 'aws',
};

if (!FLAGS.serviceCode || args.includes('--help') || args.includes('-h')) {
  console.error(`Usage: node scripts/generate-catalog-stub.js <serviceCode> [--region REGION] [--write] [--force]

Generates a stub catalog entry from the PCT. Without --write, prints
JSON to stdout. With --write, writes to catalog/services/<serviceCode>.json.

Run the generator first; then hand-fill traps[] and bump status after
a probe + browser check.`);
  process.exit(args.includes('--help') ? 0 : 1);
}

// PCT-required fields, recursively. Mirrors the lib/can-rehydrate.js
// findRequiredComponentIds walk so the two stay in agreement.
function findPctRequired(template) {
  const out = [];
  const visit = (node, ancestorConditional) => {
    if (!node || typeof node !== 'object') return;
    const conditional = ancestorConditional || Object.prototype.hasOwnProperty.call(node, 'displayIf');
    if (Array.isArray(node)) {
      for (const item of node) visit(item, conditional);
      return;
    }
    if (node.id && typeof node.id === 'string') {
      if (!conditional && !Object.prototype.hasOwnProperty.call(node, 'displayIf') &&
          node.validations && node.validations.required === true) {
        out.push(node.id);
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') visit(v, conditional);
    }
  };
  visit(template, false);
  return out;
}

// Per-subType: produce { shape, example } that the catalog schema
// accepts and the calculator validates.
function shapeForField(field) {
  switch (field.type) {
    case 'numericInput':
    case 'percentInput':
      return { shape: 'string', example: '1' };
    case 'frequency': {
      const unit = (field.options && field.options[0] && (field.options[0].id || field.options[0])) || 'perMonth';
      return {
        shape: "{ value: '<n>', unit: '<one of options>' }",
        example: { value: '1', unit: unit },
      };
    }
    case 'durationInput':
      return {
        shape: "{ value: '<n>', unit: 'min' | 'hr' | 'sec' }",
        example: { value: '1', unit: 'min' },
      };
    case 'fileSize':
      return {
        shape: "{ value: '<n>', unit: '<size>|<frequency>' }",
        example: { value: '1', unit: field.defaultUnit || 'gb|NA' },
      };
    case 'dropdown': {
      const opts = (field.options || []).map(o => o.id || o).filter(Boolean);
      return {
        shape: 'string (one of options)',
        enumValues: opts,
        example: opts[0],
      };
    }
    case 'columnFormIPM':
      return {
        shape: 'columnFormIPM matrix — see field.row schema in get_service_fields',
        example: '<see field.row>',
      };
    case 'autosuggest':
      return { shape: 'string (autosuggest)', example: '<service-specific>' };
    default:
      return { shape: `string (${field.type || 'unknown'})`, example: '<set me>' };
  }
}

function buildEntry(serviceMeta, definition, fields, region) {
  const templates = (definition.templates || []).filter(t => t && typeof t === 'object');
  // For sub-service-selector parents the PCT's templates is a string
  // array AND there's a top-level templateId for the wrapper. We don't
  // pretend to expand sub-services — flag it for the human.
  const isSubServiceSelector = definition.subType === 'subServiceSelector';
  const templateId = isSubServiceSelector
    ? definition.templateId
    : (templates[0] && templates[0].id) || definition.templateId || 'template';

  const pctRequired = new Set();
  for (const t of templates) for (const id of findPctRequired(t)) pctRequired.add(id);

  const required = [];
  const optional = [];
  for (const f of fields) {
    const sh = shapeForField(f);
    const item = {
      field: f.id,
      hint: f.label || f.id,
      shape: sh.shape,
    };
    if (sh.enumValues) item.enum = sh.enumValues;
    if (sh.example !== undefined) item.example = sh.example;
    if (pctRequired.has(f.id)) required.push(item);
    else optional.push(item);
  }

  // minimalConfig: take the PCT-required fields plus region + description.
  // For sub-service-selector parents, the catalog uses a sub-service-keyed
  // shape that this generator can't fill — leave empty and prompt human.
  const minimalConfig = isSubServiceSelector
    ? { _comment: 'Sub-service-selector parent. Replace this comment with one entry per sub-service: { <childCode>: { region, description, ... } }. See catalog/services/awsAppSync.json for an example.' }
    : { region, description: 'fill me' };
  if (!isSubServiceSelector) {
    for (const r of required) {
      minimalConfig[r.field] = r.example;
    }
  }

  // subServices: for sub-service-selector parents, list the child code
  // and a placeholder estimateFor. The human probes each child's PCT.
  const subServices = isSubServiceSelector
    ? (definition.templates || []).filter(c => typeof c === 'string').map(childCode => ({
        serviceCode: childCode,
        estimateFor: '<probe child PCT for templates[0].id>',
        required: [],
      }))
    : [];

  return {
    $schema: '../schema.json',
    serviceCode: serviceMeta.key,
    displayName: (serviceMeta.name || serviceMeta.key).trim(),
    templateId,
    status: 'unverified',
    required,
    optional,
    traps: [],
    subServices,
    minimalConfig,
  };
}

(async function main() {
  const manifest = await loadManifest(FLAGS.partition);
  const svcMeta = manifest.get(FLAGS.serviceCode);
  if (!svcMeta) {
    console.error(`Service "${FLAGS.serviceCode}" not in manifest. Try one of:\n  ` +
      [...manifest.keys()].slice(0, 20).join(', ') + ', ...');
    process.exit(2);
  }
  const definition = await fetchServiceDefinition(manifest, FLAGS.serviceCode, FLAGS.partition);
  if (!definition) {
    console.error(`No PCT definition for "${FLAGS.serviceCode}".`);
    process.exit(2);
  }

  let fields = extractInputFields(definition);
  fields = await enrichFieldsWithMetadata(definition, fields);

  const entry = buildEntry(svcMeta, definition, fields, FLAGS.region);

  if (FLAGS.write) {
    const targetPath = path.join(__dirname, '..', 'catalog', 'services', `${FLAGS.serviceCode}.json`);
    if (fs.existsSync(targetPath) && !FLAGS.force) {
      console.error(`Refusing to overwrite ${targetPath} (use --force).`);
      process.exit(3);
    }
    fs.writeFileSync(targetPath, JSON.stringify(entry, null, 2) + '\n');
    console.error(`Wrote ${targetPath}`);
    console.error(`Status: 'unverified'. Required next steps:`);
    console.error(`  1. Hand-fill traps[] with empirical knowledge.`);
    console.error(`  2. For sub-service-selector parents: replace the minimalConfig _comment placeholder with sub-service-keyed configs.`);
    console.error(`  3. Probe via scripts/probe-catalog-entry.js (when it exists) or save+fetch manually.`);
    console.error(`  4. Open the URL in a browser; confirm editable.`);
    console.error(`  5. Bump status to 'partial' or 'verified' and add lastVerifiedAt + verifiedEstimateId.`);
  } else {
    console.log(JSON.stringify(entry, null, 2));
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(2);
});
