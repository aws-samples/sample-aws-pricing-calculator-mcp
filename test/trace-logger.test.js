const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// This file's tests all assert that events are emitted. Tracing is
// off by default in production; turning it on for the suite is the
// equivalent of running the bundle with TRACE=on. Off-by-default
// behavior is exercised in trace-flag.test.js.
process.env.TRACE = 'on';

const { emit } = require('../lib/trace/trace-logger');

describe('trace-logger emit', () => {
  it('writes a single JSON line to stderr with ts, event, and payload', () => {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    try {
      emit('tool.call', { name: 'create_estimate', args: { foo: 'bar' } });
    } finally {
      process.stderr.write = orig;
    }
    assert.equal(writes.length, 1);
    const line = writes[0];
    assert.match(line, /\n$/, 'must end with a newline');
    const obj = JSON.parse(line);
    assert.equal(obj.event, 'tool.call');
    assert.equal(obj.name, 'create_estimate');
    assert.deepEqual(obj.args, { foo: 'bar' });
    assert.match(obj.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });
});

const { traceTool } = require('../lib/trace/trace-logger');
const { runWithSession } = require('../lib/trace/request-context');

describe('traceTool wrapper', () => {
  function captureWrites(fn) {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
      .then(r => ({ result: r, lines: writes.map(s => JSON.parse(s)) }));
  }

  it('emits tool.call before and tool.result after on success', async () => {
    const handler = traceTool('test_tool', async ({ x }) => ({
      content: [{ type: 'text', text: `hello ${x}` }],
    }));
    const { result, lines } = await captureWrites(() => handler({ x: 'world' }));

    const events = lines.map(l => l.event);
    assert.deepEqual(events, ['tool.call', 'tool.result']);

    assert.equal(lines[0].name, 'test_tool');
    assert.deepEqual(lines[0].args, { x: 'world' });

    assert.equal(lines[1].name, 'test_tool');
    assert.equal(lines[1].isError, false);
    assert.equal(lines[1].resultText, 'hello world');
    assert.equal(typeof lines[1].durationMs, 'number');

    assert.deepEqual(result, { content: [{ type: 'text', text: 'hello world' }] });
  });

  it('truncates resultText to 500 chars and adds a marker', async () => {
    const long = 'x'.repeat(2000);
    const handler = traceTool('big', async () => ({ content: [{ type: 'text', text: long }] }));
    const { lines } = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.resultText.length, 500 + ' …[truncated]'.length);
    assert.match(resultLine.resultText, / …\[truncated\]$/);
  });

  it('emits tool.result with isError: true when the handler returns isError', async () => {
    const handler = traceTool('bad', async () => ({
      content: [{ type: 'text', text: 'something broke' }],
      isError: true,
    }));
    const { lines } = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    assert.equal(resultLine.resultText, 'something broke');
  });

  it('emits tool.result with isError: true when the handler throws', async () => {
    const handler = traceTool('boom', async () => { throw new Error('kaboom'); });
    const { lines } = await captureWrites(() => handler({}).catch(() => {}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    assert.match(resultLine.resultText, /kaboom/);
  });
});

describe('traceTool session id propagation', () => {
  it('stamps mcpSessionId on tool.call/tool.result when called inside runWithSession', async () => {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    try {
      const handler = traceTool('hi', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      await runWithSession('sess-xyz', () => handler({}));
    } finally {
      process.stderr.write = orig;
    }
    const lines = writes.map(s => JSON.parse(s));
    assert.equal(lines[0].mcpSessionId, 'sess-xyz');
    assert.equal(lines[1].mcpSessionId, 'sess-xyz');
  });

  it('omits mcpSessionId when called outside a session scope', async () => {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    try {
      const handler = traceTool('hi', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      await handler({});
    } finally {
      process.stderr.write = orig;
    }
    const lines = writes.map(s => JSON.parse(s));
    assert.equal(lines[0].mcpSessionId, undefined);
    assert.equal(lines[1].mcpSessionId, undefined);
  });

  it('propagates the session through an awaited dispatcher (mirrors transport.handleRequest)', async () => {
    // Simulates the HTTP-transport shape: runWithSession wraps an outer
    // dispatcher (transport.handleRequest), which awaits a promise chain
    // that eventually reaches a tool handler. currentSessionId() must
    // still return the right value at the
    // *handler's* call site, not just at the dispatcher's.
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    try {
      const handler = traceTool('inner', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      // Fake dispatcher with multiple await points + a setImmediate, the
      // kinds of async boundaries the MCP SDK has internally.
      async function dispatcher() {
        await Promise.resolve();
        await new Promise(r => setImmediate(r));
        return handler({});
      }
      await runWithSession('sess-deep', dispatcher);
    } finally {
      process.stderr.write = orig;
    }
    const lines = writes.map(s => JSON.parse(s));
    assert.equal(lines[0].event, 'tool.call');
    assert.equal(lines[0].mcpSessionId, 'sess-deep');
    assert.equal(lines[1].event, 'tool.result');
    assert.equal(lines[1].mcpSessionId, 'sess-deep');
  });
});

describe('traceTool resultLength + TRACE_RESULT_TEXT_MAX', () => {
  function captureWrites(fn) {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
      .then(() => writes.map(s => JSON.parse(s)));
  }

  it('stamps resultLength with the original (pre-truncation) length on success', async () => {
    const long = 'x'.repeat(2000);
    const handler = traceTool('big', async () => ({ content: [{ type: 'text', text: long }] }));
    const lines = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.resultLength, 2000, 'resultLength must reflect the original text length, not the truncated one');
    // Sanity: the truncated text should still be the short one.
    assert.ok(resultLine.resultText.length < resultLine.resultLength);
  });

  it('stamps resultLength on the throw path with the error text length', async () => {
    const handler = traceTool('boom', async () => { throw new Error('kaboom'); });
    const lines = await captureWrites(() => handler({}).catch(() => {}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    // Stack is what we capture; just verify the field is present and matches resultText.length when not truncated.
    assert.equal(typeof resultLine.resultLength, 'number');
    assert.ok(resultLine.resultLength > 0);
  });

  it('respects TRACE_RESULT_TEXT_MAX env override', async () => {
    const original = process.env.TRACE_RESULT_TEXT_MAX;
    process.env.TRACE_RESULT_TEXT_MAX = '2000';
    try {
      const text = 'y'.repeat(1500);  // longer than default 500, shorter than override 2000
      const handler = traceTool('override', async () => ({ content: [{ type: 'text', text }] }));
      const lines = await captureWrites(() => handler({}));
      const resultLine = lines.find(l => l.event === 'tool.result');
      assert.equal(resultLine.resultText.length, 1500, 'should not truncate under raised cap');
      assert.ok(!resultLine.resultText.includes('[truncated]'), 'should not have truncation marker');
      assert.equal(resultLine.resultLength, 1500);
    } finally {
      if (original === undefined) delete process.env.TRACE_RESULT_TEXT_MAX;
      else process.env.TRACE_RESULT_TEXT_MAX = original;
    }
  });

  it('falls back to default cap on invalid TRACE_RESULT_TEXT_MAX', async () => {
    const original = process.env.TRACE_RESULT_TEXT_MAX;
    process.env.TRACE_RESULT_TEXT_MAX = 'not-a-number';
    try {
      const text = 'z'.repeat(2000);
      const handler = traceTool('bogus-cap', async () => ({ content: [{ type: 'text', text }] }));
      const lines = await captureWrites(() => handler({}));
      const resultLine = lines.find(l => l.event === 'tool.result');
      assert.equal(resultLine.resultText.length, 500 + ' …[truncated]'.length, 'unparseable cap should fall back to default 500');
    } finally {
      if (original === undefined) delete process.env.TRACE_RESULT_TEXT_MAX;
      else process.env.TRACE_RESULT_TEXT_MAX = original;
    }
  });

  it('uses the bigger error cap (10000) when isError is true on a returned result', async () => {
    // Live data: build_estimate error responses cluster around 4K-5K chars
    // (per-service correction hints). The default 500 cap was hiding the
    // back half of those messages. The error cap is 10K — verify here
    // that errors get the bigger cap while successes stay at 500.
    const long = 'e'.repeat(2000);
    const handler = traceTool('failing', async () => ({
      content: [{ type: 'text', text: long }],
      isError: true,
    }));
    const lines = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    // Under the error cap, 2000 chars passes through unmolested.
    assert.equal(resultLine.resultText.length, 2000, 'error result under 10K should not be truncated');
    assert.equal(resultLine.resultText, long);
  });

  it('still uses the default cap (500) for successful results', async () => {
    const long = 's'.repeat(2000);
    const handler = traceTool('succeeding', async () => ({
      content: [{ type: 'text', text: long }],
    }));
    const lines = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, false);
    assert.equal(resultLine.resultText.length, 500 + ' …[truncated]'.length, 'success result over 500 chars should still be truncated at 500');
  });

  it('uses the bigger error cap on the throw path', async () => {
    // Construct an Error whose stack is long enough to demonstrate the
    // bigger error cap is applied on the throw path too.
    const handler = traceTool('throws-long', async () => {
      const e = new Error('e'.repeat(2000));
      throw e;
    });
    const lines = await captureWrites(() => handler({}).catch(() => {}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    // The stack will be longer than 500 but well under 10K — should pass
    // through with no truncation marker.
    assert.ok(!resultLine.resultText.includes('[truncated]'),
      'throw-path error under 10K cap should not have truncation marker');
  });

  it('truncates at the error cap (10000) when error text is longer', async () => {
    const huge = 'x'.repeat(15000);
    const handler = traceTool('failing-huge', async () => ({
      content: [{ type: 'text', text: huge }],
      isError: true,
    }));
    const lines = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    assert.equal(resultLine.resultText.length, 10000 + ' …[truncated]'.length,
      'error result over 10K should truncate at the error cap');
    assert.equal(resultLine.resultLength, 15000,
      'resultLength should still report the original size');
  });
});

describe('traceTool redaction of customer free text', () => {
  function captureWrites(fn) {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
      .then(() => writes.map(s => JSON.parse(s)));
  }

  it('redacts top-level args.name in tool.call', async () => {
    const handler = traceTool('create_estimate', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const lines = await captureWrites(() => handler({ name: 'GOGOGO Technology - AWS Migration' }));
    const callLine = lines.find(l => l.event === 'tool.call');
    assert.equal(callLine.args.name, '[redacted: 33 chars]');
  });

  it('redacts description nested inside the JSON-string services arg of build_estimate', async () => {
    const handler = traceTool('build_estimate', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const services = JSON.stringify([
      {
        service: 'aWSLambda',
        config: {
          region: 'us-east-1',
          description: 'Customer-Identifying Workload Name',
          numberOfRequests: { value: '1', unit: 'millionPerMonth' },
        },
      },
    ]);
    const lines = await captureWrites(() => handler({ services, name: 'My Sensitive Estimate' }));
    const callLine = lines.find(l => l.event === 'tool.call');
    // Top-level name redacted
    assert.equal(callLine.args.name, '[redacted: 21 chars]');
    // Re-parse the redacted services string and check the nested description
    const parsed = JSON.parse(callLine.args.services);
    assert.equal(parsed[0].config.description, '[redacted: 34 chars]');
    // Non-sensitive fields untouched
    assert.equal(parsed[0].config.region, 'us-east-1');
    assert.deepEqual(parsed[0].config.numberOfRequests, { value: '1', unit: 'millionPerMonth' });
  });

  it('redacts description in tool.result JSON content', async () => {
    const handler = traceTool('import_estimate', async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        estimate_id: 'abc',
        services: { s1: { description: 'Stakeholder name embedded here', region: 'us-east-1' } },
      }) }],
    }));
    const lines = await captureWrites(() => handler({}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    const parsed = JSON.parse(resultLine.resultText);
    assert.equal(parsed.services.s1.description, '[redacted: 30 chars]');
    assert.equal(parsed.services.s1.region, 'us-east-1');
    // resultLength reflects the ORIGINAL pre-redaction text length
    assert.ok(resultLine.resultLength > resultLine.resultText.length || resultLine.resultLength === resultLine.resultText.length,
      'resultLength must be >= resultText.length');
  });

  it('leaves non-string values at sensitive keys alone', async () => {
    const handler = traceTool('weird', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    // Hypothetical: an args envelope whose name is a number, not a string.
    // The redactor should leave it alone — the concern is free text leakage,
    // not type-shaped fields.
    const lines = await captureWrites(() => handler({ name: 12345 }));
    const callLine = lines.find(l => l.event === 'tool.call');
    assert.equal(callLine.args.name, 12345);
  });

  it('does not break when the result text is not JSON (throw path stack trace)', async () => {
    const handler = traceTool('boom', async () => { throw new Error('regular failure'); });
    const lines = await captureWrites(() => handler({}).catch(() => {}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.isError, true);
    assert.match(resultLine.resultText, /regular failure/);
  });

  it('does not break when args is missing or non-object', async () => {
    const handler = traceTool('odd', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const lines = await captureWrites(() => handler(undefined));
    const callLine = lines.find(l => l.event === 'tool.call');
    assert.equal(callLine.args, undefined);
  });
});

describe('traceTool estimate.id propagation', () => {
  function captureWrites(fn) {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
      .then(() => writes.map(s => JSON.parse(s)));
  }

  it('stamps estimateId on tool.call when args.estimate_id is present', async () => {
    const handler = traceTool('add_service', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const lines = await captureWrites(() => handler({ estimate_id: 'abc-123', services: '[]' }));
    const callLine = lines.find(l => l.event === 'tool.call');
    assert.equal(callLine.estimateId, 'abc-123');
  });

  it('stamps estimateId on tool.result for the same call', async () => {
    const handler = traceTool('add_service', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const lines = await captureWrites(() => handler({ estimate_id: 'abc-123' }));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.estimateId, 'abc-123');
  });

  it('omits estimateId when args has no estimate_id', async () => {
    // create_estimate doesn't take an estimate_id (it returns one). The
    // trace should not invent a value.
    const handler = traceTool('create_estimate', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const lines = await captureWrites(() => handler({ name: 'My Estimate' }));
    const callLine = lines.find(l => l.event === 'tool.call');
    assert.equal(callLine.estimateId, undefined);
  });

  it('handles missing or non-object args without crashing', async () => {
    const handler = traceTool('weird', async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const lines = await captureWrites(() => handler(undefined));
    const callLine = lines.find(l => l.event === 'tool.call');
    assert.equal(callLine.estimateId, undefined);
  });

  it('stamps estimateId even on the throw path', async () => {
    const handler = traceTool('boom', async () => { throw new Error('kaboom'); });
    const lines = await captureWrites(() => handler({ estimate_id: 'abc-123' }).catch(() => {}));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.estimateId, 'abc-123');
    assert.equal(resultLine.isError, true);
  });
});

describe('traceTool estimate.id from result body', () => {
  function captureWrites(fn) {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
      .then(() => writes.map(s => JSON.parse(s)));
  }

  it('extracts estimate_id from result body when args has none (build_estimate success)', async () => {
    const handler = traceTool('build_estimate', async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        estimate_id: 'local-uuid-1',
        aws_estimate_id: 'sha1-saved-key',
        sharable_url: 'https://calculator.aws/...',
      }) }],
    }));
    const lines = await captureWrites(() => handler({ services: '[]' }));
    const callLine = lines.find(l => l.event === 'tool.call');
    const resultLine = lines.find(l => l.event === 'tool.result');
    // tool.call args has no estimate_id, so it stays undefined on the
    // call event — the eid only exists after the tool runs.
    assert.equal(callLine.estimateId, undefined);
    // tool.result extracts it from the body.
    assert.equal(resultLine.estimateId, 'local-uuid-1');
  });

  it('extracts estimate_id from result body on tool-error path (isError:true)', async () => {
    const handler = traceTool('build_estimate', async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        estimate_id: 'local-uuid-2',
        services: [{ error: 'Invalid field IDs for amazonS3Standard' }],
        error: 'Validation failed for one or more services; not saved.',
      }) }],
      isError: true,
    }));
    const lines = await captureWrites(() => handler({ services: '[]' }));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.estimateId, 'local-uuid-2');
    assert.equal(resultLine.isError, true);
  });

  it('does not extract from result body when args already has estimate_id', async () => {
    // args wins. Otherwise an unrelated body field could overwrite the
    // correct correlator (e.g. import_estimate's body might mention an id
    // from inside the imported payload).
    const handler = traceTool('add_service', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ estimate_id: 'body-id' }) }],
    }));
    const lines = await captureWrites(() =>
      handler({ estimate_id: 'args-id', services: '[]' }));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.estimateId, 'args-id');
  });

  it('falls back gracefully when result body has no estimate_id', async () => {
    const handler = traceTool('build_estimate', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid JSON' }) }],
      isError: true,
    }));
    const lines = await captureWrites(() => handler({ services: 'not-json' }));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.estimateId, undefined);
    assert.equal(resultLine.isError, true);
  });

  it('handles non-JSON result text without crashing', async () => {
    const handler = traceTool('build_estimate', async () => ({
      content: [{ type: 'text', text: 'Build failed: AWS save API returned HTTP 500' }],
      isError: true,
    }));
    const lines = await captureWrites(() => handler({ services: '[]' }));
    const resultLine = lines.find(l => l.event === 'tool.result');
    assert.equal(resultLine.estimateId, undefined);
    assert.equal(resultLine.isError, true);
  });
});

describe('traceEvents.session.start', () => {
  function captureWrites(fn) {
    const writes = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { writes.push(s); return true; };
    return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
      .then(() => writes.map(s => JSON.parse(s)));
  }

  it('emits a session.start line with estimateId, partition, origin, mcpSessionId', async () => {
    // Per-estimateId save-rate metric over-counts retries (each
    // build_estimate call mints a new estimateId). session.start gives
    // observability a session-shaped denominator: one event per
    // create_estimate-rooted flow. Pin the event shape so observability
    // can rely on it.
    const traceEvents = require('../lib/trace/trace-events');
    const lines = await captureWrites(() => {
      runWithSession('test-session-id', () => {
        traceEvents.session.start({
          estimateId: 'fake-uuid-123',
          partition: 'aws',
          origin: 'create_estimate',
        });
      });
    });
    const evt = lines.find(l => l.event === 'session.start');
    assert.ok(evt, 'expected a session.start event');
    assert.equal(evt.estimateId, 'fake-uuid-123');
    assert.equal(evt.partition, 'aws');
    assert.equal(evt.origin, 'create_estimate');
    assert.equal(evt.mcpSessionId, 'test-session-id');
  });
});
