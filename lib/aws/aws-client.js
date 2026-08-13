// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const traceEvents = require('../trace/trace-events');
const SAVE_URL = process.env.AWS_SAVE_URL || 'https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs';
const CDN_BASE = 'https://d1qsjq9pzbk1k6.cloudfront.net';

const PARTITIONS = {
  'aws': {
    manifestPath: '/manifest/en_US.json',
    cdnPrefix: '',
    contract: null,
    awsPartition: 'aws',
    regions: {},
  },
  'aws-iso': {
    manifestPath: '/aws-iso/manifest/en_US.json',
    cdnPrefix: '/aws-iso',
    contract: '5423f8cd3b711c6f899ba4dade31b50c',
    awsPartition: 'aws-iso',
    regions: {
      'us-iso-east-1': 'US ISO East',
      'us-iso-west-1': 'US ISO West',
    },
  },
  'aws-iso-b': {
    manifestPath: '/aws-iso-b/manifest/en_US.json',
    cdnPrefix: '/aws-iso-b',
    contract: '5423f8cd3b711c6f899ba4dade31b50c',
    awsPartition: 'aws-iso-b',
    regions: {
      'us-isob-east-1': 'US ISOB East (Ohio)',
    },
  },
  'aws-eusc': {
    manifestPath: '/getAllServiceDetails/aws-eusc/manifest/en_US.json',
    cdnPrefix: '/getAllServiceDetails/aws-eusc',
    cdnBase: 'https://pricing.calculator.aws.eu',
    saveUrl: 'https://bieyocog1d.execute-api.eusc-de-east-1.amazonaws.eu/Prod/v2/saveAs',
    readBase: 'https://pricing.calculator.aws.eu/getSavedEstimates',
    shareableBase: 'https://pricing.calculator.aws.eu/#/estimate?id=',
    contract: null,
    awsPartition: 'aws-eusc',
    regions: {
      'eusc-de-east-1': 'AWS European Sovereign Cloud (Germany)',
    },
  },
};

function resolvePartition(region) {
  if (!region) return 'aws';
  if (region.startsWith('us-iso-')) return 'aws-iso';
  if (region.startsWith('us-isob-')) return 'aws-iso-b';
  if (region.startsWith('eusc-')) return 'aws-eusc';
  return 'aws';
}

const manifestCache = new Map();
const definitionCache = new Map();
const metadataCache = new Map();
const regionListCache = new Map();
const aggregationCache = new Map();

// Per-service region whitelist endpoint. Manifest entries carry a `regions[]`
// field but it's populated for only ~40% of services (175/436 as of 2026-05-30);
// this companion file covers ~91% (396/436) and is the authoritative source
// the calculator's frontend itself reads. Empty array = "all regions" (sentinel).
// `aws-iso` / `aws-iso-b` partitions don't publish this; we skip validation there.
const REGION_LIST_PATH = '/manifest/regionList/publish.json';

async function loadRegionList(partition = 'aws') {
  if (partition !== 'aws') return null;
  if (regionListCache.has(partition)) return regionListCache.get(partition);
  const url = `${CDN_BASE}${REGION_LIST_PATH}`;
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  })();
  regionListCache.set(partition, promise);
  promise.catch(() => regionListCache.delete(partition));
  return promise;
}

const METADATA_CDN = 'https://calculator.aws';

/**
 * Fetch PLC_2.0 metadata.json for a mapping definition.
 * Returns { valueAttributes, primarySelectors, secondarySelectors } or null on failure.
 */
