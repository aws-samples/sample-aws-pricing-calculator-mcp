// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Amazon EC2 config transformation: converts agent-friendly eC2Next fields
// to the ec2Enhancement format the calculator frontend expects.

const traceEvents = require('../trace/trace-events');

const SHORTHAND_RE = /^(?:ri|reserved|standard|convertible|instanceSavings|computeSavings|ondemand|spot)(?:(\d)yr)?(?:(No|Partial|All)Upfront)?$/i;

// Keys are lowercased with all non-letters stripped, so exact-form
// lookups cover 'on-demand', 'instance-savings', 'Compute Savings', etc.
const MODEL_ALIASES = {
  ri: 'reserved', reserved: 'reserved', standard: 'reserved',
  convertible: 'convertible',
  instancesavings: 'instanceSavings', computesavings: 'computeSavings',
  ondemand: 'ondemand', spot: 'spot',
};

const SELECTED_OPTION = {
  ondemand: 'on-demand', reserved: 'standard', convertible: 'convertible',
  instanceSavings: 'instance-savings', computeSavings: 'compute-savings', spot: 'spot',
};

const PAYMENT_ALIASES = { no: 'None', none: 'None', partial: 'Partial', all: 'All' };

const VALID_MODELS_MSG =
  '"ondemand", "instanceSavings", "computeSavings", "reserved" (alias "standard"; ' +
  'dedicated/host tenancy only), "convertible" (dedicated/host tenancy only), "spot". ' +
  'Display labels like "EC2 Instance Savings Plans" are also accepted';
const VALID_TERMS_MSG = '"1 Year", "3 Year" (shorthands "1yr", "3yr" also accepted)';
const VALID_UPFRONT_MSG = '"None", "Partial", "All"';
const PRICING_EXAMPLE = '{"model":"instanceSavings","term":"3 Year","upfrontPayment":"None"}';

// Agent-report 2026-08-12: pricingStrategy previously fell back to
// On-Demand silently when a value didn't resolve (e.g. object-form
// model "EC2 Instance Savings Plans", term "3 Year", model "standard").
// Fail-fast is the contract now: anything unresolvable throws with the
// valid values listed. lib/lint/validation.js surfaces the same error
// at add_service time via validatePricingStrategy().
function pricingError(part, raw, validMsg) {
  const err = new Error(
    `Invalid pricingStrategy ${part}: ${JSON.stringify(raw)}. ` +
    `Valid ${part} values: ${validMsg}. Example: pricingStrategy: ${PRICING_EXAMPLE}`);
  err.code = 'EC2_PRICING_INVALID';
  return err;
}

// Shared model resolver — the ONE place both the string and object
// paths normalize through. Exact aliases first (case/punctuation
// insensitive), then display-label fuzzy forms. Returns the canonical
// model key or null when unresolvable.
function resolveModel(raw) {
  if (raw == null || raw === '') return 'ondemand';
  const str = String(raw);
  const key = str.toLowerCase().replace(/[^a-z]/g, '');
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];
  if (/instance.?savings/i.test(str)) return 'instanceSavings';
  if (/compute.?savings/i.test(str)) return 'computeSavings';
  if (/convertible/i.test(str)) return 'convertible';
  if (/reserved|standard|\bri\b/i.test(str)) return 'reserved';
  if (/spot/i.test(str)) return 'spot';
  if (/on.?demand/i.test(str)) return 'ondemand';
  return null;
}

// Term resolver → canonical '1 Year' / '3 Year'. Accepts '1yr', '3yr',
// '1 Year', '3 Years', bare '1'/'3', any case. The catalog documents
// the full-word form; pre-fix only '3yr' was recognized and the
// documented "3 Year" silently degraded to 1 Year.
function resolveTerm(raw) {
  if (raw == null || raw === '') return '1 Year';
  const m = String(raw).match(/^\s*([13])\s*-?\s*(?:yr|year)?s?\s*$/i);
  if (!m) return null;
  return m[1] === '3' ? '3 Year' : '1 Year';
}

// Upfront resolver → canonical 'None' / 'Partial' / 'All'. Accepts any
// case, with or without the 'Upfront' suffix ('No Upfront', 'AllUpfront').
function resolveUpfront(raw) {
  if (raw == null || raw === '') return 'None';
  const key = String(raw).toLowerCase().replace(/[^a-z]/g, '').replace(/upfront$/, '');
  return PAYMENT_ALIASES[key] ?? null;
}

