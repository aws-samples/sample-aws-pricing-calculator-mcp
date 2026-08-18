// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const crypto = require('crypto');
const { PARTITIONS, resolvePartition, loadManifest, findService, fetchServiceDefinition, saveEstimate, extractInputFields } = require('./aws-client');
const ec2 = require('./ec2');

const REGIONS = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'af-south-1': 'Africa (Cape Town)',
  'ap-east-1': 'Asia Pacific (Hong Kong)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ca-central-1': 'Canada (Central)',
  'ca-west-1': 'Canada West (Calgary)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-central-2': 'Europe (Zurich)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-south-1': 'Europe (Milan)',
  'eu-south-2': 'Europe (Spain)',
  'eu-north-1': 'Europe (Stockholm)',
  'il-central-1': 'Israel (Tel Aviv)',
  'me-south-1': 'Middle East (Bahrain)',
  'me-central-1': 'Middle East (UAE)',
  'sa-east-1': 'South America (Sao Paulo)',
  'us-iso-east-1': 'US ISO East',
  'us-iso-west-1': 'US ISO West',
  'us-isob-east-1': 'US ISOB East (Ohio)',
};

// Strip characters that the save API rejects with HTTP 400, plus the "=cmd"
// substring which the API silently strips server-side. Allow named HTML
// entities (&amp; &lt; &gt; &quot; &apos;) since those round-trip cleanly.
function sanitize(str) {
  if (str == null) return '';
  let out = String(str);
  out = out.replace(/=cmd/gi, '');
  out = out.replace(/[<>]/g, '');
  out = out.replace(/&(?!(?:apos|quot|gt|lt|amp);)/g, '');
  // Strip leading @=+- and any whitespace mixed in, so "- bullet" → "bullet"
  // rather than " bullet".
  out = out.replace(/^[\s@=+-]+/, '');
  return out;
}

function wrapValues(config) {
  const components = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === 'region' || k === 'description') continue;
    if (v == null) continue;
    components[k] = (typeof v === 'object') ? v : { value: String(v) };
  }
  return components;
}

// Pull a columnFormIPM component's remap.keyValue map out of a service
// definition. The frontend stores REMAPPED values (e.g. "Windows" →
// "WorkSpaces Core Windows", "AlwaysOn" → "Monthly") in the saved estimate,
// so the builder must translate the selector values the agent supplies into
// their stored forms or the estimate rehydrates read-only ($0). Returns null
// when no columnFormIPM component carries a remap block.
function columnFormRemap(def) {
  const templates = def?.templates;
  if (!Array.isArray(templates)) return null;
  for (const t of templates) {
    for (const card of (t?.cards || def?.cards || [])) {
      for (const c of (card?.inputSection?.components || [])) {
        if ((c.subType === 'columnFormIPM' || c.type === 'columnFormIPM') && c.remap?.keyValue) {
          return c.remap.keyValue;
        }
      }
    }
  }
  return null;
}

// Apply a remap.keyValue map to the cell values inside a config's
// columnFormIPM field, in place. Plain cells store the value at
// cell.value (a string); utilization cells store it at
// cell.value.selectedId. A value is remapped only when it is a KEY in the
// map (selector form); already-stored target values are left alone so
// applying the remap twice is safe.
function applyColumnFormRemap(config, keyValue) {
  if (!keyValue) return;
  const remap = (v) => (typeof v === 'string' && v in keyValue) ? keyValue[v] : v;
  for (const field of Object.values(config)) {
    const rows = field?.value;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const cell of Object.values(row)) {
        if (!cell || typeof cell !== 'object') continue;
        if (cell.value && typeof cell.value === 'object') {
          cell.value.selectedId = remap(cell.value.selectedId);
        } else {
          cell.value = remap(cell.value);
        }
      }
    }
  }
}