async function fetchMappingMetadata(mappingDef) {
  if (!mappingDef || mappingDef.mappingDefinitionVersion !== 'PLC_2.0') return null;
  const url = mappingDef.mappingDefinitionURL;
  if (!url || !url.endsWith('metadata.json')) return null;

  const resolved = `${METADATA_CDN}/${url.replace('[currency]', 'USD')}`;
  if (metadataCache.has(resolved)) return metadataCache.get(resolved);

  const promise = (async () => {
    try {
      const res = await fetch(resolved);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        valueAttributes: data.valueAttributes || {},
        primarySelectors: data.primarySelectors || [],
        secondarySelectors: data.secondarySelectors || [],
        // The exact Location labels the aggregation files are keyed by
        // (e.g. "EU (Ireland)", "Israel (Tel Aviv)"). These DIFFER from
        // the blob's regionName (e.g. "Europe (Ireland)"), so the tuple
        // predicate resolves blob → agg label by parenthetical city match.
        regionLocations: (data.regionAttributes && Array.isArray(data.regionAttributes.Location))
          ? data.regionAttributes.Location
          : [],
      };
    } catch { return null; }
  })();

  metadataCache.set(resolved, promise);
  return promise;
}

// Extract the parenthetical "city" from a region label, e.g.
// "Europe (Ireland)" → "ireland", "Israel (Tel Aviv)" → "tel aviv".
// Used to bridge the blob's regionName and the aggregation files'
// Location labels, which name the same city under different prefixes
// (Europe vs EU, Middle East vs Israel).
function parenCity(label) {
  if (typeof label !== 'string') return null;
  const m = label.match(/\(([^)]+)\)/);
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * Fetch the calculator's primary-selector-aggregations.json for a
 * columnFormIPM service + region. Returns the array of valid selector-
 * tuple objects (each agg's `selectors`), or null on any failure.
 *
 * This is the side-channel resource backing the column-form-tuple-valid
 * predicate. It is best-effort: any unreachable/unparseable step returns
 * null so the predicate degrades to a no-op (offline-safe, matches the
 * regionList pattern).
 *
 *  - serviceFamily + calcId are derived from the def's mappingDefinitions:
 *    the PLC_2.0 entry matching `columnFormField.mappingDefinitionName`
 *    whose URL ends in `metadata.json`. The metadata.json URL stem is the
 *    same one fetchMappingMetadata uses; we swap the final path component.
 *  - the blob's region is resolved to the aggregation Location label via
 *    parenthetical city match against metadata.regionAttributes.Location.
 *
 * `region` is the region CODE (e.g. "eu-west-1") — always present on every
 * service node, including sub-service children that carry no regionName
 * label (only the parent envelope carries regionName). The code is resolved
 * to its human name via the shared REGIONS map; the parenthetical city of
 * that name is then matched against the aggregation Location labels. The
 * city match survives the prefix mismatch between REGIONS names
 * ("Europe (Ireland)") and agg labels ("EU (Ireland)"). For backward
 * compatibility a value already shaped like a label (no REGIONS entry) is
 * passed through to the city match unchanged.
 */
async function loadSelectorAggregations(definition, columnFormField, region) {
  if (!definition || !columnFormField || !region) return null;
  const mappingDefs = definition.mappingDefinitions;
  if (!Array.isArray(mappingDefs)) return null;

  const mappingDef = mappingDefs.find(
    d => d && d.mappingDefinitionName === columnFormField.mappingDefinitionName
  );
  if (!mappingDef || mappingDef.mappingDefinitionVersion !== 'PLC_2.0') return null;
  const url = mappingDef.mappingDefinitionURL;
  if (!url || !url.endsWith('metadata.json')) return null;

  // URL stem up to (and including) the calcId directory:
  //   pricing/2.0/meteredUnitMaps/<family>/[currency]/current/<calcId>/metadata.json
  // → pricing/2.0/meteredUnitMaps/<family>/USD/current/<calcId>
  const stem = url.replace('[currency]', 'USD').replace(/\/metadata\.json$/, '');

  // Resolve region → aggregation Location label via city match. Prefer the
  // region CODE: REGIONS gives its human name, whose parenthetical city
  // matches the agg label's city. Falls back to treating `region` as a
  // label directly (so a passed-in regionName still works).
  // nosemgrep: lazy-load-module
  const { REGIONS } = require('./estimate-builder');
  const regionLabel = REGIONS[region] || region;

  const meta = await fetchMappingMetadata(mappingDef);
  if (!meta || !Array.isArray(meta.regionLocations) || meta.regionLocations.length === 0) return null;
  const wantCity = parenCity(regionLabel);
  if (!wantCity) return null;
  const aggLabel = meta.regionLocations.find(l => parenCity(l) === wantCity);
  if (!aggLabel) return null;  // no city match → aggregations unavailable for this service

  const aggUrl = `${METADATA_CDN}/${stem}/${encodeURIComponent(aggLabel)}/primary-selector-aggregations.json`;
  if (aggregationCache.has(aggUrl)) return aggregationCache.get(aggUrl);

  const promise = (async () => {
    try {
      const res = await fetch(aggUrl);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.aggregations)) return null;
      return data.aggregations
        .map(a => a && a.selectors)
        .filter(s => s && typeof s === 'object');
    } catch { return null; }
  })();

  aggregationCache.set(aggUrl, promise);
  return promise;
}