function parsePricing(input) {
  if (typeof input === 'string') return parseString(input);
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw pricingError('value', input,
      'a string shorthand or an object {model, term, upfrontPayment}');
  }
  // Accept both the agent-friendly flat object and the manifest-canonical
  // envelope { value: {...} }. `selectedOption` (the saved-blob key) is
  // accepted alongside `model` so re-transformed imports resolve too.
  const obj = (input.value && (input.value.model || input.value.selectedOption))
    ? input.value : input;
  const rawModel = obj.model ?? obj.selectedOption;
  const model = resolveModel(rawModel);
  if (model === null) throw pricingError('model', rawModel, VALID_MODELS_MSG);
  const term = resolveTerm(obj.term);
  if (term === null) throw pricingError('term', obj.term, VALID_TERMS_MSG);
  const rawUpfront = obj.upfrontPayment ?? obj.options;
  const upfrontPayment = resolveUpfront(rawUpfront);
  if (upfrontPayment === null) throw pricingError('upfrontPayment', rawUpfront, VALID_UPFRONT_MSG);
  return { model, term, upfrontPayment };
}

function parseString(str) {
  const m = str.match(SHORTHAND_RE);
  if (m) {
    const modelKey = str.match(/^[a-zA-Z]+/)[0].toLowerCase();
    return {
      model: MODEL_ALIASES[modelKey] || modelKey,
      term: m[1] === '3' ? '3 Year' : '1 Year',
      upfrontPayment: m[2] ? (PAYMENT_ALIASES[m[2].toLowerCase()] || 'None') : 'None',
    };
  }
  const model = resolveModel(str);
  if (model === null) throw pricingError('model', str, VALID_MODELS_MSG);
  const lower = str.toLowerCase();
  const termMatch = lower.match(/([13])\s*(?:yr|year)/);
  let upfrontPayment = 'None';
  if (lower.includes('all upfront')) upfrontPayment = 'All';
  else if (lower.includes('partial')) upfrontPayment = 'Partial';

  return {
    model,
    term: termMatch && termMatch[1] === '3' ? '3 Year' : '1 Year',
    upfrontPayment,
  };
}

