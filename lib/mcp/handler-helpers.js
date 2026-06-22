// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared internals for the MCP tool handlers. Pulled out of mcp-server.js
 * so the entry point reads as "9 tool registrations" rather than 689
 * lines of mixed prose, schema, and helper bodies.
 *
 * Each helper here is invoked from one or more handlers in mcp-server.js.
 * The catalog is passed in once at module init via createHandlerHelpers()
 * — every helper closes over it rather than re-loading per call. The
 * estimates store is passed similarly. Tests inject mocks via the same
 * factory.
 */

'use strict';

const { PARTITIONS, loadManifest, fetchServiceDefinition, extractInputFields, enrichFieldsWithMetadata, findService } = require('../aws/aws-client');
const { validateConfigKeys } = require('../lint/validation');
const { canRehydrateFetch } = require('../lint/can-rehydrate-fetch');
const { nextStepFor, notFoundHintFor, allFieldsAreSyntheticSlots, findCatalogEntry, partialEntryHintFor } = require('../lint/lint-hints');
const { getEntry } = require('../lint/catalog');
const { synthesizeAgentFields } = require('../aws/agent-fields');
const traceEvents = require('../trace/trace-events');

// MCP response envelope shorthands. Tools register handlers that return
// `{ content: [{ type: 'text', text }], isError? }`; before these helpers
// every return statement reconstructed that shape inline (~23 sites).
// Centralizing also pins the error envelope shape so changes happen in
// one place.
function mcpTextOk(text) {
  return { content: [{ type: 'text', text }] };
}
function mcpTextErr(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function mcpJsonOk(obj) {
  return mcpTextOk(JSON.stringify(obj, null, 2));
}

// Partition validation. The same 2-line PARTITIONS[p] check + identical
// error message was repeated across 4 tool handlers. Returns null when
// the partition is valid (or absent — most tools accept undefined as
// "default to aws"); returns an MCP error envelope ready to short-circuit
// when the partition is unknown. Pass `requireExplicit=true` to reject
// missing/empty p (search_services and get_service_fields default to 'aws'
// before checking, so they always pass a non-empty value here).
function checkPartition(p, { requireExplicit = false } = {}) {
  if (!p && !requireExplicit) return null;
  if (PARTITIONS[p]) return null;
  return mcpTextErr(`Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}`);
}

// Parse the `services` JSON-string argument used by add_service and
// build_estimate. Both accept a single-object shorthand and normalize
// to an array. Returns `{ entries }` on success, `{ error }` (an MCP
// envelope) on parse failure.
function parseServicesArg(servicesStr) {
  try {
    let entries = JSON.parse(servicesStr);
    if (!Array.isArray(entries)) entries = [entries];
    return { entries };
  } catch {
    return { error: mcpTextErr('Invalid JSON in services parameter.') };
  }
}

/**
 * Inject any catalog `defaultFields` keys absent from the agent's config.
 *
 * The calculator silently demands certain fields whose `validations.required`
 * is FALSE in the manifest — so neither `get_service_fields` flags them
 * nor does the lint refuse without them. Authors declare the literal
 * saved-blob shape under `defaultFields` on the catalog entry; this
 * helper does a non-destructive merge: keys already in the agent's
 * config win, missing keys get the catalog default.
 *
 * Returns a new object when any merge happened; returns the input config
 * reference when there's nothing to inject (so callers that rely on
 * identity stay correct).
 */
function applyDefaultFields(config, catalogEntry) {
  const defaults = catalogEntry?.defaultFields;
  if (!defaults || typeof defaults !== 'object') return config;
  let merged = null;
  for (const [k, v] of Object.entries(defaults)) {
    if (k in config) continue;
    if (merged === null) merged = { ...config };
    merged[k] = v;
  }
  return merged === null ? config : merged;
}

/**
 * Find an existing entry in the estimate that matches the agent's
 * incoming (serviceCode, description, group) tuple. Used to surface a
 * non-blocking duplicate warning on add_service responses.
 *
 * Returns a small descriptor `{ service, description, group }` when a
 * match is found, or `null` otherwise. The match is on
 * description-equality — agents usually re-use the same description on
 * a retry, and a true duplicate (same description, same service, same
 * group) is the production case we're catching.
 *
 * Production case 2026-06-07: same prompt produced two different saves
 * because session 2's agent retried add_service after a perceived
 * issue, stacking a second Prod entry on top of the original. add_service
 * had no signal to surface the impending duplicate; the saved estimate
 * was 33% over-priced.
 */
function findExistingEntry(estimate, serviceCode, description, group) {
  if (typeof description !== 'string' || !description) return null;
  const targetGroup = group || null;
  // Stored entries live in two buckets: top-level services (ungrouped)
  // and groups[name].services (grouped). The compositeKey is either
  // `serviceCode` or `serviceCode:instance` — that's how we recover
  // the service identity since EstimateBuilder doesn't replicate it
  // onto the config object.
  const bucket = targetGroup
    ? (estimate.groups || {})[targetGroup]?.services
    : estimate.services;
  if (!bucket) return null;
  for (const [key, config] of Object.entries(bucket)) {
    const storedService = key.split(':')[0];
    if (storedService !== serviceCode) continue;
    if (config && config.description === description) {
      return { service: serviceCode, description, group: targetGroup };
    }
  }
  return null;
}

function createHandlerHelpers({ catalog }) {
  // Shared by add_service and build_estimate. Validates each entry,
  // adds it to the estimate, and returns per-entry results in the same
  // shape both tools use. Keeps the JSON-string config parsing + the
  // validation-corrections plumbing in one place.
  async function addEntries(estimate, entries) {
    const results = [];
    for (const entry of entries) {
      const { service, instance, group } = entry;
      let config = entry.config;
      if (!service || !config) {
        results.push({ error: 'Missing "service" or "config" in entry', entry });
        continue;
      }
      if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch {
          results.push({ error: 'Invalid JSON in config', service });
          continue;
        }
      }
      const key = instance ? `${service}:${instance}` : service;
      const validation = await validateConfigKeys(service, config, estimate.partition, catalog);
      if (validation.error) {
        results.push({ error: validation.error, service: key });
        continue;
      }
      config = validation.correctedConfig;
      const catalogEntry = getEntry(catalog, service);
      // defaultFields injection: the calculator silently demands certain
      // fields that the manifest does NOT mark validations.required (e.g.
      // EC2's dataTransferForEC2 envelope, with three rows of empty
      // INBOUND/OUTBOUND/INTRA_REGION slots). Catalog authors declare the
      // literal saved-blob shape under `defaultFields`; this merge
      // injects any keys absent from the user's config. Lives here, not
      // in the per-service transform (lib/ec2.js), so the same primitive
      // is available to every service that needs it.
      config = applyDefaultFields(config, catalogEntry);
      // Pass the catalog's templateId as a hint to the builder so multi-
      // template services (Cognito, MQ, etc.) route through the human-
      // curated tier rather than field-membership scoring's tie-break.
      // The hint always wins when present — but unverified entries emit a
      // trace event because their templateId is itself an unconfirmed
      // guess (e.g. CloudFront's catalog says productPackd1 while
      // inference picks CDN; nobody has browser-confirmed which is
      // right). The gate is observability, not enforcement: a wrong
      // unverified hint surfaces in traces for follow-up rather than
      // silently corrupting saves.
      const templateIdHint = catalogEntry?.templateId || undefined;
      if (templateIdHint && catalogEntry.status === 'unverified') {
        traceEvents.templateHint.unverified({
          serviceCode: service,
          templateId: templateIdHint,
          estimateId: estimate.id,
        });
      }
      // Duplicate detection: check BEFORE addService so the response
      // surfaces the existing entry. Detection is purely advisory; the
      // entry still registers (we don't auto-dedupe — that's a behavior
      // change deferred). The agent's recovery path on seeing this
      // signal: call create_estimate to start fresh, which is documented
      // in the ADD_SERVICE description's RETRY SEMANTICS section.
      const existingEntry = findExistingEntry(estimate, service, config.description, group);
      estimate.addService(key, config, { group, templateIdHint });
      const result = { success: true, service: key, group: group || '(ungrouped)' };
      if (existingEntry) {
        result.existing_entry = existingEntry;
        result.warning =
          `An entry with service="${service}" and description="${config.description}" ` +
          `already exists in this estimate (group: "${existingEntry.group || '(ungrouped)'}"). ` +
          `add_service has appended a duplicate row — this inflates the cost. If you intended ` +
          `to replace the previous attempt (e.g. retrying after an error), call create_estimate ` +
          `to start fresh instead.`;
      }
      if (validation.corrections.length > 0) {
        result.corrections = validation.corrections;
        if (validation.truncated) result.truncated = true;
      }
      // Partial-entry warning: validation accepted the entry (every
      // present field is valid) but the catalog/manifest declares
      // required fields the agent omitted. The entry IS registered in
      // the estimate; the agent gets a same-call signal to recover by
      // re-calling add_service with the missing fields populated.
      // Closes the validateConfigKeys-vs-lint required gap.
      if (validation.missingRequired && validation.missingRequired.length > 0) {
        result.partial = true;
        result.missing_required_fields = validation.missingRequired;
        result.next_step = partialEntryHintFor({
          serviceKey: service,
          missingFields: validation.missingRequired,
          catalog,
        });
      }
      results.push(result);
    }
    return results;
  }

  // Shared by export_estimate, build_estimate, and validate_estimate.
  // Builds the would-be saved payload and runs the rehydration linter.
  // Returns the verdict + payload regardless of read-only status — callers
  // decide whether to short-circuit (export) or surface the verdict
  // (validate).
  async function lintEstimate(estimate) {
    const blob = await estimate.toAWSPayload();
    // estimate.partition may be null (default 'aws' wasn't set explicitly).
    // canRehydrateFetch's destructure default fires only on undefined, so
    // coerce null→undefined at the call site.
    const lintResult = await canRehydrateFetch({
      savedBlob: blob,
      partition: estimate.partition || undefined,
      catalog,
    });
    return { blob, lintResult };
  }

  // Standard MCP-shaped result for the three sites that return early when
  // an estimate isn't in the store. Bundles the not-found line and a hint
  // classifying what the agent passed (UUID-shape / save-id / free text).
  function estimateNotFoundResult(estimateId) {
    return mcpTextErr(`Estimate "${estimateId}" not found.\n\nNext step: ${notFoundHintFor(estimateId)}`);
  }

  // Format a lint refusal into a human-readable message. The verdict
  // determines which failures to surface and the framing — read-only
  // means the saved blob would rehydrate as a useless husk, while
  // required-input means the calculator would silently default the
  // missing fields and price against a value the user never chose.
  function formatLintRefusal(lintResult, prefix) {
    const verdict = lintResult.status;
    // For required-input refusals, only the missing-required failures
    // matter — other (lower-severity) noise should not dilute the
    // remediation message.
    const includeFailure = verdict === 'required-input'
      ? (f) => f.severity === 'required-only'
      : () => true;
    const failureSummary = lintResult.services
      .map(s => s.failures.filter(includeFailure).map(f => f.message).join('; '))
      .filter(Boolean)
      .join(' | ');
    const predicates = lintResult.services
      .flatMap(s => s.failures.filter(includeFailure).map(f => f.predicate))
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');
    // Concrete remediation hint, in language the agent can act on directly.
    // Pass the catalog so curated `traps` and `subServices` data wins over
    // generic fallback wording.
    const hint = nextStepFor(lintResult, catalog);
    const hintBlock = hint ? `\n\nNext step: ${hint}` : '';
    const reason = verdict === 'required-input'
      ? 'the saved estimate is missing required fields the calculator would silently default'
      : 'the saved estimate would rehydrate as read-only';
    return `${prefix} ${reason}. ${failureSummary}${hintBlock}\n\nPredicate names: ${predicates}.`;
  }

  // Shared by export_estimate and build_estimate. Runs the rehydration
  // lint preflight and either returns the saved estimate's URL/ID or
  // returns an MCP-shaped error result describing which predicate failed.
  // Refuses on both read-only AND required-input verdicts: read-only
  // because the saved blob is unusable, required-input because the
  // calculator silently defaults missing required fields and prices
  // against a value the user never chose.
  async function exportWithLint(estimate) {
    const { lintResult } = await lintEstimate(estimate);
    traceEvents.lint({ verdict: lintResult.status, services: lintResult.services, estimateId: estimate.id });
    if (lintResult.status === 'read-only' || lintResult.status === 'required-input') {
      return {
        isError: true,
        text: formatLintRefusal(lintResult, 'Export refused —'),
      };
    }
    const result = await estimate.export();
    return { isError: false, sharable_url: result.shareableUrl, aws_estimate_id: result.estimateId };
  }

  // Build the {serviceCode, fields, catalog} block returned by
  // get_service_fields for one resolved service. Pulled out so the
  // parent-envelope redirect branch can pre-fetch the same payload for
  // the redirect target's first child code, sparing the agent a second
  // round trip in the unambiguous case.
  async function buildFieldsResult(svcEntry, partition) {
    const manifest = await loadManifest(partition);
    const def = await fetchServiceDefinition(manifest, svcEntry.key, partition);
    if (!def) return null;
    const fs = extractInputFields(def);
    const enriched = await enrichFieldsWithMetadata(def, fs);
    const synthesized = synthesizeAgentFields(svcEntry.key, enriched);
    const out = { serviceCode: svcEntry.key, serviceName: svcEntry.name, fields: synthesized };
    const ce = getEntry(catalog, svcEntry.key);
    if (ce) {
      out.catalog = {
        status: ce.status,
        templateId: ce.templateId,
        required: ce.required,
        traps: ce.traps,
        subServices: ce.subServices,
        minimalConfig: ce.minimalConfig,
        lastVerifiedAt: ce.lastVerifiedAt,
      };
    }
    return out;
  }

  // Reverse index: productCode → { parentEntry, providerCode } for any
  // catalog entry's subServices[].productCodes[] declarations. Built once
  // per handler-helpers init, used by the discovery-time redirects
  // (get_service_fields and search_services) so an agent who reaches for
  // a product-level Bedrock code (e.g. titanTextEmbeddingsV2) gets pointed
  // at the provider envelope (e.g. amazon) BEFORE attempting a save —
  // shaving the wasted save+lint-refusal turn observed in production.
  const productCodeIndex = new Map();
  if (catalog) {
    for (const entry of catalog.values()) {
      for (const sub of (entry.subServices || [])) {
        for (const productCode of (sub.productCodes || [])) {
          if (productCode) {
            productCodeIndex.set(productCode, {
              parentEntry: entry,
              providerCode: sub.serviceCode,
            });
          }
        }
      }
    }
  }

  // Detect get_service_fields product-redirect: service code is listed in
  // some catalog entry's subServices[].productCodes[] (e.g. Bedrock's
  // titan/nova family). The calculator's parent envelope only claims
  // provider-granularity codes, so the agent should call
  // get_service_fields(<provider>) instead. Empirical: Sonnet 4.5
  // experiment 2026-06-03 showed this redirect cuts tool calls 6→3 vs
  // post-save lint refusal. Returns the redirect envelope (with preview
  // of the provider's fields) or null if no redirect applies.
  async function maybeBuildProductRedirect({ svc, partition }) {
    const match = productCodeIndex.get(svc.key);
    if (!match) return null;
    const { parentEntry, providerCode } = match;

    let preview = null;
    const manifest = await loadManifest(partition);
    const providerSvc = findService(manifest, providerCode);
    if (providerSvc) {
      try { preview = await buildFieldsResult(providerSvc, partition); } catch {}
    }
    traceEvents.getServiceFields.redirectToParent({
      serviceCode: svc.key,
      redirectTo: providerCode,
      childCodes: [providerCode],
      previewServiceCode: preview?.serviceCode || null,
    });
    return {
      serviceCode: svc.key,
      serviceName: svc.name,
      status: 'redirect_to_provider',
      next_step: `Service "${svc.key}" is a product under the "${providerCode}" provider in ${parentEntry.serviceCode}. ` +
        `${parentEntry.serviceCode} is structured per-provider, not per-product — ` +
        `the calculator does not accept "${svc.key}" as a top-level service. ` +
        `Use service code "${providerCode}" with add_service / build_estimate; ` +
        `select the specific model via modelSelection in the provider's field set ` +
        `(previewed below).`,
      redirect_to: providerCode,
      parent_service_code: parentEntry.serviceCode,
      catalog: {
        status: parentEntry.status,
        traps: parentEntry.traps,
      },
      ...(preview ? { preview_fields_for: preview } : {}),
    };
  }

  // Annotate search_services results: any hit whose key is a product
  // code in some catalog entry's productCodes[] gets a `redirect_to` and
  // `note` so the agent sees the redirect target in the same response.
  // No additional tool round-trip; pure post-processing of the manifest
  // search.
  function annotateSearchResults(results) {
    if (!productCodeIndex.size) return results;
    const annotate = (hit) => {
      const match = productCodeIndex.get(hit.key);
      if (!match) return hit;
      return {
        ...hit,
        redirect_to: match.providerCode,
        note: `Product under "${match.providerCode}" provider in ${match.parentEntry.serviceCode}; use service code "${match.providerCode}" in add_service / build_estimate.`,
      };
    };
    if (Array.isArray(results)) return results.map(annotate);
    // Multi-term search returns { term: [...hits] }
    const out = {};
    for (const [k, v] of Object.entries(results)) {
      out[k] = Array.isArray(v) ? v.map(annotate) : v;
    }
    return out;
  }

  // Detect get_service_fields parent-envelope redirect: service is
  // isActive:false, PCT exposes only synthetic-slot field IDs, and a
  // catalog entry covers the same brand under a different code. Returns
  // the redirect envelope (with preview-fetch of the first child) or
  // null if no redirect applies.
  async function maybeBuildRedirectResult({ svc, fields, partition }) {
    const validIds = fields.map(f => f.id);
    const isInactive = svc.isActive === 'false';
    const allSynthetic = allFieldsAreSyntheticSlots(validIds);
    if (!isInactive || !allSynthetic) return null;
    const redirect = findCatalogEntry(catalog, svc.key);
    if (!redirect || redirect.serviceCode === svc.key) return null;

    const childCodes = (redirect.subServices || [])
      .map(s => s.serviceCode).filter(Boolean);
    let preview = null;
    if (childCodes[0]) {
      const manifest = await loadManifest(partition);
      const childSvc = findService(manifest, childCodes[0]);
      if (childSvc) {
        try { preview = await buildFieldsResult(childSvc, partition); } catch {}
      }
    }
    traceEvents.getServiceFields.redirectToParent({
      serviceCode: svc.key,
      redirectTo: redirect.serviceCode,
      childCodes,
      previewServiceCode: preview?.serviceCode || null,
    });
    const result = {
      serviceCode: svc.key,
      serviceName: svc.name,
      status: 'redirect_to_parent',
      next_step: `Service "${svc.key}" is a deprecated parent envelope ` +
        `with no real input fields. Use one of the verified child ` +
        `service codes instead: ${childCodes.join(', ')}. ` +
        (childCodes.length > 1
          ? `Pick the one matching the user's intent — fields for "${childCodes[0]}" ` +
            `are previewed below; if a different child fits better, call ` +
            `get_service_fields with that code.`
          : `Fields for "${childCodes[0]}" are previewed below; use that code in add_service.`),
      redirect_to: redirect.serviceCode,
      child_service_codes: childCodes,
      catalog: {
        status: redirect.status,
        traps: redirect.traps,
        subServices: redirect.subServices,
      },
    };
    if (preview) result.preview_fields_for = preview;
    return result;
  }

  return {
    addEntries,
    lintEstimate,
    estimateNotFoundResult,
    formatLintRefusal,
    exportWithLint,
    buildFieldsResult,
    maybeBuildRedirectResult,
    maybeBuildProductRedirect,
    annotateSearchResults,
  };
}

module.exports = {
  createHandlerHelpers,
  mcpTextOk,
  mcpTextErr,
  mcpJsonOk,
  checkPartition,
  parseServicesArg,
};
