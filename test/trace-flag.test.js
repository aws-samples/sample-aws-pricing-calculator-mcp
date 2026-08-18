const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// This file does NOT pre-set TRACE — that's the whole point: it
// asserts the off-by-default contract. Each test toggles TRACE
// inside its own scope and restores the prior value afterwards.

const { emit, traceTool, isTraceEnabled } = require('../lib/trace/trace-logger');
const traceEvents = require('../lib/trace/trace-events');
const { runWithSession, currentSessionId } = require('../lib/trace/request-context');

function withTrace(value, fn) {
  const prior = process.env.TRACE;
  if (value === undefined) delete process.env.TRACE;
  else process.env.TRACE = value;
  try { return fn(); }
  finally {
    if (prior === undefined) delete process.env.TRACE;
    else process.env.TRACE = prior;
  }
}

function captureStderr(fn) {
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { writes.push(s.toString()); return true; };
  return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
    .then(r => ({ result: r, writes }));
}

describe('TRACE flag — default off', () => {
  it('isTraceEnabled() is false when TRACE is unset', () => {
    withTrace(undefined, () => {
      assert.equal(isTraceEnabled(), false);
    });
  });

  it('emit() writes nothing when TRACE is unset', async () => {
    await withTrace(undefined, async () => {
      const { writes } = await captureStderr(async () => {
        emit('save.send', { bytes: 42 });
        traceEvents.lint({ verdict: 'editable', services: [] });
      });
      assert.equal(writes.length, 0, 'no events should reach stderr when tracing is off');
    });
  });

  it('traceTool wrapper is a passthrough when TRACE is unset', async () => {
    await withTrace(undefined, async () => {
      const handler = traceTool('passthru', async ({ x }) => ({
        content: [{ type: 'text', text: `got ${x}` }],
      }));
      const { result, writes } = await captureStderr(() => handler({ x: 'value' }));
      assert.deepEqual(result, { content: [{ type: 'text', text: 'got value' }] });
      assert.equal(writes.length, 0);
    });
  });

  it('traceTool still re-throws handler errors with tracing off', async () => {
    await withTrace(undefined, async () => {
      const handler = traceTool('throws', async () => { throw new Error('boom'); });
      let caught;
      try { await handler({}); } catch (e) { caught = e; }
      assert.ok(caught && caught.message === 'boom');
    });
  });
});

describe('TRACE flag — explicit values', () => {
  for (const v of ['on', '1', 'true', 'yes', 'ON', 'True', ' yes ']) {
    it(`enables tracing for TRACE=${JSON.stringify(v)}`, () => {
      withTrace(v, () => assert.equal(isTraceEnabled(), true));
    });
  }

  for (const v of ['', 'off', '0', 'false', 'no', 'maybe']) {
    it(`leaves tracing off for TRACE=${JSON.stringify(v)}`, () => {
      withTrace(v, () => assert.equal(isTraceEnabled(), false));
    });
  }

  it('emit() writes when TRACE=on', async () => {
    await withTrace('on', async () => {
      const { writes } = await captureStderr(async () => {
        emit('save.ok', { savedKey: 'k' });
      });
      assert.equal(writes.length, 1);
      const obj = JSON.parse(writes[0]);
      assert.equal(obj.event, 'save.ok');
      assert.equal(obj.savedKey, 'k');
    });
  });
});

describe('TRACE flag — request-context still runs with tracing off', () => {
  // The session scope is pure plumbing — it has nothing to do with
  // logging. Disabling tracing must NOT disable the scope.
  it('runWithSession scope is observable even with TRACE unset', async () => {
    await withTrace(undefined, async () => {
      let inner;
      await runWithSession('sid-off', async () => { inner = currentSessionId(); });
      assert.equal(inner, 'sid-off');
    });
  });
});
