// Layer 3 — real-manifest probes. Hits the live AWS manifest CDN.
// Skip in CI if AWS_OFFLINE is set.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfigKeys } = require('../lib/lint/validation');

if (process.env.AWS_OFFLINE) {
  describe('value validation against real manifest (AWS_OFFLINE set, skipping)', () => {
    it('skipped', () => assert.ok(true));
  });
} else {
  describe('value validation against real manifest', () => {
    it('aWSLambda — realistic config produces no error or corrections', async () => {
      // Lambda is the canary for "our rules don't false-positive on realistic
      // config." If this test fails on r.corrections, inspect the corrections:
      //   - Look like a calculator-side change (manifest renamed a unit,
      //     added a default we don't know about)? Update this fixture and
      //     note the change in commit message.
      //   - Look like our rules over-corrected something legitimate? Fix
      //     the rule in lib/validation.js, do not loosen this test.
      // Real Lambda fields (verified against the live manifest 2026-05-14):
      //   numberOfRequests       — frequency, units include millionPerMonth
      //   durationOfEachRequest  — numericInput (string-typed)
      const r = await validateConfigKeys('aWSLambda', {
        region: 'us-east-1',
        description: 'real probe',
        numberOfRequests: { value: '5', unit: 'millionPerMonth' },
        durationOfEachRequest: '200',
      });
      assert.equal(r.error, null,
        `expected no error; got: ${r.error}`);
      assert.deepEqual(r.corrections, [],
        `expected no corrections on a realistic Lambda config; got: ${JSON.stringify(r.corrections)}`);
    });

    it('amazonS3Standard — realistic config produces no error', async () => {
      const r = await validateConfigKeys('amazonS3Standard', {
        region: 'us-east-1',
        description: 'real probe',
        s3StandardStorageSize: { value: '100', unit: 'gb|month' },
      });
      assert.equal(r.error, null);
      // S3 may have legitimate corrections (e.g. casing differences from
      // the manifest). Don't fail on corrections here; only fail on error.
    });

    it('amazonRDSPostgreSQLDB — realistic IPM config passes', async () => {
      const r = await validateConfigKeys('amazonRDSPostgreSQLDB', {
        region: 'eu-south-1',
        description: 'real probe',
        columnFormIPM: {
          value: [{
            'Number of Nodes': { value: '1' },
            'Instance Type': { value: 'db.r6g.4xlarge' },
            'undefined': { value: { unit: '100', selectedId: '%Utilized/Month' } },
            'Deployment Option': { value: 'Single-AZ' },
            'TermType': { value: 'OnDemand' },
          }],
        },
        storageVolume: 'General Purpose-GP3',
        storageAmount: { value: '100', unit: 'gb|NA' },
      });
      assert.equal(r.error, null,
        `expected no error; got: ${r.error}`);
    });

    it('amazonMQ — RabbitMQ template config validates without crashing', async () => {
      // Same field IDs as test/templates.test.js
      const r = await validateConfigKeys('amazonMQ', {
        region: 'eu-south-1',
        description: 'real probe',
        rabbitBrokerType: '1',
        rabbitmqNumberOfBrokers: '1',
        rabbitmqInstanceType: 'tIoJ4D_dNdY2Z0ip26h0fdIGIr9-giewflvmYs_wLQ4',
      });
      // Accept either "no error" or — if MQ has dropdowns where the values
      // we passed are wrong — an error that mentions one of the fields
      // above. The point is we don't crash and don't produce a NONSENSE
      // error unrelated to our config.
      if (r.error) {
        const mentioned = ['rabbitBrokerType', 'rabbitmqNumberOfBrokers', 'rabbitmqInstanceType']
          .some(f => r.error.includes(f));
        assert.ok(mentioned, `error must reference an MQ field; got: ${r.error}`);
      }
    });

    it('aWSFargate — minimal config produces no crash', async () => {
      const r = await validateConfigKeys('aWSFargate', {
        region: 'us-east-1',
        description: 'real probe',
      });
      // Just confirm we can validate this service without a crash. No
      // assertions on shape — we are testing reachability.
      assert.ok(r);
      assert.ok('error' in r);
    });
  });
}
