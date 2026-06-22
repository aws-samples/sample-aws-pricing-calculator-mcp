const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runWithSession, currentSessionId } = require('../lib/trace/request-context');

describe('request-context session scope', () => {
  it('returns undefined outside a session scope', () => {
    assert.equal(currentSessionId(), undefined);
  });

  it('returns the session id inside a runWithSession scope', async () => {
    let inner;
    await runWithSession('sid-123', async () => {
      inner = currentSessionId();
    });
    assert.equal(inner, 'sid-123');
    assert.equal(currentSessionId(), undefined);  // restored
  });

  it('survives an async boundary inside the scope', async () => {
    let inner;
    await runWithSession('sid-abc', async () => {
      await new Promise(r => setTimeout(r, 1));
      inner = currentSessionId();
    });
    assert.equal(inner, 'sid-abc');
  });
});
