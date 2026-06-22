// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

'use strict';

/**
 * Synthetic fields surfaced to agents on top of the manifest's PCT inputs.
 *
 * Some knobs that production agents need are not exposed as discrete
 * fields in the manifest — they live inside composite component types
 * (e.g. ec2Enhancement's utilization is buried inside the
 * `ec2AdvPricingStrategyV2` component as a sub-field of pricingStrategy).
 * `extractInputFields` returns only the top-level inputs, so an agent
 * doing get_service_fields sees no `utilization` and has no agent-visible
 * affordance to set it.
 *
 * This module owns the agent-discovery layer for those gaps. It runs
 * AFTER extractInputFields + enrichFieldsWithMetadata in two places:
 *   - lib/handler-helpers.js (get_service_fields path) — agents see the
 *     synthetic field in the field list.
 *   - lib/validation.js (validateConfigKeys path) — the synthetic id is
 *     accepted as a valid config key, not auto-corrected away.
 *
 * The transform side (lib/ec2.js) reads top-level config.utilization
 * already; no changes there. The synthesis is purely a discovery shim.
 *
 * Production case 2026-06-03 (estimate 7898fb2d65a09e...): user asked
 * for "two g6e.24xlarge at 80% utilization", agent saved with
 * pricingStrategy='ondemand' string and never set utilization. Closing
 * message told the user to "monitor actual usage and apply a 0.8x
 * multiplier" — agent literally gave up because the knob wasn't visible.
 */

const SYNTHETIC_BY_SERVICE = {
  ec2Enhancement: [
    {
      id: 'utilization',
      type: 'numericInput',
      label: 'Utilization (% of month, 1–100)',
      helpText:
        'Percent of the month the instance is running (1–100, default 100). ' +
        'Pass as a top-level string, e.g. utilization: "80". The transform ' +
        'routes it into pricingStrategy.value.utilizationValue. The PCT does ' +
        'not surface this field directly because it is nested inside the ' +
        'pricingStrategy component — pass it at the top level of your config.',
      default: '100',
      _synthetic: true,
    },
  ],
};

/**
 * Append synthetic agent-discovery fields for a given serviceCode.
 *
 * No-op for services without synthetics (most of the catalog). Returns
 * the same `fields` array reference if no synthetics apply, so callers
 * that rely on identity stay correct.
 */
function synthesizeAgentFields(serviceCode, fields) {
  const additions = SYNTHETIC_BY_SERVICE[serviceCode];
  if (!additions || additions.length === 0) return fields;
  // De-dupe in the unlikely case the manifest already exposes the id.
  const existing = new Set(fields.map(f => f.id));
  const fresh = additions.filter(a => !existing.has(a.id));
  if (fresh.length === 0) return fields;
  return [...fields, ...fresh];
}

module.exports = { synthesizeAgentFields };
