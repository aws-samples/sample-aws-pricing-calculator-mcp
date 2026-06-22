// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Tests for multi-template services (e.g. Amazon MQ with ActiveMQ +
// RabbitMQ) and for the columnFormIPM composite row widget used by
// Amazon RDS engines.
//
// Design intent: the MCP surfaces the raw shape of the service
// definition (per-template fields, IPM row schema) so an agent can
// make informed choices; the MCP infers the template from the config
// keys it received rather than blindly picking templates[0].

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { extractInputFields } = require('../lib/aws/aws-client');

// ─── helpers ────────────────────────────────────────────────

function clearCaches() {
  delete require.cache[require.resolve('../lib/aws/aws-client')];
  delete require.cache[require.resolve('../lib/aws/estimate-builder')];
}

function mockFetch(responses) {
  global.fetch = async (url) => {
    for (const [pattern, body] of responses) {
      if (url.includes(pattern)) {
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
  };
}

// ─── fixtures ───────────────────────────────────────────────
// Minimal MQ-shaped definition: two templates with distinct field IDs.
const MQ_DEF = {
  version: '0.0.59',
  serviceCode: 'amazonMQ',
  templates: [
    {
      id: 'singleInstanceBroker',
      cards: [{ inputSection: { components: [
        { id: 'activeBrokerType', type: 'input', subType: 'dropdown', label: 'Broker type' },
        { id: 'numberOfBrokers', type: 'numericInput', label: 'Number of Brokers running' },
        { id: 'instanceType', type: 'input', subType: 'dropdown', label: 'Amazon MQ Broker Instance',
          options: [{ id: 'mq.m5.large-id', label: 'mq.m5.large' }] },
        { id: 'storagePerBroker', type: 'fileSize', label: 'Storage per Broker',
          dropDownSize: [{ value: 'gb' }], defaultOption: { size: 'gb', frequency: 'NA' } },
      ]}}],
    },
    {
      id: 'rabbitMQBroker',
      cards: [{ inputSection: { components: [
        { id: 'rabbitBrokerType', type: 'input', subType: 'dropdown', label: 'Broker type' },
        { id: 'rabbitmqNumberOfBrokers', type: 'numericInput', label: 'Number of Brokers running' },
        { id: 'rabbitmqInstanceType', type: 'input', subType: 'dropdown', label: 'Amazon RabbitMQ Broker Instance',
          options: [{ id: 'mq.m5.large-rabbit-id', label: 'mq.m5.large' }] },
        { id: 'rabbitmqStoragePerBroker', type: 'fileSize', label: 'Storage per Broker',
          dropDownSize: [{ value: 'gb' }], defaultOption: { size: 'gb', frequency: 'NA' } },
      ]}}],
    },
  ],
};

// Minimal RDS-shaped definition with a columnFormIPM composite.
const RDS_DEF = {
  version: '0.0.110',
  serviceCode: 'amazonRDSPostgreSQLDB',
  templates: [
    {
      id: 'rdsForPostgreSQL',
      cards: [{ inputSection: { components: [
        {
          id: 'columnFormIPM',
          type: 'input',
          subType: 'columnFormIPM',
          mappingDefinitionName: 'rds-postgresql-calc',
          row: [
            { label: 'Nodes', selectorId: 'Number of Nodes', type: 'textInput', exportValueAs: 'count' },
            { label: 'Instance Type', selectorId: 'Instance Type', type: 'autoSuggest', isInstanceType: true },
            { label: 'Utilization (On-Demand only)', type: 'utilization', exportValueAs: 'utilizationOut' },
            { label: 'Deployment Option', selectorId: 'Deployment Option', type: 'dropDown', exportValueAs: 'deploymentStrategy' },
            { label: 'Pricing Model', selectorId: 'TermType', type: 'dropDown', exportValueAs: 'pricingModel' },
          ],
        },
        { id: 'storageVolume', type: 'input', subType: 'dropdown', label: 'Storage volume',
          options: [{ id: 'General Purpose-GP3', label: 'General Purpose SSD (gp3)' }] },
        { id: 'storageAmount', type: 'fileSize', label: 'Storage amount',
          dropDownSize: [{ value: 'gb' }], defaultOption: { size: 'gb', frequency: 'NA' } },
      ]}}],
    },
  ],
};

const FAKE_MANIFEST = {
  awsServices: [
    { key: 'amazonMQ', name: 'Amazon MQ', serviceCode: 'amazonMQ' },
    { key: 'amazonRDSPostgreSQLDB', name: 'Amazon RDS for PostgreSQL', serviceCode: 'amazonRDSPostgreSQLDB' },
  ],
};

// ════════════════════════════════════════════════════════════
// extractInputFields — per-template grouping + IPM row schema
// ════════════════════════════════════════════════════════════

describe('extractInputFields — multi-template services', () => {
  it('tags each field with the template it belongs to', () => {
    const fields = extractInputFields(MQ_DEF);
    const byId = Object.fromEntries(fields.map(f => [f.id, f]));
    assert.equal(byId.activeBrokerType.templateId, 'singleInstanceBroker',
      'ActiveMQ field should be tagged with its template');
    assert.equal(byId.rabbitBrokerType.templateId, 'rabbitMQBroker',
      'RabbitMQ field should be tagged with its template');
  });

  it('lists all fields across all templates (not just templates[0])', () => {
    const fields = extractInputFields(MQ_DEF);
    const ids = fields.map(f => f.id);
    // Field IDs that only exist in template[1] must still be visible
    assert.ok(ids.includes('rabbitmqInstanceType'),
      'RabbitMQ field from templates[1] must be exposed');
    assert.ok(ids.includes('instanceType'),
      'ActiveMQ field from templates[0] must be exposed');
  });
});

describe('extractInputFields — columnFormIPM row schema', () => {
  it('exposes the row schema so an agent knows the expected keys', () => {
    const fields = extractInputFields(RDS_DEF);
    const ipm = fields.find(f => f.id === 'columnFormIPM');
    assert.ok(ipm, 'columnFormIPM field should be extracted');
    assert.equal(ipm.type, 'columnFormIPM');
    assert.ok(Array.isArray(ipm.row), 'should include row schema');
    assert.ok(ipm.row.length >= 5, 'should include all row items');
  });

  it('includes selectorId, label, type and exportValueAs per row', () => {
    const fields = extractInputFields(RDS_DEF);
    const ipm = fields.find(f => f.id === 'columnFormIPM');
    const byLabel = Object.fromEntries(ipm.row.map(r => [r.label, r]));
    assert.equal(byLabel['Instance Type'].selectorId, 'Instance Type');
    assert.equal(byLabel['Instance Type'].type, 'autoSuggest');
    assert.equal(byLabel['Nodes'].exportValueAs, 'count');
    assert.equal(byLabel['Pricing Model'].selectorId, 'TermType');
  });

  it('documents the expected value shape for columnFormIPM', () => {
    const fields = extractInputFields(RDS_DEF);
    const ipm = fields.find(f => f.id === 'columnFormIPM');
    // The agent needs an example of how to shape the value. We expose
    // a hint string describing the array-of-rows-keyed-by-label shape.
    assert.ok(ipm.valueShape, 'valueShape hint should be present');
    assert.match(ipm.valueShape, /array/i, 'should mention array');
    assert.match(ipm.valueShape, /selectorId/i, 'should mention selectorId usage');
  });
});

// ════════════════════════════════════════════════════════════
// template inference — pick the template whose fields match
// ════════════════════════════════════════════════════════════

describe('template inference in _buildServiceConfig', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearCaches();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCaches();
  });

  it('picks rabbitMQBroker when config uses RabbitMQ-only field IDs', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/amazonMQ', MQ_DEF],
    ]);
    const EB = require('../lib/aws/estimate-builder');
    const eb = new EB('MQ inference test');
    eb.addService('amazonMQ', {
      region: 'eu-south-1',
      description: 'RabbitMQ 3x mq.m5.large',
      rabbitBrokerType: '1',
      rabbitmqNumberOfBrokers: '3',
      rabbitmqInstanceType: 'mq.m5.large-rabbit-id',
    });
    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    assert.equal(svc.estimateFor, 'rabbitMQBroker',
      'estimateFor must reflect the template that actually contains the configured fields');
  });

  it('picks singleInstanceBroker when config uses ActiveMQ-only field IDs', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/amazonMQ', MQ_DEF],
    ]);
    const EB = require('../lib/aws/estimate-builder');
    const eb = new EB('MQ ActiveMQ test');
    eb.addService('amazonMQ', {
      region: 'us-east-1',
      description: 'ActiveMQ',
      activeBrokerType: '1',
      numberOfBrokers: '1',
      instanceType: 'mq.m5.large-id',
    });
    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    assert.equal(svc.estimateFor, 'singleInstanceBroker');
  });

  it('falls back to templates[0] when no config keys disambiguate', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/amazonMQ', MQ_DEF],
    ]);
    const EB = require('../lib/aws/estimate-builder');
    const eb = new EB('MQ ambiguous test');
    eb.addService('amazonMQ', { region: 'us-east-1', description: 'No fields' });
    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    assert.equal(svc.estimateFor, 'singleInstanceBroker',
      'with no signal, keep back-compat behaviour and use templates[0]');
  });

  it('uses templates[0] for single-template services (RDS PostgreSQL)', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/amazonRDSPostgreSQLDB', RDS_DEF],
    ]);
    const EB = require('../lib/aws/estimate-builder');
    const eb = new EB('RDS single template');
    eb.addService('amazonRDSPostgreSQLDB', {
      region: 'eu-south-1',
      description: 'Primary',
      storageVolume: 'General Purpose-GP3',
      storageAmount: { value: '100', unit: 'gb|NA' },
    });
    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    assert.equal(svc.estimateFor, 'rdsForPostgreSQL');
  });
});

