// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Translate lint failures into agent-actionable next-step hints.
 *
 * The lint module reports *what's wrong*; this module reports *what to do
 * about it* in language an agent can act on without parsing predicate
 * structure.
 *
 * The catalog (catalog/services/*.json) is the source of truth for
 * curated guidance: each entry has `traps` (free-form gotchas like
 * "this is a sub-service-selector parent — don't add it directly") and
 * `subServices` (the actual child service codes plus required-field
 * examples). When a failing serviceCode matches a catalog entry, or
 * appears as a child of one, we surface the catalog's guidance verbatim
 * — the catalog is human-curated and verified, so its wording wins over
 * anything we'd invent here.
 *
 * Returns null if the lint result is healthy. Otherwise returns a single
 * string suitable for a top-level `next_step` field on the validate /
 * export response.
 */

'use strict';

// How many real field IDs to list back in invalidFieldIdsHintFor's
// "Valid field IDs for X: ..." block. Picked so the line stays readable
// in a terminal but covers the common shape (most services have 5-15
// fields; only a handful need the (N more) suffix).
const MAX_VALID_FIELD_IDS_SHOWN = 12;

// Synthetic slot ID shape — emitted by the calculator when a service is
// a parent envelope (e.g. `amazonS3` exposes `s3Services_generated_0..3`
// rather than real per-class field IDs). When *every* manifest field
// matches this shape, the agent should be redirected to the verified
// child-bearing catalog entry rather than handed an unusable field list.
const SYNTHETIC_SLOT_RE = /_generated_\d+$/;
function allFieldsAreSyntheticSlots(validIds) {
  if (!Array.isArray(validIds) || validIds.length === 0) return false;
  return validIds.every(id => SYNTHETIC_SLOT_RE.test(id));
}

// Min length below which the displayName word-match fallback in
// findCatalogEntry stops trying. Avoids matching "s3" → "Amazon S3" when
// the failing serviceCode is just an ambiguous fragment.
const MIN_DISPLAYNAME_MATCH_LEN = 3;

// Build a reverse index once: childCode → parentCatalogEntry. Lets us
// detect "agent sent a child code at top level when its parent envelope
// would have been smarter," and "agent sent the parent code when they
// should have used a child."
function buildChildToParent(catalog) {
  // Map: childServiceCode → parent catalog entry.
  // For product-code redirects (Bedrock's Titan/Nova family vs the
  // provider-granularity templates[] the calculator actually claims),
  // the entry is wrapped with `_redirectVia` so the hint can name the
  // intermediate provider code the agent should retry with.
  const index = new Map();
  if (!catalog) return index;
  for (const entry of catalog.values()) {
    for (const sub of (entry.subServices || [])) {
      if (sub.serviceCode) index.set(sub.serviceCode, entry);
      // productCodes[] are manifest codes for product-level subServices
      // (titanTextEmbeddingsV2, novaPro, ...) that route under this
      // provider but aren't in the parent envelope's templates[].
      // Index them too, but record the provider code so the hint can
      // tell the agent which code to retry with.
      for (const productCode of (sub.productCodes || [])) {
        if (productCode) index.set(productCode, { ...entry, _redirectVia: sub.serviceCode });
      }
    }
  }
  return index;
}

function trapsLine(entry) {
  const traps = entry?.traps || [];
  if (traps.length === 0) return '';
  // Use the first trap verbatim — they're written first-most-load-bearing
  // by convention and almost always carry the "use child X instead of
  // parent Y" guidance up front.
  return ` Catalog hint: ${traps[0]}`;
}

function listChildren(entry) {
  const subs = entry?.subServices || [];
  return subs.map(s => s.serviceCode).filter(Boolean);
}

function findCatalogEntry(catalog, serviceCode) {
  if (!catalog || !serviceCode) return null;
  // Exact match first (covers concrete services and parent envelopes
  // when the serviceCode happens to equal a catalog key).
  const direct = catalog.get(serviceCode);
  if (direct) return direct;
  const lower = serviceCode.toLowerCase();
  // Heuristic for the "agent sent a bare brand name like amazonS3 or
  // amazonDynamoDB but the catalog parent has a more specific name".
  // Match when the failing serviceCode is a prefix of any subService's
  // serviceCode for a catalog entry. amazonS3 → amazonS3Standard child
  // → its parent envelope. amazonDynamoDB → dynamoDbOnDemand top-level
  // entry (this last lookup is by the displayName check below).
  for (const entry of catalog.values()) {
    for (const sub of (entry.subServices || [])) {
      if (sub.serviceCode?.toLowerCase().startsWith(lower)) return entry;
    }
  }
  // Last resort: displayName word-match. "amazonDynamoDb" → catalog
  // entry with displayName containing "DynamoDB".
  const stripped = lower.replace(/^amazon/, '');
  for (const entry of catalog.values()) {
    const dn = (entry.displayName || '').toLowerCase();
    if (dn.includes(stripped) && stripped.length >= MIN_DISPLAYNAME_MATCH_LEN) return entry;
  }
  return null;
}

function PREDICATE_HINT(predicate, failure, catalog, childToParent) {
  const ctx = failure.context || {};
  const svc = ctx.serviceCode;

  if (predicate === 'empty-estimate') {
    return 'This estimate has no services. Call add_service with at least one ' +
           'service before validating or exporting.';
  }

  if (predicate === 'tenancy-pricing-mismatch') {
    const selected = ctx.selectedOption;
    return `Service ${svc}: pricingStrategy "${selected}" is invalid under ` +
           `tenancy "shared" — Standard/Convertible Reserved Instances are ` +
           `hidden by the calculator under shared tenancy, so the saved ` +
           `estimate renders Read-only. Two recovery paths: (a) set ` +
           `tenancy: "dedicated" or "host" to keep ${selected} reserved ` +
           `instances, OR (b) switch to instance-savings (the shared-tenancy ` +
           `equivalent of standard) or compute-savings (the equivalent of ` +
           `convertible). Re-add via add_service with the corrected combination.`;
  }

  if (predicate === 'template-existence') {
    // Two distinct shapes: (a) "no estimateFor" — usually means the agent
    // sent a sub-service-selector parent code, (b) "estimateFor not in
    // templates" — wrong template id.
    const want = ctx.estimateFor;
    const avail = ctx.availableTemplates || [];
    const parent = svc ? findCatalogEntry(catalog, svc) : null;
    const childList = listChildren(parent);

    if (!want) {
      // Parent-passed-as-bare-name. If the catalog tells us the right
      // children, name them; otherwise fall back to availableTemplates
      // (which the lint already collected from the manifest's templates
      // array — these ARE the child codes for sub-service-selector parents).
      const choices = childList.length > 0 ? childList : avail;
      const traps = parent ? trapsLine(parent) : '';
      if (choices.length > 0) {
        return `Service ${svc} has no estimateFor — it is a parent envelope, ` +
               `not something to add directly. Call add_service using one of ` +
               `its child service codes: ${choices.join(', ')}.${traps}`;
      }
      return `Service ${svc} has no estimateFor. It is likely a parent ` +
             `envelope. Call search_services with the service name to find a ` +
             `concrete child service code, then add_service that one.${traps}`;
    }

    if (avail.length > 0) {
      return `Service ${svc}: estimateFor "${want}" is not valid. Re-add via ` +
             `add_service with one of: ${avail.join(', ')}. ` +
             `Tip: get_service_fields lists the correct templates per service.`;
    }
    return `Service ${svc}: estimateFor "${want}" not recognized. Re-add via ` +
           `add_service after checking get_service_fields for the correct template.`;
  }

  if (predicate === 'required-field-presence') {
    const id = ctx.componentId;
    // s3Services_generated_<n> and similar synthetic keys are slot
    // markers for sub-services, not real fields. If we see one, the agent
    // almost certainly sent the parent code (e.g. amazonS3) when they
    // should have sent a specific sub-service code.
    const isSyntheticSlot = id && /_generated_\d+$/.test(id);
    if (isSyntheticSlot) {
      const parent = svc ? findCatalogEntry(catalog, svc) : null;
      const choices = listChildren(parent);
      const traps = parent ? trapsLine(parent) : '';
      if (choices.length > 0) {
        return `Service ${svc} is a parent envelope — its "${id}" slot ` +
               `expects a sub-service, not a literal value. Call add_service ` +
               `with one of these child codes instead of "${svc}": ` +
               `${choices.join(', ')}.${traps}`;
      }
      return `Service ${svc} has a synthetic "_generated_" slot which means ` +
             `it is a parent envelope. Don't add it directly — use ` +
             `search_services to find the concrete child service code.${traps}`;
    }

    if (id) {
      const entry = svc ? findCatalogEntry(catalog, svc) : null;
      const fieldDef = (entry?.required || []).find(f => f.field === id);
      const example = fieldDef?.example !== undefined
        ? ` Example: ${typeof fieldDef.example === 'string'
            ? `"${fieldDef.example}"`
            : JSON.stringify(fieldDef.example)}.`
        : '';
      return `Service ${svc} is missing required field "${id}". Re-add this ` +
             `service via add_service with "${id}" populated.${example} ` +
             `Use get_service_fields for full field details.`;
    }
    return `Service ${svc} is missing required fields. Re-add via add_service; ` +
           `check get_service_fields for the required set.`;
  }

  if (predicate === 'value-parsability') {
    const id = ctx.componentId;
    return `Service ${svc} field "${id}" has an unparseable value. Re-add via ` +
           `add_service with the correct shape; get_service_fields shows the ` +
           `expected value type for each field.`;
  }

  if (predicate === 'sub-service-active-list') {
    const parent = ctx.parentServiceCode;
    const child = ctx.childServiceCode;
    const allowed = ctx.allowedActiveList;
    if (svc && !parent) {
      // Flattened-sub-service: top-level peer that should be nested.
      // The parent's catalog entry is what the agent should have used.
      const parentEntry = childToParent.get(svc);
      if (parentEntry) {
        // Product-code redirect: agent sent a manifest product code (e.g.
        // titanTextEmbeddingsV2) that the calculator's parent envelope
        // does not claim in its templates[]. The catalog's productCodes[]
        // names the provider code (e.g. amazon) the agent must retry with.
        if (parentEntry._redirectVia) {
          const provider = parentEntry._redirectVia;
          const traps = trapsLine(parentEntry);
          return `Service "${svc}" is a product under the "${provider}" provider in ${parentEntry.serviceCode}. ` +
                 `${parentEntry.serviceCode} is structured per-provider, not per-product — ` +
                 `the calculator does not accept "${svc}" as a top-level service. ` +
                 `Call add_service with service="${provider}" instead — the server nests ` +
                 `it under ${parentEntry.serviceCode} automatically. Use get_service_fields("${provider}") ` +
                 `to discover the model selection field IDs for the specific product.${traps}`;
        }
        const choices = listChildren(parentEntry).filter(c => c !== svc);
        const traps = trapsLine(parentEntry);
        const peer = choices.length > 0
          ? ` Other valid children: ${choices.join(', ')}.`
          : '';
        return `Service "${svc}" is a sub-service of ${parentEntry.serviceCode}. ` +
               `Call add_service with service="${svc}" (the child code) — the server ` +
               `nests it under ${parentEntry.serviceCode} automatically.${peer}${traps}`;
      }
      return `Service "${svc}" is a sub-service. Re-add via add_service using a ` +
             `parent envelope's child code (e.g. "amazonS3:Standard" rather than ` +
             `"amazonS3" alone). Use search_services to find the right key.`;
    }
    if (Array.isArray(allowed) && allowed.length > 0) {
      return `Sub-service "${child}" is not allowed under parent "${parent}". ` +
             `Allowed children: ${allowed.join(', ')}. Re-add via add_service ` +
             `using one of those.`;
    }
    return `Sub-service entry under ${parent} is malformed. Re-add via add_service ` +
           `with a valid sub-service code; check search_services.`;
  }

  if (predicate === 'column-form-default-trap') {
    const id = ctx.componentId;
    const count = ctx.defaultCount;
    const inst = ctx.defaultInstanceType || '(unspecified)';
    const tableLabel = ctx.tableLabel || id;
    const rowLabel = ctx.countRowLabel || 'count';
    return `Service ${svc}'s columnFormIPM "${id}" (${tableLabel}) is missing — ` +
           `the calculator would silently default it to ${count} × "${inst}" and add ` +
           `cost the user did not authorize. To suppress: add "${id}" to ` +
           `calculationComponents with the count row "${rowLabel}" set to "0" ` +
           `(or populate it explicitly if the user actually wants those nodes). ` +
           `Use get_service_fields(${svc}) to see the row column structure.`;
  }

  if (predicate === 'definition-unavailable') {
    return `Service code "${svc || 'unknown'}" is not in the manifest. Use ` +
           `search_services to find the correct service code, then re-add via ` +
           `add_service.`;
  }

  // Unknown predicate: surface the lint message so the agent has something
  // to act on, but still nudge toward the recovery tools.
  return `Lint failure: ${failure.message}. Re-add the affected service via ` +
         `add_service after consulting get_service_fields.`;
}

/**
 * Build a next_step hint from a lintResult.
 *
 *   nextStepFor(lintResult, catalog?)
 *
 * `catalog` is the Map produced by lib/catalog.js#loadCatalog. Optional:
 * when omitted, hints fall back to manifest-derived data on the failure
 * context. Pass it from mcp-server.js to get curated catalog guidance.
 *
 * Returns null when the estimate is healthy enough to export. Otherwise
 * returns a single guidance string.
 */
function nextStepFor(lintResult, catalog) {
  if (!lintResult || lintResult.status === 'editable') return null;

  const childToParent = buildChildToParent(catalog);

  // Collect failures that should drive the next-step hint. The
  // `required-only` severity (missing required fields) is included
  // when the verdict is read-only OR required-input — both refusal
  // verdicts. For other (informational) verdicts, drop them: the
  // estimate is exportable and surfaceing required-only noise just
  // distracts the agent.
  const includeRequiredOnly =
    lintResult.status === 'read-only' || lintResult.status === 'required-input';
  const failures = [];
  for (const svc of lintResult.services || []) {
    for (const f of svc.failures || []) {
      if (!includeRequiredOnly && f.severity === 'required-only') continue;
      failures.push(f);
    }
  }

  if (failures.length === 0) return null;

  // Batch case: when all failures are `required-field-presence` for the
  // SAME service, name every missing field in one hint. Without this,
  // agents fix the first-named field, retry, get refused for the next,
  // and loop N times for N missing fields. Production 2026-06-03
  // observability: NAT averaged 8 retries per estimate (3 required
  // fields, agent iterating one-at-a-time). Collapsing the hint should
  // drop that to 1-2.
  const allRequiredOnSameService = failures.length > 1
    && failures.every(f => f.predicate === 'required-field-presence')
    && failures.every(f => f.context?.serviceCode === failures[0].context?.serviceCode);

  if (allRequiredOnSameService) {
    const svc = failures[0].context.serviceCode;
    const ids = failures.map(f => f.context?.componentId).filter(Boolean);
    return `Service ${svc} is missing ${ids.length} required fields: ` +
           `${ids.map(id => `"${id}"`).join(', ')}. Re-add via add_service with ALL of them ` +
           `populated in one call. Use get_service_fields(${svc}) for value shapes.`;
  }

  const primary = PREDICATE_HINT(failures[0].predicate, failures[0],
                                 catalog, childToParent);

  if (failures.length > 1) {
    return primary + ` (${failures.length - 1} more issue${failures.length > 2 ? 's' : ''} ` +
           `to fix; full list in lint_services.)`;
  }
  return primary;
}

// Shape of a calcmcp estimate_id (UUID v4 returned by create_estimate /
// build_estimate). 8-4-4-4-12 hex with hyphens.
const ESTIMATE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Calculator save id shape (the value AWS's save endpoint mints,
// embedded in sharable_url). 40-char lowercase hex.
const CALCULATOR_SAVE_ID_RE = /^[0-9a-f]{40}$/i;

/**
 * Hint text for the "Estimate <id> not found" failure mode. Classifies
 * what the agent likely passed and explains what the field should be.
 *
 * Returns a short string suitable for appending to the existing not-found
 * error text. Always actionable; never null.
 */
function notFoundHintFor(value) {
  const v = String(value || '');
  const looksLikeUuid = ESTIMATE_ID_RE.test(v);
  const looksLikeCalculatorSaveId = CALCULATOR_SAVE_ID_RE.test(v);

  if (looksLikeUuid) {
    return 'The id is in the right shape but the estimate is not in storage — ' +
           'estimates expire after 24h. Call create_estimate (or build_estimate) ' +
           'to start a new one and re-add the services.';
  }
  if (looksLikeCalculatorSaveId) {
    return 'That looks like a calculator save id (the 40-char hex from ' +
           'export_estimate\'s sharable_url), not the id this tool expects. ' +
           'If you want to read an existing public estimate, use ' +
           'import_estimate. To build a new one, call create_estimate and ' +
           'use the id it returns.';
  }
  // Anything else — names, free text, garbage. The empirical case from
  // production was an estimate *name* passed into estimate_id.
  return 'That looks like a name or free text, not an estimate id. The ' +
         'estimate_id argument expects the id returned by create_estimate ' +
         'or build_estimate (a 36-char hyphenated string). Call ' +
         'create_estimate to get one.';
}

/**
 * Hint for the "Invalid field IDs for <svc>" failure mode in build_estimate
 * / add_service. Two distinct shapes:
 *
 *   - validIds is empty: the manifest knows the service but it has no
 *     input fields → it's a parent envelope and the agent picked the
 *     wrong service code.
 *   - validIds is non-empty: the agent picked the right service but typed
 *     field names by intuition. Surface a small set of real field IDs so
 *     the agent has something concrete to retry with.
 *
 * Returns a string suitable for appending to the validateConfigKeys error.
 */
function invalidFieldIdsHintFor({ serviceKey, validIds, catalog }) {
  // Two parent-envelope shapes need this branch: empty validIds (the
  // textbook case — sub-service-selector parents have no input fields
  // of their own) AND validIds where every entry is a synthetic slot
  // marker (`amazonS3` exposes `s3Services_generated_0..3` — fields the
  // pricing engine doesn't actually accept from agents). Both lead the
  // agent to a verified child code; falling through to "Valid field IDs:
  // s3Services_generated_0, ..." would send them down a dead end.
  const isParentEnvelope = !validIds || validIds.length === 0
    || allFieldsAreSyntheticSlots(validIds);
  if (isParentEnvelope) {
    const entry = findCatalogEntry(catalog, serviceKey);
    const children = listChildren(entry);
    if (children.length > 0) {
      return `Service "${serviceKey}" is a parent envelope with no fields ` +
             `of its own. Call add_service / build_estimate with one of its ` +
             `child service codes: ${children.join(', ')}. ` +
             (entry.traps?.[0] ? `Catalog hint: ${entry.traps[0]}` : '');
    }
    return `Service "${serviceKey}" has no input fields — it's likely a ` +
           `parent envelope. Call search_services to find concrete child ` +
           `service codes (e.g. for "${serviceKey}"-shaped names, the ` +
           `actual codes often differ in capitalization or have suffixes ` +
           `like "Standard" / "OnDemand").`;
  }
  // Real fields exist; show the agent a sample so it can retry without
  // needing to call get_service_fields. Cap to keep the message readable.
  const sample = validIds.slice(0, MAX_VALID_FIELD_IDS_SHOWN);
  const more = validIds.length > sample.length
    ? ` (and ${validIds.length - sample.length} more — call get_service_fields for the full list)`
    : '';
  return `Valid field IDs for ${serviceKey}: ${sample.join(', ')}${more}.`;
}

/**
 * Build the partial-entry hint for an add_service result whose config
 * is missing required fields. Mirrors the batched-required-fields branch
 * of nextStepFor so the prose is identical whether the agent first sees
 * it from add_service (entry-point) or from validate_estimate (lint
 * time).
 */
function partialEntryHintFor({ serviceKey, missingFields, catalog }) {
  const entry = findCatalogEntry(catalog, serviceKey);
  // Single-field path: include the catalog example when present, same
  // shape as PREDICATE_HINT('required-field-presence').
  if (missingFields.length === 1) {
    const id = missingFields[0];
    const fieldDef = (entry?.required || []).find(f => f.field === id);
    const example = fieldDef?.example !== undefined
      ? ` Example: ${typeof fieldDef.example === 'string'
          ? `"${fieldDef.example}"`
          : JSON.stringify(fieldDef.example)}.`
      : '';
    return `Service ${serviceKey} is missing required field "${id}". ` +
           `Re-add this service via add_service with "${id}" populated.${example} ` +
           `Use get_service_fields(${serviceKey}) for full field details.`;
  }
  // Batched path: ≥2 missing on the same service.
  return `Service ${serviceKey} is missing ${missingFields.length} required fields: ` +
         `${missingFields.map(id => `"${id}"`).join(', ')}. Re-add via add_service with ALL of them ` +
         `populated in one call. Use get_service_fields(${serviceKey}) for value shapes.`;
}

module.exports = {
  nextStepFor,
  notFoundHintFor,
  invalidFieldIdsHintFor,
  partialEntryHintFor,
  allFieldsAreSyntheticSlots,
  findCatalogEntry,
  _internals: { buildChildToParent, findCatalogEntry, ESTIMATE_ID_RE, CALCULATOR_SAVE_ID_RE },
};
