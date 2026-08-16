# Changelog

All notable changes to the AWS Pricing Calculator MCP server are documented here.

## [1.3.0] - 2026-08-16

Merges upstream `aws-samples` 1.2.4–1.2.9. Minor rather than patch
because two changes are visible to consumers: `lib/` module paths moved
(below), and the new `ec2-pricing-invalid-value` lint predicate refuses
saves that 1.2.9 accepted.

### Changed

- **`lib/` regrouped into subdirectories** — the flat `lib/*.js` layout
  became `lib/aws/` (`aws-client`, `ec2`, `estimate-builder`,
  `agent-fields`, `pct-config`, `surfaceability`), `lib/lint/`
  (`can-rehydrate`, `can-rehydrate-fetch`, `catalog`, `lint-hints`,
  `validation`), `lib/mcp/` (`handler-helpers`, `tool-descriptions`),
  `lib/store/` (`estimate-store`, `estimate-store-dynamodb`), and
  `lib/trace/` (`trace-logger`, `trace-events`, `request-context`).
  Pure moves — no behavior change — but **breaking for anything
  requiring `lib/*.js` paths directly**; e.g. `lib/ec2.js` is now
  `lib/aws/ec2.js`. The MCP tool surface is unaffected, as is the
  bundled `dist/mcp-server.js`. `lib/dom-cost.js` stays at the root:
  it is a validation oracle, not part of any of the five groups.

### Fixed

