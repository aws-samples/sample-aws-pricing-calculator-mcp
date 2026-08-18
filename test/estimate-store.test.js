const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryEstimateStore, createEstimateStore } = require('../lib/store/estimate-store');
const EstimateBuilder = require('../lib/aws/estimate-builder');

describe('MemoryEstimateStore', () => {
  it('returns null for unknown id', async () => {
    const store = new MemoryEstimateStore();
    assert.equal(await store.get('nope'), null);
  });

  it('persists and retrieves an estimate as a hydrated EstimateBuilder', async () => {
    const store = new MemoryEstimateStore();
    const e = new EstimateBuilder('test', 'aws');
    e.addService('aWSLambda', { region: 'us-east-1' });
    await store.put(e);

    const got = await store.get(e.id);
    assert.ok(got);
    assert.equal(got.id, e.id);
    assert.equal(got.name, 'test');
    assert.equal(typeof got.addService, 'function');
    assert.deepEqual(got.services, e.services);
  });

  it('returns independent copies on each get (no shared mutation)', async () => {
    const store = new MemoryEstimateStore();
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);

    const a = await store.get(e.id);
    const b = await store.get(e.id);
    a.addService('aWSLambda', { region: 'us-east-1' });
    assert.equal(Object.keys(b.services).length, 0,
      'mutating one retrieved copy must not affect another');
  });

  it('delete removes the entry', async () => {
    const store = new MemoryEstimateStore();
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    await store.delete(e.id);
    assert.equal(await store.get(e.id), null);
  });
});

describe('createEstimateStore', () => {
  it('returns MemoryEstimateStore by default', () => {
    const store = createEstimateStore({});
    assert.ok(store instanceof MemoryEstimateStore);
  });

  it('returns MemoryEstimateStore when ESTIMATES_STORE=memory', () => {
    const store = createEstimateStore({ ESTIMATES_STORE: 'memory' });
    assert.ok(store instanceof MemoryEstimateStore);
  });

  it('throws on unknown store type', () => {
    assert.throws(
      () => createEstimateStore({ ESTIMATES_STORE: 'redis' }),
      /Unknown ESTIMATES_STORE/,
    );
  });
});
