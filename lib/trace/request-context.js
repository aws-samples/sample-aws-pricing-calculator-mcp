// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Request-scoped context for the MCP server. Threads a session id from
// the HTTP transport entrypoint down through tool handlers and any
// helpers they call, without changing function signatures.
//
// This is plumbing — it has nothing to do with logging. The trace
// logger consumes `currentSessionId()` to stamp events, but the scope
// itself runs unconditionally so any consumer (custom log pipelines,
// per-session metrics, request-keyed caches) can read it the same way.

const { AsyncLocalStorage } = require('node:async_hooks');

const sessionStorage = new AsyncLocalStorage();

function runWithSession(sessionId, fn) {
  return sessionStorage.run({ sessionId }, fn);
}

function currentSessionId() {
  const store = sessionStorage.getStore();
  return store && store.sessionId;
}

module.exports = { sessionStorage, runWithSession, currentSessionId };
