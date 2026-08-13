# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""
Reusable assertion predicates for evaluating MCP server behavior.

Each predicate takes a TraceResult (the captured output of one scenario
run) plus its expected value, and returns an AssertionOutcome
(`ok | fail | skip` + a human-readable reason).

Predicates are intentionally pure: they don't fetch anything, don't
reach into the MCP client, don't mutate state. The driver is
responsible for producing a TraceResult; predicates score it.

Two consumers today:
- eval/run.py (this repo) — drives mcp-server.js over stdio, asserts
  with these predicates.
- A downstream deployment harness — drives the hosted MCP server over
  HTTPS, asserts with the same predicates so behavioral assertions
  stay identical across transport boundaries.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


# ----- Result/outcome data shapes ----------------------------------------

@dataclass
class CallRecord:
    """One MCP tool call's input and parsed output, captured by the driver."""
    tool: str
    args: dict
    is_error: bool
    text: str  # the raw text returned in result.content[0].text
    parsed: Any = None  # JSON.parse(text), or None if not JSON


@dataclass
class TraceResult:
    """The full trace of one scenario run.

    `calls` is the ordered list of MCP tool calls the driver executed.
    `final_url` is set when an export_estimate / build_estimate succeeded.
    `events` (optional) is the structured trace events emitted by
    lib/trace/trace-logger.js, when the driver captures stderr.
    `assistant_messages` is the ordered list of plain-text content
    blocks the model emitted across the conversation (LLM scenarios
    only; empty for scripted runs). Captures reasoning between tool
    calls — useful for understanding why the agent chose a particular
    path or feature variant.
    """
    scenario_id: str
    calls: list[CallRecord] = field(default_factory=list)
    final_url: str | None = None
    events: list[dict] = field(default_factory=list)
    assistant_messages: list[str] = field(default_factory=list)
    duration_ms: int = 0


@dataclass
class AssertionOutcome:
    status: str  # 'ok' | 'fail' | 'skip'
    predicate: str
    reason: str = ''
    expected: Any = None
    actual: Any = None


# ----- Predicates ---------------------------------------------------------

def assert_save_succeeded(trace: TraceResult) -> AssertionOutcome:
    """Some path that produces a calculator URL ran cleanly.

    Either build_estimate returned a sharable_url, or export_estimate did.
    """
    if trace.final_url:
        return AssertionOutcome(status='ok', predicate='save_succeeded',
                                actual=trace.final_url)
    return AssertionOutcome(
        status='fail', predicate='save_succeeded',
        reason='no calculator URL captured from any tool call',
    )


def assert_export_refused(
    trace: TraceResult, *, contains: str | None = None,
) -> AssertionOutcome:
    """The most recent export_estimate call returned isError:true.

    Use to assert that exportWithLint refused (read-only or
    required-input verdict). Pairs naturally with `lint_verdict`
    to express the full contract: "lint produced verdict X, and
    export refused on it." When `contains` is given, the refusal
    text must include that substring — useful for asserting the
    refusal names the missing field by id.

    Skips when no export_estimate call appears in the trace.
    """
    exports = [c for c in trace.calls if c.tool == 'export_estimate']
    if not exports:
        return AssertionOutcome(
            status='skip', predicate='export_refused',
            reason='no export_estimate call in trace',
        )
    last = exports[-1]
    # nosemgrep: is-function-without-parentheses
    # is_error is a `bool` field on the CallRecord dataclass (line 37), not a method.
    if not last.is_error:
        return AssertionOutcome(
            status='fail', predicate='export_refused',
            expected='isError:true', actual='isError:false',
            reason=f'export_estimate succeeded; expected refusal. text={last.text[:200]}',
        )
    if contains is not None and contains not in last.text:
        return AssertionOutcome(
            status='fail', predicate='export_refused',
            expected=f'refusal text containing {contains!r}',
            actual=last.text[:200],
            reason=f'export refused but text did not contain {contains!r}',
        )
    return AssertionOutcome(
        status='ok', predicate='export_refused',
        actual='isError:true' + (f' contains={contains!r}' if contains else ''),
    )