async function loadManifest(partition = 'aws') {
  if (!PARTITIONS[partition]) {
    throw new Error(`Unknown partition '${partition}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}`);
  }

  if (manifestCache.has(partition)) return manifestCache.get(partition);

  const url = `${PARTITIONS[partition].cdnBase || CDN_BASE}${PARTITIONS[partition].manifestPath}`;
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    const manifest = await res.json();
    const services = new Map();
    manifest.awsServices.forEach(s => {
      const key = s.key || s.serviceCode;
      if (key) services.set(key, { ...s, key });
    });
    console.error(`Loaded ${services.size} services from manifest (partition: ${partition})`);
    return services;
  })();

  manifestCache.set(partition, promise);

  // Allow retry on failure — clear only this partition's cache entry
  promise.catch(() => { manifestCache.delete(partition); });

  return promise;
}

function findService(manifest, name) {
  const lower = name.toLowerCase();
  // Exact key match (case-insensitive)
  for (const [key, svc] of manifest) {
    if (key.toLowerCase() === lower) return svc;
  }
  // Match by display name (case-insensitive)
  for (const [, svc] of manifest) {
    if (svc.name && svc.name.toLowerCase() === lower) return svc;
  }
  // Partial name match (input is substring of name)
  for (const [, svc] of manifest) {
    if (svc.name && svc.name.toLowerCase().includes(lower)) return svc;
  }
  return null;
}

// Return all services whose key or display name contains the query.
// Used to surface candidates when findService returns null due to ambiguity.
function findServiceCandidates(manifest, name, max = 10) {
  const lower = name.toLowerCase();
  const candidates = [];
  for (const [key, svc] of manifest) {
    if (key.toLowerCase().includes(lower) || (svc.name && svc.name.toLowerCase().includes(lower))) {
      candidates.push({ key, name: svc.name });
      if (candidates.length >= max) break;
    }
  }
  return candidates;
}

function searchServices(manifest, query) {
  const terms = query.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const search = (term) => {
    const matches = [];
    for (const [key, svc] of manifest) {
      if (svc.subType === 'subServiceSelector') continue;
      if (svc.isActive === 'false') continue;
      const hit = key.toLowerCase().includes(term)
        || (svc.name && svc.name.toLowerCase().includes(term))
        || svc.searchKeywords?.some(kw => kw.toLowerCase().includes(term));
      if (hit) matches.push({ key, name: svc.name });
    }
    return matches;
  };
  if (terms.length === 1) return search(terms[0]);
  const results = {};
  for (const term of terms) results[term] = search(term);
  return results;
}

async function fetchServiceDefinition(manifest, serviceCode, partition = 'aws') {
  const cacheKey = `${partition}:${serviceCode}`;
  if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);

  const svc = manifest.get(serviceCode);
  if (!svc) return null;

  const urlPath = svc.serviceDefinitionUrlPath || `/data/${serviceCode}/en_US.json`;
  const cdnPrefix = PARTITIONS[partition]?.cdnPrefix || '';
  const base = PARTITIONS[partition]?.cdnBase || CDN_BASE;
  const res = await fetch(`${base}${cdnPrefix}${urlPath}`);
  if (!res.ok) throw new Error(`Definition fetch failed for ${serviceCode}: HTTP ${res.status}`);

  const definition = await res.json();
  definitionCache.set(cacheKey, definition);
  return definition;
}