// ════════════════════════════════════════════════════════════
// columnFormIPM passthrough — agent supplies the shape, MCP
// must not mangle it.
// ════════════════════════════════════════════════════════════

describe('columnFormIPM passthrough', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearCaches();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCaches();
  });

  it('passes an already-shaped columnFormIPM value through unchanged', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/amazonRDSPostgreSQLDB', RDS_DEF],
    ]);
    const EB = require('../lib/aws/estimate-builder');
    const eb = new EB('RDS IPM test');

    const ipmValue = {
      value: [{
        'Number of Nodes': { value: '1' },
        'Instance Type': { value: 'db.r6g.4xlarge' },
        'undefined': { value: { unit: '100', selectedId: '%Utilized/Month' } },
        'Deployment Option': { value: 'Single-AZ' },
        'TermType': { value: 'OnDemand' },
      }],
    };

    eb.addService('amazonRDSPostgreSQLDB', {
      region: 'eu-south-1',
      description: 'Primary db.r6g.4xlarge',
      columnFormIPM: ipmValue,
      storageVolume: 'General Purpose-GP3',
      storageAmount: { value: '3700', unit: 'gb|NA' },
    });
    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    assert.deepEqual(svc.calculationComponents.columnFormIPM, ipmValue,
      'columnFormIPM must reach the payload exactly as supplied');
  });
});
