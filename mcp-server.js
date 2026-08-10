#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// Entry point. The 9 tool registrations live here; their long
// descriptions are in lib/tool-descriptions.js and the helpers each
// handler calls into are in lib/handler-helpers.js. Read this file
// to understand the wiring; read those files for the prose and logic.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const path = require('node:path');

const { PARTITIONS, loadManifest, findService, fetchServiceDefinition, extractInputFields, searchServices, fetchEstimate, estimateToMarkdown } = require('./lib/aws-client');
const EstimateBuilder = require('./lib/estimate-builder');
const { createEstimateStore } = require('./lib/estimate-store');
const { loadCatalog } = require('./lib/catalog');
const { nextStepFor } = require('./lib/lint-hints');
const { traceTool } = require('./lib/trace-logger');
const traceEvents = require('./lib/trace-events');
const { runWithSession } = require('./lib/request-context');
const { createHandlerHelpers, mcpJsonOk, mcpTextErr, checkPartition, parseServicesArg } = require('./lib/handler-helpers');
const desc = require('./lib/tool-descriptions');

// CALCMCP_CATALOG_DIR is an eval-only override — the eval harness uses
// it to point the server at a mutated copy of the catalog so probe
// scenarios can ask "what does the agent do with bad catalog data?"
// without rewriting the canonical files. Default deployments leave it
// unset; if a deployment does set it, log to stderr so it's visible.
//
// Resolution (when CALCMCP_CATALOG_DIR is unset):
//   1. <__dirname>/catalog/services    — local dev (node mcp-server.js
//      from the repo root) and any deployment that copies the catalog
//      next to the entry script
//   2. <__dirname>/../catalog/services — npm/npx install layout, where
//      mcp-server.js lives at <pkg>/dist/mcp-server.js and the catalog
//      ships at <pkg>/catalog/services per the package.json files[].
//
// First match wins. Falls through to an empty catalog (loadCatalog
// returns an empty Map for a missing dir) which is safe but degraded —
// agents miss the curated `minimalConfig` / `traps[]` enrichment.
const fs = require('node:fs');
function resolveCatalogDir() {
  if (process.env.CALCMCP_CATALOG_DIR) return process.env.CALCMCP_CATALOG_DIR;
  const candidates = [
    path.join(__dirname, 'catalog', 'services'),
    path.join(__dirname, '..', 'catalog', 'services'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]; // returns the primary so error paths look familiar
}
const _catalogDir = resolveCatalogDir();
if (process.env.CALCMCP_CATALOG_DIR) {
  process.stderr.write(`NOTE: catalog override active — loading from ${_catalogDir}\n`);
}
const catalog = loadCatalog(_catalogDir, { strict: false });

const estimates = createEstimateStore();

const pkg = require('./package.json');

const server = new McpServer({
  name: pkg.name,
  version: pkg.version,
});

const helpers = createHandlerHelpers({ catalog });
const {
  addEntries,
  lintEstimate,
  estimateNotFoundResult,
  exportWithLint,
  buildFieldsResult,
  maybeBuildRedirectResult,
  maybeBuildProductRedirect,
  annotateSearchResults,
} = helpers;

server.tool(
  'get_server_info',
  desc.GET_SERVER_INFO,
  {},
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traceTool('get_server_info', async () => mcpJsonOk({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    tools: ['search_services', 'get_service_fields', 'create_estimate', 'add_service', 'build_estimate', 'validate_estimate', 'export_estimate', 'import_estimate', 'get_server_info'],
    partitions: Object.keys(PARTITIONS),
  }))
);

server.tool(
  'search_services',
  desc.SEARCH_SERVICES,
  {
    query: z.string().describe('One or more search terms, comma-separated (e.g. "Lambda, S3, Amazon Personalize, API Gateway, CloudWatch")'),
    partition: z.string().optional().describe('AWS partition to search in (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b", "aws-eusc"'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traceTool('search_services', async ({ query, partition }) => {
    const p = partition || 'aws';
    const partErr = checkPartition(p);
    if (partErr) return partErr;
    const manifest = await loadManifest(p);
    // annotateSearchResults adds redirect_to + note on hits whose
    // serviceCode is a product-level orphan (Bedrock Titan/Nova family).
    // Discovery-time hint earns 6→3 tool-call reduction on Sonnet 4.5
    // empirically; the same data drives the post-save lint refusal hint
    // for less-capable agents that skip this signal.
    return mcpJsonOk(annotateSearchResults(searchServices(manifest, query)));
  })
);

server.tool(
  'get_service_fields',
  desc.GET_SERVICE_FIELDS,
  {
    service: z.string().describe('One or more service keys, comma-separated (e.g. "aWSLambda, amazonS3, stepFunctionStandard, amazonApiGateway")'),
    partition: z.string().optional().describe('AWS partition to fetch from (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b", "aws-eusc"'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  traceTool('get_service_fields', async ({ service, partition }) => {
    const p = partition || 'aws';
    const partErr = checkPartition(p);
    if (partErr) return partErr;
    const manifest = await loadManifest(p);
    const keys = service.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    const errors = [];

    for (const key of keys) {
      const svc = findService(manifest, key);
      if (!svc) { errors.push(`Service "${key}" not found.`); continue; }

      // Product-code redirect: agent reached for an orphan child like
      // titanTextEmbeddingsV2 that the calculator's parent envelope
      // doesn't claim in templates[]. Returns null when no productCodes
      // entry covers this service. Checked BEFORE fetching the def to
      // skip an unnecessary network call when we know we're redirecting.
      const productRedirect = await maybeBuildProductRedirect({ svc, partition: p });
      if (productRedirect) { results.push(productRedirect); continue; }

      const definition = await fetchServiceDefinition(manifest, svc.key, p);
      if (!definition) { errors.push(`Failed to fetch definition for "${svc.key}".`); continue; }

      // Parent-envelope redirect (e.g. amazonS3 → amazonS3Standard).
      // Returns null if no redirect applies; otherwise the redirect
      // envelope with preview-fetched first-child fields inline.
      const fields = extractInputFields(definition);
      const redirect = await maybeBuildRedirectResult({ svc, fields, partition: p });
      if (redirect) { results.push(redirect); continue; }

      const result = await buildFieldsResult(svc, p);
      if (result) results.push(result);
    }

    const output = errors.length
      ? { services: results, errors }
      : keys.length === 1 ? results[0] : results;
    return mcpJsonOk(output);
  })
);

server.tool(
  'create_estimate',
  desc.CREATE_ESTIMATE,
  {
    name: z.string().optional().describe('Name for the estimate (default: "My Estimate")'),
    partition: z.string().optional().describe('AWS partition for this estimate (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b", "aws-eusc"'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traceTool('create_estimate', async ({ name, partition }) => {
    const partErr = checkPartition(partition);
    if (partErr) return partErr;
    const estimate = new EstimateBuilder(name, partition || undefined);
    await estimates.put(estimate);
    // Mark the start of an estimate flow so observability can derive a
    // session-shaped denominator instead of per-estimateId. See
    // lib/trace-events.js#session for why build_estimate intentionally
    // doesn't fire this event.
    traceEvents.session.start({
      estimateId: estimate.id,
      partition: partition || 'aws',
      origin: 'create_estimate',
    });
    return mcpJsonOk({ estimate_id: estimate.id, name: estimate.name });
  })
);

server.tool(
  'add_service',
  desc.ADD_SERVICE,
  {
    estimate_id: z.string().describe('Estimate ID from create_estimate'),
    services: z.string().describe('JSON array of service entries. Each entry: {"service":"serviceKey","instance":"optional","group":"optional","config":{...with region, description, and field values}}. Example: [{"service":"aWSLambda","group":"Prod","config":{"region":"eu-west-1","description":"Compute","numberOfRequests":{"value":"19","unit":"millionPerMonth"}}}]'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  traceTool('add_service', async ({ estimate_id, services: servicesStr }) => {
    const estimate = await estimates.get(estimate_id);
    if (!estimate) return estimateNotFoundResult(estimate_id);

    const parsed = parseServicesArg(servicesStr);
    if (parsed.error) return parsed.error;

    const results = await addEntries(estimate, parsed.entries);
    // All-or-nothing batch: if any entry failed validation, don't persist.
    // The deep-cloned `estimate` is discarded; the stored snapshot stays as
    // it was pre-call. Prevents the partial-state trap where a mixed batch
    // [valid, invalid] left the valid entries stuck in the store, tripping
    // the next save (observed 2026-06-02 OpenSearch agent recovery turn).
    if (results.some(r => r.error)) return mcpJsonOk(results);
    await estimates.put(estimate);
    return mcpJsonOk(results);
  })
);

server.tool(
  'validate_estimate',
  desc.VALIDATE_ESTIMATE,
  { estimate_id: z.string().describe('Estimate ID from create_estimate or build_estimate') },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  traceTool('validate_estimate', async ({ estimate_id }) => {
    const estimate = await estimates.get(estimate_id);
    if (!estimate) return estimateNotFoundResult(estimate_id);

    try {
      const { blob, lintResult } = await lintEstimate(estimate);
      const hint = nextStepFor(lintResult, catalog);
      // We ALWAYS return success: the verdict tells the caller what to
      // do next. Read-only is informational, not a tool error. Hint
      // surfaces remediation guidance at the top so the agent sees an
      // actionable instruction without parsing the lint structure;
      // null when the estimate is healthy enough to export.
      return mcpJsonOk({
        lint_verdict: lintResult.status,
        next_step: hint,
        lint_services: lintResult.services,
        would_be_payload: blob,
      });
    } catch (err) {
      return mcpTextErr(`Validate failed: ${err.message}`);
    }
  })
);

server.tool(
  'export_estimate',
  desc.EXPORT_ESTIMATE,
  { estimate_id: z.string().describe('Estimate ID from create_estimate') },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  traceTool('export_estimate', async ({ estimate_id }) => {
    const estimate = await estimates.get(estimate_id);
    if (!estimate) return estimateNotFoundResult(estimate_id);

    try {
      const result = await exportWithLint(estimate);
      if (result.isError) return mcpTextErr(result.text);
      return mcpJsonOk({ sharable_url: result.sharable_url, aws_estimate_id: result.aws_estimate_id });
    } catch (err) {
      return mcpTextErr(`Export failed: ${err.message}`);
    }
  })
);

// Extracted for testability — registered below via traceTool wrapper.
// Pre-mint branches (bad-partition, JSON-parse, empty-array) return before
// EstimateBuilder is constructed, so they have no estimate_id to surface.
// All post-mint branches include estimate_id so failures correlate with
// lint/save trace events for this estimate.
async function buildEstimateHandler({ services: servicesStr, name, partition }) {
  const partErr = checkPartition(partition);
  if (partErr) return partErr;

  const parsed = parseServicesArg(servicesStr);
  if (parsed.error) return parsed.error;
  if (parsed.entries.length === 0) return mcpTextErr('No services provided.');

  const estimate = new EstimateBuilder(name, partition || undefined);
  const results = await addEntries(estimate, parsed.entries);
  const failed = results.filter(r => r.error);
  if (failed.length > 0) {
    // Pre-flight grounding nudge. The dominant build_estimate failure
    // mode is calling cold with field IDs guessed from training priors
    // (e.g. "allocatedMemory" vs the schema's "sizeOfMemoryAllocated").
    // Return isError:false with a structured next_step pointing at
    // get_service_fields — error responses have 0% recovery per the
    // recovery widget, so a non-error envelope with explicit guidance
    // is the only redirect that has a chance. Per-entry results
    // (with did-you-mean hints from invalidFieldIdsHintFor) are
    // preserved in issues[] so no information is lost.
    const servicesToInspect = [...new Set(
      failed.map(r => String(r.service || '').split(':')[0]).filter(Boolean),
    )];
    try {
      traceEvents.buildEstimate.needsGrounding({
        estimateId: estimate.id,
        servicesToInspect,
        failureCount: failed.length,
      });
    } catch {}
    // Explicit isError:false (not absent) — the recovery widget keys on
    // this exact value to distinguish "pre-flight nudge, retry me" from
    // "tool error, give up." Production observed 0% recovery on
    // isError:true; the structured-redirect-with-explicit-false envelope
    // is the only shape that gets agents to retry.
    return { ...mcpJsonOk({
      estimate_id: estimate.id,
      status: 'needs_field_grounding',
      next_step: `Field IDs/values for ${servicesToInspect.join(', ')} did not match the schema. Call get_service_fields for those services to discover valid field IDs and value shapes, then retry build_estimate with the corrected payload.`,
      services_to_inspect: servicesToInspect,
      issues: results,
    }), isError: false };
  }
  await estimates.put(estimate);

  try {
    const exportResult = await exportWithLint(estimate);
    if (exportResult.isError) {
      // Include estimate_id so the lint-refused failure correlates with
      // the lint trace event emitted by exportWithLint. The body switches
      // from a plain string to JSON; the multi-line "Next step:" hint inside
      // exportResult.text gets escaped (\n literals) but is still readable.
      return mcpTextErr(JSON.stringify({ estimate_id: estimate.id, error: exportResult.text }));
    }
    return mcpJsonOk({
      estimate_id: estimate.id,
      sharable_url: exportResult.sharable_url,
      aws_estimate_id: exportResult.aws_estimate_id,
      services: results,
    });
  } catch (err) {
    // Include estimate_id so the failure correlates with the prior
    // lint/save.send/save.fail trace events for this estimate. The body
    // switches from a plain string to JSON; agents reading the text field
    // still see the failure, structured consumers see the id.
    return mcpTextErr(JSON.stringify({ estimate_id: estimate.id, error: `Build failed: ${err.message}` }));
  }
}

server.tool(
  'build_estimate',
  desc.BUILD_ESTIMATE,
  {
    services: z.string().describe('JSON array of service entries. Same shape as add_service. Each entry: {"service":"serviceKey","instance":"optional","group":"optional","config":{...with region, description, and field values}}.'),
    name: z.string().optional().describe('Estimate name (default: "My Estimate")'),
    partition: z.string().optional().describe('AWS partition (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b", "aws-eusc", "aws-eusc"'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  traceTool('build_estimate', buildEstimateHandler)
);

server.tool(
  'import_estimate',
  desc.IMPORT_ESTIMATE,
  {
    estimate_id: z.string().describe('A full estimate URL or a bare ID. If you were given a URL, pass the whole URL rather than reducing it to the ID — the domain identifies which calculator stores the estimate (standard "calculator.aws" vs European Sovereign Cloud "pricing.calculator.aws.eu"). A bare ID is always read from the standard calculator, so an ESC estimate is only importable as its full pricing.calculator.aws.eu URL.'),
    format: z.enum(['json', 'markdown']).optional().describe('Output format: "json" for raw data (default), "markdown" for LLM-friendly summary'),
  },
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  traceTool('import_estimate', async ({ estimate_id, format }) => {
    // Extract ID from URL if needed
    let id = estimate_id;
    let partition;
    const urlMatch = estimate_id.match(/[?&]id=([a-f0-9]+)/);
    if (urlMatch) id = urlMatch[1];
    if (estimate_id.includes('pricing.calculator.aws.eu')) partition = 'aws-eusc';

    try {
      const data = await fetchEstimate(id, { partition });
      const output = (format === 'markdown')
        ? estimateToMarkdown(data)
        : JSON.stringify(data, null, 2);
      return { content: [{ type: 'text', text: output }] };  // raw, not JSON-wrapped
    } catch (err) {
      return mcpTextErr(`Import failed: ${err.message}`);
    }
  })
);

async function main() {
  if (process.env.MCP_TRANSPORT === 'http') {
    // Lazy require: stdio is the default and most-used path. Hoisting these
    // would force every stdio user (and the bundled stdio binary) to load
    // Express + the streamable HTTP transport just to throw them away.
    // nosemgrep: lazy-load-module
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    // nosemgrep: lazy-load-module
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    // No CSRF middleware: this endpoint speaks JSON-RPC, not HTML forms.
    // It uses no cookies and relies on transport-level auth (bearer token /
    // SigV4 / network policy) configured by the deployment, not browser
    // origin trust.
    app.post('/mcp', async (req, res) => {
      // Long-lived containers behind a persistent-connection front-end
      // (HTTP/2-style) don't always fire res.on('close') between requests.
      // Disconnect any prior transport before attaching the new one —
      // McpServer.close() is a no-op when nothing is connected.
      await server.close();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await server.connect(transport);
      // Run the request inside an AsyncLocalStorage scope keyed on the
      // inbound MCP session id (the deployment's HTTP front-end is
      // expected to set the Mcp-Session-Id header on every request).
      // Tool handlers and any helpers they call see this via
      // currentSessionId() in lib/request-context (consumed by trace
      // events and lib/aws-client.js's save logs).
      const mcpSessionId = req.headers['mcp-session-id'] || null;
      await runWithSession(mcpSessionId, () =>
        transport.handleRequest(req, res, req.body),
      );
    });
    app.get('/mcp', (req, res) => res.writeHead(405).end('Method Not Allowed'));
    app.delete('/mcp', (req, res) => res.writeHead(405).end('Method Not Allowed'));
    const port = process.env.PORT || 8000;
    const host = process.env.HOST || '127.0.0.1';
    app.listen(port, host, () => console.error(`MCP server listening on ${host}:${port}`));
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

// Test-only export. Production callers ignore this. Lets tests inspect the
// configured store and any other internals without forking the module.
module.exports = { __test: { store: estimates, addEntries, exportWithLint, lintEstimate, buildEstimateHandler } };

// Auto-start when invoked directly (`node mcp-server.js`) or when the
// HTTP-mode env var is set. The latter handles bundled deployments where
// a wrapper script requires the bundle from a separate entrypoint —
// require.main !== module there, but MCP_TRANSPORT=http is the explicit
// "run the server" signal. Tests don't set MCP_TRANSPORT, so they still
// get a side-effect-free require().
if (require.main === module || process.env.MCP_TRANSPORT === 'http') {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