def assert_no_tool_errors(trace: TraceResult) -> AssertionOutcome:
    """Every tool call returned isError:false.

    The needs_grounding nudge returns isError:false by design — that's
    a redirect, not an error — so this predicate stays clean for that
    bucket. True tool errors (validation failures, save 4xx, lint
    refusals on export) flip isError:true and fail this.
    """
    # nosemgrep: is-function-without-parentheses
    # is_error is a `bool` field on the CallRecord dataclass (line 37), not a method.
    errors = [c for c in trace.calls if c.is_error]
    if not errors:
        return AssertionOutcome(status='ok', predicate='no_tool_errors')
    return AssertionOutcome(
        status='fail', predicate='no_tool_errors',
        reason=f'{len(errors)} tool call(s) returned isError:true',
        actual=[c.tool for c in errors],
    )


def assert_lint_verdict(trace: TraceResult, expected: str) -> AssertionOutcome:
    """The most recent validate_estimate result has the given lint verdict.

    `expected` is one of: editable | required-input | read-only | unknown.
    Skips with reason if no validate_estimate call was made.
    """
    valid = {'editable', 'required-input', 'read-only', 'unknown'}
    if expected not in valid:
        return AssertionOutcome(
            status='fail', predicate='lint_verdict',
            reason=f'expected must be one of {valid}, got {expected!r}',
        )
    validates = [c for c in trace.calls if c.tool == 'validate_estimate']
    if not validates:
        return AssertionOutcome(
            status='skip', predicate='lint_verdict',
            reason='no validate_estimate call in trace',
        )
    last = validates[-1]
    actual = (last.parsed or {}).get('lint_verdict')
    if actual == expected:
        return AssertionOutcome(status='ok', predicate='lint_verdict',
                                expected=expected, actual=actual)
    return AssertionOutcome(
        status='fail', predicate='lint_verdict',
        expected=expected, actual=actual,
        reason=f'expected {expected!r}, got {actual!r}',
    )


def assert_trajectory_includes(
    trace: TraceResult, sequence: list[str], strict: bool = False,
) -> AssertionOutcome:
    """The given tool-name sequence appears in the trace.

    By default ('strict=False'), the sequence must appear in order but
    other tool calls can interleave. With strict=True, the sequence
    must appear contiguously.

    Use this to test trajectory hypotheses like
    `['get_service_fields', 'add_service']` — i.e. "the agent looked up
    fields before adding the service."
    """
    actual_tools = [c.tool for c in trace.calls]
    if strict:
        # Find sequence as a contiguous subsequence.
        for i in range(len(actual_tools) - len(sequence) + 1):
            if actual_tools[i:i + len(sequence)] == sequence:
                return AssertionOutcome(
                    status='ok', predicate='trajectory_includes_strict',
                    expected=sequence, actual=actual_tools,
                )
        return AssertionOutcome(
            status='fail', predicate='trajectory_includes_strict',
            expected=sequence, actual=actual_tools,
            reason=f'sequence {sequence} not found contiguously',
        )
    # Loose: each element appears in order, possibly with other calls between.
    j = 0
    for tool in actual_tools:
        if j < len(sequence) and tool == sequence[j]:
            j += 1
    if j == len(sequence):
        return AssertionOutcome(
            status='ok', predicate='trajectory_includes',
            expected=sequence, actual=actual_tools,
        )
    return AssertionOutcome(
        status='fail', predicate='trajectory_includes',
        expected=sequence, actual=actual_tools,
        reason=f'sequence {sequence} not found in order (matched {j}/{len(sequence)})',
    )


