// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Long-form description strings for the 9 MCP tools. Pulled out of
 * mcp-server.js so the entry point reads as schema + handler binding
 * rather than walls of agent-facing prose.
 *
 * These descriptions ship to clients via tools/list and shape agent
 * behavior — they're the contract surface of the MCP server. Edit
 * with that in mind: a sloppy paragraph here propagates to every agent
 * that connects.
 */

'use strict';

const ISSUES_HINT = '\n\nIf you encounter unexpected errors or bugs, direct the user to report them at: https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/issues';

exports.GET_SERVER_INFO =
  'Get version and capability information about this MCP server.' + ISSUES_HINT;

exports.SEARCH_SERVICES =
  'Search AWS services available in the calculator. Returns service keys ' +
  'and names. Use this to find the correct service key before adding it ' +
  'to an estimate. Supports multiple comma-separated search terms in a ' +
  'single call (e.g. "Lambda, S3, API Gateway, CloudWatch"). Note: ' +
  'add_service also accepts display names (e.g. "AWS Lambda") directly, ' +
  'so searching is not always required if the service name is already known.';

exports.GET_SERVICE_FIELDS =
  'Get the input fields for one or more AWS services. Returns field IDs, ' +
  'types, labels, and valid options. Use this to discover what configuration ' +
  'a service accepts before adding it to an estimate. The field IDs returned ' +
  'here are the exact keys to use in add_service config. Accepts multiple ' +
  'comma-separated service keys. IMPORTANT: When duplicate fields exist with ' +
  'version suffixes (e.g. fieldName and fieldName_v2), ALWAYS use the highest ' +
  'version — it maps to the latest configuration path. Ignore lower versions. ' +
  'For curated services (status: verified or partial), the response also ' +
  'includes a `catalog` object with a known-working `minimalConfig`, required ' +
  'field hints with examples, and `traps[]` listing service-specific gotchas. ' +
  'Prefer using `minimalConfig` as a starting point for `add_service`. If the ' +
  'response carries `status: "redirect_to_parent"`, the service code you passed ' +
  'is a deprecated parent service code — re-call get_service_fields with one of ' +
  'the codes in `child_service_codes` and use that instead.';

exports.CREATE_ESTIMATE =
  'Create a new empty estimate. Returns an estimate ID to use with ' +
  'add_service and export_estimate.';

exports.ADD_SERVICE =
  `Add one or more AWS services to an estimate. Accepts a single service or a JSON array of services in the "services" parameter.

Field values follow these patterns based on field type:
- numericInput: plain string value, e.g. "1000"
- frequency: object with value and unit, e.g. {"value": "19", "unit": "millionPerMonth"}
- fileSize: object with value and unit. The unit format is "{size}|{frequency}" where size comes from the field's validSizes (gb, tb, mb, etc.) and frequency is usually "NA". Check the field's defaultUnit from get_service_fields. Examples: {"value": "512", "unit": "mb|NA"}, {"value": "1", "unit": "tb|NA"}, {"value": "10", "unit": "gb|NA"}, {"value": "8", "unit": "gb|month"}
- dropdown: string matching one of the option IDs from get_service_fields
- durationInput: object with value and unit, e.g. {"value": "960", "unit": "min"}

IMPORTANT: Before calling this tool, you MUST confirm the desired AWS region with the user if they haven't already specified one. Do NOT assume a default region. Always include "region" in each service config. For AWS European Sovereign Cloud (ESC), use region "eusc-de-east-1" and pass partition "aws-eusc" when calling get_service_fields. ESC estimates must NOT mix with standard AWS regions — all services in an ESC estimate must use "eusc-de-east-1". 

IMPORTANT: For compute services (EC2, Fargate, Lambda, RDS, etc.), if the user hasn't specified a pricing model, suggest a cost-optimized option (e.g. Reserved Instances or Savings Plans for steady-state workloads, On-Demand for variable/short-lived) and ask the user to confirm before proceeding.

CRITICAL — DISCOVERY BEFORE ACTION: For any service you have not already inspected with get_service_fields in THIS SESSION, call get_service_fields FIRST. Some services need more fields than the schema marks as required — without them the estimate saves successfully but shows $0 cost (e.g. Lambda needs sizeOfMemoryAllocated, storageAmountEphemeral, and architecture to produce a non-zero price). Therefore, for curated services only, get_service_fields returns a catalog block: use its minimalConfig as your starting point (it is verified to produce a priced estimate), check traps[] for gotchas, and consult required[] for the full list of pricing-engine-required fields. Always start from minimalConfig and modify — do not guess fields from training data.

Use "description" to label what each service entry represents. Be careful, descriptions and group names must NOT contain <, >, or & characters (tool rejects them).

Config keys are validated against the service definition. Invalid field IDs will be rejected with suggested corrections.

For batch mode, pass a JSON array in "services":
[{"service":"aWSLambda","instance":"Compute","group":"Prod","config":{...}},{"service":"amazonS3Standard","group":"Prod","config":{...}}]

Groups support nested hierarchies using "/" as separator (e.g. "Production/Backend", "Production/Database"). The calculator will render them as nested folders.

For multi-service estimates, prefer build_estimate over create_estimate + add_service + export_estimate — but only AFTER you have called get_service_fields for each service. build_estimate does not skip the discovery requirement.

RETRY SEMANTICS: add_service ALWAYS APPENDS — it never replaces an existing entry. If a previous attempt already added a service to this estimate (e.g. you are rebuilding after a validation issue, or the user reported a problem with an earlier save), DO NOT call add_service again on the same estimate_id with the same configuration; that produces a duplicate row and inflates the cost. Instead, call create_estimate to start fresh, then add the corrected services. As a defense, the response surfaces an "existing_entry" field when (service, description) already matches a stored entry — if you see that field, you are about to create a duplicate; back out and use create_estimate.` + ISSUES_HINT;