function configSummary(config) {
  return Object.entries(config)
    .filter(([k, v]) => k !== 'region' && k !== 'description' && v != null)
    .map(([k, v]) => `${k} (${(v && typeof v === 'object') ? v.value : v})`)
    .join(', ');
}

class EstimateBuilder {
  constructor(name = 'My Estimate', partition = null) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.partition = partition;
    this.services = {};
    this.groups = {};
    this.usedKeys = new Set();
    // compositeKey → templateId override from a verified/partial catalog
    // entry. Used by _inferTemplateId to bypass field-membership scoring
    // when a human-curated catalog has a known-good template choice.
    // Stored separately so config keys remain pure field IDs and the
    // existing wrapValues/configSummary logic doesn't need to filter
    // out a reserved hint key.
    this.templateHints = new Map();
  }

  addService(compositeKey, config, { group, templateIdHint } = {}) {
    if (this.usedKeys.has(compositeKey) && config?.description) {
      compositeKey = `${compositeKey}:${config.description.replace(/\s+/g, '')}`;
    }
    this.usedKeys.add(compositeKey);
    if (templateIdHint) this.templateHints.set(compositeKey, templateIdHint);
    const target = group
      ? this._resolveGroupPath(group).services
      : this.services;
    target[compositeKey] = config;
  }

  // Resolve a group path (e.g. "Production/Backend") into a nested group,
  // creating intermediate groups as needed. Returns the leaf group object.
  _resolveGroupPath(groupPath) {
    const parts = groupPath.split('/').map(p => p.trim()).filter(Boolean);
    let container = this.groups;
    let node;
    for (const part of parts) {
      container[part] ??= { services: {}, groups: {} };
      node = container[part];
      container = node.groups ??= {};
    }
    return node;
  }

  // Recursively collect all service configs from nested groups.
  _allGroupServices() {
    const collect = (groupMap) => {
      const configs = [];
      for (const g of Object.values(groupMap)) {
        configs.push(...Object.values(g.services || {}));
        if (g.groups) configs.push(...collect(g.groups));
      }
      return configs;
    };
    return collect(this.groups);
  }

  _resolvePartition() {
    if (this.partition) return this.partition;
    const allConfigs = [
      ...Object.values(this.services),
      ...this._allGroupServices(),
    ];
    for (const config of allConfigs) {
      if (config.region) {
        const p = resolvePartition(config.region);
        if (p !== 'aws') return p;
      }
    }
    return 'aws';
  }

  _validatePartitionConsistency() {
    const allConfigs = [
      ...Object.values(this.services),
      ...this._allGroupServices(),
    ];
    const partitions = new Set();
    for (const config of allConfigs) {
      if (config.region) {
        partitions.add(resolvePartition(config.region));
      }
    }
    if (partitions.size > 1) {
      throw new Error(`Mixed-partition estimates are not supported. Found regions from partitions: ${[...partitions].join(', ')}`);
    }
  }

  async toAWSPayload() {
    const partition = this._resolvePartition();
    this._validatePartitionConsistency();
    const manifest = await loadManifest(partition);

    // Build reverse map: subService key → parent service entry
    const subServiceParent = new Map();
    for (const [, svc] of manifest) {
      if (svc.subType === 'subServiceSelector' && Array.isArray(svc.templates)) {
        for (const child of svc.templates) subServiceParent.set(child, svc);
      }
    }

    const buildEntries = async (serviceMap) => {
      const out = {};
      // Multiple subservice children that share a parent (e.g. AppSync's
      // appSyncApiCall + appSyncCaching under awsAppSync) must collapse into
      // a single parent envelope with a subServices[] array, not one parent
      // per child. Track envelopes by parent service code so subsequent
      // children append to the existing array.
      const parentEnvelopes = new Map();

      for (const [compositeKey, config] of Object.entries(serviceMap)) {
        const svcKey = compositeKey.split(':')[0];
        const svc = findService(manifest, svcKey);
        if (!svc) continue;

        const hint = this.templateHints.get(compositeKey);

        if (svc.subType === 'subService' && subServiceParent.has(svcKey)) {
          const parent = subServiceParent.get(svcKey);
          const parentDef = await fetchServiceDefinition(manifest, parent.key, partition);
          const subDef = await fetchServiceDefinition(manifest, svc.key, partition);
          const region = config.region || 'us-east-1';
          applyColumnFormRemap(config, columnFormRemap(subDef));
          const subEntry = {
            calculationComponents: wrapValues(config),
            serviceCode: subDef?.serviceCode || svc.key,
            region,
            estimateFor: this._inferTemplateId(subDef, config, hint),
            version: subDef?.version || '0.0.1',
            description: sanitize(config.description) || null,
          };

          let envelope = parentEnvelopes.get(parent.key);
          if (!envelope) {
            const envKey = `${parent.key}-${crypto.randomUUID()}`;
            envelope = {
              serviceCode: parentDef?.serviceCode || parent.key,
              region,
              estimateFor: parentDef?.templateId || 'template',
              description: sanitize(config.description) || null,
              subServices: [],
              serviceName: parent.name,
              regionName: REGIONS[region] || region,
              version: parentDef?.version || '0.0.1',
              configSummary: '',
            };
            out[envKey] = envelope;
            parentEnvelopes.set(parent.key, envelope);
          }
          envelope.subServices.push(subEntry);
          continue;
        }

        out[`${this._payloadKey(svc)}-${crypto.randomUUID()}`] =
          await this._buildServiceConfig(manifest, svc, config, partition, hint);
      }
      return out;
    };

    const buildGroups = async (groupMap) => {
      const out = {};
      for (const [name, data] of Object.entries(groupMap)) {
        const safeName = sanitize(name);
        out[`${safeName}-${crypto.randomUUID()}`] = {
          name: safeName,
          services: await buildEntries(data.services),
          groups: data.groups ? await buildGroups(data.groups) : {},
        };
      }
      return out;
    };

    const groups = await buildGroups(this.groups);

    const payload = {
      name: sanitize(this.name) || 'My Estimate',
      services: await buildEntries(this.services),
      groups,
      groupSubtotal: {},
      support: {},
      metaData: {
        locale: 'en_US',
        currency: 'USD',
        createdOn: new Date().toISOString(),
        source: 'calculator-platform',
      },
    };

    if (partition !== 'aws' && partition !== 'aws-eusc') {
      payload.settings = {
        subTotalModifier: { type: 'VOLUME_DISCOUNT', value: 0, valuePercentage: 0, label: 'Discount' },
        monthlyTimeFrame: 12,
        timeFrame: { length: 12, unit: 'month' },
        awsPartition: PARTITIONS[partition].awsPartition,
      };
    }

    if (partition === 'aws-eusc') {
      payload.metaData.currency = 'EUR';
    }

    return payload;
  }

  async export() {
    const payload = await this.toAWSPayload();
    const partition = this._resolvePartition();
    const result = await saveEstimate(payload, { estimateId: this.id, partition });
    return {
      estimateId: result.estimateId,
      shareableUrl: this._buildShareUrl(result.estimateId, partition),
    };
  }

  _buildShareUrl(savedKey, partition) {
    const shareableBase = PARTITIONS[partition]?.shareableBase;
    if (shareableBase) {
      return `${shareableBase}${savedKey}`;
    }
    const contract = PARTITIONS[partition]?.contract;
    if (contract) {
      return `https://calculator.aws/#/estimate?ctrct=${contract}&volume_discount=0&id=${savedKey}`;
    }
    return `https://calculator.aws/#/estimate?id=${savedKey}`;
  }

  _hasTransform(service) {
    return service.key.toLowerCase() === 'ec2enhancement';
  }

  _payloadKey(service) {
    return this._hasTransform(service) ? 'ec2Enhancement' : service.key;
  }

  // Pick the template whose field IDs best match the config the agent
  // supplied. This solves the multi-template case (e.g. Amazon MQ has
  // both singleInstanceBroker and rabbitMQBroker and the right one
  // depends entirely on which field IDs are in use). When nothing
  // disambiguates, fall back to templates[0] for back-compat.
  //
  // `hint` (optional) is a templateId from a verified/partial catalog
  // entry. When set and present in the PCT's templates list, it wins
  // over field-membership scoring — verified catalog entries are
  // human-confirmed against a real saved estimate, so their template
  // choice is more reliable than scoring (especially for services like
  // Cognito where shared-but-tier-specific fields produce ties that
  // fall back to templates[0], silently routing through the wrong
  // pricing engine).
  _inferTemplateId(def, config, hint) {
    const templates = def.templates;
    if (!Array.isArray(templates) || templates.length === 0) return 'template';
    if (hint) {
      const hintMatches = templates.some(
        t => (typeof t === 'string' ? t : t && t.id) === hint,
      );
      if (hintMatches) return hint;
    }
    if (templates.length === 1) return templates[0].id;

    const configFieldIds = Object.keys(config)
      .filter(k => k !== 'region' && k !== 'description');
    if (configFieldIds.length === 0) return templates[0].id;

    // Count how many of the config's field IDs each template declares.
    const fields = extractInputFields(def);
    const fieldToTemplate = new Map();
    for (const f of fields) {
      if (f.templateId) fieldToTemplate.set(f.id, f.templateId);
    }

    const scores = new Map();
    for (const id of configFieldIds) {
      const tpl = fieldToTemplate.get(id);
      if (tpl) scores.set(tpl, (scores.get(tpl) || 0) + 1);
    }

    if (scores.size === 0) return templates[0].id;

    // Pick the template with the highest score; break ties in favour
    // of the template that appears first in the definition so the
    // behaviour remains deterministic and back-compat for ambiguous
    // configs.
    let best = templates[0].id;
    let bestScore = -1;
    for (const tpl of templates) {
      const s = scores.get(tpl.id) || 0;
      if (s > bestScore) {
        bestScore = s;
        best = tpl.id;
      }
    }
    return best;
  }

  async _buildServiceConfig(manifest, service, config, partition, hint) {
    const region = config.region || 'us-east-1';
    const defKey = this._payloadKey(service);

    let version = '0.0.1', serviceCode = defKey, estimateFor = 'template';
    try {
      const def = await fetchServiceDefinition(manifest, defKey, partition);
      if (def) {
        version = def.version || version;
        serviceCode = def.serviceCode || serviceCode;
        estimateFor = this._inferTemplateId(def, config, hint);
        applyColumnFormRemap(config, columnFormRemap(def));
      }
    } catch (err) {
      console.error(`Failed to fetch definition for ${defKey}: ${err.message}`);
    }

    return {
      serviceCode,
      region,
      estimateFor,
      description: sanitize(config.description),
      serviceName: service.name,
      regionName: REGIONS[region] || region,
      version,
      calculationComponents: this._hasTransform(service) ? ec2.transformConfig(config) : wrapValues(config),
      configSummary: configSummary(config),
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      partition: this.partition,
      services: this.services,
      groups: this.groups,
      usedKeys: [...this.usedKeys],
      templateHints: [...this.templateHints],
    };
  }

  static fromJSON(obj) {
    const e = new EstimateBuilder(obj.name, obj.partition);
    e.id = obj.id;
    e.services = obj.services || {};
    e.groups = obj.groups || {};
    e.usedKeys = new Set(obj.usedKeys || []);
    e.templateHints = new Map(obj.templateHints || []);
    return e;
  }
}

module.exports = EstimateBuilder;
module.exports.sanitize = sanitize;
// Region code → human name. Shared with aws-client's selector-aggregation
// resolution (sub-service nodes carry only the region CODE, not a label).
module.exports.REGIONS = REGIONS;