def assert_response_field_present(
    trace: TraceResult, tool: str, field_path: str,
) -> AssertionOutcome:
    """The most recent call to `tool` returned a JSON body with `field_path`.

    `field_path` is a dotted path into the parsed JSON, e.g. 'status' or
    'services_to_inspect.0'. Skips if the tool was never called.

    Useful for asserting the shape of the needs_grounding envelope:
        assert_response_field_present(trace, 'build_estimate',
                                      'services_to_inspect')
    """
    matching = [c for c in trace.calls if c.tool == tool]
    if not matching:
        return AssertionOutcome(
            status='skip', predicate='response_field_present',
            reason=f'no call to {tool} in trace',
        )
    body = matching[-1].parsed
    if body is None:
        return AssertionOutcome(
            status='fail', predicate='response_field_present',
            reason=f'last {tool} response was not JSON',
        )

    cur = body
    for part in field_path.split('.'):
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return AssertionOutcome(
                    status='fail', predicate='response_field_present',
                    expected=field_path,
                    reason=f'list index {part!r} not reachable',
                )
        elif isinstance(cur, dict):
            if part not in cur:
                return AssertionOutcome(
                    status='fail', predicate='response_field_present',
                    expected=field_path,
                    reason=f'key {part!r} not in response',
                )
            cur = cur[part]
        else:
            return AssertionOutcome(
                status='fail', predicate='response_field_present',
                expected=field_path,
                reason=f'cannot descend into {type(cur).__name__} at {part!r}',
            )
    return AssertionOutcome(
        status='ok', predicate='response_field_present',
        expected=field_path, actual=cur,
    )


def assert_max_tool_calls(trace: TraceResult, n: int) -> AssertionOutcome:
    """The trace contains at most `n` tool calls.

    Use as a cost guardrail when the LLM driver lands (Group D): a
    catalog miss might cost 12 tool calls; a healthy session ~3-5.
    """
    actual = len(trace.calls)
    if actual <= n:
        return AssertionOutcome(status='ok', predicate='max_tool_calls',
                                expected=n, actual=actual)
    return AssertionOutcome(
        status='fail', predicate='max_tool_calls',
        expected=n, actual=actual,
        reason=f'used {actual} tool calls, max {n}',
    )


