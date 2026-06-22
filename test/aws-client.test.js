const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Tracing is off by default; tests in this file assert save.* event
// emission, which only happens with TRACE=on. Off-state behavior is
// covered in test/trace-flag.test.js.
process.env.TRACE = 'on';

const { runWithSession } = require('../lib/trace/request-context');

function mockManifest() {
  return new Map([
    ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda', searchKeywords: ['serverless', 'functions'] }],
    ['amazonS3Standard', { key: 'amazonS3Standard', name: 'Amazon S3 Standard', searchKeywords: ['storage', 'object store'] }],
    ['amazonSimpleNotificationService', { key: 'amazonSimpleNotificationService', name: 'Amazon SNS', subType: 'subServiceSelector' }],
    ['standardTopics', { key: 'standardTopics', name: 'Amazon SNS Standard Topics', searchKeywords: ['notification'] }],
    ['eC2Next', { key: 'eC2Next', name: 'Amazon EC2', isActive: 'false' }],
    ['ec2Enhancement', { key: 'ec2Enhancement', name: 'Amazon EC2', isActive: 'true' }],
  ]);
}

describe('searchServices', () => {
  it('finds services by name', () => {
    const { searchServices } = require('../lib/aws/aws-client');
    const results = searchServices(mockManifest(), 'lambda');
    assert.equal(results.length, 1);
    assert.equal(results[0].key, 'aWSLambda');
  });

  it('finds services by keyword', () => {
    const { searchServices } = require('../lib/aws/aws-client');
    const results = searchServices(mockManifest(), 'serverless');
    assert.equal(results.length, 1);
    assert.equal(results[0].key, 'aWSLambda');
  });

  it('excludes inactive services', () => {
    const { searchServices } = require('../lib/aws/aws-client');
    const results = searchServices(mockManifest(), 'ec2');
    const keys = results.map(r => r.key);
    assert.ok(!keys.includes('eC2Next'), 'should exclude inactive eC2Next');
    assert.ok(keys.includes('ec2Enhancement'), 'should include active ec2Enhancement');
  });

  it('excludes subServiceSelector parents', () => {
    const { searchServices } = require('../lib/aws/aws-client');
    const results = searchServices(mockManifest(), 'sns');
    const keys = results.map(r => r.key);
    assert.ok(!keys.includes('amazonSimpleNotificationService'));
  });

  it('handles multiple comma-separated terms', () => {
    const { searchServices } = require('../lib/aws/aws-client');
    const results = searchServices(mockManifest(), 'lambda, s3');
    assert.ok(results.lambda, 'should have lambda key');
    assert.ok(results.s3, 'should have s3 key');
    assert.equal(results.lambda.length, 1);
    assert.equal(results.s3.length, 1);
  });

  it('returns empty array for no matches', () => {
    const { searchServices } = require('../lib/aws/aws-client');
    const results = searchServices(mockManifest(), 'nonexistent');
    assert.equal(results.length, 0);
  });
});

describe('parseDoubleEncodedResponse', () => {
  it('parses valid double-encoded AWS response', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws/aws-client');
    const raw = JSON.stringify({
      statusCode: 200,
      body: JSON.stringify({ savedKey: 'abc123' }),
    });
    const result = parseDoubleEncodedResponse(raw);
    assert.equal(result.savedKey, 'abc123');
  });

  it('throws on invalid outer JSON', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws/aws-client');
    assert.throws(() => parseDoubleEncodedResponse('not json'), /invalid JSON/i);
  });

  it('throws on invalid inner body JSON', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws/aws-client');
    const raw = JSON.stringify({ body: 'not json' });
    assert.throws(() => parseDoubleEncodedResponse(raw), /invalid body/i);
  });

  it('throws when savedKey is missing', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws/aws-client');
    const raw = JSON.stringify({ body: JSON.stringify({ other: 'data' }) });
    assert.throws(() => parseDoubleEncodedResponse(raw), /savedKey/i);
  });
});

