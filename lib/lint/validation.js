// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const { loadManifest, loadRegionList, findService, findServiceCandidates, fetchServiceDefinition, extractInputFields, enrichFieldsWithMetadata } = require('../aws/aws-client');
const { invalidFieldIdsHintFor } = require('./lint-hints');
const { synthesizeAgentFields } = require('../aws/agent-fields');
const { validatePricingStrategy } = require('../aws/ec2');
const { findRequiredComponentIds, findTemplate } = require('./can-rehydrate');
const { getEntry } = require('./catalog');

const META_KEYS = new Set(['region', 'description']);

// Fields that the EC2 transform (lib/aws/ec2.js) handles or that are
// automatically included by the calculator in saved Dedicated Host
// (host tenancy) payloads, but are not part of the public input schema.
// Exempt from unknown-field validation to avoid rejecting valid configs/imports.
const EC2_PASSTHROUGH_KEYS = new Set([
  'tenancy', 'vcpu', 'physicalCores',
  'storageTypeDH', 'storageAmountDH', 'gp3IopsDH', 'gp3ThroughputDH',
  'iopsDH', 'iops2DH',
]);

const MAX_CORRECTIONS = 20;

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = d[0];
    d[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = d[i];
      d[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[i], d[i - 1]);
      prev = tmp;
    }
  }
  return d[m];
}

function suggestMatch(invalid, validIds, max = 3) {
  const lower = invalid.toLowerCase();
  return validIds
    .map(id => ({ id, dist: levenshtein(lower, id.toLowerCase()) }))
    .filter(m => m.dist <= Math.max(Math.floor(invalid.length * 0.6), 3))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map(m => m.id);
}

// Module-scope cache for "fields where case-insensitive auto-correct is unsafe."
// Populated lazily on first use of each field. Keyed on `${serviceCode}:${fieldId}`.
//
// Lifetime is intentionally process-wide. We never invalidate because:
//   - field IDs are stable across manifest revisions (per project memory)
//   - the manifest is fetched per-call, so a re-cached value would be the
//     same as the existing one
//   - test isolation is fine: each test uses a unique field ID, and even
//     if reused, a positive entry only widens permissibility (suppresses
//     case auto-correct), it never produces a wrong correction.
const _caseUnsafeFields = new Set();

function _hasCaseCollisions(options) {
  const seen = new Map();
  for (const opt of options) {
    const k = String(opt.id).toLowerCase();
    if (seen.has(k) && seen.get(k) !== opt.id) return true;
    seen.set(k, opt.id);
  }
  return false;
}