def assert_estimate_renders_cost(
    trace: TraceResult, *,
    min_monthly_usd: float = 0.01,
    max_monthly_usd: float | None = None,
) -> AssertionOutcome:
    """The saved URL renders a non-zero monthly cost in calculator.aws.

    Closes the gap between "lint says editable + roundtrip ok" and
    "the rehydrated estimate computes a real cost." Catches the
    silent-$0 bug class — saved estimate that passes every other
    oracle but renders $0 in the browser because PCT-required is
    narrower than what the pricing engine actually needs — which is
    invisible to lint and roundtrip; only this oracle catches it.

    Reads the **summary total** at the top of the page (the "X.XX USD
    monthly" cell). The per-service detail rows are intentionally NOT
    asserted: in MCP-saved estimates the per-row column is render-
    inconsistent. Some services render priced on first load (e.g. EKS
    and Fargate did in estimate bfdefa4586976e6e…, 2026-05-31), while
    others stay at $0 indefinitely until the user clicks Update on the
    row (Lambda and the VPC NAT/TGW envelope did NOT, in the same
    estimate, with the same blob shape and lint editable). The saved
    blob in both cases lacks `serviceCost.monthly` — so per-row
    presence is NOT a function of save shape, and neither presence
    nor absence is a reliable signal of "did pricing succeed."

    Why is the per-row inconsistent for the same blob shape? Unknown.
    The pattern correlates roughly with pricing complexity (constants-
    only services render fast; services with tiered/free-tier math or
    async price-table fetches stay blank), but that's an inference
    from one probe, not a verified rule. Either way, it's a
    calculator-side render gating choice we don't control.

    The summary total IS computed on first render and is reliable —
    that's why this predicate keys on it.

    `min_monthly_usd` is a floor (default 1 cent). Set higher for
    scenarios that target specific cost magnitudes.

    `max_monthly_usd` is an optional ceiling — fail when the rendered
    cost exceeds it. Useful for paired catalog audit scenarios where
    the catalog's `minimalConfig` calibrates magnitudes (e.g. NAT's
    `regionalNatGatewayCount: 1` vs the manifest default of 5);
    without the catalog the agent may pick the wider default and
    over-estimate ~5x. Bounding both ends turns "the cost looks
    right" into a structured assertion.

    `actual` includes per-row breakdown (informational only) so CI
    logs preserve the asymmetry without enforcing it.

    Skips with reason if no final_url was captured.
    Cost data comes from lib/dom-cost.js via the Node bridge at
    eval/bin/csv-cost.js; requires Playwright (headless Chromium).
    """
    # Lazy import — Playwright only required when this predicate is used.
    from eval.csv_oracle import fetch_cost, CSVOracleError

    if not trace.final_url:
        return AssertionOutcome(
            status='skip', predicate='estimate_renders_cost',
            reason='no final_url in trace; predicate needs a saved URL',
        )

    try:
        cost = fetch_cost(trace.final_url)
    except CSVOracleError as e:
        return AssertionOutcome(
            status='fail', predicate='estimate_renders_cost',
            reason=f'CSV oracle error: {e}',
        )

    monthly = cost.get('monthlyCost')
    if monthly is None:
        return AssertionOutcome(
            status='fail', predicate='estimate_renders_cost',
            reason='no Estimate summary monthly cost in CSV',
        )
    per_service = ', '.join(
        f'{name}=${val}' for name, val in cost.get('monthlyByService', [])
    )
    actual = f'${monthly}/mo'
    if per_service:
        actual += f' (per-row: {per_service})'

    expected_band = f'>= ${min_monthly_usd}/mo'
    if max_monthly_usd is not None:
        expected_band = f'${min_monthly_usd}/mo to ${max_monthly_usd}/mo'

    if monthly < min_monthly_usd:
        return AssertionOutcome(
            status='fail', predicate='estimate_renders_cost',
            expected=expected_band,
            actual=actual,
            reason=f'rehydrate produced ${monthly}/mo, below floor ${min_monthly_usd}',
        )
    if max_monthly_usd is not None and monthly > max_monthly_usd:
        return AssertionOutcome(
            status='fail', predicate='estimate_renders_cost',
            expected=expected_band,
            actual=actual,
            reason=f'rehydrate produced ${monthly}/mo, above ceiling ${max_monthly_usd}',
        )
    # Per-row breakdown is informational only (see docstring). When
    # rows are render-lazy (the common case for programmatic saves)
    # they read $0 even when the summary is correct.
    return AssertionOutcome(
        status='ok', predicate='estimate_renders_cost',
        expected=expected_band,
        actual=actual,
    )


_FETCHED_BLOB_CACHE: dict[str, dict] = {}


def _fetch_saved_blob(estimate_id: str) -> dict:
    """Fetch the saved blob via the unauth GET endpoint.

    Caches per-id to amortize across multiple field assertions on the
    same scenario run. The endpoint is documented in
    project_get_endpoint_unauth memory.
    """
    if estimate_id in _FETCHED_BLOB_CACHE:
        return _FETCHED_BLOB_CACHE[estimate_id]
    import urllib.request
    url = f'https://d3knqfixx3sbls.cloudfront.net/{estimate_id}'
    # nosemgrep: dynamic-urllib-use-detected
    # nosec B310 - urllib.urlopen with hardcoded https host
    # Host is a fixed public AWS Pricing Calculator CDN; only the path
    # component varies. No file:// or custom-scheme injection vector since
    # the URL string is built with a hardcoded https://...cloudfront.net
    # prefix and only the estimate_id (a hex hash) is templated in.
    with urllib.request.urlopen(url, timeout=10) as resp:
        blob = json.loads(resp.read().decode('utf-8'))
    _FETCHED_BLOB_CACHE[estimate_id] = blob
    return blob