describe('extractInputFields', () => {
  const { extractInputFields } = require('../lib/aws/aws-client');

  it('extracts numericInput fields', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'requestCount', type: 'numericInput', label: 'Requests' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].id, 'requestCount');
    assert.equal(fields[0].type, 'numericInput');
    assert.equal(fields[0].label, 'Requests');
  });

  it('extracts dropdown subType fields', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'storageClass', type: 'input', subType: 'dropdown', label: 'Storage class',
        options: [{ id: 'standard', label: 'Standard' }, { id: 'ia', label: 'Infrequent Access' }] },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].type, 'dropdown');
    assert.equal(fields[0].options.length, 2);
    assert.equal(fields[0].options[0].id, 'standard');
  });

  it('skips WithoutFreeTier and _MVP duplicates', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'requests', type: 'numericInput', label: 'Requests' },
      { id: 'requestsWithoutFreeTier', type: 'numericInput', label: 'Requests (no free tier)' },
      { id: 'duration_MVP', type: 'numericInput', label: 'Duration MVP' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1, 'should only include the base field');
    assert.equal(fields[0].id, 'requests');
  });

  it('deduplicates fields repeated across templates', () => {
    const def = { templates: [
      { id: 'tpl1', groups: [{ items: [{ id: 'region', type: 'input', subType: 'dropdown' }] }] },
      { id: 'tpl2', groups: [{ items: [{ id: 'region', type: 'input', subType: 'dropdown' }] }] },
    ]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1, 'should deduplicate');
  });

  it('includes fileSize metadata', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'storage', type: 'fileSize', label: 'Storage',
        dropDownSize: [{ value: 'gb' }, { value: 'tb' }],
        defaultOption: { size: 'gb', frequency: 'NA' } },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.deepEqual(fields[0].validSizes, ['gb', 'tb']);
    assert.equal(fields[0].defaultUnit, 'gb|NA');
  });

  it('surfaces PCT defaultValue when present', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'numberOfWriteTrails', type: 'numericInput', label: 'Trails', defaultValue: 1 },
      { id: 'noDefault', type: 'numericInput', label: 'No default' },
    ]}]}]};
    const fields = extractInputFields(def);
    const trails = fields.find(f => f.id === 'numberOfWriteTrails');
    const noDefault = fields.find(f => f.id === 'noDefault');
    assert.equal(trails.defaultValue, 1);
    assert.equal(noDefault.defaultValue, undefined);
  });

  it('surfaces meaningful placeholder text but skips generic ones', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'specific', type: 'numericInput', label: 'X', placeholder: 'Enter number of S3 operations in units selected' },
      { id: 'generic1', type: 'numericInput', label: 'Y', placeholder: 'Enter the amount' },
      { id: 'generic2', type: 'numericInput', label: 'Z', placeholder: 'Enter amount' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.find(f => f.id === 'specific').placeholder, 'Enter number of S3 operations in units selected');
    assert.equal(fields.find(f => f.id === 'generic1').placeholder, undefined);
    assert.equal(fields.find(f => f.id === 'generic2').placeholder, undefined);
  });

  it('skips decorative types like bodyText and headerText', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'header1', type: 'input', subType: 'headerText' },
      { id: 'body1', type: 'input', subType: 'bodyText' },
      { id: 'alert1', type: 'input', subType: 'alert' },
      { id: 'actual', type: 'numericInput', label: 'Value' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].id, 'actual');
  });
});

describe('saveEstimate trace events', () => {
  let originalFetch;
  let writes;
  let originalWrite;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalWrite = process.stderr.write.bind(process.stderr);
    writes = [];
    process.stderr.write = (s) => { writes.push(s); return true; };
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.stderr.write = originalWrite;
  });

  it('emits save.send and save.ok for a successful save, stamped with session id', async () => {
    // The AWS save endpoint returns a Lambda proxy-shaped response:
    // outer JSON has statusCode + body, body is a JSON string. See
    // parseDoubleEncodedResponse in lib/aws-client.js and its existing
    // test on line 62-70 of test/aws-client.test.js for the exact shape.
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        statusCode: 200,
        body: JSON.stringify({ savedKey: 'abc123' }),
      }),
    });
    const { saveEstimate } = require('../lib/aws/aws-client');
    await runWithSession('sid-42', () =>
      saveEstimate({ services: { s1: {} }, groups: {} }),
    );
    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const send = events.find(e => e.event === 'save.send');
    const ok = events.find(e => e.event === 'save.ok');
    assert.ok(send, 'expected save.send event');
    assert.ok(ok, 'expected save.ok event');
    assert.equal(send.serviceCount, 1);
    assert.equal(send.groupCount, 0);
    assert.equal(send.mcpSessionId, 'sid-42');
    assert.equal(ok.savedKey, 'abc123');
    assert.equal(ok.mcpSessionId, 'sid-42');
  });

  it('emits save.fail on non-200 with the response status and a body excerpt', async () => {
    // The save.fail path triggers when res.ok is false. Response text
    // is treated as opaque (no double-decode), so a plain string is the
    // right shape here.
    global.fetch = async () => ({
      ok: false, status: 400,
      text: async () => 'bad request: too many tokens',
    });
    const { saveEstimate } = require('../lib/aws/aws-client');
    await assert.rejects(() =>
      runWithSession('sid-43', () => saveEstimate({ services: {}, groups: {} })),
    );
    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const fail = events.find(e => e.event === 'save.fail');
    assert.ok(fail);
    assert.equal(fail.status, 400);
    assert.match(fail.body, /bad request/);
    assert.equal(fail.mcpSessionId, 'sid-43');
  });

  it('passes estimateId through to save.send / save.ok / save.fail when supplied', async () => {
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        statusCode: 200,
        body: JSON.stringify({ savedKey: 'abc123' }),
      }),
    });
    const { saveEstimate } = require('../lib/aws/aws-client');
    await runWithSession('sid-50', () =>
      saveEstimate({ services: { s1: {} }, groups: {} }, { estimateId: 'local-est-id-99' }),
    );
    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const send = events.find(e => e.event === 'save.send');
    const ok = events.find(e => e.event === 'save.ok');
    assert.equal(send.estimateId, 'local-est-id-99');
    assert.equal(ok.estimateId, 'local-est-id-99');
  });

  it('omits estimateId when not supplied (back-compat)', async () => {
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        statusCode: 200,
        body: JSON.stringify({ savedKey: 'abc124' }),
      }),
    });
    const { saveEstimate } = require('../lib/aws/aws-client');
    await saveEstimate({ services: {}, groups: {} });  // no second arg
    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const send = events.find(e => e.event === 'save.send');
    assert.equal(send.estimateId, undefined);
  });

  it('stamps estimateId on save.fail too', async () => {
    global.fetch = async () => ({
      ok: false, status: 400,
      text: async () => 'bad request',
    });
    const { saveEstimate } = require('../lib/aws/aws-client');
    await assert.rejects(() =>
      runWithSession('sid-51', () => saveEstimate({ services: {}, groups: {} }, { estimateId: 'local-est-id-100' })),
    );
    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const fail = events.find(e => e.event === 'save.fail');
    assert.equal(fail.estimateId, 'local-est-id-100');
  });
});
