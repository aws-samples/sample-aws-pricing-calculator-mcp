// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Pure helper: given a service's PCT definition, suggest a minimal
 * config the agent could send. Used by:
 *   - scripts/author-catalog.js#pad — applies suggestions to a catalog
 *     entry's minimalConfig
 *   - scripts/diagnose-service.js   — builds a no-catalog config to
 *     test whether the agent could PCT-resolve the service alone
 *
 * Returns:
 *   {
 *     config:          { region, description, [field]: value },
 *     surfaceable:     [{ id, label, subType, value }],     // what we set
 *     skipped:         [{ id, reason }]                     // surfaceable
 *                                                            // but no good
 *                                                            // default
 *                                                            // (e.g. columnFormIPM)
 *   }
 *
 * The config is minimal-and-safe for PCT-derivable fields (numericInput,
 * frequency, dropdown, fileSize, durationInput). For columnFormIPM the
 * function emits a stub that requires human customization — diagnose-
 * service.js treats services that hit this as "needs-catalog" because
 * the matrix shape isn't auto-inferable.
 */

'use strict';

const { buildSurfaceabilityIndex } = require('./surfaceability');

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_DESCRIPTION = 'PCT-derived diagnostic estimate';

// Per-subType value suggester. For frequency/dropdown we pick the FIRST
// option from the field's PCT options. For fileSize we use the field's
// defaultUnit when present. For columnFormIPM we emit a sentinel that
// callers detect via the `skipped` array.
function suggestValue(f) {
  switch (f.subType) {
    case 'numericInput':
    case 'percentInput':
      return f.defaultValue !== undefined ? String(f.defaultValue) : '1';
    case 'frequency': {
      const opts = f.options || [];
      const unit = opts[0]?.id || 'perMonth';
      return { value: '1', unit };
    }
    case 'durationInput': {
      const opts = f.options || [];
      const unit = opts[0]?.id || 'min';
      return { value: '1', unit };
    }
    case 'fileSize':
      return { value: '1', unit: f.defaultUnit || 'gb|NA' };
    case 'dropdown': {
      const opts = f.options || [];
      return opts[0]?.id || '';
    }
    case 'columnFormIPM':
      return undefined;  // sentinel — caller must record as skipped
    default:
      return '1';
  }
}

function suggestConfigFromPCT(definition, {
  region = DEFAULT_REGION,
  description = DEFAULT_DESCRIPTION,
  highVolume = false,
} = {}) {
  if (!definition) {
    return { config: { region, description }, surfaceable: [], skipped: [] };
  }
  const { fields } = buildSurfaceabilityIndex(definition);
  const config = { region, description };
  const surfaceable = [];
  const skipped = [];

  for (const f of fields.values()) {
    if (f.surfaceable !== true) continue;  // skip conditional + not-surfaceable
    if (!f.label) continue;
    const value = suggestValue(f);
    if (value === undefined) {
      skipped.push({ id: f.id, reason: `${f.subType} requires per-service customization` });
      continue;
    }
    // High-volume override for numeric/frequency fields — pushes past
    // free tiers so cost renders. Use case: the diagnostic tries normal
    // first, then high-volume, to distinguish "PCT-sufficient at any
    // volume" from "PCT-sufficient only above free tier."
    if (highVolume) {
      if (typeof value === 'string' && /^\d+$/.test(value)) {
        config[f.id] = '1000000';
        surfaceable.push({ id: f.id, label: f.label, subType: f.subType, value: '1000000' });
        continue;
      }
      if (value && typeof value === 'object' && /^\d+$/.test(String(value.value))) {
        const high = { ...value, value: '1000000' };
        config[f.id] = high;
        surfaceable.push({ id: f.id, label: f.label, subType: f.subType, value: high });
        continue;
      }
    }
    config[f.id] = value;
    surfaceable.push({ id: f.id, label: f.label, subType: f.subType, value });
  }

  return { config, surfaceable, skipped };
}

module.exports = { suggestConfigFromPCT, suggestValue };
