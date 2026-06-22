/**
 * End-to-end integration tests — hit the real AWS Calculator save and read APIs.
 *
 * These tests require network access and the read endpoint to be live.
 * They verify:
 *   1. Build → save → URL works (smoke).
 *   2. Build → save → fetch back → field-by-field comparison (true roundtrip).
 *
 * Run with: npm test (or `node --test test/integration.test.js`).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EstimateBuilder = require('../lib/aws/estimate-builder');
const { fetchEstimate } = require('../lib/aws/aws-client');

describe('integration: export to calculator.aws', () => {
  it('builds and saves a Lambda estimate, returns a working URL', async () => {
    const eb = new EstimateBuilder('Integration Test');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      requestDuration: { value: '200', unit: 'ms' },
    });

    const result = await eb.export();

    assert.ok(result.estimateId, 'should return an estimateId');
    assert.ok(result.shareableUrl, 'should return a shareableUrl');
    assert.ok(
      result.shareableUrl.startsWith('https://calculator.aws/'),
      `URL should start with https://calculator.aws/, got: ${result.shareableUrl}`
    );
    assert.ok(
      result.shareableUrl.includes(result.estimateId),
      'URL should contain the estimate ID'
    );

    console.log(`\n  Shareable URL: ${result.shareableUrl}\n`);
  });
});

describe('integration: roundtrip (save → fetch → compare)', () => {
  it('preserves estimate name, service, region, description, and calculation components', async () => {
    const NAME = `Roundtrip Test ${Date.now()}`;
    const DESCRIPTION = 'Compute for API';
    const REGION = 'us-east-1';
    const REQUESTS = { value: '7', unit: 'millionPerMonth' };

    const eb = new EstimateBuilder(NAME);
    eb.addService('aWSLambda', {
      region: REGION,
      description: DESCRIPTION,
      numberOfRequests: REQUESTS,
      requestDuration: { value: '150', unit: 'ms' },
    });

    const exported = await eb.export();
    assert.ok(exported.estimateId, 'export must return an estimateId');

    const fetched = await fetchEstimate(exported.estimateId);

    // Top-level
    assert.equal(fetched.name, NAME, 'estimate name should round-trip');
    assert.ok(fetched.services, 'fetched estimate should have services');

    const serviceEntries = Object.entries(fetched.services);
    assert.equal(serviceEntries.length, 1, 'should have exactly one ungrouped service');
    const [svcKey, svc] = serviceEntries[0];
    assert.ok(svcKey.startsWith('aWSLambda'), `service key should start with aWSLambda, got ${svcKey}`);

    // Service-level fields
    assert.equal(svc.serviceCode, 'aWSLambda');
    assert.equal(svc.serviceName, 'AWS Lambda');
    assert.equal(svc.region, REGION);
    assert.equal(svc.description, DESCRIPTION);

    // Calculation components — the actual configuration must be preserved
    assert.ok(svc.calculationComponents, 'should have calculationComponents');
    assert.deepEqual(
      svc.calculationComponents.numberOfRequests,
      REQUESTS,
      'numberOfRequests should round-trip exactly'
    );

    console.log(`\n  Roundtrip OK — ${exported.shareableUrl}\n`);
  });

  it('preserves grouped services and EC2 transform through roundtrip', async () => {
    const eb = new EstimateBuilder('Roundtrip Grouped + EC2');
    eb.addService('aWSLambda', {
      region: 'eu-west-1',
      description: 'Compute',
      numberOfRequests: { value: '2', unit: 'millionPerMonth' },
    }, { group: 'Production' });
    eb.addService('ec2Enhancement', {
      region: 'eu-west-1',
      description: '2x m5.large On-Demand',
      instanceType: 'm5.large',
      quantity: 2,
      selectedOS: 'linux',
      pricingStrategy: 'ondemand',
    }, { group: 'Production' });

    const exported = await eb.export();
    const fetched = await fetchEstimate(exported.estimateId);

    // Grouped — top-level services should be empty, group should hold both
    assert.equal(Object.keys(fetched.services || {}).length, 0, 'no ungrouped services expected');
    const groups = Object.values(fetched.groups || {});
    assert.equal(groups.length, 1, 'should have one group');
    assert.equal(groups[0].name, 'Production');

    const groupSvcs = Object.values(groups[0].services || {});
    assert.equal(groupSvcs.length, 2, 'group should contain both services');

    const codes = groupSvcs.map(s => s.serviceCode).sort();
    assert.deepEqual(codes, ['aWSLambda', 'ec2Enhancement'], 'EC2 must be saved as ec2Enhancement, not eC2Next');

    const ec2Svc = groupSvcs.find(s => s.serviceCode === 'ec2Enhancement');
    assert.equal(ec2Svc.calculationComponents?.instanceType?.value, 'm5.large');
    assert.equal(ec2Svc.calculationComponents?.workload?.value?.data, '2', 'quantity should map to workload data');
    assert.equal(ec2Svc.calculationComponents?.pricingStrategy?.value?.selectedOption, 'on-demand');

    console.log(`\n  Grouped+EC2 roundtrip OK — ${exported.shareableUrl}\n`);
  });

  it('wraps a subService child in its parent envelope on save', async () => {
    // standardTopics is a `subType: 'subService'` child of
    // amazonSimpleNotificationService. The estimate-builder must emit a
    // parent envelope with subServices[] — saving the child directly
    // produces a calculator that can't rehydrate it.
    const REQUESTS = { value: '4', unit: 'millionPerMonth' };
    const DESCRIPTION = 'SNS topic publishes';

    const eb = new EstimateBuilder('Roundtrip subService');
    eb.addService('standardTopics', {
      region: 'us-east-1',
      description: DESCRIPTION,
      numberOfRequests: REQUESTS,
    });

    const exported = await eb.export();
    const fetched = await fetchEstimate(exported.estimateId);

    const entries = Object.entries(fetched.services || {});
    assert.equal(entries.length, 1, 'should have one service entry');
    const [key, svc] = entries[0];

    assert.ok(
      key.startsWith('amazonSimpleNotificationService'),
      `entry must be keyed under the parent SNS service, got ${key}`
    );
    assert.equal(svc.serviceCode, 'amazonSimpleNotificationService',
      'parent serviceCode must be the SNS top-level service');
    assert.ok(Array.isArray(svc.subServices), 'must have subServices array');
    assert.equal(svc.subServices.length, 1);

    const sub = svc.subServices[0];
    assert.equal(sub.serviceCode, 'standardTopics', 'inner subService must keep its real serviceCode');
    assert.equal(sub.description, DESCRIPTION, 'subService description should round-trip');
    assert.deepEqual(
      sub.calculationComponents.numberOfRequests,
      REQUESTS,
      'subService calculationComponents must round-trip exactly'
    );

    console.log(`\n  subService roundtrip OK — ${exported.shareableUrl}\n`);
  });
});

describe('estimate-store integration', () => {
  it('create_estimate + add_service share state through the configured store', async () => {
    delete require.cache[require.resolve('../mcp-server.js')];
    delete require.cache[require.resolve('../lib/store/estimate-store')];
    delete require.cache[require.resolve('../lib/aws/estimate-builder')];
    process.env.ESTIMATES_STORE = 'memory';

    const { __test } = require('../mcp-server.js');
    assert.ok(__test, 'mcp-server.js must export a __test handle');
    const store = __test.store;

    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const estimate = new EstimateBuilder('integ', 'aws');
    await store.put(estimate);

    const got = await store.get(estimate.id);
    assert.ok(got, 'estimate must round-trip through the configured store');
    got.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'integ',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });
    await store.put(got);

    const final = await store.get(estimate.id);
    assert.equal(Object.keys(final.services).length, 1);
  });
});
