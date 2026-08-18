const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Reported as issue #7: repeated ECONNRESET after a few successful calls,
// where curl on the same host succeeded. The reporter attributed it to
// CloudFront WAF TLS fingerprinting; that was never confirmed and does
// not fit their own repro (a fingerprint block would reject the FIRST
// request, not the fourth). What IS confirmed is that every fetch() in
// aws-client.js had no timeout and no retry, so any transient reset
// became an unrecoverable tool failure and a stalled socket hung the
// MCP tool forever. These tests pin the resilience contract, which
// mitigates #7 regardless of what actually trips the connection.
const { resilientFetch, isTransientNetworkError, RETRYABLE_CODES } = require('../lib/aws/fetch-resilience');

function netError(code) {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(code), { code });
  return err;
}

describe('isTransientNetworkError', () => {
  for (const code of RETRYABLE_CODES) {
    it(`treats ${code} as transient`, () => {
      assert.equal(isTransientNetworkError(netError(code)), true);
    });
  }

  it('does not treat a bad-URL TypeError as transient', () => {
    assert.equal(isTransientNetworkError(new TypeError('Invalid URL')), false);
  });

  it('does not treat an arbitrary Error as transient', () => {
    assert.equal(isTransientNetworkError(new Error('boom')), false);
  });

  it('recognizes an undici socket-hang-up message with no code', () => {
    assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
  });

  it('recognizes an AbortError from our own timeout as transient', () => {
    const e = new Error('The operation was aborted');
    e.name = 'TimeoutError';
    assert.equal(isTransientNetworkError(e), true);
  });
});

describe('resilientFetch retry behavior', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns the first successful response without retrying', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('ok', { status: 200 }); };
    const res = await resilientFetch('https://example.test/a', undefined, { sleep: async () => {} });
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });

  it('retries a transient reset and succeeds on a later attempt', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls < 3) throw netError('ECONNRESET');
      return new Response('ok', { status: 200 });
    };
    const res = await resilientFetch('https://example.test/b', undefined, { sleep: async () => {} });
    assert.equal(res.status, 200);
    assert.equal(calls, 3, 'should have retried twice before succeeding');
  });

  it('gives up after maxAttempts and rethrows the underlying error', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw netError('ECONNRESET'); };
    await assert.rejects(
      () => resilientFetch('https://example.test/c', undefined, { maxAttempts: 3, sleep: async () => {} }),
      (err) => {
        // The original cause must survive so callers//users still see ECONNRESET
        // rather than a generic wrapper that hides the diagnosis.
        assert.equal(err.cause?.code, 'ECONNRESET');
        assert.match(err.message, /3 attempts/);
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  it('does NOT retry a non-transient error', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError('Invalid URL'); };
    await assert.rejects(() => resilientFetch('not-a-url', undefined, { sleep: async () => {} }));
    assert.equal(calls, 1, 'a malformed URL must fail immediately, not burn retries');
  });

  it('does NOT retry on an HTTP error status — 4xx/5xx is the caller\'s to interpret', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('nope', { status: 500 }); };
    const res = await resilientFetch('https://example.test/d', undefined, { sleep: async () => {} });
    assert.equal(res.status, 500);
    assert.equal(calls, 1);
  });

  it('honors retry:false so a caller can opt out entirely', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw netError('ECONNRESET'); };
    await assert.rejects(
      () => resilientFetch('https://example.test/save', { method: 'POST' }, { retry: false, sleep: async () => {} }),
    );
    assert.equal(calls, 1);
  });

  it('honors a reduced maxAttempts, for callers on a smaller budget', async () => {
    // The save POST takes 2 rather than the default 3: it is not
    // idempotent, so each extra attempt is another chance to orphan a
    // duplicate blob. See saveEstimate in lib/aws/aws-client.js.
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw netError('ECONNRESET'); };
    await assert.rejects(
      () => resilientFetch('https://example.test/save', { method: 'POST' },
        { maxAttempts: 2, sleep: async () => {} }),
    );
    assert.equal(calls, 2);
  });

  it('fires onRetry before each re-attempt, not before the first', async () => {
    let calls = 0;
    const seen = [];
    globalThis.fetch = async () => {
      calls++;
      if (calls < 3) throw netError('ECONNRESET');
      return new Response('ok', { status: 200 });
    };
    const res = await resilientFetch('https://example.test/h', undefined, {
      sleep: async () => {},
      onRetry: (info) => seen.push(info),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
    assert.equal(seen.length, 2, 'two re-attempts means two onRetry calls');
    assert.deepEqual(seen.map(s => s.attempt), [1, 2],
      'attempt is the number of the attempt that just FAILED');
    assert.equal(seen[0].error.cause.code, 'ECONNRESET');
  });

  it('does not fire onRetry when the first attempt succeeds', async () => {
    let fired = 0;
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    await resilientFetch('https://example.test/i', undefined, {
      sleep: async () => {}, onRetry: () => { fired++; },
    });
    assert.equal(fired, 0);
  });

  it('does not fire onRetry on a non-retryable error', async () => {
    let fired = 0;
    globalThis.fetch = async () => { throw new TypeError('Invalid URL'); };
    await assert.rejects(() => resilientFetch('nonsense', undefined, {
      sleep: async () => {}, onRetry: () => { fired++; },
    }));
    assert.equal(fired, 0, 'a bad URL is not worth re-attempting or recording');
  });

  it('does not fire onRetry on the final failed attempt', async () => {
    // The last failure is reported by the thrown error, not by onRetry.
    // A caller using onRetry to count "possible duplicates server-side"
    // must not over-count the attempt that never went out again.
    let fired = 0;
    globalThis.fetch = async () => { throw netError('ECONNRESET'); };
    await assert.rejects(() => resilientFetch('https://example.test/j', undefined, {
      maxAttempts: 2, sleep: async () => {}, onRetry: () => { fired++; },
    }));
    assert.equal(fired, 1, '2 attempts means exactly 1 re-attempt');
  });

  it('backs off with growing delays between attempts', async () => {
    const delays = [];
    globalThis.fetch = async () => { throw netError('ECONNRESET'); };
    await assert.rejects(() => resilientFetch('https://example.test/e', undefined, {
      maxAttempts: 4,
      sleep: async (ms) => { delays.push(ms); },
    }));
    assert.equal(delays.length, 3, 'one sleep between each pair of attempts');
    assert.ok(delays[1] > delays[0], `expected growth, got ${delays.join(',')}`);
    assert.ok(delays[2] > delays[1], `expected growth, got ${delays.join(',')}`);
  });
});

describe('resilientFetch timeout', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('passes an AbortSignal so a stalled connection cannot hang forever', async () => {
    let seenSignal;
    globalThis.fetch = async (_url, init) => {
      seenSignal = init?.signal;
      return new Response('ok', { status: 200 });
    };
    await resilientFetch('https://example.test/f', undefined, { sleep: async () => {} });
    assert.ok(seenSignal, 'init.signal must be set');
    assert.equal(typeof seenSignal.aborted, 'boolean');
  });

  it('preserves caller-supplied headers and method', async () => {
    let seenInit;
    globalThis.fetch = async (_url, init) => { seenInit = init; return new Response('ok'); };
    await resilientFetch('https://example.test/g', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, { retry: false, sleep: async () => {} });
    assert.equal(seenInit.method, 'POST');
    assert.equal(seenInit.headers['content-type'], 'application/json');
    assert.equal(seenInit.body, '{}');
  });
});