def _walk_path(blob: dict, path: str) -> tuple[bool, Any, str]:
    """Walk a dotted path through a JSON blob with two wildcard tokens.

    Tokens:
      - '*' inside a dict — try every key, return first that resolves.
      - '*' inside a list — try every index, return first that resolves.

    Returns (found, value, trace) where trace describes the path actually
    taken (useful for error messages).
    """
    cur = blob
    trace_parts = []
    for part in path.split('.'):
        if part == '*':
            if isinstance(cur, dict):
                # First child whose subpath resolves wins. We don't peek
                # ahead, so just take the first value here.
                if not cur:
                    return False, None, '.'.join(trace_parts) + '.*<empty-dict>'
                key = next(iter(cur))
                trace_parts.append(f'{{{key}}}')
                cur = cur[key]
            elif isinstance(cur, list):
                if not cur:
                    return False, None, '.'.join(trace_parts) + '.*<empty-list>'
                trace_parts.append('[0]')
                cur = cur[0]
            else:
                return False, None, '.'.join(trace_parts) + f'.*<not-iterable:{type(cur).__name__}>'
        elif isinstance(cur, list):
            try:
                idx = int(part)
                cur = cur[idx]
                trace_parts.append(f'[{idx}]')
            except (ValueError, IndexError):
                return False, None, '.'.join(trace_parts) + f'.{part}<bad-index>'
        elif isinstance(cur, dict):
            if part not in cur:
                return False, None, '.'.join(trace_parts) + f'.{part}<missing>'
            cur = cur[part]
            trace_parts.append(part)
        else:
            return False, None, '.'.join(trace_parts) + f'.{part}<not-descendable>'
    return True, cur, '.'.join(trace_parts)


def assert_saved_blob_field_equals(
    trace: TraceResult, *, equals: Any,
    path: str = None, paths: list = None,
) -> AssertionOutcome:
    """A specific field in the saved blob equals an expected value.

    Closes the gap that estimate_renders_cost can't: when workload and
    utilization compose multiplicatively, a wrong save can be exactly
    compensated by a different wrong field. The cost-band oracle passes
    while the saved blob structurally lies.

    Production case 2026-06-03 (estimate 7898fb2d65a09e...): user asked
    for 80% utilization; agent saved utilizationValue: '100' with no
    way for cost-band to discriminate. Local eval reproduced the
    workload-fudge variant (workload: 0.8, utilizationValue: 100) that
    happens to land in the cost band but is structurally wrong.

    Path syntax: dotted JSON path with '*' wildcards. '*' on a dict
    takes the first key; on a list takes index 0. For estimates with
    one group / one service, this is enough; the path

        services.*.calculationComponents.pricingStrategy.value.utilizationValue

    walks the standard top-level shape; for grouped saves use
    `groups.*.services.*.calculationComponents...`. To assert the
    same field across both shapes, supply `paths` (list of paths)
    instead of `path`; the predicate passes if ANY of them
    resolves to the expected value.

    Skips when no final_url is set (no save happened).
    """
    if not trace.final_url:
        return AssertionOutcome(
            status='skip', predicate='saved_blob_field_equals',
            reason='no final_url in trace; predicate needs a saved URL',
        )
    candidate_paths = paths if paths is not None else [path] if path else []
    if not candidate_paths:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_equals',
            reason='need either path: or paths: argument',
        )
    estimate_id = trace.final_url.rsplit('=', 1)[-1]
    try:
        blob = _fetch_saved_blob(estimate_id)
    except Exception as e:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_equals',
            expected=f'{candidate_paths} == {equals!r}',
            reason=f'failed to fetch saved blob: {e}',
        )
    walked_traces = []
    last_value = None
    for p in candidate_paths:
        found, value, walked = _walk_path(blob, p)
        walked_traces.append(walked)
        if found:
            if value == equals:
                return AssertionOutcome(
                    status='ok', predicate='saved_blob_field_equals',
                    expected=f'{p} == {equals!r}', actual=value,
                )
            last_value = value
    expected_str = ' OR '.join(f'{p} == {equals!r}' for p in candidate_paths)
    if last_value is not None:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_equals',
            expected=expected_str, actual=last_value,
            reason=f'saved {last_value!r}, expected {equals!r}',
        )
    return AssertionOutcome(
        status='fail', predicate='saved_blob_field_equals',
        expected=expected_str,
        actual=f'walked: {walked_traces}',
        reason='no path resolved in saved blob',
    )


