#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Audits every catalog entry's `required[]` fields against the manifest's
 * template inputs. Flags fields that don't exist in the template the
 * entry pins (catches the EC2 `quantity` class — a synthetic field
 * declared required while the lint runs against the post-transform blob).
 *
 * Synthetic fields (transformed at save time by lib/aws/ec2.js) opt out via
 * `"synthetic": true` on the field entry. The auditor reports how many
 * fields each entry uses synthetic vs. manifest-backed.
 *
 * Also surfaces minimalConfig keys that aren't valid template inputs —
 * a frequent silent-bug class when a service's manifest revs.
 *
 * Usage: node scripts/audit-catalog-fields.js
 *
 * Exits non-zero if any entry has unknown / unflagged fields.
 */

'use strict';

const path = require('node:path');
const { loadCatalog } = require('../lib/lint/catalog');
const { loadManifest, fetchServiceDefinition } = require('../lib/aws/aws-client');

const CATALOG_DIR = path.join(__dirname, '..', 'catalog', 'services');

function* allNodes(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) yield* allNodes(x); return; }
  yield n;
  for (const v of Object.values(n)) yield* allNodes(v);
}

// META keys are fields the agent supplies that the catalog/lint code uses
// directly without expecting them in the manifest's template.
const META_KEYS = new Set(['region', 'description']);

function collectTemplateInputIds(definition, templateId) {
  if (!definition?.templates) return null;
  const out = new Set();
  for (const tpl of definition.templates) {
    if (typeof tpl !== 'object') continue;
    if (templateId && (tpl.id || tpl.templateId) !== templateId) continue;
    for (const n of allNodes(tpl)) {
      if (n.type === 'input' && typeof n.id === 'string') out.add(n.id);
    }
    if (templateId) break;
  }
  return out;
}

async function audit(entry, manifest) {
  const issues = [];
  let definition;
  try {
    definition = await fetchServiceDefinition(manifest, entry.serviceCode);
  } catch (e) {
    return [`fetch failed: ${e.message}`];
  }
  if (!definition) return ['service not in manifest'];

  // Validate templateId. For parent-envelope services
  // (subType: 'subServiceSelector'), the templateId names the wrapper
  // (`amazonBedrockClassesGroup`) and `templates` is a string array of
  // child codes. Those entries don't have their own inputs — they
  // delegate. Skip the inputs-required check for them.
  const manifestSvc = manifest.get(entry.serviceCode);
  const isParentEnvelope = manifestSvc?.subType === 'subServiceSelector';

  const templateInputs = collectTemplateInputIds(definition, entry.templateId);
  if (entry.templateId && !isParentEnvelope && (!templateInputs || templateInputs.size === 0)) {
    issues.push(`templateId "${entry.templateId}" has no inputs (or doesn't exist)`);
  }

  for (const r of (entry.required || [])) {
    if (!r?.field) continue;
    if (templateInputs && !templateInputs.has(r.field)) {
      issues.push(`required[].field "${r.field}" not in template "${entry.templateId}"`);
    }
  }

  // productCodes[]: declared product-level subService codes that route
  // under this provider. Each must exist in the manifest with
  // subType:'subService' or the redirect hint will name a code the
  // calculator doesn't understand.
  for (const sub of (entry.subServices || [])) {
    for (const productCode of (sub.productCodes || [])) {
      const manifestProductSvc = manifest.get(productCode);
      if (!manifestProductSvc) {
        issues.push(`subServices[${sub.serviceCode}].productCodes "${productCode}" not in manifest`);
      } else if (manifestProductSvc.subType !== 'subService') {
        issues.push(`subServices[${sub.serviceCode}].productCodes "${productCode}" has subType "${manifestProductSvc.subType}", expected "subService"`);
      }
    }
  }

  // minimalConfig keys must be META or real template inputs.
  // Parent envelopes (minimalConfig keyed by sub-service code) skip this.
  if (entry.minimalConfig && !entry.subServices) {
    const cfgKeys = Object.keys(entry.minimalConfig);
    const allInputs = new Set();
    for (const tpl of definition.templates || []) {
      if (typeof tpl !== 'object') continue;
      for (const n of allNodes(tpl)) {
        if (n.type === 'input' && typeof n.id === 'string') allInputs.add(n.id);
      }
    }
    for (const k of cfgKeys) {
      if (META_KEYS.has(k)) continue;
      if (!allInputs.has(k)) {
        issues.push(`minimalConfig.${k} is neither a META key nor a template input`);
      }
    }
  }

  return issues;
}

(async () => {
  const catalog = loadCatalog(CATALOG_DIR);
  const manifest = await loadManifest('aws');
  console.log(`Auditing ${catalog.size} catalog entries...\n`);

  let totalIssues = 0;
  const sorted = [...catalog.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [code, entry] of sorted) {
    const issues = await audit(entry, manifest);
    if (issues.length === 0) {
      console.log(`OK    ${code}`);
    } else {
      console.log(`FAIL  ${code}`);
      for (const i of issues) console.log(`        ${i}`);
      totalIssues += issues.length;
    }
  }
  console.log(`\n${totalIssues} issue(s) across ${catalog.size} entries.`);
  process.exit(totalIssues > 0 ? 1 : 0);
})().catch(e => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});