- **EC2 pricingStrategy no longer silently falls back to On-Demand /
  1 Year** (`lib/aws/ec2.js`). Agent report 2026-08-12: object-form
  `pricingStrategy: {"model": "EC2 Instance Savings Plans", "term":
  "3 Year"}` saved as `selectedOption: "on-demand"`, `term: "1 Year"`
  — a valid-looking estimate with wrong pricing, and every tool call
  returned success. Three distinct silent-mismatch paths, all fixed:

  1. **Object-form model skipped normalization.** Only the string
     path had alias/fuzzy matching; the object path passed `model`
     through verbatim into `SELECTED_OPTION[model] || 'on-demand'`.
     The paths now share one resolver (`resolveModel`) covering
     aliases, display labels ("EC2 Instance Savings Plans"), the
     catalog-documented `"standard"` spelling, and saved-blob
     `selectedOption` forms (`"instance-savings"`).
  2. **Full-word terms degraded.** `term === '3yr' ? '3 Year' :
     '1 Year'` turned the catalog's own documented `"3 Year"` into a
     1-year commitment. `resolveTerm` now accepts `1yr`/`3yr`,
     `1 Year`/`3 Years`, bare `1`/`3`, any case. Omitted terms default
     to `3 Year` (upstream 1.2.9 decision, kept on merge); present-but-
     unresolvable terms fail fast.
  3. **The `|| 'on-demand'` fallback is gone.** Anything unresolvable
     (model, term, upfrontPayment) throws with the valid values
     listed. `validateConfigKeys` runs the same check at add_service
     time via the new `validatePricingStrategy` export, so agents get
     the rejection on the first call, not a wrong estimate.

  Discovery surface: `get_service_fields` now carries `validModels`
  / `validTerms` / `validUpfrontPayments` directly on the
  `pricingStrategy` field (agent-fields enrichment) instead of only
  in catalog trap prose; the ec2Enhancement catalog hint/traps were
  rewritten to match the enforced contract (the old text documented
  formats the code didn't accept). Regression locks: 4 new eval
  scenarios (`ec2-pricing-object-display-label` with a cost-band
  oracle excluding both $0 and on-demand, `ec2-pricing-term-full-word`,
  `ec2-pricing-model-standard-dedicated`,
  `ec2-pricing-string-display-label-control`) + 14 unit tests.

  Defense-in-depth: new **`ec2-pricing-invalid-value` lint predicate**
  (`lib/lint/can-rehydrate.js`) fires (required-input) when a saved
  ec2Enhancement blob carries a `pricingStrategy.value` whose
  `selectedOption` / `term` / `upfrontPayment` is outside the
  calculator's accepted enums — the bypass-path backstop for
  `import_estimate` of hand-edited blobs and external construction,
  the same role `column-form-unremapped-value` plays for the remap
  fix. Only checks keys present in the envelope (on-demand envelopes
  without `upfrontPayment`, utilization-only shapes stay silent) and
  is scoped to ec2Enhancement. Paired `lint-hints` recovery text
  shows the accepted object form.

- **Every calculator HTTP call now has a timeout and bounded retry**
  (new `lib/aws/fetch-resilience.js`, wired into the six GETs and the
  save POST in `lib/aws/aws-client.js`). Mitigates
  [#7](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/issues/7):
  repeated `fetch failed` / `ECONNRESET` against all three CloudFront
  distributions on Windows 11 / Node 22, where `curl` on the same host
  worked.

  **The root cause is still unknown, and this release does not claim
  otherwise.** Two theories were probed and both fail on the evidence:
  the reporter's CloudFront-WAF-fingerprints-undici theory does not fit
  their own repro (a fingerprint block rejects request *#1*, theirs
  failed only after several successes), and the competing stale-keep-
  alive-socket theory does not hold either (these distributions
  advertise no Keep-Alive timeout, and undici socket reuse after a 9s
  idle gap succeeds). The symptom did not reproduce on macOS.

  What was never in doubt is the defect underneath it: **no call site
  had a timeout or a retry**, so one transient reset was an
  unrecoverable tool failure and a stalled socket hung the MCP tool
  forever with no path for the agent to recover. That is what is fixed
  — 3 attempts with exponentially-backed-off jittered delays, 30s
  timeout, retry only on socket-level errors. HTTP statuses are a real
  answer from the server and pass straight through; retrying a 400
  from the save API would only replay a payload rejected on its merits.

  `POST /saveAs` retries too, but on a **smaller budget (2 attempts)**
  and it is the one genuinely debatable call in this change. The POST is
  not idempotent — it mints a fresh `estimateId` per call — so a network
  error raised *after* the lambda accepted the body is ambiguous, and the
  re-attempt may leave a duplicate blob server-side.

  It was initially excluded for exactly that reason, and that was wrong:
  #7's headline symptom was `export_estimate` failing, i.e. this exact
  call, so excluding it would have hardened the six read paths and left
  the one that actually broke unprotected. The cost of being wrong is
  asymmetric. A duplicate blob is unreachable (nobody holds its URL),
  belongs to no estimate, and inflates no cost — unlike a duplicate
  `add_service` entry, which silently inflates the total by the price of
  the service. A save that fails on a transient reset is a real
  user-visible failure. Cheap orphan beats lost save.

  Every re-attempt emits a new **`save.retry`** trace event carrying
  `mayHaveOrphaned: true`, the error code, and the local `estimateId`, so
  the orphans stay attributable after the fact rather than being
  invisible. 28 unit tests pin the contract, 5 of them driving
  `saveEstimate` against a stubbed `fetch` (no estimate is actually
  saved) to cover retry, the attempt cap, the `save.retry` payload, and
  the no-retry-on-HTTP-400 case.

### Security

- Dependency bumps, superseding dependabot
  [#30](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/30),
  [#31](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/31),
  and [#32](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/pull/32):
  `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 (direct),
  `ip-address` 10.2.0 → 10.5.0 and `hono` 4.12.32 → 4.13.2 (both
  transitive, lockfile only). `npm audit` reported 0 vulnerabilities
  before and after — these are currency bumps, not CVE fixes.

### Investigated, not changed

- **[#13](https://github.com/aws-samples/sample-aws-pricing-calculator-mcp/issues/13)
  (sub-service rows render `$0`) is not reproducible as a save-payload
  bug and needs no code change here.** Recording the evidence so nobody
  re-derives it: on the reporter's own estimate, 10/10 drill-in rows
  show `0.00 USD` while the group total is correct ($80,943.91). Two
  candidate causes were tested and both refuted. (a) *Envelope shape* —
  the builder already collapses multi-child sub-services into one
  envelope as of `158f974` (2026-05-15), which **predates the report**;
  a freshly-saved, correctly-shaped estimate
  (`7200827712498e3329dbd014d4a262ab444626cd`, 1 envelope / 3
  subServices) still renders $0. (b) *Grouping* — an ungrouped control
  (`571560fab77a50eca687a0dd7b0d517ffa044dea`) renders the service row
  at $0 too, with a correct $18,122.90 summary.

  So the calculator computes the cost correctly and simply does not
  paint it into the per-service row until an interaction — client-side
  render gating, not something the save payload controls (consistent
  with the already-known Lambda/VPC asymmetry). **The summary total is
  authoritative; per-row values may need an Update click.** The
  reporter most likely ran a build predating `158f974`.

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