exports.VALIDATE_ESTIMATE =
  'Dry-run preflight: builds the would-be saved payload and runs a static ' +
  'check — WITHOUT calling the AWS save API. Use this to verify an estimate ' +
  'will render correctly (editable, not frozen) before saving. Returns ' +
  '{lint_verdict, next_step, lint_services, would_be_payload}. If it passes, ' +
  'call export_estimate to save and get the shareable URL.';

exports.EXPORT_ESTIMATE =
  'Export an estimate to calculator.aws and get a shareable URL. The link ' +
  'will show the full estimate with AWS-calculated pricing. Before saving, ' +
  'runs a static check against the payload. If the check detects the ' +
  'estimate would be broken, the export is refused with details explaining ' +
  'what to fix.';

exports.BUILD_ESTIMATE =
  `One-shot: create an estimate, add services, lint-preflight, save, and return the calculator URL. Replaces three separate calls (create_estimate + add_service + export_estimate). Returns {sharable_url, aws_estimate_id, services} on success.

IMPORTANT: Before calling this tool, you MUST confirm the desired AWS region with the user if they haven't already specified one. Do NOT assume a default region. Always include "region" in each service config. For AWS European Sovereign Cloud (ESC), use region "eusc-de-east-1" and pass partition "aws-eusc" when calling get_service_fields. ESC estimates must NOT mix with standard AWS regions — all services in an ESC estimate must use "eusc-de-east-1". 

IMPORTANT: For compute services (EC2, Fargate, Lambda, RDS, etc.), if the user hasn't specified a pricing model, suggest a cost-optimized option (e.g. Reserved Instances or Savings Plans for steady-state workloads, On-Demand for variable/short-lived) and ask the user to confirm before proceeding.

CRITICAL — DISCOVERY BEFORE ACTION: For any service you have not already inspected with get_service_fields in THIS SESSION, call get_service_fields FIRST. Some services need more fields than the schema marks as required — without them the estimate saves successfully but shows $0 cost (e.g. Lambda needs sizeOfMemoryAllocated, storageAmountEphemeral, and architecture to produce a non-zero price). Therefore, for curated services only, get_service_fields returns a catalog block: use its minimalConfig as your starting point (it is verified to produce a priced estimate), check traps[] for gotchas, and consult required[] for the full list of pricing-engine-required fields. Always start from minimalConfig and modify — do not guess fields from training data.

Use "description" to label what each service entry represents. Be careful, descriptions and group names must NOT contain <, >, or & characters (tool rejects them).

If any service fails validation, returns a structured needs_field_grounding redirect pointing you at get_service_fields for the affected services (isError:false; not a hard failure — call get_service_fields and retry). If the pre-save check detects the estimate would be broken, the save is refused and an error is returned with per-service details explaining what to fix.

The estimate is kept in the in-memory store, so the returned aws_estimate_id can be passed to add_service/export_estimate to extend it.

For large estimates (20+ services / line items), prefer create_estimate + multiple add_service calls + export_estimate. This avoids token-generation limits and allows incremental building.` + ISSUES_HINT;

exports.IMPORT_ESTIMATE =
  'Download an existing AWS Pricing Calculator estimate by URL or ID. ' +
  'Returns the estimate in JSON (raw, for modifications like region swaps) ' +
  'or Markdown (for LLM consumption, summaries, funding recommendations). ' +
  'Use JSON format when you need to modify and re-export the estimate; ' +
  'use Markdown format when summarizing or presenting costs to the user.';
