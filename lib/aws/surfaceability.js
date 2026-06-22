// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Surfaceability index — predicts which fields will appear in the
 * calculator's CSV "Configuration summary" column.
 *
 * The calculator's CSV exporter concatenates each calculationComponent's
 * `configSummaryString`. Per-subtype containers only set
 * `configSummaryString` when the PCT marks `displayInConfigSummary: true`.
 * Common containers and their formats:
 *   - numericInput        → `${label} (${value})`
 *   - frequency           → `${label} (${value} ${selectedOption.label})`
 *   - durationInput       → `${label} (${value} ${selectedOption.label})`
 *   - dropdown            → `${label} (${selectedLabel})`
 *   - fileSize            → `${label} (${value} ${selectedOption.label})`
 *   - ec2AdvPricingMetrics → `${label} (${value})`
 * Containers for math/intermediate components (basicMaths,
 * tieredPricingMath, variable, priceSelector, rounding, concatenate,
 * etc.) hard-code configSummaryString to null — they never surface.
 *
 * For ec2Enhancement the calculator hard-codes a curated picklist of
 * components that get included (tenancy, selectedOS, workload,
 * instanceType, pricingStrategy, detailedMonitoringCheckbox,
 * storageAmount/storageAmountDH, storageAmountIo2, dataTransferForEC2).
 * That picklist overrides displayInConfigSummary for the EC2 path.
 */

// Components ec2Enhancement explicitly surfaces, regardless of the
// PCT's displayInConfigSummary flag — the calculator's CSV exporter
// hardcodes this picklist for the EC2 path.
const EC2_ENHANCEMENT_SURFACED = new Set([
  'tenancy',
  'selectedOS',
  'workload',
  'instanceType',
  'pricingStrategy',
  'detailedMonitoringCheckbox',
  'storageAmount',
  'storageAmountDH',
  'storageAmountIo2',
  'dataTransferForEC2',
]);

// EC2-specific component containers that hardcode their own
// configSummaryString labels rather than reading from inputData.label.
// The PCT labels (e.g. "Advance pricing strategy", "Advance workloads")
// are not what the calculator renders in the CSV — these containers
// override them. This map mirrors the override at the surfaceability
// layer so label-based matching works for catalog-driven EC2 estimates.
const EC2_ENHANCEMENT_LABEL_OVERRIDES = {
  pricingStrategy: 'Pricing strategy',
  workload: 'Workload',
};

// dataTransferForEC2 doesn't surface as a single label — its container
// emits one `DT <entryType>: ...` row per (Inbound, Outbound,
// Intra-Region) entry. Excluded from the surfaceability label set
// since there's no single label to match.
const EC2_ENHANCEMENT_NO_SINGLE_LABEL = new Set([
  'dataTransferForEC2',
]);

// SubTypes whose container hard-codes configSummaryString=null
// (mathematical / intermediate components — they never surface even if
// the PCT mistakenly sets displayInConfigSummary: true).
const NEVER_SURFACES_SUBTYPES = new Set([
  'basicMaths',
  'tieredPricingMath',
  'variable',
  'priceSelector',
  'rounding',
  'concatenate',
  'pricingTablePLC2',
  'replaceString',
]);

/**
 * Walks a PCT definition and returns:
 *   { fields: Map<id, { id, label, subType, surfaceable, conditional }>, source }
 * where `source` is 'ec2Enhancement-curated' for the EC2 special case
 * and 'displayInConfigSummary' otherwise.
 *
 * Surfaceable values:
 *   - true   — PCT marks the field surfaceable AND no displayIf gates it
 *   - false  — PCT marks displayInConfigSummary: false (or the subType
 *              never surfaces, or the ec2Enhancement curated list omits
 *              it)
 *   - 'conditional' — PCT marks the field surfaceable BUT it (or one of
 *              its ancestors) has a displayIf. Whether it actually
 *              appears in the CSV depends on the displayIf evaluating
 *              true at rehydrate time, which is a runtime concern.
 *              Treated as "exclude from expected set" by the matcher
 *              so a missing label doesn't produce a false-positive
 *              Partial.
 *
 * For a field id that appears in multiple templates (Lambda's free-tier
 * vs without-free-tier duplicates), the index keeps the FIRST occurrence.
 * This matches extractInputFields' deduplication policy in
 * lib/aws-client.js.
 *
 * Returns an empty index for falsy / non-object input.
 */
function buildSurfaceabilityIndex(definition) {
  const fields = new Map();
  if (!definition || typeof definition !== 'object') {
    return { fields, source: 'displayInConfigSummary' };
  }

  const isEc2Enhancement = definition.serviceCode === 'ec2Enhancement';
  const source = isEc2Enhancement ? 'ec2Enhancement-curated' : 'displayInConfigSummary';

  const visit = (node, ancestorConditional) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, ancestorConditional);
      return;
    }
    // A node is "conditional" if it (or any ancestor) carries a
    // displayIf. Mirrors lib/can-rehydrate.js predicate 2's walk so the
    // two stay in agreement about which fields the calculator gates at
    // rehydrate time.
    const conditional = ancestorConditional ||
      Object.prototype.hasOwnProperty.call(node, 'displayIf');

    if (typeof node.id === 'string' && typeof node.subType === 'string') {
      // Skip duplicate-of-an-existing-id (matches extractInputFields' dedup).
      if (!fields.has(node.id)) {
        const baseSurfaceable = NEVER_SURFACES_SUBTYPES.has(node.subType)
          ? false
          : isEc2Enhancement
            ? EC2_ENHANCEMENT_SURFACED.has(node.id)
            : node.displayInConfigSummary === true;
        const surfaceable = baseSurfaceable && conditional
          ? 'conditional'
          : baseSurfaceable;
        // For ec2Enhancement, fields whose container hardcodes a
        // different label override the PCT label; fields with no
        // single label (dataTransferForEC2) drop the label entirely.
        let label = node.label || null;
        if (isEc2Enhancement && baseSurfaceable) {
          if (EC2_ENHANCEMENT_NO_SINGLE_LABEL.has(node.id)) {
            label = null;
          } else if (EC2_ENHANCEMENT_LABEL_OVERRIDES[node.id]) {
            label = EC2_ENHANCEMENT_LABEL_OVERRIDES[node.id];
          }
        }
        fields.set(node.id, {
          id: node.id,
          label,
          subType: node.subType,
          surfaceable,
          conditional,
        });
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') visit(v, conditional);
    }
  };
  visit(definition, false);
  return { fields, source };
}

/**
 * Convenience wrapper: returns the set of labels predicted to
 * unconditionally surface in the CSV summary. Conditional fields
 * (gated by a displayIf) are excluded — the calculator only renders
 * them when the displayIf evaluates true at rehydrate time, which
 * the static analysis can't determine.
 *
 * Useful for csv-match.js where labels (not ids) are how we look
 * things up. The matcher excludes labels not in this set from the
 * expected set, so conditional fields don't produce false-positive
 * Partials when the calculator legitimately doesn't surface them.
 */
function surfaceableLabels(definition) {
  const { fields } = buildSurfaceabilityIndex(definition);
  const out = new Set();
  for (const f of fields.values()) {
    if (f.surfaceable === true && f.label) out.add(f.label);
  }
  return out;
}

module.exports = {
  buildSurfaceabilityIndex,
  surfaceableLabels,
  EC2_ENHANCEMENT_SURFACED,
  NEVER_SURFACES_SUBTYPES,
};