// add_service-time validation hook (used by lib/lint/validation.js).
// Same normalization as the transform — a config that validates here
// cannot silently change meaning at save time.
function validatePricingStrategy(input) {
  try {
    parsePricing(input == null ? 'ondemand' : input);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function buildPricingStrategy(parsed, utilization, tenancy) {
  let { model, term, upfrontPayment } = parsed;
  // parsePricing normalizes term to canonical '1 Year' / '3 Year'.
  const termStr = term;

  // Standard/Convertible RIs are only for dedicated/host tenancy.
  // When the agent asks for reserved/convertible under shared, the
  // calculator hides those options — so we remap to the shared-tenancy
  // equivalent (instance-savings / compute-savings). Emit a trace
  // event so observability can detect the asked-X-got-Y divergence
  // even though the saved blob alone can't show it.
  if (!tenancy || tenancy === 'shared') {
    const asked = model;
    if (model === 'reserved') model = 'instanceSavings';
    if (model === 'convertible') model = 'computeSavings';
    if (asked !== model) {
      try {
        traceEvents.ec2.tenancyRemap({ asked, got: model, tenancy: tenancy || 'shared' });
      } catch { /* best-effort observability — never block a save */ }
    }
  }

  // No `|| 'on-demand'` fallback: parsePricing guarantees model is a
  // SELECTED_OPTION key. If an uncovered path ever delivers one that
  // isn't, failing the save loudly beats silently pricing On-Demand.
  const selectedOption = SELECTED_OPTION[model];
  if (!selectedOption) throw pricingError('model', model, VALID_MODELS_MSG);
  if (model === 'ondemand') {
    return { value: { selectedOption: 'on-demand', term: termStr, utilizationValue: utilization || '100', utilizationUnit: '%Utilized/Month' } };
  }
  return { value: { selectedOption, term: termStr, upfrontPayment, model } };
}

const STORAGE_TYPE_MAP = {
  'gp3': 'Storage General Purpose gp3 GB Mo',
  'gp2': 'Storage General Purpose GB Mo',
  'io1': 'Storage Provisioned IOPS GB Mo',
  'io2': 'Storage Provisioned IOPS io2 GB month',
  'st1': 'Storage Throughput Optimized HDD GB Mo',
  'sc1': 'Storage Cold HDD GB Mo',
  'magnetic': 'Storage Magnetic GB Mo',
};

function transformConfig(config) {
  const tenancy = config.tenancy || 'shared';
  const pricing = parsePricing(config.pricingStrategy || 'ondemand');
  // Three places utilization can arrive: top-level `utilization` (the
  // shorthand we document), pricingStrategy.value.utilizationValue (the
  // manifest-canonical envelope shape that `get_service_fields` shows
  // agents), or pricingStrategy.utilizationValue (some agents skip the
  // .value layer). Production case 2026-06-03: agent sent the manifest-
  // shape envelope and the transform silently coerced it to '100',
  // showing the user 100% when they asked for 80%. Lint can't catch
  // this because the saved blob is structurally valid.
  const psObj = (config.pricingStrategy && typeof config.pricingStrategy === 'object')
    ? config.pricingStrategy : null;
  const envelopeUtil = psObj?.value?.utilizationValue ?? psObj?.utilizationValue;
  const rawUtil = config.utilization ?? envelopeUtil;
  const utilization = rawUtil != null ? String(rawUtil) : '100';

  // Workload: agents may send `workload` (the manifest-canonical name)
  // OR `quantity` (the older synonym). When `workload` is already a full
  // envelope `{ value: { workloadType, data } }`, pass through; when it's
  // a scalar (number/string), wrap. `quantity` always wraps. The
  // canonical-name path keeps the saved-blob shape identical to what
  // the manifest's template inputs declare, so the lint's audit can
  // verify catalog fields against the manifest cleanly.
  const workloadInput = config.workload !== undefined ? config.workload : config.quantity;
  let workload;
  if (workloadInput && typeof workloadInput === 'object' && 'value' in workloadInput) {
    // Canonical envelope { value: { workloadType, data } } — pass through.
    workload = workloadInput;
  } else if (workloadInput && typeof workloadInput === 'object') {
    // Object that doesn't match the canonical envelope. Pre-fix this
    // branch ran `String(workloadInput)` and produced "[object Object]"
    // in the saved blob, rendering the calculator estimate read-only.
    // Production case 2026-06-07: agent passed
    // `workload: { type: 'constant', values: { utilization: 80 } }`.
    // Fall back to the default workload data of '1' rather than
    // poisoning the saved blob with a stringified object. Validation
    // should reject malformed workload upstream now that the EC2
    // bypass is removed; this branch is defense-in-depth for direct
    // imports / hand-constructed blobs.
    workload = { value: { workloadType: 'consistent', data: '1' } };
  } else {
    workload = { value: { workloadType: 'consistent', data: String(workloadInput || '1') } };
  }

  // Infer storageType from IOPS/throughput fields if not explicitly set
  let storageType = config.storageType || null;
  if (!storageType) {
    if (config.gp3Iops || config.gp3Throughput) storageType = 'Storage General Purpose gp3 GB Mo';
    else if (config.iops) storageType = 'Storage Provisioned IOPS GB Mo';
    else if (config.iops2 || config.storageAmountIo2) storageType = 'Storage Provisioned IOPS io2 GB month';
    else if (config.storageAmount) storageType = 'Storage General Purpose gp3 GB Mo';
  }
  // Normalize shorthands to full metered unit IDs
  if (storageType && STORAGE_TYPE_MAP[storageType.toLowerCase()]) {
    storageType = STORAGE_TYPE_MAP[storageType.toLowerCase()];
  }

  return {
    tenancy: { value: tenancy },
    selectedOS: { value: config.selectedOS || 'linux' },
    workloadSelection: { value: 'consistent' },
    instanceType: { value: config.instanceType || '' },
    workload,
    pricingStrategy: buildPricingStrategy(pricing, utilization, tenancy),
    ec2AdvancedPricingMetrics: { value: 1 },
    detailedMonitoringCheckbox: { value: false },
    ...(storageType && { storageType: { value: storageType } }),
    ...(config.storageAmount && {
      storageAmount: typeof config.storageAmount === 'object'
        ? config.storageAmount : { value: String(config.storageAmount), unit: 'gb|NA' },
    }),
    ...(config.snapshotFrequency != null && { snapshotFrequency: { value: String(config.snapshotFrequency) } }),
    ...(config.gp3Iops && { gp3Iops: typeof config.gp3Iops === 'object' ? config.gp3Iops : { value: String(config.gp3Iops) } }),
    ...(config.gp3Throughput && { gp3Throughput: typeof config.gp3Throughput === 'object' ? config.gp3Throughput : { value: String(config.gp3Throughput), unit: 'mbps' } }),
    ...(config.iops && { iops: typeof config.iops === 'object' ? config.iops : { value: String(config.iops) } }),
    ...(config.iops2 && { iops2: typeof config.iops2 === 'object' ? config.iops2 : { value: String(config.iops2) } }),
    ...(config.storageAmountIo2 && { storageAmountIo2: typeof config.storageAmountIo2 === 'object' ? config.storageAmountIo2 : { value: String(config.storageAmountIo2), unit: 'gb|NA' } }),
    // dataTransferForEC2 is injected by lib/handler-helpers.js#applyDefaultFields
    // when the catalog declares it under defaultFields. Pass through whatever
    // the agent (or default-field merge) supplied; if neither set it, the
    // calculator surfaces the validation error via the lint, not silently.
    ...(config.dataTransferForEC2 && { dataTransferForEC2: config.dataTransferForEC2 }),
  };
}

module.exports = { transformConfig, validatePricingStrategy };
