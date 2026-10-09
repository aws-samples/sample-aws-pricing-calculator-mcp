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
  'the codes in `child_service_codes` and use that instead. ' +
  'If the response includes a `freeTierChoice` object, the service offers an AWS ' +
  'Free Tier template choice (e.g. AWS Lambda): you MUST ask the user whether to ' +
  'include or exclude the Free Tier, then pass the chosen template id as ' +
  '`estimateFor` on the add_service/build_estimate entry.';

exports.CREATE_ESTIMATE =
  'Create a new empty estimate. Returns an estimate ID to use with ' +
  'add_service and export_estimate.';

exports.ADD_SERVICE =
  `Add one or more AWS services to an estimate. Accepts a single service or a JSON array of services in the "services" parameter.

TEMPLATE / FREE TIER: Each entry may set an optional "estimateFor" template id to pick a specific pricing template. This is how you control the AWS Free Tier: services like AWS Lambda expose an include/exclude Free Tier template pair (surfaced as freeTierChoice by get_service_fields). When a service offers that choice you MUST ask the user whether to include or exclude the Free Tier and set "estimateFor" to the chosen template id — if you don't, it defaults to INCLUDING the Free Tier, which understates steady-state/production cost. When that default is applied the per-entry result carries a free_tier_choice object with the includeFreeTier/excludeFreeTier template ids so you can re-add with the user's choice.

Field values follow these patterns based on field type:
- numericInput: plain string value, e.g. "1000"
- frequency: object with value and unit, e.g. {"value": "19", "unit": "millionPerMonth"}
- fileSize: object with value and unit. The unit format is "{size}|{frequency}" where size comes from the field's validSizes (gb, tb, mb, etc.) and frequency is usually "NA". Check the field's defaultUnit from get_service_fields. Examples: {"value": "512", "unit": "mb|NA"}, {"value": "1", "unit": "tb|NA"}, {"value": "10", "unit": "gb|NA"}, {"value": "8", "unit": "gb|month"}
- dropdown: string matching one of the option IDs from get_service_fields
- durationInput: object with value and unit, e.g. {"value": "960", "unit": "min"}

IMPORTANT: Before calling this tool, you MUST confirm the desired AWS region with the user if they haven't already specified one. Do NOT assume a default region. Always include "region" in each service config. For AWS European Sovereign Cloud (ESC), use region "eusc-de-east-1" and pass partition "aws-eusc" when calling get_service_fields. ESC estimates must NOT mix with standard AWS regions — all services in an ESC estimate must use "eusc-de-east-1". 

IMPORTANT: For compute services (EC2, Fargate, Lambda, RDS, etc.), if the user hasn't specified a pricing model, suggest a cost-optimized option (e.g. Reserved Instances or Savings Plans for steady-state workloads, On-Demand for variable/short-lived) and ask the user to confirm before proceeding.

IMPORTANT: For EC2 Dedicated Hosts, do NOT use "amazonEc2DedicatedHosts" — use service code "ec2Enhancement" with tenancy: "host" in the config. This produces the full Dedicated Host estimate with EBS storage, pricing strategies, and data transfer. Storage fields are automatically mapped to DH-suffixed variants (storageAmountDH, gp3IopsDH, etc.).

CRITICAL — DISCOVERY BEFORE ACTION: For any service you have not already inspected with get_service_fields in THIS SESSION, call get_service_fields FIRST. Some services need more fields than the schema marks as required — without them the estimate saves successfully but shows $0 cost (e.g. Lambda needs sizeOfMemoryAllocated, storageAmountEphemeral, and architecture to produce a non-zero price). Therefore, for curated services only, get_service_fields returns a catalog block: use its minimalConfig as your starting point (it is verified to produce a priced estimate), check traps[] for gotchas, and consult required[] for the full list of pricing-engine-required fields. Always start from minimalConfig and modify — do not guess fields from training data.

Use "description" to label what each service entry represents. Be careful, descriptions and group names must NOT contain <, >, or & characters (tool rejects them).

Config keys are validated against the service definition. Invalid field IDs will be rejected with suggested corrections.

For batch mode, pass a JSON array in "services":
[{"service":"aWSLambda","instance":"Compute","group":"Prod","config":{...}},{"service":"amazonS3Standard","group":"Prod","config":{...}}]

Groups support nested hierarchies using "/" as separator (e.g. "Production/Backend", "Production/Database"). The calculator will render them as nested folders.

SUB-SERVICE CARD GROUPING: for sub-service-selector families (AWS Backup, S3 storage classes, VPC's TGW/VPN/NAT, ELB's ALB/NLB, DynamoDB, Glue, SageMaker, Bedrock, ...), the "instance" field controls how children map to calculator cards. Children that share the same "instance" (including the default of none) collapse into ONE card; children with distinct "instance" values become SEPARATE cards. So to reproduce N independent cards of the same family — e.g. two AWS Backup vaults, or several S3 Standard buckets — give each line item a unique "instance" (e.g. "instance":"vaultA" / "vaultB"). Omitting "instance" keeps the legacy single-card behavior. This matters when re-creating an imported estimate: assign one "instance" per source card so the saved shape (card count, per-card cost, editability) matches the original.

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

TEMPLATE / FREE TIER: Each entry may set an optional "estimateFor" template id to pick a specific pricing template. Services like AWS Lambda expose an include/exclude Free Tier template pair (surfaced as freeTierChoice by get_service_fields). When a service offers that choice you MUST ask the user whether to include or exclude the Free Tier BEFORE building and set "estimateFor" accordingly — otherwise it defaults to INCLUDING the Free Tier, which understates steady-state/production cost. When the default is applied, the service's result carries a free_tier_choice object with the includeFreeTier/excludeFreeTier template ids.

IMPORTANT: Before calling this tool, you MUST confirm the desired AWS region with the user if they haven't already specified one. Do NOT assume a default region. Always include "region" in each service config. For AWS European Sovereign Cloud (ESC), use region "eusc-de-east-1" and pass partition "aws-eusc" when calling get_service_fields. ESC estimates must NOT mix with standard AWS regions — all services in an ESC estimate must use "eusc-de-east-1". 

IMPORTANT: For compute services (EC2, Fargate, Lambda, RDS, etc.), if the user hasn't specified a pricing model, suggest a cost-optimized option (e.g. Reserved Instances or Savings Plans for steady-state workloads, On-Demand for variable/short-lived) and ask the user to confirm before proceeding.

IMPORTANT: For EC2 Dedicated Hosts, do NOT use "amazonEc2DedicatedHosts" — use service code "ec2Enhancement" with tenancy: "host" in the config. This produces the full Dedicated Host estimate with EBS storage, pricing strategies, and data transfer. Storage fields are automatically mapped to DH-suffixed variants (storageAmountDH, gp3IopsDH, etc.).

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
  'use Markdown format when summarizing or presenting costs to the user. ' +
  'Accepts a full estimate URL or a bare ID. If the user gave you a URL, pass the ' +
  'whole URL rather than reducing it to the ID — the domain identifies which ' +
  'calculator stores the estimate (standard calculator.aws vs European Sovereign ' +
  'Cloud pricing.calculator.aws.eu). A bare ID is always read from the standard ' +
  'calculator, so an ESC estimate is only importable as its full ' +
  'pricing.calculator.aws.eu URL.';

exports.GET_ESTIMATE_COST =
  'Hydrate a saved AWS Pricing Calculator estimate in a headless browser and return the ' +
  'calculator-computed costs: the summary monthly_cost plus per-service rows (service, monthly, ' +
  'config). Use this when you need the ACTUAL rendered cost of an estimate — import_estimate ' +
  'returns the saved configuration but does not reliably carry a computed cost, because the ' +
  'calculator does the pricing math in the browser. Accepts a full estimate URL or a bare id ' +
  '(a bare id is read from the standard calculator.aws; pass the full pricing.calculator.aws.eu ' +
  'URL for an ESC estimate).\n\n' +
  'The summary monthly_cost is authoritative; a per-row value can render stale/$0 until the ' +
  'calculator recomputes, so when rows_total disagrees with monthly_cost a "note" field is ' +
  'returned and you must NOT attribute per-row costs.\n\n' +
  'ON-DEMAND DEPENDENCY: this tool requires Playwright AND the Chromium browser binary, which ' +
  'are NOT installed by default (Chromium is a ~150MB download). The tool checks for them first ' +
  'and, when either is missing, returns cost_available:false with reason and the exact ' +
  'install_commands instead of failing. Do NOT install them silently — surface the commands and ' +
  'ask the user to confirm before running them, then retry.' + ISSUES_HINT;
