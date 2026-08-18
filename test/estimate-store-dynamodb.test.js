const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DynamoEstimateStore } = require('../lib/store/estimate-store-dynamodb');
const EstimateBuilder = require('../lib/aws/estimate-builder');

class FakeDocClient {
  constructor() {
    this.rows = new Map();
    this.calls = [];
  }
  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ name, input });
    if (name === 'GetCommand') {
      const item = this.rows.get(input.Key.id);
      return { Item: item ?? undefined };
    }
    if (name === 'PutCommand') {
      this.rows.set(input.Item.id, input.Item);
      return {};
    }
    if (name === 'DeleteCommand') {
      this.rows.delete(input.Key.id);
      return {};
    }
    throw new Error(`Unsupported command in FakeDocClient: ${name}`);
  }
}

describe('DynamoEstimateStore', () => {
  let fakeClient;
  let store;

  beforeEach(() => {
    fakeClient = new FakeDocClient();
    store = new DynamoEstimateStore({
      tableName: 'estimates-test',
      docClient: fakeClient,
    });
  });

  it('returns null for unknown id', async () => {
    assert.equal(await store.get('missing'), null);
    assert.equal(fakeClient.calls.length, 1);
    assert.equal(fakeClient.calls[0].name, 'GetCommand');
    assert.equal(fakeClient.calls[0].input.TableName, 'estimates-test');
    assert.deepEqual(fakeClient.calls[0].input.Key, { id: 'missing' });
  });

  it('puts an estimate as a JSON snapshot', async () => {
    const e = new EstimateBuilder('test', 'aws');
    e.addService('aWSLambda', { region: 'us-east-1' });
    await store.put(e);

    assert.equal(fakeClient.calls.length, 1);
    assert.equal(fakeClient.calls[0].name, 'PutCommand');
    const item = fakeClient.calls[0].input.Item;
    assert.equal(item.id, e.id);
    assert.equal(typeof item.snapshot, 'string',
      'snapshot must be a JSON string for portability');
    const parsed = JSON.parse(item.snapshot);
    assert.equal(parsed.id, e.id);
    assert.equal(parsed.name, 'test');
  });

  it('round-trips through put + get yielding a hydrated EstimateBuilder', async () => {
    const e = new EstimateBuilder('test', 'aws');
    e.addService('aWSLambda', { region: 'us-east-1' });
    await store.put(e);

    const got = await store.get(e.id);
    assert.ok(got);
    assert.equal(got.id, e.id);
    assert.equal(typeof got.addService, 'function');
    assert.deepEqual(got.services, e.services);
  });

  it('writes a TTL attribute when ttlSeconds is configured', async () => {
    const ttlStore = new DynamoEstimateStore({
      tableName: 'estimates-test',
      docClient: fakeClient,
      ttlSeconds: 3600,
    });
    const e = new EstimateBuilder('test', 'aws');
    const before = Math.floor(Date.now() / 1000);
    await ttlStore.put(e);
    const item = fakeClient.calls[0].input.Item;
    assert.ok(typeof item.expiresAt === 'number',
      'expiresAt must be a numeric epoch second when TTL is configured');
    assert.ok(item.expiresAt >= before + 3600 - 1);
    assert.ok(item.expiresAt <= before + 3600 + 5);
  });

  it('omits TTL when ttlSeconds is not configured', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const item = fakeClient.calls[0].input.Item;
    assert.equal(item.expiresAt, undefined);
  });

  it('delete sends DeleteCommand against the configured table', async () => {
    await store.delete('some-id');
    assert.equal(fakeClient.calls[0].name, 'DeleteCommand');
    assert.equal(fakeClient.calls[0].input.TableName, 'estimates-test');
    assert.deepEqual(fakeClient.calls[0].input.Key, { id: 'some-id' });
  });

  it('factory rejects construction without tableName', () => {
    assert.throws(
      () => new DynamoEstimateStore({ docClient: fakeClient }),
      /tableName is required/,
    );
  });
});

describe('createEstimateStore + dynamodb wiring', () => {
  it('createEstimateStore("dynamodb") returns a DynamoEstimateStore', () => {
    const { createEstimateStore } = require('../lib/store/estimate-store');
    const store = createEstimateStore({
      ESTIMATES_STORE: 'dynamodb',
      ESTIMATES_TABLE: 'estimates-test',
      AWS_REGION: 'us-east-1',
    });
    assert.equal(store.constructor.name, 'DynamoEstimateStore');
  });
});