function parseDoubleEncodedResponse(rawText) {
  let result;
  try { result = JSON.parse(rawText); }
  catch { throw new Error('AWS save API returned invalid JSON'); }

  let body;
  try { body = JSON.parse(result.body); }
  catch { throw new Error('AWS save API returned invalid body'); }

  if (!body.savedKey) {
    throw new Error(`AWS save API did not return a savedKey: ${JSON.stringify(body).substring(0, 200)}`);
  }
  return body;
}

async function saveEstimate(payload, { estimateId, partition } = {}) {
  const jsonBody = JSON.stringify(payload);
  traceEvents.save.send({
    bytes: jsonBody.length,
    groupCount: Object.keys(payload.groups || {}).length,
    serviceCount: Object.keys(payload.services || {}).length,
    estimateId,
  });
  const saveUrl = PARTITIONS[partition]?.saveUrl || SAVE_URL;
  const referer = PARTITIONS[partition]?.shareableBase ? PARTITIONS[partition].shareableBase.replace(/#.*/, '') : 'https://calculator.aws/';
  const res = await fetch(saveUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Referer': referer },
    body: jsonBody,
  });
  const rawText = await res.text();
  if (!res.ok) {
    traceEvents.save.fail({
      status: res.status,
      body: rawText.substring(0, 500),
      estimateId,
    });
    let detail;
    try {
      const body = parseDoubleEncodedResponse(rawText);
      detail = body.message || rawText.substring(0, 200);
    } catch {
      detail = rawText.substring(0, 200);
    }
    throw new Error(`AWS save API returned HTTP ${res.status}: ${detail}`);
  }
  const body = parseDoubleEncodedResponse(rawText);
  traceEvents.save.ok({ savedKey: body.savedKey, estimateId });
  const shareableBase = PARTITIONS[partition]?.shareableBase || 'https://calculator.aws/#/estimate?id=';
  return {
    estimateId: body.savedKey,
    shareableUrl: `${shareableBase}${body.savedKey}`,
  };
}

const INPUT_TYPES = new Set([
  'input', 'numericInput', 'frequency', 'fileSize', 'durationInput', 'percentInput',
]);
const INPUT_SUBTYPES = new Set([
  'dropdown', 'numericInput', 'frequency', 'fileSize', 'durationInput',
  'columnFormIPM', 'dataTransferV2',
]);

// Human-readable hint describing the value shape the calculator
// frontend expects for a columnFormIPM composite widget. Exposed to
// agents so they can supply an already-shaped value without guessing.
const COLUMN_FORM_IPM_VALUE_SHAPE =
  'columnFormIPM expects {value: [rowObject]} — an array of one or more row objects. ' +
  'Each row is keyed by the selectorId (or label where no selectorId is defined; ' +
  'the utilization row uses the literal key "undefined"). Every cell wraps its value as ' +
  '{value: ...}. Example for RDS: {value: [{"Number of Nodes": {value: "1"}, ' +
  '"Instance Type": {value: "db.r6g.xlarge"}, "undefined": {value: {unit: "100", ' +
  'selectedId: "%Utilized/Month"}}, "Deployment Option": {value: "Single-AZ"}, ' +
  '"TermType": {value: "OnDemand"}}]}.';

