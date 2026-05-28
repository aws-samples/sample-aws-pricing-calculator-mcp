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

function sanitize(str) {
  return (str || '').replace(/[<>&]/g, '');
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

/**
 * Fill required fields that the user did not supply with safe zero defaults.
 *
 * The calculator.aws rehydration engine expects ALL required fields to be
 * present in calculationComponents. When a required numericInput or fileSize
 * field is absent, the engine falls back to an internal default (often a
 * non-zero value from a related feature, e.g. Regional NAT Gateways) which
 * inflates the estimate.
 *
 * This function fetches the service definition, finds required input fields
 * for the active template, and fills any missing ones with {value: "0"}.
 */
async function fillRequiredDefaults(components, definition, templateId) {
  if (!definition) return components;

  const fields = extractInputFields(definition);
  const activeFields = templateId
    ? fields.filter(f => !f.templateId || f.templateId === templateId)
    : fields;

  for (const field of activeFields) {
    if (components[field.id] !== undefined) continue;

    const fieldDef = _findFieldDef(definition, field.id);
    if (!fieldDef?.validations?.required) continue;

    // Set "0" to explicitly disable sub-features the user did not request.
    // Without this, the calculator engine activates optional sub-features
    // with high internal defaults (e.g. 5 Regional NAT Gateways at ~5TB each)
    // which inflates the estimate by $1,000+.
    //
    // Note: for services where required fields represent baselines (e.g. EBS
    // IOPS=3000), the user must explicitly provide these values. The tool's
    // get_service_fields response documents which fields are required.
    if (field.type === 'numericInput') {
      components[field.id] = { value: '0' };
    } else if (field.type === 'fileSize') {
      const defaultUnit = field.defaultUnit || 'gb|NA';
      components[field.id] = { value: '0', unit: defaultUnit };
    }
  }
  return components;
}

function _findFieldDef(definition, fieldId) {
  function search(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.id === fieldId && (obj.type || obj.subType)) return obj;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          const r = search(item);
          if (r) return r;
        }
      } else if (typeof v === 'object') {
        const r = search(v);
        if (r) return r;
      }
    }
    return null;
  }
  return search(definition);
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
  }

  addService(compositeKey, config, { group } = {}) {
    if (this.usedKeys.has(compositeKey) && config?.description) {
      compositeKey = `${compositeKey}:${config.description.replace(/\s+/g, '')}`;
    }
    this.usedKeys.add(compositeKey);
    const target = group
      ? (this.groups[group] ??= { services: {} }).services
      : this.services;
    target[compositeKey] = config;
  }

  _resolvePartition() {
    if (this.partition) return this.partition;
    const allConfigs = [
      ...Object.values(this.services),
      ...Object.values(this.groups).flatMap(g => Object.values(g.services)),
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
      ...Object.values(this.groups).flatMap(g => Object.values(g.services)),
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
      for (const [compositeKey, config] of Object.entries(serviceMap)) {
        const svcKey = compositeKey.split(':')[0];
        const svc = findService(manifest, svcKey);
        if (!svc) continue;

        if (svc.subType === 'subService' && subServiceParent.has(svcKey)) {
          const parent = subServiceParent.get(svcKey);
          const parentDef = await fetchServiceDefinition(manifest, parent.key, partition);
          const subDef = await fetchServiceDefinition(manifest, svc.key, partition);
          const region = config.region || 'us-east-1';
          const subTemplateId = this._inferTemplateId(subDef, config);
          const components = await fillRequiredDefaults(
            wrapValues(config), subDef, subTemplateId
          );
          out[`${parent.key}-${crypto.randomUUID()}`] = {
            serviceCode: parentDef?.serviceCode || parent.key,
            region,
            estimateFor: parentDef?.templateId || 'template',
            description: null,
            subServices: [{
              calculationComponents: components,
              serviceCode: subDef?.serviceCode || svc.key,
              region,
              estimateFor: subTemplateId,
              version: subDef?.version || '0.0.1',
              description: sanitize(config.description) || null,
            }],
            serviceName: parent.name,
            regionName: REGIONS[region] || region,
            version: parentDef?.version || '0.0.1',
            configSummary: configSummary(config),
          };
          continue;
        }

        out[`${this._payloadKey(svc)}-${crypto.randomUUID()}`] =
          await this._buildServiceConfig(manifest, svc, config, partition);
      }
      return out;
    };

    const groups = {};
    for (const [name, data] of Object.entries(this.groups)) {
      const safeName = sanitize(name);
      groups[`${safeName}-${crypto.randomUUID()}`] = {
        name: safeName,
        services: await buildEntries(data.services),
        groups: {},
        //groupSubtotal: { monthly: 0 },
        //totalCost: { monthly: 0, upfront: 0 },
      };
    }

    const payload = {
      name: this.name,
      services: await buildEntries(this.services),
      groups,
      groupSubtotal: {},
      //totalCost: { monthly: 0, upfront: 0 },
      support: {},
      metaData: {
        locale: 'en_US',
        currency: 'USD',
        createdOn: new Date().toISOString(),
        source: 'calculator-platform',
      },
    };

    if (partition !== 'aws') {
      payload.settings = {
        subTotalModifier: { type: 'VOLUME_DISCOUNT', value: 0, valuePercentage: 0, label: 'Discount' },
        monthlyTimeFrame: 12,
        timeFrame: { length: 12, unit: 'month' },
        awsPartition: PARTITIONS[partition].awsPartition,
      };
    }

    return payload;
  }

  async export() {
    const payload = await this.toAWSPayload();
    const result = await saveEstimate(payload);
    const partition = this._resolvePartition();
    return {
      estimateId: result.estimateId,
      shareableUrl: this._buildShareUrl(result.estimateId, partition),
    };
  }

  _buildShareUrl(savedKey, partition) {
    const contract = PARTITIONS[partition]?.contract;
    if (contract) {
      return `https://calculator.aws/#/estimate?ctrct=${contract}&volume_discount=0&id=${savedKey}`;
    }
    return `https://calculator.aws/#/estimate?id=${savedKey}`;
  }

  _isEC2(service) {
    return service.key.toLowerCase() === 'ec2enhancement';
  }

  _payloadKey(service) {
    return this._isEC2(service) ? 'ec2Enhancement' : service.key;
  }

  // Pick the template whose field IDs best match the config the agent
  // supplied. This solves the multi-template case (e.g. Amazon MQ has
  // both singleInstanceBroker and rabbitMQBroker and the right one
  // depends entirely on which field IDs are in use). When nothing
  // disambiguates, fall back to templates[0] for back-compat.
  _inferTemplateId(def, config) {
    const templates = def.templates;
    if (!Array.isArray(templates) || templates.length === 0) return 'template';
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

  async _buildServiceConfig(manifest, service, config, partition) {
    const region = config.region || 'us-east-1';
    const defKey = this._payloadKey(service);

    let version = '0.0.1', serviceCode = defKey, estimateFor = 'template', def = null;
    try {
      def = await fetchServiceDefinition(manifest, defKey, partition);
      if (def) {
        version = def.version || version;
        serviceCode = def.serviceCode || serviceCode;
        estimateFor = this._inferTemplateId(def, config);
      }
    } catch (err) {
      console.error(`Failed to fetch definition for ${defKey}: ${err.message}`);
    }

    const components = this._isEC2(service)
      ? ec2.transformConfig(config)
      : await fillRequiredDefaults(wrapValues(config), def, estimateFor);

    return {
      serviceCode,
      region,
      estimateFor,
      description: sanitize(config.description),
      serviceName: service.name,
      regionName: REGIONS[region] || region,
      version,
      calculationComponents: components,
      configSummary: configSummary(config),
    };
  }
}

module.exports = EstimateBuilder;
module.exports.sanitize = sanitize;
