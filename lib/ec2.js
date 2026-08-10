// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Amazon EC2 config transformation: converts agent-friendly eC2Next fields
// to the ec2Enhancement format the calculator frontend expects.

const traceEvents = require('./trace-events');

const SHORTHAND_RE = /^(?:ri|reserved|convertible|instanceSavings|computeSavings|ondemand)(?:(\d)yr)?(?:(No|Partial|All)Upfront)?$/i;

const MODEL_ALIASES = {
  ri: 'reserved', reserved: 'reserved', standard: 'reserved', convertible: 'convertible',
  instancesavings: 'instanceSavings', computesavings: 'computeSavings', ondemand: 'ondemand',
};

const SELECTED_OPTION = {
  ondemand: 'on-demand', reserved: 'standard', standard: 'standard', convertible: 'convertible',
  instanceSavings: 'instance-savings', computeSavings: 'compute-savings', spot: 'spot',
};

const PAYMENT_ALIASES = { No: 'None', Partial: 'Partial', All: 'All' };

// pricingStrategy term -> calculator display label. Only two commitments
// exist (1 or 3 year). Accepts the internal token ('3yr') or the documented
// full words ('3 Year'), case-insensitive. Anything unrecognized — including
// an omitted term — falls through to the '3 Year' default in
// buildPricingStrategy (the deeper-commitment, cheaper Savings Plan).
const TERM_LABELS = {
  '1yr': '1 Year', '3yr': '3 Year',
  '1 year': '1 Year', '3 year': '3 Year',
};

function parsePricing(input) {
  if (typeof input === 'string') return parseString(input);
  const obj = (input.value?.model) ? input.value : input;
  return normalize(obj.model || 'ondemand', obj.term || '3yr', obj.upfrontPayment || obj.options || 'None');
}

function parseString(str) {
  const m = str.match(SHORTHAND_RE);
  if (m) {
    const modelKey = str.match(/^[a-zA-Z]+/)[0].toLowerCase();
    return {
      model: MODEL_ALIASES[modelKey] || modelKey,
      term: m[1] ? `${m[1]}yr` : '3yr',
      upfrontPayment: m[2] ? (PAYMENT_ALIASES[m[2]] || m[2]) : 'None',
    };
  }
  const lower = str.toLowerCase();
  let model = 'ondemand';
  if (/instance.savings/i.test(lower)) model = 'instanceSavings';
  else if (/compute.savings/i.test(lower)) model = 'computeSavings';
  else if (lower.includes('convertible')) model = 'convertible';
  else if (lower.includes('reserved') || / ri\b/.test(lower)) model = 'reserved';
  else if (lower.includes('spot')) model = 'spot';

  const termMatch = lower.match(/(\d)\s*(?:yr|year)/);
  let upfrontPayment = 'None';
  if (lower.includes('all upfront')) upfrontPayment = 'All';
  else if (lower.includes('partial')) upfrontPayment = 'Partial';

  return { model, term: termMatch ? `${termMatch[1]}yr` : '3yr', upfrontPayment };
}

function normalize(model, term, payment) {
  payment = payment.replace(/Upfront$/i, '');
  if (payment === 'No') payment = 'None';
  return { model, term, upfrontPayment: payment };
}