// Pure. Validates a single supplied value against the field's declared type/metadata.
// Returns one of:
//   { ok: true }
//   { ok: 'corrected', correctedValue, reason }
//   { ok: false, error }
function validateFieldValue(field, value, opts = {}) {
  if (!field || !field.type) return { ok: true };
  const cacheKey = opts.cacheKey || `${opts.serviceCode || ''}:${field.id}`;

  // ---------- Rule 1: dropdown ----------
  if (field.type === 'dropdown' && Array.isArray(field.options)) {
    const wasWrapped = value && typeof value === 'object' && 'value' in value;
    const inner = wasWrapped ? value.value : value;
    if (typeof inner !== 'string') {
      return { ok: false, error: `Field "${field.id}": expected a string option id, got ${typeof inner}.` };
    }

    const optionIds = field.options.map(o => o.id);
    if (optionIds.includes(inner)) return { ok: true };

    if (!_caseUnsafeFields.has(cacheKey) && _hasCaseCollisions(field.options)) {
      _caseUnsafeFields.add(cacheKey);
    }
    const caseSafe = !_caseUnsafeFields.has(cacheKey);

    if (caseSafe) {
      const lower = inner.toLowerCase();
      const ciMatch = optionIds.find(id => id.toLowerCase() === lower);
      if (ciMatch) {
        const correctedValue = wasWrapped ? { ...value, value: ciMatch } : ciMatch;
        return { ok: 'corrected', correctedValue, reason: 'case mismatch' };
      }
    }

    let lev1 = null;
    for (const id of optionIds) {
      if (levenshtein(inner, id) <= 1) { lev1 = id; break; }
    }
    if (lev1 && lev1 !== inner) {
      const correctedValue = wasWrapped ? { ...value, value: lev1 } : lev1;
      return { ok: 'corrected', correctedValue, reason: 'single-character typo' };
    }

    const suggestions = suggestMatch(inner, optionIds, 3);
    const truncate = optionIds.length > 10;
    const shown = optionIds.slice(0, 10).join(', ');
    const suffix = truncate ? ` ...(${optionIds.length} total)` : '';
    const hint = suggestions.length ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?` : '';
    return {
      ok: false,
      error: `Field "${field.id}": "${inner}" is not a valid option.${hint} Allowed: ${shown}${suffix}`,
    };
  }

  // ---------- Rule 2: fileSize ----------
  if (field.type === 'fileSize') {
    if (!value || typeof value !== 'object' || typeof value.unit !== 'string' || !('value' in value)) {
      return {
        ok: false,
        error: `Field "${field.id}": expected { value, unit } object${field.defaultUnit ? ` (e.g. unit "${field.defaultUnit}")` : ''}.`,
      };
    }
    const unit = value.unit;
    const parts = unit.split('|');
    if (parts.length !== 2) {
      return {
        ok: false,
        error: `Field "${field.id}": unit "${unit}" must be "<size>|<freq>"${field.defaultUnit ? ` (e.g. "${field.defaultUnit}")` : ''}.`,
      };
    }
    const [rawSize, freq] = parts;
    const validSizes = field.validSizes || [];
    if (validSizes.length > 0 && validSizes.includes(rawSize)) return { ok: true };
    const normalized = rawSize.trim().toLowerCase();
    if (validSizes.includes(normalized)) {
      return {
        ok: 'corrected',
        correctedValue: { ...value, unit: `${normalized}|${freq}` },
        reason: 'size casing/whitespace',
      };
    }
    return {
      ok: false,
      error: `Field "${field.id}": size "${rawSize}" is not valid. Allowed sizes: [${validSizes.join(', ')}]${field.defaultUnit ? `, default "${field.defaultUnit}"` : ''}.`,
    };
  }

  // ---------- Rule 3: numericInput / frequency / durationInput ----------
  if (field.type === 'numericInput') {
    let corrected = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      corrected = String(value);
    }
    const strVal = corrected || value;
    if (typeof strVal !== 'string') {
      return { ok: false, error: `Field "${field.id}": expected a string numeric value, got ${value === null ? 'null' : typeof value}.` };
    }
    // Range/decimal validation only when the value parses as a number —
    // some numericInput fields hold non-numeric strings (e.g. EC2 instanceType)
    const num = Number(strVal);
    if (Number.isFinite(num)) {
      if (field.minValue != null && num < field.minValue) {
        return { ok: false, error: `Field "${field.id}": value ${num} is below minimum ${field.minValue}.` };
      }
      if (field.maxValue != null && num > field.maxValue) {
        return { ok: false, error: `Field "${field.id}": value ${num} exceeds maximum ${field.maxValue}.` };
      }
      if (field.allowDecimals === false && !Number.isInteger(num)) {
        return { ok: false, error: `Field "${field.id}": decimals are not allowed, got ${num}.` };
      }
    }
    if (corrected) {
      return { ok: 'corrected', correctedValue: corrected, reason: 'number coerced to string' };
    }
    return { ok: true };
  }

  if (field.type === 'frequency' || field.type === 'durationInput') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `Field "${field.id}": expected { value, unit } object, got ${value === null ? 'null' : typeof value}.` };
    }
    if (!('value' in value)) {
      return { ok: false, error: `Field "${field.id}": missing inner "value".` };
    }
    let coerced = value;
    if (typeof value.value === 'number' && Number.isFinite(value.value)) {
      coerced = { ...value, value: String(value.value) };
    } else if (typeof value.value !== 'string') {
      return { ok: false, error: `Field "${field.id}": inner "value" must be a string, got ${value.value === null ? 'null' : typeof value.value}.` };
    }

    // Unit enum check. PCT options[] for frequency / durationInput defines
    // the only units the pricing engine accepts — units outside this list
    // (e.g. millionPerMonth on a field that only declares perHour/perDay/
    // perMonth) save cleanly but rehydrate $0. Today's awsStepFunctions
    // bug, in test form. Skips if the field has no options metadata.
    const optionIds = (field.options || []).map(o => o.id).filter(Boolean);
    if (optionIds.length > 0 && typeof coerced.unit === 'string' && !optionIds.includes(coerced.unit)) {
      const suggestions = suggestMatch(coerced.unit, optionIds, 3);
      const hint = suggestions.length ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?` : '';
      return {
        ok: false,
        error: `Field "${field.id}": unit "${coerced.unit}" is not a valid option.${hint} Allowed: ${optionIds.join(', ')}.`,
      };
    }

    if (coerced !== value) {
      return { ok: 'corrected', correctedValue: coerced, reason: 'inner value coerced to string' };
    }
    return { ok: true };
  }

  // Unknown type → don't validate.
  return { ok: true };
}