function extractInputFields(definition) {
  const fields = [];
  const seen = new Set();

  const visit = (obj, templateId) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.id && (INPUT_TYPES.has(obj.type) || INPUT_SUBTYPES.has(obj.subType))) {
      const fieldType = obj.subType || obj.type;
      // Skip non-input decorative types
      if (['bodyText', 'headerText', 'alert'].includes(fieldType)) {
        // still walk into children — decorative wrappers may host inputs
      } else if (obj.isDisabled === 'true' || obj.isDisabled === true) {
        // Skip disabled fields — they're read-only in the calculator UI
      } else if (obj.id.includes('WithoutFreeTier') || obj.id.includes('_withoutFree') || obj.id.endsWith('_MVP')) {
        // Skip "without free tier" / MVP duplicate fields — these are alternate
        // versions of the same inputs for different pricing modes
      } else {
        // Deduplicate across templates by id+type. We still remember the
        // *first* template we found the field in, so agents can tell
        // which template a field belongs to when they are disjoint
        // (e.g. Amazon MQ's ActiveMQ vs RabbitMQ templates).
        const dedupKey = obj.id + ':' + fieldType;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);

          const field = { id: obj.id, type: fieldType };
          if (templateId) field.templateId = templateId;
          if (obj.label) field.label = obj.label;
          // Surface PCT-declared defaults and placeholder text. The pricing
          // engine's required-field superset is wider than these — but where
          // the PCT *does* publish a default, agents shouldn't have to guess.
          if (obj.defaultValue !== undefined) field.defaultValue = obj.defaultValue;
          if (obj.placeholder && obj.placeholder !== 'Enter the amount' && obj.placeholder !== 'Enter amount') {
            field.placeholder = obj.placeholder;
          }
          if (obj.options) {
            field.options = obj.options
              .filter(o => o.id !== undefined || o.label !== undefined)
              .map(o => {
                const opt = {};
                if (o.id !== undefined) opt.id = o.id;
                if (o.label) opt.label = o.label;
                // Throughput options carry a `value` property that is the
                // actual unit string the calculator stores (e.g. "mbps").
                // Expose it so agents use the storage unit, not the UI id.
                if (o.value !== undefined) opt.value = o.value;
                return opt;
              });
          }
          if (obj.unit) field.unit = obj.unit;
          // Surface validation constraints so agents know acceptable ranges
          if (obj.validations) {
            if (obj.validations.minValue != null) field.minValue = obj.validations.minValue;
            if (obj.validations.maxValue != null) field.maxValue = obj.validations.maxValue;
            if (obj.validations.allowDecimals != null) field.allowDecimals = obj.validations.allowDecimals;
          }
          // Capture defaults for server-side injection
          if (obj.defaultValue !== undefined) field.defaultValue = obj.defaultValue;
          if (obj.defaultDropDownItem !== undefined) field.defaultValue = obj.defaultDropDownItem;
          // fileSize fields: include valid size units and default unit format
          if (fieldType === 'fileSize') {
            const sizes = obj.dropDownSize?.map(s => s.value || s.id) || ['gb'];
            const defaultSize = obj.defaultOption?.size || obj.outputSize || 'gb';
            const defaultFreq = obj.defaultOption?.frequency || obj.outputFrequency || 'NA';
            field.unitFormat = `{value}|{size}|{frequency} — sizes: [${sizes.join(', ')}], default: "${defaultSize}|${defaultFreq}"`;
            field.validSizes = sizes;
            field.defaultUnit = `${defaultSize}|${defaultFreq}`;
          }
          // columnFormIPM composite: expose the row schema so an
          // agent can build the expected value shape without trial
          // and error. The calculator stores this as a matrix keyed
          // by selectorId (or label when no selectorId), with a
          // literal "undefined" key for the utilization row.
          if (fieldType === 'columnFormIPM') {
            field.mappingDefinitionName = obj.mappingDefinitionName || null;
            field.row = (obj.row || []).map(r => {
              const item = {
                label: r.label,
                selectorId: r.selectorId,
                type: r.type,
              };
              if (r.exportValueAs) item.exportValueAs = r.exportValueAs;
              if (r.isInstanceType) item.isInstanceType = true;
              if (r.mappingValue) item.mappingValue = r.mappingValue;
              return item;
            });
            field.valueShape = COLUMN_FORM_IPM_VALUE_SHAPE;
          }
          fields.push(field);
        }
      }
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(x => visit(x, templateId));
      else if (typeof v === 'object') visit(v, templateId);
    }
  };

  // Walk each template separately so fields can be tagged with their
  // owning template. This lets callers (agents, the estimate builder)
  // tell which template a given field belongs to when a service has
  // more than one (e.g. Amazon MQ → singleInstanceBroker vs
  // rabbitMQBroker).
  const templates = Array.isArray(definition.templates) ? definition.templates : null;
  if (templates && templates.length > 0) {
    for (const tpl of templates) visit(tpl, tpl.id);
  } else {
    visit(definition, null);
  }
  return fields;
}