function buildPricingStrategy(parsed, utilization, tenancy) {
  let { model, term, upfrontPayment } = parsed;
  const termStr = TERM_LABELS[String(term).trim().toLowerCase()] || '3 Year';

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

  const selectedOption = SELECTED_OPTION[model] || 'on-demand';
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

  // Dedicated Host (host tenancy) uses DH-suffixed storage fields.
  // Infer storageTypeDH the same way, and also promote regular storage
  // fields to DH variants when tenancy is host.
  let storageTypeDH = config.storageTypeDH || null;
  if (!storageTypeDH && tenancy === 'host') {
    if (config.gp3IopsDH || config.gp3ThroughputDH) storageTypeDH = 'Storage General Purpose gp3 GB Mo';
    else if (config.storageAmountDH) storageTypeDH = 'Storage General Purpose gp3 GB Mo';
    // Promote regular storage fields to DH when tenancy is host
    else if (storageType) storageTypeDH = storageType;
  }
  if (storageTypeDH && STORAGE_TYPE_MAP[storageTypeDH.toLowerCase()]) {
    storageTypeDH = STORAGE_TYPE_MAP[storageTypeDH.toLowerCase()];
  }
  // When tenancy is host, promote regular storage fields to DH variants
  const storageAmountDH = config.storageAmountDH || (tenancy === 'host' ? config.storageAmount : null);
  const gp3IopsDH = config.gp3IopsDH || (tenancy === 'host' ? config.gp3Iops : null);
  const gp3ThroughputDH = config.gp3ThroughputDH || (tenancy === 'host' ? config.gp3Throughput : null);
  const iopsDH = config.iopsDH || (tenancy === 'host' ? config.iops : null);
  const iops2DH = config.iops2DH || (tenancy === 'host' ? config.iops2 : null);

  return {
    tenancy: { value: tenancy },
    selectedOS: { value: config.selectedOS || 'linux' },
    workloadSelection: { value: 'consistent' },
    instanceType: { value: config.instanceType || '' },
    workload,
    pricingStrategy: buildPricingStrategy(pricing, utilization, tenancy),
    ec2AdvancedPricingMetrics: { value: 1 },
    detailedMonitoringCheckbox: { value: false },
    ...(storageType && tenancy !== 'host' && { storageType: { value: storageType } }),
    ...(config.storageAmount && tenancy !== 'host' && {
      storageAmount: typeof config.storageAmount === 'object'
        ? config.storageAmount : { value: String(config.storageAmount), unit: 'gb|NA' },
    }),
    ...(config.snapshotFrequency != null && { snapshotFrequency: { value: String(config.snapshotFrequency) } }),
    ...(config.gp3Iops && tenancy !== 'host' && { gp3Iops: typeof config.gp3Iops === 'object' ? config.gp3Iops : { value: String(config.gp3Iops) } }),
    ...(config.gp3Throughput && tenancy !== 'host' && { gp3Throughput: typeof config.gp3Throughput === 'object' ? config.gp3Throughput : { value: String(config.gp3Throughput), unit: 'mbps' } }),
    ...(config.iops && tenancy !== 'host' && { iops: typeof config.iops === 'object' ? config.iops : { value: String(config.iops) } }),
    ...(config.iops2 && tenancy !== 'host' && { iops2: typeof config.iops2 === 'object' ? config.iops2 : { value: String(config.iops2) } }),
    ...(config.storageAmountIo2 && tenancy !== 'host' && { storageAmountIo2: typeof config.storageAmountIo2 === 'object' ? config.storageAmountIo2 : { value: String(config.storageAmountIo2), unit: 'gb|NA' } }),
    // Dedicated Host (host tenancy) EBS storage fields
    ...(storageTypeDH && { storageTypeDH: { value: storageTypeDH } }),
    ...(storageAmountDH && {
      storageAmountDH: typeof storageAmountDH === 'object'
        ? storageAmountDH : { value: String(storageAmountDH), unit: 'gb|NA' },
    }),
    ...(gp3IopsDH && { gp3IopsDH: typeof gp3IopsDH === 'object' ? gp3IopsDH : { value: String(gp3IopsDH) } }),
    ...(gp3ThroughputDH && { gp3ThroughputDH: typeof gp3ThroughputDH === 'object' ? gp3ThroughputDH : { value: String(gp3ThroughputDH), unit: 'mbps' } }),
    ...(iopsDH && { iopsDH: typeof iopsDH === 'object' ? iopsDH : { value: String(iopsDH) } }),
    ...(iops2DH && { iops2DH: typeof iops2DH === 'object' ? iops2DH : { value: String(iops2DH) } }),
    // dataTransferForEC2 is injected by lib/handler-helpers.js#applyDefaultFields
    // when the catalog declares it under defaultFields. Pass through whatever
    // the agent (or default-field merge) supplied; if neither set it, the
    // calculator surfaces the validation error via the lint, not silently.
    ...(config.dataTransferForEC2 && { dataTransferForEC2: config.dataTransferForEC2 }),
  };
}

module.exports = { transformConfig };
