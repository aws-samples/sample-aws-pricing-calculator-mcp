const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const EstimateBuilder = require('../lib/estimate-builder');

// --- helpers for toAWSPayload tests ---

function clearAwsClientCache() {
  const mod = require.resolve('../lib/aws-client');
  delete require.cache[mod];
  // estimate-builder caches the require too, so clear it as well
  const ebMod = require.resolve('../lib/estimate-builder');
  delete require.cache[ebMod];
}

function mockFetch(responses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    for (const [pattern, body] of responses) {
      if (url.includes(pattern)) {
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
  };
  return calls;
}

const FAKE_MANIFEST = {
  awsServices: [
    { key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' },
    { key: 'amazonS3Standard', name: 'Amazon S3 Standard', serviceCode: 'amazonS3Standard' },
  ],
};

const FAKE_DEFINITION = {
  version: '2.0.0',
  serviceCode: 'aWSLambda',
  templates: [{ id: 'lambda-template-1' }],
};

const FAKE_S3_DEFINITION = {
  version: '1.5.0',
  serviceCode: 'amazonS3Standard',
  templates: [{ id: 's3-template-1' }],
};

// FSx-for-Lustre-shaped definition for end-to-end payload tests. The real
// storage field id is persistent_generated_0 (label "Storage capacity",
// fileSize, default unit gb|NA) — NOT "storageCapacity". This mirrors the
// live service definition that extractInputFields walks.
const FAKE_FSX_MANIFEST = {
  awsServices: [
    { key: 'amazonFSxForLustre', name: 'Amazon FSx for Lustre', serviceCode: 'amazonFSxForLustre' },
  ],
};

const FAKE_FSX_DEFINITION = {
  version: '0.0.94',
  serviceCode: 'amazonFSxForLustre',
  templates: [
    {
      id: 'persistent',
      components: [
        {
          type: 'input', subType: 'fileSize', id: 'persistent_generated_0',
          label: 'Storage capacity',
          dropDownSize: [{ id: 'gb' }, { id: 'tb' }],
          defaultOption: { size: 'gb', frequency: 'NA' },
        },
        {
          type: 'input', subType: 'fileSize', id: 'backupStorage',
          label: 'Backup storage',
          dropDownSize: [{ id: 'gb' }, { id: 'tb' }],
          defaultOption: { size: 'gb', frequency: 'NA' },
        },
      ],
    },
  ],
};

describe('EstimateBuilder', () => {
  describe('description field', () => {
    it('defaults to empty string when no description provided', async () => {
      const { sanitize } = require('../lib/estimate-builder');
      const result = sanitize(undefined);
      assert.equal(result, '', 'sanitize(undefined) should return empty string');
      assert.equal(sanitize(undefined) || null, null, 'demonstrates the bug with || null');
    });
  });

  describe('sanitize', () => {
    const { sanitize } = require('../lib/estimate-builder');

    it('passes plain ASCII through unchanged', () => {
      assert.equal(sanitize('Plain description'), 'Plain description');
    });

    it('strips leading @=+- (CSV-injection guards)', () => {
      assert.equal(sanitize('- bullet item'), 'bullet item');
      assert.equal(sanitize('@everyone'), 'everyone');
      assert.equal(sanitize('=cmd injection'), 'injection');
      assert.equal(sanitize('+1 service'), '1 service');
    });

    it('keeps mid-string hyphens', () => {
      assert.equal(sanitize('API - Lambda handler'), 'API - Lambda handler');
    });

    it('strips < and > anywhere', () => {
      assert.equal(sanitize('use < this'), 'use  this');
      assert.equal(sanitize('rate >100'), 'rate 100');
    });

    it('strips bare ampersand but keeps named HTML entities', () => {
      assert.equal(sanitize('AI & ML'), 'AI  ML');
      assert.equal(sanitize('AI &amp; ML'), 'AI &amp; ML');
      assert.equal(sanitize('less &lt; 5'), 'less &lt; 5');
      assert.equal(sanitize('quote &quot; here'), 'quote &quot; here');
    });

    it('strips =cmd anywhere (server silently strips it)', () => {
      assert.equal(sanitize('echo =cmd test'), 'echo  test');
      assert.equal(sanitize('echo =CMD test'), 'echo  test');
    });

    it('neutralizes numeric/hex HTML entities (server 400s on them)', () => {
      // The save lambda runs sanitize-html on the JSON body; a decoded
      // numeric entity (&#34; → ") shatters JSON structure and the API
      // returns "Unexpected token q in JSON at position N". Probe shape
      // 2026-05-15 confirmed this. Sanitize must strip the leading `&`
      // so the entity can never decode server-side.
      assert.equal(sanitize('has &#34; numeric entity').includes('&#'), false);
      assert.equal(sanitize('has &#x22; hex entity').includes('&#'), false);
    });

    it('handles null and undefined', () => {
      assert.equal(sanitize(null), '');
      assert.equal(sanitize(undefined), '');
    });
  });

  describe('addService deduplication', () => {
    it('deduplicates same service key using description', () => {
      const eb = new EstimateBuilder('test');
      eb.addService('aWSLambda', { description: 'API handler', region: 'us-east-1' });
      eb.addService('aWSLambda', { description: 'Cron jobs', region: 'us-east-1' });
      const keys = Object.keys(eb.services);
      assert.equal(keys.length, 2, 'should have two entries');
      assert.ok(keys.includes('aWSLambda'), 'first entry uses original key');
      assert.ok(keys.some(k => k.includes('Cronjobs')), 'second entry has description suffix');
    });

    it('recognizes ec2Enhancement as a service with a custom transform', () => {
      const eb = new EstimateBuilder('test');
      assert.ok(eb._hasTransform({ key: 'ec2Enhancement' }), 'should recognize ec2Enhancement');
      assert.ok(!eb._hasTransform({ key: 'eC2Next' }), 'eC2Next is inactive, not supported');
      assert.ok(!eb._hasTransform({ key: 'aWSLambda' }), 'should not match other services');
    });

    it('places services in groups when specified', () => {
      const eb = new EstimateBuilder('test');
      eb.addService('aWSLambda', { region: 'us-east-1' }, { group: 'Prod' });
      assert.equal(Object.keys(eb.services).length, 0, 'ungrouped should be empty');
      assert.ok(eb.groups.Prod, 'Prod group should exist');
      assert.equal(Object.keys(eb.groups.Prod.services).length, 1);
    });
  });
});

describe('toAWSPayload', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearAwsClientCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearAwsClientCache();
  });

  it('builds a full exportable payload with ungrouped services', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Test Estimate');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1000', unit: 'millionPerMonth' },
    });

    const payload = await eb.toAWSPayload();

    // Top-level structure
    assert.equal(payload.name, 'Test Estimate');
    assert.ok(payload.services, 'should have services');
    assert.ok(payload.groups, 'should have groups');
    assert.ok(payload.metaData, 'should have metaData');
    assert.equal(payload.metaData.currency, 'USD');
    assert.equal(payload.settings, undefined, 'aws partition should not have settings');

    // Service entry
    const entries = Object.values(payload.services);
    assert.equal(entries.length, 1, 'should have one service');
    const svc = entries[0];
    assert.equal(svc.serviceCode, 'aWSLambda');
    assert.equal(svc.region, 'us-east-1');
    assert.equal(svc.regionName, 'US East (N. Virginia)');
    assert.equal(svc.version, '2.0.0');
    assert.equal(svc.estimateFor, 'lambda-template-1');
    assert.equal(svc.description, 'API handler');
    assert.deepEqual(svc.calculationComponents.numberOfRequests, { value: '1000', unit: 'millionPerMonth' });
  });

  it('maps a friendly config label to the real field id in the payload (FSx $0 fix)', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_FSX_MANIFEST],
      ['data/amazonFSxForLustre', FAKE_FSX_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('FSx Estimate');
    // The caller uses the friendly key "storageCapacity" and a bare number —
    // the pre-fix builder would emit that verbatim and the engine would price
    // storage at $0. normalizeFieldKeys must route it to persistent_generated_0
    // with the gb|NA unit.
    eb.addService('amazonFSxForLustre', {
      region: 'us-east-1',
      description: 'FSx Lustre 1200GB',
      storageCapacity: '1200',
      backupStorage: { value: '500', unit: 'gb' },
    });

    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];

    assert.equal(svc.serviceCode, 'amazonFSxForLustre');
    assert.equal(svc.estimateFor, 'persistent');
    // storageCapacity must have been rewritten to the real field id + unit.
    assert.deepEqual(
      svc.calculationComponents.persistent_generated_0,
      { value: '1200', unit: 'gb|NA' },
      'friendly storageCapacity should become persistent_generated_0 with gb|NA'
    );
    assert.equal(
      svc.calculationComponents.storageCapacity, undefined,
      'the bogus friendly key must not leak into the payload'
    );
    // A bare "gb" unit on a real field id must be repaired to "gb|NA".
    assert.equal(svc.calculationComponents.backupStorage.unit, 'gb|NA');
  });

  it('builds payload with grouped services', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
      ['data/amazonS3Standard', FAKE_S3_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Grouped Estimate');
    eb.addService('aWSLambda', { region: 'eu-west-1', description: 'Compute' }, { group: 'Prod' });
    eb.addService('amazonS3Standard', { region: 'eu-west-1', description: 'Storage' }, { group: 'Prod' });

    const payload = await eb.toAWSPayload();

    assert.equal(Object.keys(payload.services).length, 0, 'ungrouped should be empty');
    const groupEntries = Object.values(payload.groups);
    assert.equal(groupEntries.length, 1);
    const group = groupEntries[0];
    assert.equal(group.name, 'Prod');
    const groupServices = Object.values(group.services);
    assert.equal(groupServices.length, 2);
    const codes = groupServices.map(s => s.serviceCode).sort();
    assert.deepEqual(codes, ['aWSLambda', 'amazonS3Standard']);
  });

  it('merges multiple subservice children under a single parent envelope', async () => {
    const APPSYNC_MANIFEST = {
      awsServices: [
        { key: 'awsAppSync', name: 'AWS AppSync', serviceCode: 'awsAppSync',
          subType: 'subServiceSelector',
          templates: ['appSyncApiCall', 'appSyncCaching', 'appSyncRealTime'] },
        { key: 'appSyncApiCall', name: 'AppSync API Calls', serviceCode: 'appSyncApiCall',
          subType: 'subService' },
        { key: 'appSyncCaching', name: 'AppSync Caching', serviceCode: 'appSyncCaching',
          subType: 'subService' },
        { key: 'appSyncRealTime', name: 'AppSync RealTime', serviceCode: 'appSyncRealTime',
          subType: 'subService' },
      ],
    };
    mockFetch([
      ['manifest/en_US.json', APPSYNC_MANIFEST],
      ['data/awsAppSync', { version: '0.0.66', serviceCode: 'awsAppSync',
        templateId: 'appSyncClassesGroup', templates: [{ id: 'appSyncClassesGroup' }] }],
      ['data/appSyncApiCall', { version: '0.0.16', serviceCode: 'appSyncApiCall',
        templates: [{ id: 'apiquerydatamodification' }] }],
      ['data/appSyncCaching', { version: '0.0.15', serviceCode: 'appSyncCaching',
        templates: [{ id: 'cacheSpeed' }] }],
      ['data/appSyncRealTime', { version: '0.0.18', serviceCode: 'appSyncRealTime',
        templates: [{ id: 'apiquerydatamodification' }] }],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('AppSync multi-child');
    eb.addService('appSyncApiCall',  { region: 'us-east-1', description: 'API queries' });
    eb.addService('appSyncCaching',  { region: 'us-east-1', description: 'Cache' });
    eb.addService('appSyncRealTime', { region: 'us-east-1', description: 'Subs' });

    const payload = await eb.toAWSPayload();
    const entries = Object.entries(payload.services);

    assert.equal(entries.length, 1, 'all 3 children must collapse into ONE parent envelope');
    const [key, parent] = entries[0];
    assert.ok(key.startsWith('awsAppSync-'), `parent key should start with awsAppSync-, got ${key}`);
    assert.equal(parent.serviceCode, 'awsAppSync');
    assert.equal(parent.estimateFor, 'appSyncClassesGroup');
    assert.ok(Array.isArray(parent.subServices));
    assert.equal(parent.subServices.length, 3, 'parent should hold all 3 subservices');

    const codes = parent.subServices.map(s => s.serviceCode).sort();
    assert.deepEqual(codes, ['appSyncApiCall', 'appSyncCaching', 'appSyncRealTime']);

    const apiCall = parent.subServices.find(s => s.serviceCode === 'appSyncApiCall');
    assert.equal(apiCall.estimateFor, 'apiquerydatamodification');
    assert.equal(apiCall.version, '0.0.16');
    assert.equal(apiCall.description, 'API queries');
  });

  it('keeps single subservice case working (no regression)', async () => {
    const SNS_MANIFEST = {
      awsServices: [
        { key: 'amazonSimpleNotificationService', name: 'Amazon SNS',
          serviceCode: 'amazonSimpleNotificationService',
          subType: 'subServiceSelector', templates: ['standardTopics'] },
        { key: 'standardTopics', name: 'Standard Topics', serviceCode: 'standardTopics',
          subType: 'subService' },
      ],
    };
    mockFetch([
      ['manifest/en_US.json', SNS_MANIFEST],
      ['data/amazonSimpleNotificationService', { version: '0.0.59',
        serviceCode: 'amazonSimpleNotificationService',
        templates: [{ id: 'snsClassesGroup' }] }],
      ['data/standardTopics', { version: '0.0.59', serviceCode: 'standardTopics',
        templates: [{ id: 'sns_t1' }] }],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('SNS single child');
    eb.addService('standardTopics', { region: 'us-east-1', description: 'Notifications' });

    const payload = await eb.toAWSPayload();
    const entries = Object.entries(payload.services);
    assert.equal(entries.length, 1);
    const [key, parent] = entries[0];
    assert.ok(key.startsWith('amazonSimpleNotificationService-'));
    assert.equal(parent.subServices.length, 1);
    assert.equal(parent.subServices[0].serviceCode, 'standardTopics');
  });

  it('remaps columnFormIPM selector values to stored forms (top-level service)', async () => {
    // workSpacesCore-shaped definition: the columnFormIPM component carries a
    // remap.keyValue block. The agent supplies SELECTOR values (Windows,
    // AlwaysOn); the saved blob must contain the REMAPPED stored forms
    // (WorkSpaces Core Windows, Monthly) or the estimate rehydrates $0.
    const WSC_MANIFEST = {
      awsServices: [
        { key: 'workSpacesCore', name: 'WorkSpaces Core', serviceCode: 'workSpacesCore' },
      ],
    };
    const WSC_DEFINITION = {
      version: '0.0.5',
      serviceCode: 'workSpacesCore',
      templates: [{ id: 'wsc-template-1' }],
      cards: [{
        inputSection: {
          components: [{
            type: 'input', subType: 'columnFormIPM', id: 'columnFormIPM',
            remap: { keyValue: {
              AlwaysOn: 'Monthly', AutoStop: 'Hourly',
              Windows: 'WorkSpaces Core Windows', Any: 'WorkSpaces Core Windows BYOL',
            } },
          }],
        },
      }],
    };
    mockFetch([
      ['manifest/en_US.json', WSC_MANIFEST],
      ['data/workSpacesCore', WSC_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('WSC');
    eb.addService('workSpacesCore', {
      region: 'us-east-1',
      description: 'Single Standard workspace',
      columnFormIPM: {
        value: [{
          'Operating System': { value: 'Windows' },
          'Number of Nodes': { value: '1' },
          'Running Mode': { value: { unit: '100', selectedId: 'AlwaysOn' } },
        }],
      },
    });

    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    const row = svc.calculationComponents.columnFormIPM.value[0];
    assert.equal(row['Operating System'].value, 'WorkSpaces Core Windows',
      'plain-cell selector value must be remapped');
    assert.equal(row['Running Mode'].value.selectedId, 'Monthly',
      'utilization-cell selectedId must be remapped');
    assert.equal(row['Number of Nodes'].value, '1',
      'unmapped value passes through unchanged');
  });

  it('remaps columnFormIPM values for a sub-service entry', async () => {
    // workSpacesCore is a sub-service under the amazonWorkSpaces envelope.
    const WSC_SUB_MANIFEST = {
      awsServices: [
        { key: 'amazonWorkSpaces', name: 'Amazon WorkSpaces', serviceCode: 'amazonWorkSpaces',
          subType: 'subServiceSelector', templates: ['workSpacesCore'] },
        { key: 'workSpacesCore', name: 'WorkSpaces Core', serviceCode: 'workSpacesCore',
          subType: 'subService' },
      ],
    };
    const WSC_SUB_DEFINITION = {
      version: '0.0.5',
      serviceCode: 'workSpacesCore',
      templates: [{ id: 'wsc-template-1' }],
      cards: [{
        inputSection: {
          components: [{
            type: 'input', subType: 'columnFormIPM', id: 'columnFormIPM',
            remap: { keyValue: { AlwaysOn: 'Monthly', Windows: 'WorkSpaces Core Windows' } },
          }],
        },
      }],
    };
    mockFetch([
      ['manifest/en_US.json', WSC_SUB_MANIFEST],
      ['data/amazonWorkSpaces', { version: '0.0.1', serviceCode: 'amazonWorkSpaces',
        templateId: 'wsParentGroup', templates: [{ id: 'wsParentGroup' }] }],
      ['data/workSpacesCore', WSC_SUB_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('WSC sub');
    eb.addService('workSpacesCore', {
      region: 'us-east-1',
      description: 'Single Standard workspace',
      columnFormIPM: {
        value: [{
          'Operating System': { value: 'Windows' },
          'Running Mode': { value: { unit: '100', selectedId: 'AlwaysOn' } },
        }],
      },
    });

    const payload = await eb.toAWSPayload();
    const parent = Object.values(payload.services)[0];
    const sub = parent.subServices[0];
    const row = sub.calculationComponents.columnFormIPM.value[0];
    assert.equal(row['Operating System'].value, 'WorkSpaces Core Windows',
      'sub-service plain-cell value must be remapped');
    assert.equal(row['Running Mode'].value.selectedId, 'Monthly',
      'sub-service utilization selectedId must be remapped');
  });

  it('is idempotent and a no-op when no remap block is present', async () => {
    // (a) Already-remapped values must not double-remap. (b) A definition
    // with no remap.keyValue leaves the columnFormIPM untouched.
    const WSC_MANIFEST = {
      awsServices: [
        { key: 'workSpacesCore', name: 'WorkSpaces Core', serviceCode: 'workSpacesCore' },
        { key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' },
      ],
    };
    const WSC_DEFINITION = {
      version: '0.0.5', serviceCode: 'workSpacesCore',
      templates: [{ id: 'wsc-template-1' }],
      cards: [{ inputSection: { components: [{
        type: 'input', subType: 'columnFormIPM', id: 'columnFormIPM',
        remap: { keyValue: { Windows: 'WorkSpaces Core Windows', AlwaysOn: 'Monthly' } },
      }] } }],
    };
    mockFetch([
      ['manifest/en_US.json', WSC_MANIFEST],
      ['data/workSpacesCore', WSC_DEFINITION],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Idempotency');
    // Already-remapped (stored) values supplied directly.
    eb.addService('workSpacesCore', {
      region: 'us-east-1', description: 'Already stored',
      columnFormIPM: { value: [{
        'Operating System': { value: 'WorkSpaces Core Windows' },
        'Running Mode': { value: { unit: '100', selectedId: 'Monthly' } },
      }] },
    });
    // No-remap-block service with a columnFormIPM.
    eb.addService('aWSLambda', {
      region: 'us-east-1', description: 'No remap',
      columnFormIPM: { value: [{ 'Some Field': { value: 'Windows' } }] },
    });

    const payload = await eb.toAWSPayload();
    const svcs = Object.values(payload.services);
    const wsc = svcs.find(s => s.serviceCode === 'workSpacesCore');
    const wscRow = wsc.calculationComponents.columnFormIPM.value[0];
    assert.equal(wscRow['Operating System'].value, 'WorkSpaces Core Windows',
      'already-remapped value must not double-remap');
    assert.equal(wscRow['Running Mode'].value.selectedId, 'Monthly',
      'already-remapped selectedId must not double-remap');

    const lam = svcs.find(s => s.serviceCode === 'aWSLambda');
    const lamRow = lam.calculationComponents.columnFormIPM.value[0];
    assert.equal(lamRow['Some Field'].value, 'Windows',
      'no remap block means values pass through untouched');
  });

  it('falls back gracefully when definition fetch fails', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      // no definition response — will 404
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Fallback Test');
    eb.addService('aWSLambda', { region: 'us-east-1', description: 'Test' });

    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    // Should use fallback values
    assert.equal(svc.version, '0.0.1');
    assert.equal(svc.estimateFor, 'template');
  });
});

describe('partition support', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearAwsClientCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearAwsClientCache();
  });

  it('resolvePartition maps regions correctly', () => {
    const { resolvePartition } = require('../lib/aws-client');
    assert.equal(resolvePartition('us-east-1'), 'aws');
    assert.equal(resolvePartition('eu-west-1'), 'aws');
    assert.equal(resolvePartition('us-iso-east-1'), 'aws-iso');
    assert.equal(resolvePartition('us-iso-west-1'), 'aws-iso');
    assert.equal(resolvePartition('us-isob-east-1'), 'aws-iso-b');
    assert.equal(resolvePartition(null), 'aws');
    assert.equal(resolvePartition(undefined), 'aws');
    assert.equal(resolvePartition(''), 'aws');
  });

  it('_buildShareUrl includes contract param for ISO partitions', () => {
    const EB = require('../lib/estimate-builder');
    const eb = new EB('test');
    const awsUrl = eb._buildShareUrl('abc-123', 'aws');
    assert.ok(!awsUrl.includes('ctrct='), 'aws should not have contract param');
    assert.ok(awsUrl.includes('id=abc-123'));

    const isoUrl = eb._buildShareUrl('abc-123', 'aws-iso');
    assert.ok(isoUrl.includes('ctrct='), 'aws-iso should have contract param');
    assert.ok(isoUrl.includes('id=abc-123'));

    const isobUrl = eb._buildShareUrl('abc-123', 'aws-iso-b');
    assert.ok(isobUrl.includes('ctrct='), 'aws-iso-b should have contract param');
  });

  it('auto-detects partition from ISO region', async () => {
    const FAKE_ISO_MANIFEST = {
      awsServices: [{ key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' }],
    };
    const calls = mockFetch([
      ['aws-iso/manifest', FAKE_ISO_MANIFEST],
      ['aws-iso/data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('ISO Test');
    eb.addService('aWSLambda', { region: 'us-iso-east-1', description: 'Test' });

    const payload = await eb.toAWSPayload();
    assert.ok(payload.settings, 'ISO partition should have settings');
    assert.equal(payload.settings.awsPartition, 'aws-iso');
    assert.ok(calls.some(c => c.url.includes('aws-iso/manifest')), 'should fetch ISO manifest');
  });

  it('rejects mixed-partition estimates', () => {
    const EB = require('../lib/estimate-builder');
    const eb = new EB('Mixed Test');
    eb.addService('aWSLambda', { region: 'us-east-1', description: 'Commercial' });
    eb.addService('amazonS3Standard', { region: 'us-iso-east-1', description: 'ISO' });

    assert.rejects(() => eb.toAWSPayload(), /Mixed-partition/);
  });

  it('uses explicit partition over auto-detection', async () => {
    const FAKE_ISO_MANIFEST = {
      awsServices: [{ key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' }],
    };
    mockFetch([
      ['aws-iso/manifest', FAKE_ISO_MANIFEST],
      ['aws-iso/data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Explicit Partition', 'aws-iso');
    eb.addService('aWSLambda', { region: 'us-iso-east-1', description: 'Test' });

    const payload = await eb.toAWSPayload();
    assert.equal(payload.settings.awsPartition, 'aws-iso');
  });

  it('loadManifest rejects unknown partition', async () => {
    const { loadManifest } = require('../lib/aws-client');
    await assert.rejects(() => loadManifest('aws-govcloud'), /Unknown partition/);
  });
});

describe('EstimateBuilder serialization', () => {
  it('round-trips through toJSON / fromJSON preserving all state', () => {
    const original = new EstimateBuilder('My Test', 'aws');
    original.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'compute',
      numberOfRequests: { value: '10', unit: 'millionPerMonth' },
    });
    original.addService('amazonS3Standard', {
      region: 'us-east-1',
      description: 'storage',
    }, { group: 'Prod' });
    original.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'second lambda',
    });

    const snapshot = original.toJSON();
    const hydrated = EstimateBuilder.fromJSON(snapshot);

    assert.equal(hydrated.id, original.id);
    assert.equal(hydrated.name, original.name);
    assert.equal(hydrated.partition, original.partition);
    assert.deepEqual(hydrated.services, original.services);
    assert.deepEqual(hydrated.groups, original.groups);
    assert.ok(hydrated.usedKeys instanceof Set);
    assert.deepEqual([...hydrated.usedKeys].sort(), [...original.usedKeys].sort());

    hydrated.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'third lambda',
    });
    const lambdaKeys = Object.keys(hydrated.services).filter(k => k.startsWith('aWSLambda'));
    assert.equal(lambdaKeys.length, 3, 'dedup logic must survive hydration');
  });

  it('toJSON returns a plain object with no class instances', () => {
    const e = new EstimateBuilder('plain', 'aws');
    e.addService('aWSLambda', { region: 'us-east-1' });
    const snapshot = e.toJSON();
    const round = JSON.parse(JSON.stringify(snapshot));
    assert.deepEqual(round, snapshot);
  });
});

describe('normalizeFieldKeys (FSx for Lustre $0 regression)', () => {
  const { normalizeFieldKeys, _normKey } = require('../lib/estimate-builder');

  // Minimal FSx-for-Lustre-shaped definition: the real storage field id is
  // persistent_generated_0 (label "Storage capacity", fileSize, defaultUnit
  // gb|NA) — NOT "storageCapacity". Mirrors what extractInputFields parses.
  const FSX_DEF = {
    templates: [
      {
        id: 'persistent',
        components: [
          {
            type: 'input', subType: 'fileSize', id: 'persistent_generated_0',
            label: 'Storage capacity',
            dropDownSize: [{ id: 'gb' }, { id: 'tb' }],
            defaultOption: { size: 'gb', frequency: 'NA' },
          },
          {
            type: 'input', subType: 'fileSize', id: 'backupStorage',
            label: 'Backup storage',
            dropDownSize: [{ id: 'gb' }, { id: 'tb' }],
            defaultOption: { size: 'gb', frequency: 'NA' },
          },
        ],
      },
    ],
  };

  it('_normKey collapses label and camelCase alias to the same token', () => {
    assert.equal(_normKey('Storage capacity'), _normKey('storageCapacity'));
    assert.equal(_normKey('Storage capacity'), 'storagecapacity');
  });

  it('maps a friendly label key to the real field id', () => {
    const out = normalizeFieldKeys(
      { storageCapacity: { value: '1200' } }, FSX_DEF, 'persistent'
    );
    assert.ok(out.persistent_generated_0, 'storageCapacity should route to persistent_generated_0');
    assert.equal(out.persistent_generated_0.value, '1200');
    assert.equal(out.storageCapacity, undefined, 'the bogus friendly key must not survive');
  });

  it('repairs a bare fileSize unit to the field default (gb -> gb|NA)', () => {
    const out = normalizeFieldKeys(
      { persistent_generated_0: { value: '1200', unit: 'gb' } }, FSX_DEF, 'persistent'
    );
    assert.equal(out.persistent_generated_0.unit, 'gb|NA');
  });

  it('wraps a bare numeric/string fileSize value with the default unit', () => {
    const out = normalizeFieldKeys(
      { storageCapacity: '1200' }, FSX_DEF, 'persistent'
    );
    assert.deepEqual(out.persistent_generated_0, { value: '1200', unit: 'gb|NA' });
  });

  it('injects the default unit when a fileSize value object has none', () => {
    const out = normalizeFieldKeys(
      { backupStorage: { value: '500' } }, FSX_DEF, 'persistent'
    );
    assert.equal(out.backupStorage.unit, 'gb|NA');
  });

  it('leaves an already-valid field id + full unit untouched', () => {
    const out = normalizeFieldKeys(
      { persistent_generated_0: { value: '1200', unit: 'tb|NA' } }, FSX_DEF, 'persistent'
    );
    assert.equal(out.persistent_generated_0.unit, 'tb|NA');
  });

  it('preserves region and description', () => {
    const out = normalizeFieldKeys(
      { region: 'us-east-1', description: 'x', storageCapacity: '1200' }, FSX_DEF, 'persistent'
    );
    assert.equal(out.region, 'us-east-1');
    assert.equal(out.description, 'x');
  });

  it('is a no-op without a definition', () => {
    const input = { storageCapacity: { value: '1200' } };
    assert.deepEqual(normalizeFieldKeys(input, null, 'persistent'), input);
  });

  it('the real field id wins over an alias regardless of key order', () => {
    // A caller who supplies BOTH the friendly alias and the real field id must
    // not have the real value silently clobbered by the alias (or vice-versa).
    const aliasFirst = normalizeFieldKeys(
      { storageCapacity: '1200', persistent_generated_0: { value: '999', unit: 'gb|NA' } },
      FSX_DEF, 'persistent'
    );
    const idFirst = normalizeFieldKeys(
      { persistent_generated_0: { value: '999', unit: 'gb|NA' }, storageCapacity: '1200' },
      FSX_DEF, 'persistent'
    );
    assert.equal(aliasFirst.persistent_generated_0.value, '999', 'alias-first: real id wins');
    assert.equal(idFirst.persistent_generated_0.value, '999', 'id-first: real id wins');
    assert.equal(aliasFirst.storageCapacity, undefined);
    assert.equal(idFirst.storageCapacity, undefined);
  });
});
