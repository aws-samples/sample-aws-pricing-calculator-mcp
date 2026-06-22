// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Catalog of structured trace events emitted by the MCP server.
//
// All event names live here in one place — adding a new event is a
// deliberate edit of this file, not a string literal scattered across
// the codebase. Downstream consumers (eval predicates, log queries)
// can read this file as the authoritative list.
//
// Each helper auto-stamps `mcpSessionId` from the active request scope,
// so callsites pass only the payload that's specific to the event.
// `estimateId` and other correlators stay explicit at the callsite —
// they're real payload, not envelope.
//
// `tool.call` and `tool.result` are emitted by lib/trace-logger.js's
// traceTool wrapper, not from here. They're event names too, but the
// wrapper owns the entire shape — including the truncation and
// redaction logic — so factoring them through these helpers would be
// awkward.

const { emit } = require('./trace-logger');
const { currentSessionId } = require('./request-context');

function withSession(payload) {
  return { ...payload, mcpSessionId: currentSessionId() };
}

// AWS Pricing Calculator save API round-trip. One save.send before the
// HTTP request, then exactly one of save.ok or save.fail.
const save = {
  send: (payload) => emit('save.send', withSession(payload)),
  ok: (payload) => emit('save.ok', withSession(payload)),
  fail: (payload) => emit('save.fail', withSession(payload)),
};

// Rehydration lint preflight result. Verdict is one of the lint
// statuses (read-only / required-input / ok); see lib/can-rehydrate.js.
function lint(payload) {
  emit('lint', withSession(payload));
}

// build_estimate emits this when the per-service validation pass
// fails on services the agent didn't first inspect via
// get_service_fields. Drives the "needs_grounding" pre-flight nudge.
const buildEstimate = {
  needsGrounding: (payload) => emit('build_estimate.needs_grounding', withSession(payload)),
};

// get_service_fields emits this when the agent asks about a sub-service
// parent (e.g. SNS) and we redirect to the canonical child service.
const getServiceFields = {
  redirectToParent: (payload) => emit('get_service_fields.redirect_to_parent', withSession(payload)),
};

// add_service / build_estimate emit this when we apply a templateId
// hint from a catalog entry whose status is 'unverified'. The hint
// might be wrong; the trace is the breadcrumb to investigate.
const templateHint = {
  unverified: (payload) => emit('template_hint.unverified', withSession(payload)),
};

// Marks the start of an estimate-building flow. Fires from create_estimate
// when an agent mints a fresh estimateId at the top of a conversation.
// Does NOT fire from build_estimate — that path can mint an estimateId
// either as a fresh start OR as a retry after a refusal, and the server
// can't tell them apart without a stable session correlator (mcpSessionId
// is unstable per-call). Observability that wants build_estimate-rooted
// flows can derive them from `tool.call:build_estimate` events that are
// not preceded by a session.start event for the same estimateId.
//
// Why this exists: the per-estimateId save-rate metric over-counts retry
// inflation (each build_estimate retry mints a new estimateId; only the
// final one carries save.ok). Counting save.ok per session.start gives
// observability a denominator that matches "user started a flow," which
// is closer to what the user feels.
const session = {
  start: (payload) => emit('session.start', withSession(payload)),
};

// EC2 transformConfig silently remaps reserved/convertible -> instance-
// savings/compute-savings under shared tenancy because the calculator
// hides Standard/Convertible RIs in that combo. The remap stays
// (otherwise every existing reserved+shared save would break), but
// we emit this event so downstream observability can detect the
// asked-X-got-Y divergence. The companion lint predicate
// tenancy-pricing-mismatch handles the structural case (blob with
// shared+standard or shared+convertible saved DIRECTLY, bypassing
// transformConfig); this trace event covers the remap-happened
// case. Together they cover both paths into the same hazard.
const ec2 = {
  tenancyRemap: (payload) => emit('ec2.tenancy_remap', withSession(payload)),
};

module.exports = { save, lint, buildEstimate, getServiceFields, templateHint, session, ec2 };