def _walk_all_paths(blob, path: str) -> list:
    """Walk a dotted path with '*' wildcards and return EVERY value
    that resolves, not just the first one. Used by predicates that
    care about counts or distributions across wildcard positions.

    Distinct from `_walk_path` which short-circuits on the first match.
    """
    def step(cur, parts):
        if not parts:
            return [cur]
        head, *rest = parts
        if head == '*':
            if isinstance(cur, dict):
                out = []
                for v in cur.values():
                    out.extend(step(v, rest))
                return out
            if isinstance(cur, list):
                out = []
                for v in cur:
                    out.extend(step(v, rest))
                return out
            return []
        if isinstance(cur, dict):
            if head not in cur:
                return []
            return step(cur[head], rest)
        if isinstance(cur, list):
            try:
                return step(cur[int(head)], rest)
            except (ValueError, IndexError):
                return []
        return []
    return step(blob, path.split('.'))


def assert_saved_blob_field_count(
    trace: TraceResult, *, path: str, equals: int = None,
    min_count: int = None, max_count: int = None,
) -> AssertionOutcome:
    """Count how many distinct values match a wildcard path; assert
    against an exact count, a min, a max, or any combination.

    Use cases that motivated this:
      - Detect duplicate service entries: count
        `groups.*.services.*` (or `services.*`) and assert it equals
        the number of services the user actually asked for.
      - Detect missing/extra entries vs. expected.

    `equals: N` asserts an exact count. `min_count` / `max_count`
    bound a range. At least one of the three must be supplied.

    Skips when no final_url is set (no save happened).
    """
    if not trace.final_url:
        return AssertionOutcome(
            status='skip', predicate='saved_blob_field_count',
            reason='no final_url in trace; predicate needs a saved URL',
        )
    if equals is None and min_count is None and max_count is None:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_count',
            reason='need at least one of equals / min_count / max_count',
        )
    estimate_id = trace.final_url.rsplit('=', 1)[-1]
    try:
        blob = _fetch_saved_blob(estimate_id)
    except Exception as e:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_count',
            reason=f'failed to fetch saved blob: {e}',
        )
    matches = _walk_all_paths(blob, path)
    actual = len(matches)
    expected_parts = []
    if equals is not None: expected_parts.append(f'== {equals}')
    if min_count is not None: expected_parts.append(f'>= {min_count}')
    if max_count is not None: expected_parts.append(f'<= {max_count}')
    expected_str = f'count({path}) ' + ' AND '.join(expected_parts)

    if equals is not None and actual != equals:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_count',
            expected=expected_str, actual=actual,
            reason=f'expected exactly {equals}, got {actual}',
        )
    if min_count is not None and actual < min_count:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_count',
            expected=expected_str, actual=actual,
            reason=f'expected at least {min_count}, got {actual}',
        )
    if max_count is not None and actual > max_count:
        return AssertionOutcome(
            status='fail', predicate='saved_blob_field_count',
            expected=expected_str, actual=actual,
            reason=f'expected at most {max_count}, got {actual}',
        )
    return AssertionOutcome(
        status='ok', predicate='saved_blob_field_count',
        expected=expected_str, actual=actual,
    )


# ----- Helpers ------------------------------------------------------------

def parse_text_or_none(text: str) -> Any:
    """JSON-parse text; return None if it isn't JSON.

    Used by drivers when constructing CallRecord — keeps the parse logic
    in one place so predicates can rely on `parsed` having the right shape.
    """
    if not isinstance(text, str) or not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