/**
 * Enrich columnFormIPM fields with valid selector values from PLC_2.0 metadata.
 * Fetches metadata for each unique mappingDefinitionName in parallel.
 */
async function enrichFieldsWithMetadata(definition, fields) {
  const mappingDefs = definition.mappingDefinitions;
  if (!Array.isArray(mappingDefs) || mappingDefs.length === 0) return fields;

  // Collect unique mappingDefinitionNames referenced by columnFormIPM fields
  const needed = new Set();
  for (const f of fields) {
    if (f.type === 'columnFormIPM' && f.mappingDefinitionName) {
      needed.add(f.mappingDefinitionName);
    }
  }
  if (needed.size === 0) return fields;

  // Fetch all needed metadata in parallel
  const metadataMap = new Map();
  await Promise.all([...needed].map(async name => {
    const def = mappingDefs.find(d => d.mappingDefinitionName === name);
    const meta = await fetchMappingMetadata(def);
    if (meta) metadataMap.set(name, meta);
  }));

  // Attach selectorValues to each columnFormIPM field
  for (const f of fields) {
    if (f.type === 'columnFormIPM' && f.mappingDefinitionName) {
      const meta = metadataMap.get(f.mappingDefinitionName);
      if (meta) {
        // Only include selectors that match the field's row selectorIds
        const rowSelectors = new Set(f.row.map(r => r.selectorId).filter(Boolean));
        const values = {};
        for (const [key, vals] of Object.entries(meta.valueAttributes)) {
          if (rowSelectors.has(key)) values[key] = vals;
        }
        if (Object.keys(values).length > 0) f.selectorValues = values;
      }
    }
  }
  return fields;
}

const READ_URL = 'https://d3knqfixx3sbls.cloudfront.net';

async function fetchEstimate(estimateId, { partition } = {}) {
  const readBase = PARTITIONS[partition]?.readBase || READ_URL;
  const res = await fetch(`${readBase}/${estimateId}`);
  if (!res.ok) throw new Error(`Failed to fetch estimate: HTTP ${res.status}`);
  return res.json();
}

function estimateToMarkdown(data) {
  const lines = [`# ${data.name || 'AWS Estimate'}\n`];
  const total = data.totalCost;
  if (total) lines.push(`**Total Monthly Cost:** $${total.monthly?.toFixed(2) || '0.00'}${total.upfront ? ` | **Upfront:** $${total.upfront.toFixed(2)}` : ''}\n`);

  const renderServices = (services, indent = '') => {
    for (const [, svc] of Object.entries(services)) {
      const cost = svc.serviceCost?.monthly != null ? ` — $${svc.serviceCost.monthly.toFixed(2)}/mo` : '';
      lines.push(`${indent}- **${svc.serviceName}** (${svc.regionName})${cost}`);
      if (svc.description) lines.push(`${indent}  - Description: ${svc.description}`);
      if (svc.configSummary) lines.push(`${indent}  - Config: ${svc.configSummary}`);
    }
  };

  if (data.services && Object.keys(data.services).length > 0) {
    lines.push('## Services\n');
    renderServices(data.services);
  }

  if (data.groups) {
    for (const [, group] of Object.entries(data.groups)) {
      lines.push(`\n## ${group.name || 'Group'}\n`);
      if (group.totalCost?.monthly != null) lines.push(`**Group Monthly:** $${group.totalCost.monthly.toFixed(2)}\n`);
      if (group.services) renderServices(group.services);
    }
  }

  return lines.join('\n');
}

module.exports = { PARTITIONS, resolvePartition, loadManifest, loadRegionList, findService, findServiceCandidates, searchServices, fetchServiceDefinition, saveEstimate, extractInputFields, enrichFieldsWithMetadata, loadSelectorAggregations, parseDoubleEncodedResponse, fetchEstimate, estimateToMarkdown };