async function validateConfigKeys(serviceKey, config, partition, catalog) {
  const configKeys = Object.keys(config).filter(k => !META_KEYS.has(k));
  // Note: previous early-return on `configKeys.length === 0` was removed
  // 2026-06-03 to close the validateConfigKeys-vs-lint required gap.
  // An empty config still needs the required-field walk so add_service can
  // attach a `partial: true` warning when the catalog/manifest declares
  // required inputs the agent omitted.

  try {
    const manifest = await loadManifest(partition || 'aws');
    const svc = findService(manifest, serviceKey);
    if (!svc) {
      // Service code didn't resolve. Surface candidate suggestions so the
      // agent can recover on the same call instead of waiting for the
      // template-existence lint refusal at save time. findService rejects
      // ambiguous short names like "RDS" or "S3" — the candidate list is
      // the agent's recovery path.
      const candidates = findServiceCandidates(manifest, serviceKey, 6);
      if (candidates.length === 0) {
        return {
          error: `Service "${serviceKey}" not found in manifest. ` +
                 `Use search_services to discover the correct service key.`,
          correctedConfig: config,
          corrections: [],
        };
      }
      const list = candidates.map(c => `  ${c.key} — ${c.name}`).join('\n');
      return {
        error: `Service "${serviceKey}" did not resolve to a unique manifest entry. ` +
               `Candidates:\n${list}\n` +
               `Re-call add_service with the exact service key from this list.`,
        correctedConfig: config,
        corrections: [],
      };
    }

    // Region whitelist preflight. The save API silently accepts unsupported
    // region/service pairs and the calculator routes them to a default,
    // producing a saved estimate that doesn't match what the user asked for.
    // Validating here surfaces the mismatch as a structured error before save.
    // Skips when the region list isn't reachable (offline) or when the service
    // is missing from the list (~9% — Bedrock and a few others) to avoid
    // false rejections.
    if (config.region && (partition || 'aws') === 'aws') {
      try {
        const regionList = await loadRegionList('aws');
        const allowed = regionList?.[svc.key];
        if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(config.region)) {
          return {
            error: `Region "${config.region}" is not supported for ${svc.key}. ` +
              `Supported regions: ${allowed.slice(0, 8).join(', ')}` +
              (allowed.length > 8 ? `, ... (${allowed.length} total)` : '') +
              `. Re-add via add_service with a supported region.`,
            correctedConfig: config,
            corrections: [],
          };
        }
      } catch { /* region list unreachable — skip validation */ }
    }

    const def = await fetchServiceDefinition(manifest, svc.key, partition || 'aws');
    if (!def) return { error: null, correctedConfig: config, corrections: [] };

    const fields = synthesizeAgentFields(svc.key, extractInputFields(def));
    const validIds = fields.map(f => f.id);
    const validSet = new Set(validIds);
    const isEc2 = svc.key.toLowerCase() === 'ec2enhancement' || serviceKey.toLowerCase() === 'ec2next';
    const invalid = configKeys.filter(k => !validSet.has(k) && !(isEc2 && EC2_PASSTHROUGH_KEYS.has(k)));
    if (invalid.length > 0) {
      const lines = invalid.map(k => {
        const suggestions = suggestMatch(k, validIds);
        return suggestions.length
          ? `  "${k}" — did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
          : `  "${k}" — no close match found`;
      });
      // Top-level recovery hint for the agent. When the service is a
      // parent envelope (no input fields), name the actual children;
      // otherwise show a sample of real field IDs so a retry doesn't
      // require another get_service_fields round-trip.
      const hint = invalidFieldIdsHintFor({
        serviceKey: svc.key, validIds, catalog,
      });
      return {
        error: `Invalid field IDs for ${svc.key}:\n${lines.join('\n')}\n` +
               `Use get_service_fields to discover valid field IDs.\n\n` +
               `Next step: ${hint}`,
        correctedConfig: config,
        corrections: [],
      };
    }

    // Pre-save value validation: per-field type checks with auto-correct.
    const correctedConfig = { ...config };
    const corrections = [];
    const valueErrors = [];
    let truncatedCorrections = false;
    const fieldsById = new Map(fields.map(f => [f.id, f]));
    for (const key of configKeys) {
      const field = fieldsById.get(key);
      if (!field) continue;
      const r = validateFieldValue(field, config[key], { serviceCode: svc.key });
      if (r.ok === true) continue;
      if (r.ok === 'corrected') {
        correctedConfig[key] = r.correctedValue;
        corrections.push({ field: key, from: config[key], to: r.correctedValue, reason: r.reason });
        if (corrections.length === MAX_CORRECTIONS) {
          truncatedCorrections = true;
          break;
        }
        continue;
      }
      // ok: false
      valueErrors.push(`  ${r.error}`);
    }
    // EC2 pricingStrategy fail-fast (agent report 2026-08-12).
    // pricingStrategy is a composite component whose type the generic
    // rules above can't validate, so unresolvable models/terms used to
    // sail through add_service and silently price as On-Demand / 1 Year
    // at save time. Run the same normalization the transform
    // (lib/aws/ec2.js) applies — a config that passes here cannot
    // change meaning at save.
    if (svc.key.toLowerCase() === 'ec2enhancement' && 'pricingStrategy' in config) {
      const ps = validatePricingStrategy(config.pricingStrategy);
      if (!ps.ok) valueErrors.push(`  ${ps.error}`);
    }
    if (valueErrors.length > 0) {
      return {
        error: `Invalid values for ${svc.key}:\n${valueErrors.join('\n')}\nUse get_service_fields to discover valid values.`,
        correctedConfig: config, // do not apply corrections when erroring
        corrections: [],
      };
    }

    // Required-field check: not implemented. A 2026-05-14 manifest probe
    // found no reliable signal indicating which fields are required —
    // none of `field.required`, `def.requiredFields`, `field.isRequired`,
    // or `field.mandatory` fired on any known-required field. Skipping
    // per the spec's decision rule (false-positive blocking valid saves
    // is worse than false-negative letting them through). If a future
    // manifest revision exposes a clean signal, slot a check in here.

    const enriched = await enrichFieldsWithMetadata(def, fields);
    const selectorErrors = [];
    for (const field of enriched) {
      if (field.type !== 'columnFormIPM' || !field.selectorValues) continue;
      const configVal = config[field.id];
      if (!configVal || !configVal.value || !Array.isArray(configVal.value)) continue;

      for (const row of configVal.value) {
        for (const [selectorId, allowedValues] of Object.entries(field.selectorValues)) {
          if (!allowedValues || allowedValues.length === 0) continue;
          const cell = row[selectorId];
          if (!cell) continue;
          const cellValue = typeof cell === 'object' && cell.value !== undefined ? cell.value : cell;
          if (typeof cellValue !== 'string') continue;
          if (!allowedValues.includes(cellValue)) {
            const suggestions = suggestMatch(cellValue, allowedValues);
            const hint = suggestions.length
              ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
              : '';
            selectorErrors.push(`  Field "${field.id}", selector "${selectorId}": "${cellValue}" is not valid.${hint}\n    Allowed: ${allowedValues.slice(0, 10).join(', ')}${allowedValues.length > 10 ? ` ... (${allowedValues.length} total)` : ''}`);
          }
        }
      }
    }
    if (selectorErrors.length > 0) {
      return {
        error: `Invalid selector values for ${svc.key}:\n${selectorErrors.join('\n')}`,
        correctedConfig: config,
        corrections: [],
      };
    }

    // Required-field-presence check at the entry point. Computes the
    // same source 1+2 union the lint uses (form-side validations.required
    // + catalog required[]), skipping the math-operand walk since the
    // saved blob doesn't exist yet at add_service time. Source 3 still
    // fires at lint time as defense-in-depth.
    //
    // Returns partial: true (NOT an error) so the entry still registers
    // in the estimate. Closes the validateConfigKeys-vs-lint gap so
    // agents see missing required fields immediately on add_service
    // instead of waiting for validate_estimate / export_estimate to refuse.
    const catalogEntry = catalog && typeof catalog.get === 'function'
      ? getEntry(catalog, svc.key) : undefined;
    const templateId = catalogEntry?.templateId
      || (typeof def.templates?.[0] === 'object' ? def.templates[0]?.id : null);
    const template = templateId ? findTemplate(def, templateId) : null;
    const missingRequired = computeMissingRequiredFields({
      template,
      catalogEntry,
      configKeys: new Set(configKeys),
    });

    return {
      error: null,
      correctedConfig,
      corrections,
      ...(truncatedCorrections ? { truncated: true } : {}),
      ...(missingRequired.length > 0 ? { missingRequired } : {}),
    };
  } catch {
    return { error: null, correctedConfig: config, corrections: [] };
  }
}

function computeMissingRequiredFields({ template, catalogEntry, configKeys }) {
  if (!template) return [];
  const required = findRequiredComponentIds(template, catalogEntry, {}, { skipMathWalk: true });
  return required.filter(id => !configKeys.has(id));
}

module.exports = { META_KEYS, levenshtein, suggestMatch, validateConfigKeys, validateFieldValue };
