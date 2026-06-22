// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Some tests in this file ('exportWithLint trace events') assert that
// `lint` events get emitted; that requires TRACE=on. Off-state
// behavior is exercised in test/trace-flag.test.js.
process.env.TRACE = 'on';

const EstimateBuilder = require('../lib/aws/estimate-builder');
const { canRehydrate } = require('../lib/lint/can-rehydrate');

describe('export_estimate lint preflight', () => {
  it('a healthy Lambda payload lints as editable (would proceed to save)', async () => {
    // Use a real Lambda config — predicate 1, 2, 3 all pass.
    const eb = new EstimateBuilder('test');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      requestDuration: { value: '200', unit: 'ms' },
    });
    const blob = await eb.toAWSPayload();
    // Inline mock perServiceDefinitions (avoids network in this unit test)
    const def = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambdaWithFreeTier' }, { id: 'lambdaWithoutFreeTier', mappingFromTemplate: null }],
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.notEqual(r.status, 'read-only', 'healthy Lambda payload must not lint read-only');
  });

  it('an estimate with the eC2Next trap lints as read-only (would refuse to save)', () => {
    // Hand-craft the trap: serviceCode ec2Enhancement, estimateFor eC2Next,
    // PCT def with no mappingFromTemplate rescue.
    const blob = {
      services: {
        s1: {
          serviceCode: 'ec2Enhancement',
          estimateFor: 'eC2Next',
          calculationComponents: {},
        },
      },
    };
    const def = {
      serviceCode: 'ec2Enhancement',
      templates: [{ id: 'template' }],
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['ec2Enhancement', def]]),
    });
    assert.equal(r.status, 'read-only');
    const predicates = r.services.flatMap(s => s.failures.map(f => f.predicate));
    assert.ok(predicates.includes('template-existence'),
      `expected template-existence in failures, got ${JSON.stringify(predicates)}`);
  });
});

describe('exportWithLint trace events', () => {
  it('emits a lint event with verdict + services before deciding to save', async () => {
    const { __test } = require('../mcp-server');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };

    let result;
    try {
      const e = new EstimateBuilder('trace-lint-test');
      result = await __test.exportWithLint(e);
    } finally {
      process.stderr.write = orig;
    }

    assert.equal(result.isError, true, 'empty estimate should be refused');

    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const lintLine = events.find(l => l.event === 'lint');
    assert.ok(lintLine, 'expected a lint event');
    assert.equal(lintLine.verdict, 'read-only');
    assert.ok(Array.isArray(lintLine.services));
    assert.ok(
      lintLine.services.some(s =>
        s.failures.some(f => f.predicate === 'empty-estimate')),
      'lint event should carry the empty-estimate predicate failure',
    );
  });

  it('emits lint with mcpSessionId when called inside a session scope', async () => {
    const { __test } = require('../mcp-server');
    const EstimateBuilder = require('../lib/aws/estimate-builder');
    const { runWithSession } = require('../lib/trace/request-context');

    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };

    try {
      const e = new EstimateBuilder('trace-lint-sid');
      await runWithSession('sid-test-7', () => __test.exportWithLint(e));
    } finally {
      process.stderr.write = orig;
    }

    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const lintLine = events.find(l => l.event === 'lint');
    assert.ok(lintLine, 'expected a lint event');
    assert.equal(lintLine.mcpSessionId, 'sid-test-7');
  });

  it('emits lint with estimateId from the EstimateBuilder', async () => {
    const { __test } = require('../mcp-server');
    const EstimateBuilder = require('../lib/aws/estimate-builder');

    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };

    let result;
    try {
      const e = new EstimateBuilder('estimate-id-test');
      // The empty estimate path is read-only-refused without ever hitting
      // the save API — same shape as the existing lint-emits test.
      result = await __test.exportWithLint(e);
      var capturedId = e.id;
    } finally {
      process.stderr.write = orig;
    }

    assert.equal(result.isError, true);

    const events = writes
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    const lintLine = events.find(l => l.event === 'lint');
    assert.ok(lintLine, 'expected a lint event');
    assert.equal(lintLine.estimateId, capturedId);
  });
});
