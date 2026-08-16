// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Timeout + bounded-retry wrapper around global fetch.
 *
 * Motivation (issue #7): a user on Windows 11 / Node 22 hit repeated
 * `fetch failed` / ECONNRESET against all three calculator CloudFront
 * distributions, while curl on the same host succeeded. They attributed
 * it to CloudFront WAF fingerprinting undici's TLS client hello. That
 * remains unconfirmed and does not fit their own reproduction — a
 * fingerprint block rejects the FIRST request, but theirs failed only
 * after several successes. Probing did not reproduce it on macOS, and
 * the competing "stale keep-alive socket" theory did not hold either
 * (these distributions advertise no Keep-Alive timeout, and undici
 * reuse after a 9s idle gap works).
 *
 * So the trigger is still unknown. What was NOT in doubt: every
 * fetch() call site had no timeout and no retry. A single transient
 * reset became an unrecoverable tool failure, and a stalled socket hung
 * the MCP tool indefinitely with no way for the agent to recover. This
 * module fixes that class of failure without claiming to have found
 * #7's root cause.
 *
 * Deliberately narrow:
 *   - Only *network* failures retry. An HTTP status is a real answer
 *     from the server and belongs to the caller, so 4xx/5xx pass
 *     straight through — retrying a 400 from the save API would just
 *     replay a payload the server already rejected on its merits.
 *   - Retries are opt-out per call. The save POST passes
 *     `retry: false`: it mints a new estimateId on every call, so an
 *     ECONNRESET raised *after* the lambda processed the body is
 *     ambiguous, and a retry would orphan a duplicate estimate blob.
 */

// Transient at the socket level: worth another attempt on a fresh
// connection. Anything not listed here fails fast.
const RETRYABLE_CODES = new Set([
  'ECONNRESET',    // peer closed the connection mid-flight — the #7 signature
  'ECONNREFUSED',  // listener not up yet / transient LB state
  'ETIMEDOUT',     // OS-level connect or read timeout
  'EPIPE',         // wrote to a closed socket
  'EAI_AGAIN',     // transient DNS failure
  'ENOTFOUND',     // DNS miss; transient behind a flaky resolver
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// Node's fetch wraps the real cause, so the code can sit one or two
// levels down. Messages are the fallback when no code is attached at
// all (undici's "socket hang up" is the common shape).
const RETRYABLE_MESSAGES = /socket hang up|other side closed|terminated|network socket disconnected/i;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;

function isTransientNetworkError(err) {
  if (!err) return false;
  // Our own AbortSignal.timeout fires as a TimeoutError. That means the
  // request stalled, which is exactly the case worth retrying.
  if (err.name === 'TimeoutError') return true;
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.code && RETRYABLE_CODES.has(e.code)) return true;
    if (typeof e.message === 'string' && RETRYABLE_MESSAGES.test(e.message)) return true;
  }
  return false;
}

// Exponential with full jitter. Jitter matters because a cold start
// fans out many definition fetches at once; without it a shared upstream
// hiccup would put every retry back on the wire in the same instant.
function backoffMs(attempt) {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {object} [opts]
 * @param {boolean} [opts.retry=true]     false for non-idempotent requests
 * @param {number}  [opts.maxAttempts=3]
 * @param {number}  [opts.timeoutMs=30000]
 * @param {Function} [opts.sleep]         injectable for tests
 */
async function resilientFetch(url, init, opts = {}) {
  const {
    retry = true,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = defaultSleep,
  } = opts;

  const attempts = retry ? Math.max(1, maxAttempts) : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // A fresh signal per attempt — an AbortSignal is single-use, so
      // reusing one would insta-abort every retry after the first timeout.
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === attempts) break;
      await sleep(backoffMs(attempt));
    }
  }

  // Rethrow the original so the underlying code (ECONNRESET) stays
  // visible to the user; only the message gains the attempt count.
  if (lastError && isTransientNetworkError(lastError) && attempts > 1) {
    lastError.message = `${lastError.message} (after ${attempts} attempts)`;
  }
  throw lastError;
}

module.exports = {
  resilientFetch,
  isTransientNetworkError,
  RETRYABLE_CODES,
  DEFAULT_TIMEOUT_MS,
};
