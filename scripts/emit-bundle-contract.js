#!/usr/bin/env node
// Emit dist/bundle-contract.json — the public contract between this bundle
// and any consumer that runs it.
//
// v1 covers env vars only. The set is hand-curated rather than discovered
// via AST traversal because:
//   1. We want the *meaning* of each var (what it switches on, default,
//      enum values) — that information is not statically derivable from
//      `process.env.X` references.
//   2. The set is small (5 today) and stable. A new env var is a deliberate
//      change worth coding into this file as part of the same PR.
//
// Future v2/v3: tool name registry, trace event schemas. Both can be
// appended to this object — consumers should treat unknown top-level
// keys as additive.
//
// Output is written to dist/bundle-contract.json next to dist/mcp-server.js
// so the consumer can sync them as a unit.

const fs = require('node:fs');
const path = require('node:path');

const pkg = require(path.resolve(__dirname, '..', 'package.json'));

const contract = {
  // Bound to the bundle's package.json version. Bumping the bundle is the
  // signal to consumers that the contract may have moved.
  version: pkg.version,
  envVars: {
    ESTIMATES_STORE: {
      type: 'enum',
      values: ['memory', 'dynamodb'],
      default: 'memory',
      purpose: 'Pluggable estimate store backend. memory = in-process Map (single-replica only); dynamodb = DynamoEstimateStore (required when running behind a stateless multi-replica router or any deployment without sticky-session routing).',
      readBy: 'lib/store/estimate-store.js#createEstimateStore',
    },
    ESTIMATES_TABLE: {
      type: 'string',
      requiredWhen: 'ESTIMATES_STORE=dynamodb',
      purpose: 'DynamoDB table name backing the DynamoEstimateStore. PK=id (S), with optional TTL on expiresAt (N).',
      readBy: 'lib/store/estimate-store-dynamodb.js#constructor',
    },
    ESTIMATES_TTL_SECONDS: {
      type: 'integer',
      default: 0,
      purpose: 'TTL applied to the expiresAt attribute on each estimate snapshot. 0 = no TTL (caller must clean up). Must match the table\'s configured timeToLiveAttribute.',
      readBy: 'lib/store/estimate-store-dynamodb.js#constructor',
    },
    MCP_TRANSPORT: {
      type: 'enum',
      values: ['stdio', 'http'],
      default: 'stdio',
      purpose: 'Selects the MCP transport. stdio is the default for local CLI usage; http starts an Express server for hosted deployments.',
      readBy: 'mcp-server.js',
    },
    TRACE: {
      type: 'enum',
      values: ['on', '1', 'true', 'yes', 'off'],
      default: 'off',
      purpose: 'Enables structured stderr trace events (tool.call, tool.result, save.*, lint, etc.). Off by default — emit() is a no-op and traceTool is a passthrough when unset. Truthy values: on, 1, true, yes (case-insensitive). Anything else, including unset, leaves tracing off.',
      readBy: 'lib/trace/trace-logger.js#isTraceEnabled',
    },
    TRACE_RESULT_TEXT_MAX: {
      type: 'integer',
      default: 500,
      purpose: 'Cap on result.text length in trace events emitted by lib/trace/trace-logger.js. Errors get a separate, larger cap (10000) hardcoded in the logger. Only consulted when TRACE is on.',
      readBy: 'lib/trace/trace-logger.js#resultTextMax',
    },
  },
};

const outDir = path.resolve(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'bundle-contract.json');
fs.writeFileSync(outPath, JSON.stringify(contract, null, 2) + '\n');
console.log(`OK: wrote ${outPath} (version=${contract.version}, ${Object.keys(contract.envVars).length} env vars)`);
