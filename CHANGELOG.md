# Changelog

All notable changes to the AWS Pricing Calculator MCP server are
documented here.

## Unreleased

### Added

- **`column-form-tuple-invalid` lint predicate** (`lib/can-rehydrate.js`)
  — validates a saved columnFormIPM row's full selector tuple against
  the region's `primary-selector-aggregations.json` (the calculator's
  own authoritative set of valid selector combinations). Catches a
  silent, region-dependent mispricing class the other oracles miss:
  WorkSpaces Core with `Operating System: Windows` + `Bring Your Own
  License` is a non-canonical tuple (canonical BYOL uses OS `Any`).
  Nothing rejected it, and it failed *silently and differently per
  region* — in il-central-1 it rendered $35,640/mo (the license-
  *included* rate, a ~53% overcharge — BYOL ignored), in eu-west-1 it
  rendered **$0** (the reported bug). Both wrong; neither blank nor an
  error. The predicate fires read-only on both.

  Mechanics worth recording: the saved blob stores *remapped* values
  (`"WorkSpaces Core Windows"`) but the aggregation file uses *selector*
  values (`"Windows"`), so the predicate reverse-maps via the
  component's `remap.keyValue` before comparing. Region resolution is
  the fragile part — the aggregation URL keys on a Location *label*
  (`"EU (Ireland)"`) that differs from the blob's `regionName`
  (`"Europe (Ireland)"`), and columnFormIPM services are sub-services
  carrying only the region *code* (`eu-west-1`), no label at all. So
  resolution goes code → `REGIONS[code]` name → parenthetical *city* →
  match against the service's `metadata.json` `regionAttributes.Location`
  labels. This self-corrects per service and survives the Europe-vs-EU
  prefix mismatch. New side-channel `loadSelectorAggregations`
  (`lib/aws-client.js`) is best-effort and skips cleanly when offline /
  unresolvable, so it never false-positives. Verified end-to-end: fires
  on the real broken estimate (eu-west-1 Windows+BYOL → $0) and on the
  il-central-1 overcharge variant; silent on canonical Any+BYOL.

  Caveat surfaced during the build: an aggregation *(OS, License)* pair
  can appear region-wide while the *full* tuple (with Bundle/volumes)
  does not — so the check must match the full tuple, not the pair. A
  pair-only check would have missed this.

- **`column-form-unremapped-value` lint predicate**
  (`lib/can-rehydrate.js`) — defense-in-depth backstop for the remap
  fix below. Fires read-only when a saved columnFormIPM cell holds a
  value that is a *key* in the def's `remap.keyValue` (and not also a
  mapped value — a guard against false positives), i.e. an un-remapped
  selector value that leaked past the builder via `import_estimate`,
  external blobs, or a future uncovered service. The builder fix is the
  cure; this catches bypasses. No-op for services without a remap
  block.

- **`workspaces-core-minimal` eval scenario** — scripted regression
  lock asserting `estimate_renders_cost >= $1000` (pre-fix this
  rendered $0). First end-to-end coverage of the WorkSpaces Core /
  parent-envelope sub-service save path.

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
     `1 Year`/`3 Years`, bare `1`/`3`, any case.
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

- **columnFormIPM `remap.keyValue` is now applied at build time.** The
  calculator stores the *remapped* selector value in a saved estimate
  (the service def's columnFormIPM component carries a
  `remap.keyValue` map of selector→stored value), and the pricing
  engine reads that stored form back. The builder was saving the raw
  selector value the agent picked, so any remap-bearing service
  rehydrated **read-only at $0**. WorkSpaces Core was the reported
  case: `Operating System: "Windows"` must save as
  `"WorkSpaces Core Windows"`, and Running Mode `selectedId:
  "AlwaysOn"` as `"Monthly"`. `lib/estimate-builder.js` now translates
  cell values (plain cells and the utilization `selectedId`) through
  `remap.keyValue` before constructing the payload, for both top-level
  and sub-service columnFormIPM services. The agent contract is
  unchanged — agents still pass the selector values `get_service_fields`
  exposes; `validateConfigKeys` still validates those selector values;
  the remap happens after validation, so no validator change was
  needed.

  How it was found, and the dead ends (git shows the fix, not the
  search): the report was "calc link is read-only." The static linter
  said `editable` — a false negative — so reproduction required the
  DOM-cost oracle (the only oracle that sees read-only/$0). Five
  single-field fixes failed in a row: correcting the utilization
  `selectedId` to the def default `"Monthly"`, then to the selector
  value `"AlwaysOn"`, then re-keying the cell `"undefined"`→`"Running
  Mode"`, then `OS=Any`, then both together. Each stayed $0. The block
  was methodology: every attempt reconstructed the blob by hand from
  the service def. The fix came from diffing against a **calculator-
  produced reference blob** (saved through the real UI), which revealed
  the values were *remapped* — invisible from the def's selector lists
  and from `primary-selector-aggregations.json`, both of which expose
  selector (un-remapped) values. There was no WorkSpaces catalog entry
  or eval scenario, so this service path had never been validated
  end-to-end. Verified after the fix: agent passes selector values →
  lint editable → renders ~$23,328/mo BYOL (matches the ~$26K estimate
  that prompted the report) and ~$35,640/mo Included, vs. $0 before.

  Two shape facts corrected along the way: (1) the columnFormIPM
  utilization cell is keyed by its row `selectorId` when the row has
  one (WorkSpaces Core: `"Running Mode"`), and only by the literal
  `"undefined"` for rows without a selectorId (RDS-style) — the prior
  value-shape hint hard-coded `"undefined"` universally. (2) AppStream
  (the second service in the same estimate) also carries a remap
  (`Multi Session: false→False`), so the generic builder fix covers it
  too.

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