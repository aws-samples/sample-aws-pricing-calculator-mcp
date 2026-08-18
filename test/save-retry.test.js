// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * saveEstimate's retry contract.
 *
 * The save POST is not idempotent — every call mints a fresh estimateId —
 * so a transient network error after the lambda already accepted the body
 * may leave a duplicate blob behind. We retry anyway, because issue #7's
 * reported symptom was export_estimate failing (this exact call), and the
 * cost is asymmetric: the orphan is unreachable and free, a lost save is
 * a real failure. These tests pin the two halves of that trade-off — that
 * the retry happens, and that every re-attempt is recorded so the orphans
 * stay attributable.
 *
 * Hermetic: globalThis.fetch is stubbed, so no estimate is actually saved.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// emit() reads process.env.TRACE per call, so setting it here is enough.
process.env.TRACE = 'on';

const { saveEstimate } = require('../lib/aws/aws-client');

function netError(code) {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(code), { code });
  return err;
}

// The save API double-encodes: a JSON envelope whose `body` is itself a
// JSON string. See parseDoubleEncodedResponse in lib/aws/aws-client.js.
function savedOk(savedKey) {
  return new Response(JSON.stringify({ body: JSON.stringify({ savedKey }) }), { status: 200 });
}

function captureTrace(fn) {
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { writes.push(s); return true; };
  return fn().finally(() => { process.stderr.write = orig; }).then(
    (value) => ({ value, events: parseEvents(writes) }),
    (error) => Promise.reject(Object.assign(error, { events: parseEvents(writes) })),
  );
}

function parseEvents(writes) {
  return writes
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

const PAYLOAD = { services: {}, groups: {} };

describe('saveEstimate retry on transient network failure', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('retries once and succeeds, rather than surfacing a transient reset', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw netError('ECONNRESET');
      return savedOk('abc123');
    };

    const { value, events } = await captureTrace(() => saveEstimate(PAYLOAD));

    assert.equal(calls, 2, 'the reset must be re-attempted');
    assert.equal(value.estimateId, 'abc123');
    assert.ok(value.shareableUrl.endsWith('abc123'));
    assert.ok(events.some(e => e.event === 'save.ok'), 'expected save.ok');
  });

  it('emits save.retry with mayHaveOrphaned so the duplicate is attributable', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw netError('ECONNRESET');
      return savedOk('def456');
    };

    const { events } = await captureTrace(() => saveEstimate(PAYLOAD, { estimateId: 'local-1' }));

    const retries = events.filter(e => e.event === 'save.retry');
    assert.equal(retries.length, 1, 'exactly one re-attempt, so exactly one save.retry');
    assert.equal(retries[0].code, 'ECONNRESET');
    assert.equal(retries[0].mayHaveOrphaned, true);
    assert.equal(retries[0].estimateId, 'local-1',
      'the local estimateId correlates the orphan back to the session');
  });

  it('stops at 2 attempts — an unbounded retry multiplies orphans', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw netError('ECONNRESET'); };

    await assert.rejects(() => captureTrace(() => saveEstimate(PAYLOAD)));
    assert.equal(calls, 2);
  });

  it('does not retry an HTTP error — the server already answered', async () => {
    // A 400 from the save API is a verdict on the payload (e.g. the
    // `<`/`>`/`&` rejection in a description). Replaying it would just
    // get the same 400 and risk a second blob for nothing.
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ body: JSON.stringify({ message: 'bad input' }) }), { status: 400 });
    };

    await assert.rejects(
      () => captureTrace(() => saveEstimate(PAYLOAD)),
      /HTTP 400/,
    );
    assert.equal(calls, 1);
  });

  it('emits no save.retry when the first attempt succeeds', async () => {
    globalThis.fetch = async () => savedOk('ghi789');
    const { events } = await captureTrace(() => saveEstimate(PAYLOAD));
    assert.equal(events.filter(e => e.event === 'save.retry').length, 0);
  });
});
