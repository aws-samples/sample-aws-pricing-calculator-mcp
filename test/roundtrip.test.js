/**
 * Round-trip tests — strict deep-equal between the payload we send and the
 * blob we get back from the read endpoint.
 *
 * Complements integration.test.js, which asserts a few specific fields
 * round-trip. These tests assert the WHOLE payload round-trips (modulo
 * server-injected estimateId and client-generated UUID suffixes), so a
 * regression in any field — not just the ones we thought to assert on —
 * fails the run.
 *
 * Probe data (scripts/probe-roundtrip.js, 2026-05-15) showed that across
 * 8 shapes, only `metaData.estimateId` ever differs. These tests pin that
 * invariant for the two shapes that aren't already covered by
 * integration.test.js: AppSync multi-child sub-service collapse, and the
 * EC2 dedicated-tenancy reserved-instance branch in lib/aws/ec2.js.
 *
 * Network required.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EstimateBuilder = require('../lib/aws/estimate-builder');
const { fetchEstimate, saveEstimate } = require('../lib/aws/aws-client');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Composite keys carry a fresh client-side UUID (`aWSLambda-<uuid>`); the
// stored copy keeps the same UUIDs but a strict deep-equal would still
// flag them on every run if we re-built. Collapse to <UUID> so the
// comparison is shape-independent.
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k.replace(UUID_RE, '<UUID>')] = normalize(v);
    }
    return out;
  }
  return node;
}

// Server-injected; expected to differ. Confirmed by 8-shape probe.
const IGNORE_PATHS = new Set(['metaData.estimateId']);

function assertNoDiffs(sent, fetched) {
  const diffs = [];
  function walk(a, b, p) {
    if (IGNORE_PATHS.has(p)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        const cp = `${p}[${i}]`;
        if (IGNORE_PATHS.has(cp)) continue;
        if (i >= a.length) diffs.push(`+ ${cp}: ${JSON.stringify(b[i])}`);
        else if (i >= b.length) diffs.push(`- ${cp}: ${JSON.stringify(a[i])}`);
        else walk(a[i], b[i], cp);
      }
      return;
    }
    const aObj = a && typeof a === 'object' && !Array.isArray(a);
    const bObj = b && typeof b === 'object' && !Array.isArray(b);
    if (aObj && bObj) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const cp = p ? `${p}.${k}` : k;
        if (IGNORE_PATHS.has(cp)) continue;
        if (!(k in a)) diffs.push(`+ ${cp}: ${JSON.stringify(b[k])}`);
        else if (!(k in b)) diffs.push(`- ${cp}: ${JSON.stringify(a[k])}`);
        else walk(a[k], b[k], cp);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push(`~ ${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  }
  walk(sent, fetched, '');
  assert.equal(diffs.length, 0, `expected zero diffs (modulo allowlist), got:\n  ${diffs.join('\n  ')}`);
}

describe('roundtrip: full payload deep-equal', () => {
  it('AppSync multi-child collapses into one parent envelope and round-trips', async () => {
    // awsAppSync is a subServiceSelector; appSyncApiCall + appSyncCaching
    // are two of its templates. The builder must collapse them into one
    // envelope with a 2-element subServices[]. This is the only multi-child
    // shape integration.test.js doesn't cover (it only tests SNS single-child).
    const eb = new EstimateBuilder('Roundtrip: AppSync multi-child');
    eb.addService('appSyncApiCall', {
      region: 'us-east-1',
      description: 'api calls',
      noOfSearches: { value: '1000', unit: 'per month' },
    });
    eb.addService('appSyncCaching', {
      region: 'us-east-1',
      description: 'caching',
      cacheSize: 'small_1_4',
    });

    // Build the payload once and save it directly. Going through
    // export() would call toAWSPayload() a second time, producing a
    // fresh metaData.createdOn timestamp that differs from `sent` by a
    // few ms — a test artifact, not a server-side mutation.
    const sent = await eb.toAWSPayload();
    const { estimateId } = await saveEstimate(sent);
    const fetched = await fetchEstimate(estimateId);

    // Spot-assert the multi-child shape before the deep-equal — gives a
    // clearer failure message if the collapse logic regresses.
    const services = Object.values(fetched.services);
    assert.equal(services.length, 1, 'multi-child must collapse to a single parent envelope');
    assert.equal(services[0].serviceCode, 'awsAppSync');
    assert.equal(services[0].subServices.length, 2);

    assertNoDiffs(normalize(sent), normalize(fetched));
  });

  it('EC2 dedicated-tenancy reserved-instance round-trips (the standard/convertible branch)', async () => {
    // ec2.js maps "reserved" → instanceSavings ONLY for shared tenancy.
    // The dedicated path (selectedOption: "standard") is exercised here;
    // it's the ec2.js branch that integration.test.js's on-demand test
    // doesn't touch.
    const eb = new EstimateBuilder('Roundtrip: EC2 dedicated RI');
    eb.addService('ec2Enhancement', {
      region: 'us-east-1',
      description: 'dedicated reserved 3yr partial',
      instanceType: 'm5.large',
      quantity: '1',
      pricingStrategy: 'reserved3yrPartialUpfront',
      tenancy: 'dedicated',
      selectedOS: 'linux',
    });

    // Build the payload once and save it directly. Going through
    // export() would call toAWSPayload() a second time, producing a
    // fresh metaData.createdOn timestamp that differs from `sent` by a
    // few ms — a test artifact, not a server-side mutation.
    const sent = await eb.toAWSPayload();
    const { estimateId } = await saveEstimate(sent);
    const fetched = await fetchEstimate(estimateId);

    // Confirm we exercised the right branch.
    const ec2 = Object.values(fetched.services)[0];
    assert.equal(ec2.calculationComponents.pricingStrategy.value.selectedOption, 'standard');
    assert.equal(ec2.calculationComponents.tenancy.value, 'dedicated');

    assertNoDiffs(normalize(sent), normalize(fetched));
  });
});
