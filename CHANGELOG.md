# Changelog

All notable changes to the AWS Pricing Calculator MCP server are documented here.

## [1.2.9] - 2026-08-04

- Improved instructions for import_estimate tool to handle ESC urls
- Fixed a TOCTOU race in `loadCatalog` that could crash startup with `ENOENT` when a catalog file was removed mid-scan (concurrent edit/deploy or parallel tests). Stale listing entries are now skipped.
- Fixed [Bug #33](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/issues/33)

## [1.2.8] - 2026-07-28

- New/updated catalog entries for StepFunction, Cognito, FsX Lustre

## [1.2.7] - 2026-07-13

- Added [MCP tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- Set 10mb limit for express [#PR23](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/23)

## [1.2.6] - 2026-07-09

- Fixed Bug [RDS Oracle](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/issues/22)

## [1.2.5] - 2026-07-07

- **EC2 Dedicated Host support** — full estimate generation for host-tenancy configurations via `ec2Enhancement` with `tenancy: "host"`:
  - Added `standard` to `MODEL_ALIASES` and `SELECTED_OPTION` in `lib/ec2.js`. AWS Pricing Calculator uses `standard` (not `reserved`) for Dedicated Host Reservations; without this mapping the pricing model fell back to On-Demand.
  - Mapped all Dedicated Host EBS storage fields (`storageTypeDH`, `storageAmountDH`, `gp3IopsDH`, `gp3ThroughputDH`, `iopsDH`, `iops2DH`) in `lib/ec2.js`. Regular storage fields are automatically promoted to DH variants when `tenancy: "host"` and suppressed from the payload.
  - Exempted `tenancy`, `vcpu`, `physicalCores`, and all DH storage fields from unknown-field validation in `lib/validation.js` (EC2-scoped). These fields are consumed by the EC2 transform or included by the calculator in saved payloads but are not in the public input schema.
  - Added tool-description hint steering agents to `ec2Enhancement` + `tenancy: "host"` instead of the limited `amazonEc2DedicatedHosts` service.

## [1.2.4] - 2026-06-25

- Added **`column-form-tuple-invalid` lint predicate** - validates columnFormIPM selector tuples against the region's `primary-selector-aggregations.json`. Catches silent, region-dependent mispricing: e.g. WorkSpaces Core `Windows + BYOL` rendered $0 in eu-west-1 and ~$35K (license-included rate) in il-central-1. Both wrong; the predicate fires read-only on both. Reverse-maps through `remap.keyValue` and resolves region codes to location labels via city-parenthetical matching.
- Added **`column-form-unremapped-value` lint predicate** - defense-in-depth backstop: fires read-only when a saved columnFormIPM cell holds an un-remapped selector value (a `remap.keyValue` key that leaked past the builder).
- Added **`workspaces-core-minimal` eval scenario** - regression lock asserting `estimate_renders_cost >= $1000` for WorkSpaces Core sub-service save path.
- Fixed **columnFormIPM** `remap.keyValue` - is now applied at build time. The script was saving raw selector values, but the calculator expects remapped values (e.g. `"Windows"` → `"WorkSpaces Core Windows"`, `"AlwaysOn"` → `"Monthly"`). Any remap-bearing service rehydrated read-only at $0. `lib/estimate-builder.js` now translates cell values through `remap.keyValue` after validation, for both top-level and sub-service columnFormIPM services. Agent contract unchanged — agents still pass selector values from `get_service_fields`.

## [1.2.3] - 2026-06-19

- Improved hint for EC2 pricing strategies & EC2 data transfer

## [1.2.2] - 2026-06-17

- Fixed bug in `amazonElasticBlockStore` using wrong format for throughput (new catalog entry)
- Fixed `aWSDataTransfer` using wrong format (new catalog entry)
- (Experimental) Support for AWS European Sovereign Cloud https://pricing.calculator.aws.eu/
- Added a hint to batch larger estimates (use `add_service` instead of `build_estimate`) - inspired by [PR17](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/17)
- Added support for nested groups - as per [PR15](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/15)

## [1.2.1] - 2026-06-16

- Fixed bug NAT Gateway vs. regional NAT Gateway ambiguity
- Added evaluation of `minValue`, `maxValue`, `allowDecimals`

## 1.2.0 — 2026-06-14

### Added

- **Two new MCP tools**:
  - `validate_estimate` — dry-run preflight that builds the would-be
    saved payload and runs the rehydration linter against it, without
    calling the AWS save API. Returns `{lint_verdict, next_step,
    lint_services, would_be_payload}` so an agent can confirm an
    estimate would render before paying the round-trip.
  - `build_estimate` — one-shot create + add-services + lint + save in
    a single call. Returns the shareable URL on success, or a
    structured envelope identifying which services need field
    discovery (`get_service_fields`) before retry.

- **Static rehydration linter** (`lib/can-rehydrate.js`) — pure
  predicate library that runs against the would-be saved blob to
  predict whether the calculator will render it editable. Refuses
  saves that would render read-only (template missing, sub-service
  shape errors, mutually-exclusive options both set, value-shape
  problems) or required-input (declared-required fields missing).
  Failures carry agent-actionable hints (`lib/lint-hints.js`)
  pointing the LLM at the specific recovery: which field to set,
  which option to swap, which service to redirect.

- **Curated service catalog** (`catalog/services/*.json`, 16 verified
  entries) — per-service hints declaring the smallest config that
  produces a priced editable estimate, pricing-engine-required fields
  the manifest underflags, gotcha notes (`traps[]`), sub-service
  routing for parent envelopes, and product-code redirects (e.g.
  Bedrock model parents → child model code). The catalog is loaded
  at runtime from per-service JSON files; a JSON Schema in
  `catalog/schema.json` validates entries.

- **Optional HTTP transport** (`MCP_TRANSPORT=http`) — opt-in
  alternative to the default stdio transport, for hosted deployments
  that need an HTTP entry point. Stdio remains the default; existing
  local clients (Claude Desktop, Kiro, Cursor, VS Code) work
  unchanged.

- **Pluggable estimate store + DynamoDB backend**
  (`lib/estimate-store.js`, `lib/estimate-store-dynamodb.js`) —
  selectable via `ESTIMATES_STORE` env var. The default in-memory
  store keeps the local developer experience unchanged (no AWS
  account needed); the DynamoDB store enables stateless multi-replica
  deployments where in-flight estimates must survive process
  restarts and round-robin routing across replicas.

- **Ambiguity rejection in `findService`** — short generic queries
  like `"RDS"` or `"S3"` now return a candidate list instead of
  silently grabbing an unrelated backup or archival service. A
  unique exact-name match still resolves; multiple partial matches
  surface the candidates so the caller can pick.

- **Scenario-driven eval harness** (`eval/`) — 87 YAML scenarios
  driving either scripted MCP calls (fast, AWS-free) or an
  LLM-driven agent (Bedrock Haiku) against the same predicate
  library. Predicates assert outcomes on the saved blob:
  `estimate_renders_cost` (Playwright DOM scrape of the calculator's
  rendered total), `saved_blob_field_equals` (structural assertion
  on what the agent actually saved), `validate_must_pass`
  (refuse-on-lint check). The harness also pairs `with-catalog` vs
  `without-catalog` scenarios so a maintainer can verify whether each
  catalog entry earns its place via cost-magnitude drift.

- **Structured trace events** (`lib/trace-logger.js`,
  `lib/trace-events.js`) — one JSON line per event on stderr, off by
  default, enabled with `TRACE=1`. Covers tool invocations
  (`tool.call`/`tool.result`), save round-trips
  (`save.send`/`save.ok`/`save.fail`), lint outcomes
  (`lint.refused`/`lint.passed`), and session boundaries
  (`session.start`). Designed for ingestion by downstream
  observability — stable event names, structured fields, no
  human-prose mixed into the JSON payload.

- **Build pipeline** — `npm run build` produces a single-file
  esbuild bundle at `dist/mcp-server.js` plus `dist/aws-calculator.zip`
  (the bundle plus the catalog files and a few runtime libs zipped
  for hosted deployment). `dist/bundle-contract.json` describes the
  bundle's environment-variable surface (6 vars: `ESTIMATES_STORE`,
  `ESTIMATES_TABLE`, `ESTIMATES_TTL_SECONDS`, `MCP_TRANSPORT`,
  `TRACE`, `TRACE_RESULT_TEXT_MAX`) so downstream consumers can
  typecheck their CDK/Terraform against the actual surface.

### Changed

- **`export_estimate` now refuses to save** when the static
  rehydration linter predicts the resulting blob would render
  read-only or required-input. Previously, every call returned a
  shareable URL regardless of whether the resulting estimate would
  render. Callers should check the response shape: a successful
  save returns the URL as before; a refused save returns
  `{lint_verdict: 'read_only'|'required_input', next_step: ...}`
  with an actionable recovery hint. Use the new `validate_estimate`
  tool to preflight before calling `export_estimate` if you want to
  separate validation from save.

- **`add_service` now validates field IDs and values** against the
  live service definition, catching dropdown options that don't
  exist, fileSize unit format errors, numeric/frequency type
  mismatches, and unsupported region/service pairs. Unambiguous
  mistakes (case mismatches, single-character typos, number-to-string
  coercion) are auto-corrected and surfaced via a new `corrections`
  array on the per-service result. Calls that would have silently
  created a malformed estimate now either succeed with corrections
  applied or return a structured error pointing at the offending
  field.

- **`add_service` returns a `partial: true` warning** when the
  catalog or manifest declares required fields the agent omitted.
  The entry still registers, but the agent sees on the same call
  that more discovery is needed — rather than learning during a
  later `validate_estimate` or `export_estimate`.

- **`get_service_fields` redirects deprecated parent shells** to the
  verified child service code via a `redirect_to_parent` envelope
  (e.g. `amazonS3` → `amazonS3Standard`). The envelope includes the
  child code and a preview of its fields. For curated services, the
  response also gains a `catalog` block with `minimalConfig`,
  required-field hints, and `traps[]`.

- Inspired by PRs [#5](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/5) and[#6](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/6), replaced the BDD/Playwright `validation/` suite by the static rehydration linter (`lib/can-rehydrate.js`) and the
  scenario-driven eval harness (`eval/`).

### Known limitations

- The lint predicates are static — they catch read-only and
  required-input failures observable from the saved blob shape, but
  cannot evaluate runtime-only failure classes (math/expression
  errors during pricing recalculation, `columnFormIPM` "Best Match"
  failures against the live pricing index). The DOM cost oracle is
  the runtime backstop for those.

- The DOM cost oracle requires Playwright + Chromium; deployment
  runtimes without a browser can run the lint and trace events but
  cannot run the cost oracle.

- Catalog coverage is partial (16 verified entries against ~436
  manifest services). Uncatalogued services still benefit from the
  lint and trace events — they just don't get the
  magnitude-calibration role the catalog's `minimalConfig` plays for
  cataloged services.

## [1.1.0] - 2026-05-14

Overall improved validation and error handling

- The LLM no longer needs to construct complete payload structures, just passes provided key-value pairs instead
- Validation runs at add-time (not export-time), giving the LLM immediate feedback on errors.
- Field ID validation with Levenshtein-based "Did you mean?" suggestions for typos.
- Dropdown values: accepts labels (e.g. "Redis OSS") and resolves to option IDs automatically.
- Region validation against known AWS region codes.
- Default injection: fields with defaultValue/defaultDropDownItem in the service definition are auto-filled when not provided.
- Disabled fields (isDisabled: true) are now filtered from extractInputFields — the LLM never sees read-only fields.
- Improved service key resolution by display name: add_service now accepts service names (e.g. "AWS Lambda", "DynamoDB on-demand") in addition to exact keys.
- Added optional HTTP transport (`MCP_TRANSPORT=http`) for hosted deployments (multi-replica HTTP, container runtimes). Defaults to stdio so existing MCP clients are unaffected.
- Fixed HTTP transport reconnection on persistent connections — calls `server.close()` between requests so the second tool call no longer fails with "Already connected to a transport" on long-lived containers.
- Added pluggable estimate store (`ESTIMATES_STORE` env var: `memory` default or `dynamodb`). Enables stateless deployments where requests may land on different processes. AWS SDK is an optional peer dependency, externalized at build time so the default bundle size is unchanged.
- Added `EstimateBuilder.toJSON()` / `EstimateBuilder.fromJSON()` for serialized round-trip through any store.
- Refactored validation helpers into `lib/validation.js` so unit tests exercise the shipping code instead of a copy.
- Added end-to-end roundtrip integration tests (build → save → fetch → field-by-field compare) for Lambda, grouped EC2, and the SNS subService write path.
- Test count grew from 70 to 95.

## [1.0.2] - 2026-05-13
- Added to npm https://www.npmjs.com/package/sample-aws-pricing-calculator-mcp
- Added quick install button (Kiro, Cursor, VS Code)

## [1.0.1] - 2026-05-13
- Fixed Bug: Proper support for nested Structures e.g. Elasticache, RDS, Bedrock, ALB
- Fixed Bug: EC2/EBS iops, throughput not recognized
- Enriched field metadata with allowed values, also validates upon submission - yet dependencies are not resolved
- Costs are now displayed on initial load - however pressing 'Update estimate' is recommended
- Supports importing/reading estimates
- Dependencies updated
- Removed dead code
- Version info added (get_server_info)

## [1.0.0] - 2026-04-30
- Initial Release