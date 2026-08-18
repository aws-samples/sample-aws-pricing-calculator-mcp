// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Structured trace logger for MCP tool I/O. Single JSON line per event,
// stderr only — stdout is the MCP protocol channel and writing there
// corrupts JSON-RPC framing.
//
// Tracing is opt-in via the TRACE env var (off by default). When off,
// emit() is a no-op and traceTool's wrapping work is skipped — the
// session-id scope still runs because that's request-context plumbing,
// not logging.
//
// Session-id correlation lives in lib/request-context — this module
// reads `currentSessionId()` from there but does not own the scope.

const { currentSessionId } = require('./request-context');

// Read TRACE on every call rather than at module load — lets tests
// flip it without re-requiring the module, and matches the precedent
// set by resultTextMax(). Truthy values: "on", "1", "true", "yes" (any
// case). Anything else, including unset, means tracing is off.
const TRUTHY_TRACE = new Set(['on', '1', 'true', 'yes']);
function isTraceEnabled() {
  const raw = process.env.TRACE;
  return raw != null && TRUTHY_TRACE.has(String(raw).trim().toLowerCase());
}

function emit(event, payload) {
  if (!isTraceEnabled()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  process.stderr.write(line + '\n');
}

const DEFAULT_RESULT_TEXT_MAX = 500;
// Errors get a bigger cap. Live data probe (24h) showed isError=1 events
// top out at ~4.3K chars (build_estimate's per-service correction
// hints), while healthy get_service_fields responses run 100K+. Raising
// the global cap would 5x log volume on the success path; raising only
// for errors captures every observed error case with margin and
// virtually no overhead. 10K leaves ~2x headroom over the current p99
// for future error growth.
const ERROR_RESULT_TEXT_MAX = 10000;
const TRUNCATED_MARKER = ' …[truncated]';

// Keys whose VALUES may carry customer-supplied free text. Trace events
// land in CloudWatch under an account-wide log group — anything in
// these fields gets queryable by anyone with read on the log group.
// Replace the value with `[redacted: N chars]` so the structure of the
// trace stays useful (you can still see "the agent set a description")
// without leaking the actual content. Add new keys here as the tool
// surface grows.
const SENSITIVE_KEYS = new Set(['name', 'description']);

// Read the truncation cap on every call rather than at module load —
// lets tests and one-off investigations override TRACE_RESULT_TEXT_MAX
// without re-requiring the module. Falls back to 500 chars if unset
// or unparseable; that's the steady-state default.
function resultTextMax() {
  const raw = process.env.TRACE_RESULT_TEXT_MAX;
  if (!raw) return DEFAULT_RESULT_TEXT_MAX;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESULT_TEXT_MAX;
}

// Recursively walk a JS value, replacing any string at a SENSITIVE_KEYS
// position with a length-only marker. Non-string values at sensitive
// positions (numbers, null) are left alone — the concern is free text,
// not type-shaped fields. Returns a fresh structure; the input is not
// mutated.
function redactValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactValue);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === 'string') {
      out[k] = `[redacted: ${v.length} chars]`;
    } else {
      out[k] = redactValue(v);
    }
  }
  return out;
}

// Redact tool-call args. The build_estimate / add_service tools pass
// the service list as a JSON-encoded string, so descriptions nested in
// service configs only get caught if we parse, redact, and re-stringify.
// Other args fields are scalars (estimate_id, query, region) and pass
// through untouched.
function redactArgs(args) {
  if (!args || typeof args !== 'object') return args;
  let cloned = args;
  if (typeof args.services === 'string') {
    try {
      cloned = { ...args, services: JSON.stringify(redactValue(JSON.parse(args.services))) };
    } catch {
      // Not JSON — leave as-is; the redactValue pass below still handles
      // the rest of the args envelope.
    }
  }
  return redactValue(cloned);
}

// Redact tool-result text. Tool results in this server are
// JSON.stringify'd in the SDK content envelope, so JSON.parse should
// succeed for every success-path emit. Throw-path emits carry a stack
// trace which won't parse — those pass through unchanged, since stacks
// rarely contain customer text and we'd rather not invent regex-based
// string surgery here.
function redactResultText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  try {
    return JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    return text;
  }
}

// Pull the first text-content piece from an MCP tool result. The MCP
// SDK shape is { content: [{ type, text }, ...], isError? }. We only
// look at the first text block — multi-part results in this server
// don't exist today and the trace doesn't need to fan out.
function extractResultText(result) {
  if (!result) return '';
  const first = (result.content || []).find(c => c && c.type === 'text');
  return (first && first.text) || '';
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  const cap = max ?? resultTextMax();
  if (s.length <= cap) return s;
  return s.slice(0, cap) + TRUNCATED_MARKER;
}

// Pull the estimate id from a tool's args without imposing structure
// on tools that don't have one. Tools that take an estimate use the
// arg name `estimate_id` (snake case, matching the MCP tool schema).
// Returns undefined when args is missing, not an object, or has no id.
function estimateIdFromArgs(args) {
  if (!args || typeof args !== 'object') return undefined;
  const v = args.estimate_id;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Pull the estimate id from a tool's result body when args didn't carry
// one. build_estimate and create_estimate mint the eid internally and
// return it in the response — without this fallback, their trace events
// have no `estimateId` and the recovery widget misses their failures.
// Args always wins: the per-call invariant is "the eid the agent passed
// IN is the one this call is about," even if the body mentions another.
function estimateIdFromResultText(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const v = parsed.estimate_id;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Wrap an MCP tool handler so each call emits structured trace events
// before and after. The wrapper does NOT change the handler's contract:
// it returns the same shape the handler returns, and re-throws any
// exception unchanged. Trace emit failures are swallowed — never let
// observability break the tool path.
function traceTool(name, handler) {
  return async function tracedHandler(args, ...rest) {
    // Fast path when tracing is off: no timing, no redaction, no
    // result-shape inspection. The handler's contract is identical
    // either way — only the observability work is skipped.
    if (!isTraceEnabled()) return handler(args, ...rest);
    const start = Date.now();
    const estimateId = estimateIdFromArgs(args);
    try { emit('tool.call', { name, args: redactArgs(args), estimateId, mcpSessionId: currentSessionId() }); }
    catch { /* never let trace emit break the tool */ }
    let result;
    let threw;
    try {
      result = await handler(args, ...rest);
    } catch (err) {
      threw = err;
    }
    const durationMs = Date.now() - start;
    if (threw) {
      try {
        const errText = threw.stack || threw.message || String(threw);
        emit('tool.result', {
          name,
          isError: true,
          resultText: truncate(errText, ERROR_RESULT_TEXT_MAX),
          resultLength: errText.length,
          durationMs,
          estimateId,
          mcpSessionId: currentSessionId(),
        });
      } catch {}
      throw threw;
    }
    try {
      const text = extractResultText(result);
      const redacted = redactResultText(text);
      const isError = !!(result && result.isError);
      const eid = estimateId ?? estimateIdFromResultText(text);
      emit('tool.result', {
        name,
        isError,
        resultText: truncate(redacted, isError ? ERROR_RESULT_TEXT_MAX : undefined),
        resultLength: text.length,
        durationMs,
        estimateId: eid,
        mcpSessionId: currentSessionId(),
      });
    } catch {}
    return result;
  };
}

module.exports = { emit, traceTool, isTraceEnabled };
