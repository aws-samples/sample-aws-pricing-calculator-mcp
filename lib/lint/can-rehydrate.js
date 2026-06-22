// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Static rehydration linter for AWS Pricing Calculator saved estimates.
 *
 * Given a saved-estimate-shaped JSON blob, the calculator manifest, and
 * the relevant per-service PCT definitions, predicts whether the
 * calculator will rehydrate the estimate as editable, required-input,
 * or read-only — without calling the save API or rendering the UI.
 *
 * The status decision mirrors the calculator's own gate: if every
 * failure is a missing required field (and only that), the result is
 * required-input (the user can fill those in interactively). If there
 * are any other failures, the result is read-only (frozen — the user
 * cannot edit).
 *
 * Returns 'unknown' when a predicate cannot run (e.g. the per-service
 * PCT definition is not provided). The runtime CSV oracle still
 * handles those cases.
 */

const PREDICATES = {
  TEMPLATE_EXISTENCE: 'template-existence',
  REQUIRED_FIELD_PRESENCE: 'required-field-presence',
  VALUE_PARSABILITY: 'value-parsability',
  SUB_SERVICE_ACTIVE_LIST: 'sub-service-active-list',
  DEFINITION_UNAVAILABLE: 'definition-unavailable',
  EMPTY_ESTIMATE: 'empty-estimate',
  ONE_OF_MUTEX: 'one-of-mutex',
  UNKNOWN_FIELD_ID: 'unknown-field-id',
  INVALID_OPTION_ID: 'invalid-option-id',
  INVALID_REGION: 'invalid-region',
  COLUMN_FORM_DEFAULT_TRAP: 'column-form-default-trap',
  COLUMN_FORM_UNREMAPPED_VALUE: 'column-form-unremapped-value',
  COLUMN_FORM_TUPLE_INVALID: 'column-form-tuple-invalid',
  TENANCY_PRICING_MISMATCH: 'tenancy-pricing-mismatch',
};

const STATUS = {
  EDITABLE: 'editable',
  REQUIRED_INPUT: 'required-input',
  READ_ONLY: 'read-only',
  UNKNOWN: 'unknown',
};

function* iterateServices(savedBlob) {
  // Yield every service the calculator runs through rehydration —
  // top-level peers, group children, AND sub-service children of
  // parent envelopes. Predicates 1-3 must apply to children too.
  const yieldOne = function* (id, svc, parentId = null) {
    yield { id, svc, parentId };
    for (const child of (svc.subServices || [])) {
      yield { id: `${id}/${child.serviceCode}`, svc: child, parentId: id };
    }
  };
  for (const [id, svc] of Object.entries(savedBlob.services || {})) {
    yield* yieldOne(id, svc);
  }
  const yieldGroup = function* (group) {
    for (const [id, svc] of Object.entries(group.services || {})) {
      yield* yieldOne(id, svc);
    }
    for (const [, childGroup] of Object.entries(group.groups || {})) {
      yield* yieldGroup(childGroup);
    }
  };
  for (const [, group] of Object.entries(savedBlob.groups || {})) {
    yield* yieldGroup(group);
  }
}

function checkTemplateExistence(svc, definition) {
  const want = svc.estimateFor;
  if (!want) {
    return {
      predicate: PREDICATES.TEMPLATE_EXISTENCE,
      severity: 'other',
      message: `service "${svc.serviceCode}" has no estimateFor`,
      context: { serviceCode: svc.serviceCode },
    };
  }
  // Sub-service-selector parents carry the wrapper template name on
  // `templateId` (e.g. SNS's parent has templateId 'amazonSnsClassesGroup'
  // even though `templates` lists only the children). Real saved estimates
  // use that wrapper id as `estimateFor`, so accept it as a match.
  if (definition && definition.templateId === want) return null;

  const templates = (definition && definition.templates) || [];
  for (const t of templates) {
    if (typeof t === 'string') {
      // Sub-service-selector parent shape: templates: ["childCode", ...]
      if (t === want) return null;
    } else if (t && typeof t === 'object') {
      // Concrete service shape: templates: [{id, mappingFromTemplate, ...}]
      if (t.id === want) return null;
      if (t.mappingFromTemplate === want) return null;
    }
  }
  // Build a readable list of what was available — handle both shapes.
  const available = templates.map(t => (typeof t === 'string' ? t : t && t.id)).filter(Boolean);
  if (definition && definition.templateId) available.unshift(definition.templateId);
  return {
    predicate: PREDICATES.TEMPLATE_EXISTENCE,
    severity: 'other',
    message: `estimateFor "${want}" not in service "${svc.serviceCode}" templates [${available.join(', ')}]`,
    context: { serviceCode: svc.serviceCode, estimateFor: want, availableTemplates: available },
  };
}

function isCardConditional(card) {
  return Object.prototype.hasOwnProperty.call(card || {}, 'displayIf');
}
function isComponentConditional(component) {
  return Object.prototype.hasOwnProperty.call(component || {}, 'displayIf');
}
function isComponentRequired(component) {
  return Boolean(component && component.validations && component.validations.required);
}

// Evaluate a manifest displayIf logic tree against the saved blob's
// calculationComponents. Returns:
//   true  — this clause is satisfied (field would be shown)
//   false — this clause fails (field would be hidden)
//   null  — the clause cannot be decided (referenced a component
//           with no saved value and no defaultValue) — conservative
//           callers should treat as true ("might be visible") to
//           avoid masking required-field misses, but math-walk
//           callers should treat as false ("don't flag") to avoid
//           false positives.
//
// Mirrors the calculator's own displayIf evaluator for the operators
// we encounter in the wild: `and`/`or`/`not`, `==`/`!=`, `>=`/`<=`/`>`/`<`,
// and `exists`.
//
// `exists` checks (meteredUnit / pricing availability) are treated
// as true because the canonical region typically has all features
// available; we have no signal otherwise.
function evalDisplayIf(node, savedComponents, getComponentDefault) {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node.and)) {
    let unknown = false;
    for (const c of node.and) {
      const r = evalDisplayIf(c, savedComponents, getComponentDefault);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (Array.isArray(node.or)) {
    let unknown = false;
    for (const c of node.or) {
      const r = evalDisplayIf(c, savedComponents, getComponentDefault);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if (node.not !== undefined) {
    const r = evalDisplayIf(node.not, savedComponents, getComponentDefault);
    if (r === null) return null;
    return !r;
  }
  if (node.exists !== undefined) {
    // Region/feature availability — assume true for canonical region.
    return true;
  }

  // Comparison operators: { "==": [lhs, rhs] }, { ">=": [lhs, rhs] }, etc.
  for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
    if (Array.isArray(node[op]) && node[op].length === 2) {
      const lhs = resolveOperand(node[op][0], savedComponents, getComponentDefault);
      const rhs = resolveOperand(node[op][1], savedComponents, getComponentDefault);
      if (lhs === undefined || rhs === undefined) return null;
      return applyComparator(op, lhs, rhs);
    }
  }
  return null;  // unknown clause shape
}

function resolveOperand(operand, savedComponents, getComponentDefault) {
  if (operand === null || operand === undefined) return operand;
  if (typeof operand !== 'object') return operand;  // literal scalar
  if (operand.type === 'component' && typeof operand.id === 'string') {
    // Saved value wins; fall back to the component's manifest defaultValue.
    const saved = savedComponents && savedComponents[operand.id];
    if (saved !== undefined) {
      // Saved blobs wrap values: { value: 'x' } or { value: 'x', unit: 'y' }.
      if (saved && typeof saved === 'object' && 'value' in saved) return saved.value;
      return saved;
    }
    if (typeof getComponentDefault === 'function') {
      return getComponentDefault(operand.id);
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(operand, 'value')) return operand.value;
  return undefined;
}

function applyComparator(op, lhs, rhs) {
  // Manifest comparisons stringify when types differ (e.g. component
  // value "1" vs literal 1). Coerce to string for ==/!=, to Number
  // for inequality where possible.
  if (op === '==') return String(lhs) === String(rhs);
  if (op === '!=') return String(lhs) !== String(rhs);
  const ln = Number(lhs), rn = Number(rhs);
  if (Number.isNaN(ln) || Number.isNaN(rn)) return null;
  if (op === '>=') return ln >= rn;
  if (op === '<=') return ln <= rn;
  if (op === '>') return ln > rn;
  if (op === '<') return ln < rn;
  return null;
}

function findTemplate(definition, estimateFor) {
  for (const t of (definition.templates || [])) {
    if (typeof t === 'string') continue;  // sub-service-selector parents have no inputSections
    if (t && typeof t === 'object') {
      if (t.id === estimateFor) return t;
      if (t.mappingFromTemplate === estimateFor) return t;
    }
  }
  return null;
}

function findRequiredComponentIds(template, catalogEntry, savedComponents, options = {}) {
  const { skipMathWalk = false } = options;
  // Three independent sources, unioned. Each catches a different
  // class of pricing-engine-required field; together they cover
  // the dual-required mismatch between the manifest's form-side
  // `validations.required` and the math-side `mathOperand.required`
  // documented in memory `pct-dual-required`.
  //
  //   1. Form-side `validations.required: true` on input components
  //      — what the calculator's own rehydration check uses.
  //   2. Catalog `required[]` empirical promotions — hand-curated.
  //   3. Math-operand-required walk — for math expressions whose
  //      user-input required operands are partially populated in
  //      the saved blob, the missing operands count as required.
  //      Provides defense-in-depth for un-cataloged services.
  //
  // Known limits of source 3:
  //   - Over-flags fields the calculator handles via auto-defaults
  //     (e.g. RDS GP3 IOPS defaults to 3000 when omitted). n=1
  //     verified; class size unknown.
  //   - Underderives Lambda's GB-second math chain when only one
  //     of (duration, memory) is populated — the expression
  //     doesn't opt in until both. Source 2 (catalog) covers this
  //     for cataloged services.
  const required = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || typeof id !== 'string') return;
    if (seen.has(id)) return;
    seen.add(id);
    required.push(id);
  };

  // Source 1: form-side validations.required walk.
  const visit = (node, ancestorConditional) => {
    if (!node || typeof node !== 'object') return;
    const nodeConditional = ancestorConditional || isCardConditional(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, nodeConditional);
      return;
    }
    if (node.id && typeof node.id === 'string') {
      if (!nodeConditional && !isComponentConditional(node) && isComponentRequired(node)) {
        add(node.id);
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') visit(v, nodeConditional);
    }
  };
  visit(template, false);

  // Source 2: catalog `required[]`.
  if (catalogEntry && Array.isArray(catalogEntry.required)) {
    for (const r of catalogEntry.required) {
      if (r && typeof r.field === 'string') add(r.field);
    }
  }

  // Source 3: math-operand-required walk.
  // Skipped when called from add_service-time validation: the saved
  // blob doesn't exist yet, and source 3's "opted-into expression"
  // logic depends on partial population in the saved blob. Sources 1
  // and 2 are sufficient for the entry-point check; source 3 still
  // fires at lint time as defense-in-depth.
  if (!skipMathWalk) {
    for (const id of findRequiredFromMath(template, savedComponents)) add(id);
  }

  return required;
}

// Walk every math expression in the template; for each expression
// whose user-input required operands are partially populated in the
// saved blob (the agent has "opted into" the expression), flag the
// missing user-input operands as required.
//
// The principle mirrors how the calculator's pricing engine works:
// each math expression is driven by its own operands, and missing
// operands cause that expression to silently zero. We enforce
// required-ness only for math expressions the saved blob has opted
// into, NOT every math expression in the manifest (that would
// over-flag feature-cards the agent didn't use — Lambda's
// Provisioned Concurrency / SnapStart / Edge / Streaming).
//
// Operand-level filter: user-input operands are filtered against
// the template's complete input component set so internal math
// variables (e.g. Lambda's `_generated_3`) are excluded.
//
// DisplayIf-level filter: each candidate operand's input component
// is checked against the manifest's displayIf rule (if any) using
// evalDisplayIf — operands whose input would be hidden by the
// canonical config's choices are skipped. This avoids the
// auto-default false-positive class (RDS GP3 IOPS, S3
// AverageObjectSize) where a math operand is `required: true` but
// the input field is gated off and the calculator silently uses a
// default. Without this filter the math walk would over-flag.
function findRequiredFromMath(template, savedComponents) {
  if (!template) return [];
  const saved = savedComponents || {};

  // Index: variableId → input component definition (for displayIf
  // and defaultValue lookup) — built from a single template walk.
  const inputComponents = new Map();
  const collectInputs = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collectInputs(x); return; }
    if (node.type === 'input' && typeof node.id === 'string') {
      inputComponents.set(node.id, node);
    }
    for (const v of Object.values(node)) collectInputs(v);
  };
  collectInputs(template);

  const getComponentDefault = (id) => {
    const c = inputComponents.get(id);
    return c && c.defaultValue !== undefined ? c.defaultValue : undefined;
  };

  // Returns true iff the input component for `variableId` would be
  // visible in the canonical save's UI. Components without
  // displayIf are always visible. Components whose displayIf
  // evaluates false against the saved blob are hidden and shouldn't
  // be flagged — the calculator either auto-defaults them or
  // doesn't read them at all in this workload.
  const isComponentVisible = (variableId) => {
    const comp = inputComponents.get(variableId);
    if (!comp || !comp.displayIf) return true;
    const result = evalDisplayIf(comp.displayIf, saved, getComponentDefault);
    // null (unknown — referenced a component we don't know about)
    // is treated as "skip flagging" to avoid the false-positive
    // class. The form-side validations.required walk + catalog
    // `required[]` are stricter sources for the cataloged path.
    return result === true;
  };

  // Card-scoped transitive opt-in.
  //
  // Expression-local opt-in (the previous rule: an expression opts
  // in if any of its user-input operands is populated) misses the
  // Lambda partial-pop gap. Lambda's GB-second expression
  // `sizeOfMemoryAllocated × generated_X` has memory as its only
  // user-input — but the chain through `generated_X` traces back to
  // populated `numberOfRequests`/`durationOfEachRequest`. Without
  // following intermediates, agents who populate requests + duration
  // but skip memory get a save that lints editable and silently
  // zeros GB-seconds (~94% under-pricing).
  //
  // A naive global transitive walk over-flags: in EC2, storage
  // expressions reference `instanceAmount` (intermediate from compute
  // card), and once compute is populated, storage gets falsely
  // flagged even when the agent legitimately omitted it.
  //
  // The fix: scope the transitive walk to within a card. Cards are
  // the explicit boundary the PCT already draws around independent
  // pricing concerns (compute / storage / snapshots / etc.).
  // Following intermediates *within a card* catches the Lambda gap;
  // not crossing cards keeps EC2 storage clean.
  //
  // Templates without `cards[]` (rare) fall through to a single-card
  // walk over the whole template — equivalent to the old
  // expression-local rule for those.

  const cards = [];  // [{ inputs: Set<id>, expressions: [node, ...] }, ...]
  const collectCard = (root) => {
    const idx = cards.length;
    cards.push({ inputs: new Set(), expressions: [] });
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      if (n.type === 'input' && typeof n.id === 'string') {
        cards[idx].inputs.add(n.id);
      }
      if (n.type === 'maths' && n.subType === 'basicMaths' && Array.isArray(n.operands)) {
        cards[idx].expressions.push(n);
      }
      for (const v of Object.values(n)) visit(v);
    };
    visit(root);
  };
  if (Array.isArray(template.cards) && template.cards.length > 0) {
    for (const card of template.cards) collectCard(card);
  } else {
    collectCard(template);
  }

  // True opt-in test: a user-input is populated AND its value
  // differs from the manifest's defaultValue. Populating a field
  // with its own default doesn't signal "the user opted in" — agents
  // sometimes fill defaults dutifully (e.g. Cognito's
  // `optimizationRateTokenRequests` = '0' which is also the manifest
  // default). Treating those as opt-in signals over-flags the rest
  // of the card.
  const isPopulatedAsNonDefault = (id) => {
    if (!(id in saved)) return false;
    const comp = inputComponents.get(id);
    if (!comp || comp.defaultValue === undefined) return true;
    const raw = saved[id];
    const observed = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
    return String(observed) !== String(comp.defaultValue);
  };

  const out = new Set();
  for (const card of cards) {
    // Build a card-local intermediate-id → expression-node map so
    // closure can resolve operand variableIds that are computed by
    // other expressions in the same card.
    const cardExprById = new Map();
    for (const e of card.expressions) {
      if (typeof e.id === 'string') cardExprById.set(e.id, e);
    }

    // Iterative closure: an intermediate is "active" if all its
    // user-input required operands (within this card) are populated
    // AND all its intermediate operands resolve (transitively) to
    // active or out-of-card intermediates. Out-of-card intermediates
    // are conservatively treated as "out of scope" — we don't follow
    // them, but they don't block the closure (the within-card
    // populated user-inputs do the activating).
    const active = new Set();
    // Subset of `active` whose activation chain bottoms out in at
    // least one populated-as-non-default user-input operand. The
    // per-expression opt-in check below trusts only this stricter
    // signal — `active` alone can't distinguish "real opt-in" from
    // "all-defaults chain" (the MediaLive false-positive class).
    const activeWithEvidence = new Set();
    let changed = true;
    let iters = 0;
    while (changed && iters < 50) {
      changed = false;
      iters++;
      for (const [id, expr] of cardExprById) {
        if (active.has(id)) continue;
        let ready = true;
        // Track whether any user-input operand is populated-as-non-default
        // OR whether any intermediate operand is itself activated by a
        // populated user-input. Without this, a chain whose user-input
        // operands are ALL `required: false` activates from defaults
        // alone (MediaLive case 2026-06-03: the `_totalActiveHours`
        // intermediate has only non-required user-input operands with
        // default 730; it activated unconditionally and falsely opted
        // its containing `_costMonthly` expression into requiring
        // populating siblings the agent never touched).
        let hasPopulatedEvidence = false;
        for (const op of expr.operands) {
          if (!op || typeof op.variableId !== 'string') continue;
          if (inputComponents.has(op.variableId)) {
            // User-input operand: must be populated if the operand is
            // marked required (otherwise it's optional in the math).
            // Cross-card user-input operands BLOCK activation — we
            // can't claim this card's chain is "ready" via inputs the
            // agent populated for a different concern. (Production
            // case: EventBridge card[4] "Event Replay" expressions
            // reference card[0]'s `Size_of_the_payload`. Without
            // blocking, populating payload size would activate
            // card[4]'s intermediates, falsely flagging
            // `Number_of_events` even though the agent never opted
            // into Event Replay.)
            if (op.required === true && !card.inputs.has(op.variableId)) {
              ready = false; break;
            }
            if (op.required === true && !isPopulatedAsNonDefault(op.variableId)) {
              ready = false; break;
            }
            // Track populated-evidence regardless of required flag:
            // ANY populated-as-non-default user-input is real opt-in.
            if (card.inputs.has(op.variableId) && isPopulatedAsNonDefault(op.variableId)) {
              hasPopulatedEvidence = true;
            }
          } else {
            // Intermediate operand. If it's another basicMaths
            // expression in this card, require it to be active.
            // Otherwise (cross-card intermediate, or a non-basicMaths
            // intermediate type like ec2Variable/pricingComboV2/
            // tieredPricingMath), treat as NOT active — we don't
            // model those, so we can't claim a populated chain
            // through them. The expression won't activate solely
            // through unmodeled intermediates; it still activates
            // through populated user-input operands in this card.
            if (!cardExprById.has(op.variableId)) {
              ready = false; break;
            }
            if (!active.has(op.variableId)) {
              ready = false; break;
            }
            // An active intermediate carries the populated-evidence
            // flag: if the chain bottoms out in a populated user-input,
            // that's real opt-in for this expression too. Tracked via
            // the active-with-evidence set below.
            if (activeWithEvidence.has(op.variableId)) {
              hasPopulatedEvidence = true;
            }
          }
        }
        if (ready && hasPopulatedEvidence) {
          active.add(id);
          activeWithEvidence.add(id);
          changed = true;
        }
      }
    }

    for (const expr of card.expressions) {
      const userOperands = expr.operands.filter(
        op => op && typeof op.variableId === 'string'
              && op.required === true
              && inputComponents.has(op.variableId)
      );
      if (userOperands.length === 0) continue;

      // Per the calculator's actual math-eval behavior: when ANY
      // required operand is missing, the expression silently returns
      // 0 — no UI error, no save block. So flagging a missing operand
      // only makes sense when the user has demonstrated INTENT to use
      // this expression by populating ≥2 of its required user-input
      // operands. That's the "partial-pop silent-zero trap" the math
      // walk exists to catch.
      //
      // 1- and 2-operand expressions: the calculator silently zeros
      // when any operand is missing; populating one operand is not
      // strong intent (it's often shared across many sibling
      // expressions, like Textract's `numberOfPages` in 25
      // billablePageswithX expressions). Skip flagging.
      //
      // 3+-operand expressions with ≥2 populated: the missing operand
      // is the silent-zero trap class — agent populated most of a
      // chain but skipped one, expecting cost contribution. Flag.
      // Lambda (numberOfRequests + duration + memory) and similar
      // chains still fire correctly.
      //
      // The activeWithEvidence intermediate path handles
      // the case where opt-in flows through a chained intermediate —
      // e.g. Lambda's `_GBseconds` activates because `numberOfRequests`
      // is populated even though it's not a direct operand here.
      //
      // Production case 2026-06-04 (Textract): 25 expressions of
      // shape [numberOfPages, percentWithFeatureN]. Pre-fix:
      // numberOfPages populated → all 25 opt in → 24 missing
      // percentWithFeatureN flagged as required-input. Post-fix:
      // 2-op expressions with 1 populated operand → silent-zero, no
      // flag. The calculator already silently zeros the unused
      // features.
      const populatedUserOperands = userOperands.filter(
        op => card.inputs.has(op.variableId) && isPopulatedAsNonDefault(op.variableId)
      );

      const optedFromIntermediate = expr.operands.some(
        op => op && typeof op.variableId === 'string'
              && !inputComponents.has(op.variableId)
              && cardExprById.has(op.variableId)
              && activeWithEvidence.has(op.variableId)
      );

      // Threshold: ≥2 populated user-input operands signals intent.
      // Lower bar: an activeWithEvidence intermediate operand carries
      // the opt-in signal through a chain that bottoms out in a
      // populated user-input elsewhere in the same card (Lambda's
      // sizeOfMemoryAllocated × _generated_3 case — _generated_3
      // activates from populated numberOfRequests + duration in a
      // sibling expression).
      const hasIntent =
        populatedUserOperands.length >= 2
        || optedFromIntermediate;

      if (!hasIntent) continue;

      for (const op of userOperands) {
        if (!card.inputs.has(op.variableId)) continue;
        if (!isComponentVisible(op.variableId)) continue;
        if (isPopulatedAsNonDefault(op.variableId)) continue;
        out.add(op.variableId);
      }
    }
  }
  return [...out];
}

// Detect "exactly one of these variants" groups in the template. The pattern:
// an addition expression sums multiple operands that all resolve (via
// `maths/variable.refer` aliases) to displayIf-gated input components,
// each `validations.required: false`, sharing the same gating field, with
// disjoint gate values. The shape models a UI choice that selects which
// of N variants applies — the calculator sums them, but only one is
// active per gating-field choice.
//
// Concrete case this catches: AWS Fargate's `vcpuPerTask` choice gates
// four memory variant fields. Without this rule, an agent that sets
// `vcpuPerTask` but no memory field saves cleanly, and the calculator
// silently zeros the GB-second cost component (~18% under-estimate).
//
// Returns an array of { gatingField, members: [{ id, values: Set }] }.
// Pure of saved blob — derivable once per template.
function parseDisplayIfGate(displayIf) {
  if (!displayIf || typeof displayIf !== 'object') return null;
  if (Array.isArray(displayIf['=='])) {
    const [a, b] = displayIf['=='];
    if (a && a.type === 'component' && typeof a.id === 'string'
        && (typeof b === 'string' || typeof b === 'number')) {
      return { field: a.id, values: new Set([String(b)]) };
    }
    return null;
  }
  if (Array.isArray(displayIf.or)) {
    let field = null;
    const values = new Set();
    for (const clause of displayIf.or) {
      if (!Array.isArray(clause['=='])) return null;
      const [a, b] = clause['=='];
      if (!(a && a.type === 'component' && typeof a.id === 'string')) return null;
      if (typeof b !== 'string' && typeof b !== 'number') return null;
      if (field && field !== a.id) return null;
      field = a.id;
      values.add(String(b));
    }
    return field ? { field, values } : null;
  }
  return null;
}

function findOneOfGroups(template) {
  if (!template) return [];
  const inputs = new Map();
  const aliases = new Map();
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collect(x); return; }
    if (node.type === 'input' && typeof node.id === 'string') {
      inputs.set(node.id, { displayIf: node.displayIf, required: node.validations && node.validations.required });
    }
    if (node.type === 'maths' && node.subType === 'variable'
        && typeof node.id === 'string' && typeof node.refer === 'string') {
      aliases.set(node.id, node.refer);
    }
    for (const v of Object.values(node)) collect(v);
  };
  collect(template);

  const resolve = (id) => aliases.get(id) || id;

  const groups = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x); return; }
    if (node.operation === 'addition' && Array.isArray(node.operands)) {
      const resolved = [];
      let bad = false;
      for (const op of node.operands) {
        if (!op || typeof op.variableId !== 'string') continue;
        const inputId = resolve(op.variableId);
        const inp = inputs.get(inputId);
        if (!inp || !inp.displayIf) { bad = true; break; }
        const gate = parseDisplayIfGate(inp.displayIf);
        if (!gate) { bad = true; break; }
        if (inp.required === true) { bad = true; break; }
        resolved.push({ inputId, gate });
      }
      if (!bad && resolved.length >= 2) {
        const gatingField = resolved[0].gate.field;
        if (resolved.every(m => m.gate.field === gatingField)) {
          const seen = new Set();
          let disjoint = true;
          for (const m of resolved) for (const v of m.gate.values) {
            if (seen.has(v)) { disjoint = false; break; }
            seen.add(v);
          }
          if (disjoint) {
            groups.push({
              gatingField,
              members: resolved.map(m => ({ id: m.inputId, values: m.gate.values })),
            });
          }
        }
      }
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(template);
  return groups;
}

// For each oneOf group: if the gating field is populated in the saved
// blob with a value V matched by some member, require that member to be
// present. Skip when the gating field is missing (form-side will catch
// it if it's required) or when V doesn't match any member (V might be
// an info-only / non-pricing choice).
function checkOneOfMutex(svc, definition) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const cc = svc.calculationComponents || {};
  const failures = [];
  for (const group of findOneOfGroups(template)) {
    const gatingEntry = cc[group.gatingField];
    if (gatingEntry === undefined) continue;
    // Saved entries are usually `{ value, unit }` or bare scalars; pull
    // the scalar value to compare against gate values.
    const v = (typeof gatingEntry === 'object' && gatingEntry !== null && 'value' in gatingEntry)
      ? gatingEntry.value
      : gatingEntry;
    if (v === undefined || v === null) continue;
    const vStr = String(v);
    const expected = group.members.find(m => m.values.has(vStr));
    if (!expected) continue;  // gating value doesn't trigger any member
    if (expected.id in cc) continue;  // populated correctly
    failures.push({
      predicate: PREDICATES.ONE_OF_MUTEX,
      severity: 'required-only',
      message: `gating field "${group.gatingField}"=${vStr} requires variant "${expected.id}" to be populated for ${svc.serviceCode}`,
      context: {
        serviceCode: svc.serviceCode,
        gatingField: group.gatingField,
        gatingValue: vStr,
        expectedComponentId: expected.id,
        availableMembers: group.members.map(m => m.id),
      },
    });
  }
  return failures;
}

function isParseable(componentEntry) {
  // Saved entries are usually { value, unit } objects, but a bare scalar
  // string is allowed for unit-less components — handle both shapes.
  if (componentEntry === undefined || componentEntry === null) return false;
  // Calculator's parseSavedValue throws when value is undefined OR
  // when isEmpty(componentState) (e.g. {} or '').
  if (typeof componentEntry === 'string') return componentEntry.trim().length > 0;
  if (typeof componentEntry === 'object') {
    if (Object.keys(componentEntry).length === 0) return false;
    if ('value' in componentEntry) {
      const v = componentEntry.value;
      if (v === undefined || v === null) return false;
      if (typeof v === 'string' && v.trim().length === 0) return false;
    }
  }
  return true;
}

function checkValueParsability(svc, definition, catalogEntry) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const required = findRequiredComponentIds(template, catalogEntry, svc.calculationComponents);
  const cc = svc.calculationComponents || {};
  const failures = [];
  for (const id of required) {
    if (!(id in cc)) continue;  // predicate 2 handles missing key
    if (!isParseable(cc[id])) {
      failures.push({
        predicate: PREDICATES.VALUE_PARSABILITY,
        severity: 'other',
        // nosemgrep: no-stringify-keys
        // The stringify result is embedded in a human-readable error message,
        // not used as a hash key or for equality comparison. Key-ordering
        // stability is irrelevant here.
        message: `required component "${id}" has unparseable value: ${JSON.stringify(cc[id])}`,
        context: { serviceCode: svc.serviceCode, componentId: id, savedValue: cc[id] },
      });
    }
  }
  return failures;
}

// Defense against silent typos. The save API accepts any key in
// calculationComponents; the pricing engine reads only known field
// IDs and silently ignores the rest. A typo'd `requestDuration`
// (instead of `durationOfEachRequest`) saves cleanly, prices wrong,
// and slips past the required-field check (which fires on the
// missing canonical id but says nothing about the unknown sibling).
//
// add_service runs validateConfigKeys at entry-point time, but
// import_estimate, hand-edited blobs, and re-validation of stale
// saves don't pass through that gate. This predicate closes the
// gap by walking the saved blob's keys directly and flagging
// non-template ids with a Levenshtein "did you mean X?" hint —
// matching what validateConfigKeys produces at add time.
//
// Probe (2026-06-01) confirmed zero false positives across all 16
// verified-catalog estimates: every cc key in every known-good save
// is a `type: input` id in the template.
function checkUnknownFieldIds(svc, definition) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const cc = svc.calculationComponents || {};
  const ccKeys = Object.keys(cc);
  if (ccKeys.length === 0) return [];

  const validIds = new Set();
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collect(x); return; }
    if (node.type === 'input' && typeof node.id === 'string') validIds.add(node.id);
    for (const v of Object.values(node)) collect(v);
  };
  collect(template);
  if (validIds.size === 0) return [];  // nothing to compare against

  const validList = [...validIds];
  const failures = [];
  for (const key of ccKeys) {
    if (validIds.has(key)) continue;
    const suggestions = suggestNearbyIds(key, validList);
    const hint = suggestions.length
      ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
      : '';
    failures.push({
      predicate: PREDICATES.UNKNOWN_FIELD_ID,
      severity: 'required-only',
      message: `unknown component "${key}" in calculationComponents for ${svc.serviceCode}.${hint}`,
      context: {
        serviceCode: svc.serviceCode,
        componentId: key,
        suggestions,
      },
    });
  }
  return failures;
}

// Edit-distance match against the template's known input IDs.
// Mirrors lib/validation.js#suggestMatch's threshold so the
// import-time and add-time hints surface the same suggestions.
function suggestNearbyIds(invalid, validIds, max = 3) {
  const lower = invalid.toLowerCase();
  return validIds
    .map(id => ({ id, dist: editDistance(lower, id.toLowerCase()) }))
    .filter(m => m.dist <= Math.max(Math.floor(invalid.length * 0.6), 3))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map(m => m.id);
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Whitelist saved values against the field's published `options[]` enum.
// The save API accepts any string; the pricing engine reads only known
// option ids and silently zeros (or defaults) the rest. Manifest-wide
// probe (2026-06-01): every dropdown and frequency input publishes an
// options[] enum (599 dropdowns, 454 frequencies — 100% coverage).
//
// Saved-value shapes per subType:
//   dropdown   — id lives in `value`     ({ value: "1" } or "1")
//   frequency  — id lives in `unit`      ({ value: "8", unit: "perMonth" })
//
// Known traps this catches:
//   - Step Functions Standard: `numberOfExecutions.unit = millionPerMonth`
//     is valid as a frequency literal but NOT in this template's options
//     ([perHour, perDay, perMonth]) — pricing engine silently zeros.
//   - EC2 pricing-strategy term: '1 year' (lowercase) instead of '1 Year'
//     silently mis-prices. (EC2 transforms early so this surfaces before
//     the lint sees it; the predicate is the import-time defense.)
//
// durationInput is excluded because no durationInput field publishes
// options[] in the manifest (271/271 have none). Other subtypes are
// excluded because they don't carry option-id semantics.
function checkInvalidOptionIds(svc, definition) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const cc = svc.calculationComponents || {};
  if (Object.keys(cc).length === 0) return [];

  // Index inputs by id (only those carrying option-id whitelists).
  const fieldsById = new Map();
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collect(x); return; }
    if (node.type === 'input' && typeof node.id === 'string'
        && Array.isArray(node.options) && node.options.length > 0
        && (node.subType === 'dropdown' || node.subType === 'frequency')) {
      fieldsById.set(node.id, {
        subType: node.subType,
        optionIds: new Set(node.options.map(o => o && o.id).filter(Boolean).map(String)),
      });
    }
    for (const v of Object.values(node)) collect(v);
  };
  collect(template);
  if (fieldsById.size === 0) return [];

  const failures = [];
  for (const [key, raw] of Object.entries(cc)) {
    const field = fieldsById.get(key);
    if (!field) continue;  // not an enumerable field — skip
    // Pull the enum-bearing slot per subType. The whitelist is the same
    // for both — only the slot name differs.
    let slot, observed;
    if (field.subType === 'dropdown') {
      slot = 'value';
      observed = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
    } else {
      slot = 'unit';
      observed = raw && typeof raw === 'object' ? raw.unit : undefined;
    }
    if (observed === undefined || observed === null) continue;  // missing slot — handled elsewhere
    const observedStr = String(observed);
    if (field.optionIds.has(observedStr)) continue;
    const sample = [...field.optionIds].slice(0, 5);
    const more = field.optionIds.size > 5 ? `, ... (${field.optionIds.size} total)` : '';
    failures.push({
      predicate: PREDICATES.INVALID_OPTION_ID,
      severity: 'required-only',
      message: `field "${key}" ${slot} "${observedStr}" not in options [${sample.join(', ')}${more}] for ${svc.serviceCode}`,
      context: {
        serviceCode: svc.serviceCode,
        componentId: key,
        slot,
        observed: observedStr,
        validOptions: [...field.optionIds],
      },
    });
  }
  return failures;
}

// Region whitelist. The save API silently accepts unsupported region/
// service pairs, the calculator routes the saved blob to a default
// region, and the rendered cost doesn't match what the user asked for.
// validateConfigKeys runs this preflight at add_service time; the lint
// catches imports + re-validations that bypass that gate.
//
// regionList is a side-channel resource; pass it in via the canRehydrate
// caller. Skipping when not provided is safe (matches the validation.js
// behavior — region list unreachable falls through silently).
function checkInvalidRegion(svc, regionList) {
  if (!regionList) return [];
  if (!svc.region) return [];
  const allowed = regionList[svc.serviceCode];
  if (!Array.isArray(allowed) || allowed.length === 0) return [];  // unknown service in region list
  if (allowed.includes(svc.region)) return [];
  const sample = allowed.slice(0, 5);
  const more = allowed.length > 5 ? `, ... (${allowed.length} total)` : '';
  return [{
    predicate: PREDICATES.INVALID_REGION,
    severity: 'required-only',
    message: `region "${svc.region}" not supported for ${svc.serviceCode}. Supported: ${sample.join(', ')}${more}`,
    context: {
      serviceCode: svc.serviceCode,
      observed: svc.region,
      validRegions: allowed,
    },
  }];
}

// columnFormIPM tables (instance-cost grids: data instances, master nodes,
// UltraWarm, RDS instances, etc.) carry per-row `defaultValue`s. When the
// agent saves an estimate WITH a populated columnFormIPM_1 (data) but
// OMITS columnFormIPM_2 (master), the calculator UI rehydrates the absent
// table with its manifest defaults (e.g. OpenSearch master defaults to
// 3 r5.2xlarge.search nodes). The user sees a fully-priced cluster even
// though the agent never authorized it.
//
// Production case 2026-06-03 (estimate a6738f91...): user asked for
// "3 m6g.large data nodes"; agent saved columnFormIPM_1 only; calculator
// auto-defaulted 3 master + 2 UltraWarm. Lint passed `editable` because
// no existing predicate detects "parent columnFormIPM input absent while
// its row has a non-zero defaultValue."
//
// Predicate logic: walk the active template; for each `subType:
// 'columnFormIPM'` input that has a count row (textInput/numericInput
// with a numeric defaultValue > 0), if the input's id is missing from
// `svc.calculationComponents`, emit a `required-only` failure naming
// the auto-defaulted node count and instance type. Skips inputs gated
// false by displayIf — out-of-scope tables don't trigger.
function checkColumnFormDefaultTrap(svc, definition) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const cc = svc.calculationComponents || {};
  const componentDefaults = collectComponentDefaults(template);
  const isComponentVisible = (variableId) => {
    const comp = componentDefaults.componentsById?.get(variableId);
    if (!comp) return true;
    if (!isComponentConditional(comp)) return true;
    const r = evalDisplayIf(comp.displayIf, cc, (id) => componentDefaults.defaultsById?.get(id));
    // Conservative: when displayIf can't be decided, treat as visible
    // (don't mask the trap on uncertainty — same policy as
    // checkRequiredFieldPresence).
    return r !== false;
  };

  const failures = [];
  // Templates may use `cards`, `inputSections`, or have inputs at the
  // root — iterateInputs walks any shape and yields every `type:'input'`
  // descendant.
  for (const inp of iterateInputs(template)) {
    if (inp.subType !== 'columnFormIPM') continue;
    if (!isComponentVisible(inp.id)) continue;
    // Find the count row — first row with a numeric defaultValue > 0
    // on a textInput/numericInput. The row's selectorId / label
    // typically reads "Number of Nodes" / "Quantity" / etc.
    const rows = inp.row || [];
    let countRow = null;
    let instanceTypeRow = null;
    for (const r of rows) {
      if (countRow == null
          && (r.type === 'textInput' || r.type === 'numericInput')
          && r.defaultValue !== undefined
          && r.defaultValue !== ''
          && Number(r.defaultValue) > 0) {
        countRow = r;
      }
      if (instanceTypeRow == null && r.type === 'autoSuggest') {
        instanceTypeRow = r;
      }
    }
    if (!countRow) continue;  // no cost-bearing default; absence is harmless
    if (inp.id in cc) continue;  // agent populated the table; skip
    const count = Number(countRow.defaultValue);
    const instType = instanceTypeRow?.defaultValue || '(unspecified)';
    const rowLabel = countRow.selectorId || countRow.label || 'count';
    failures.push({
      predicate: PREDICATES.COLUMN_FORM_DEFAULT_TRAP,
      severity: 'required-only',
      message: `columnFormIPM "${inp.id}" (${inp.label || 'unnamed table'}) is absent — calculator will silently default to ${count} × "${instType}" and add cost the agent did not authorize`,
      context: {
        serviceCode: svc.serviceCode,
        componentId: inp.id,
        tableLabel: inp.label || null,
        countRowLabel: rowLabel,
        defaultCount: count,
        defaultInstanceType: instType,
      },
    });
  }
  return failures;
}

// columnFormIPM cells must store REMAPPED (target) values, not raw
// selector (UI) values. The service definition's columnFormIPM carries
// `remap.keyValue` — a map of selector → stored value (e.g. WorkSpaces
// Core: "Windows" → "WorkSpaces Core Windows", "AlwaysOn" → "Monthly").
// The calculator frontend writes the stored value; the pricing engine
// reads it back. If a saved cell still holds the raw selector value (a
// KEY in keyValue), the pricing engine can't resolve it and the service
// rehydrates READ-ONLY at $0.
//
// The builder applies this remap (lib/estimate-builder.js#applyColumnFormRemap),
// so builder-produced saves are already correct. This predicate is the
// defense-in-depth backstop for paths that bypass the builder:
// import_estimate, re-validation of externally-produced blobs, and future
// services. Per the repo philosophy (lint defenses COMPLEMENT the builder),
// it fires ONLY on the unambiguous bug signal — a cell value that is a KEY
// in keyValue but is NOT also a VALUE in keyValue. The "not also a value"
// guard prevents false-positives where a legitimate stored value happens
// to coincide with another selector key.
//
// Cell shapes mirror the builder's remap walk:
//   Plain cell        — value at `cell.value` (a string).
//   Utilization cell  — value at `cell.value.selectedId` (a nested string).
//
// severity 'other' → drives a read-only verdict via decideServiceStatus,
// matching the bug's real-world effect (the calculator freezes the
// estimate). Same severity class as VALUE_PARSABILITY.
function checkColumnFormUnremappedValue(svc, definition) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const cc = svc.calculationComponents || {};
  const failures = [];

  for (const inp of iterateInputs(template)) {
    if (inp.subType !== 'columnFormIPM' && inp.type !== 'columnFormIPM') continue;
    const keyValue = inp.remap && inp.remap.keyValue;
    if (!keyValue || typeof keyValue !== 'object') continue;
    const keys = new Set(Object.keys(keyValue));
    if (keys.size === 0) continue;
    const values = new Set(Object.values(keyValue).map(String));

    const entry = cc[inp.id];
    const rows = entry && entry.value;
    if (!Array.isArray(rows)) continue;  // table absent or non-array — handled elsewhere

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [cellKey, cell] of Object.entries(row)) {
        if (!cell || typeof cell !== 'object') continue;
        // Pull the stored string per cell shape.
        const observed = (cell.value && typeof cell.value === 'object')
          ? cell.value.selectedId   // utilization cell
          : cell.value;             // plain cell
        if (typeof observed !== 'string') continue;
        // Fire only on the unambiguous signal: the value is a raw selector
        // KEY and is NOT also a legitimate stored VALUE in the map.
        if (!keys.has(observed)) continue;
        if (values.has(observed)) continue;
        failures.push({
          predicate: PREDICATES.COLUMN_FORM_UNREMAPPED_VALUE,
          severity: 'other',
          message: `columnFormIPM "${inp.id}" cell "${cellKey}" holds un-remapped selector value "${observed}" for ${svc.serviceCode} — calculator stores the remapped value "${keyValue[observed]}"; the raw value rehydrates read-only at $0`,
          context: {
            serviceCode: svc.serviceCode,
            componentId: inp.id,
            cellKey,
            observed,
            expectedRemapped: keyValue[observed],
          },
        });
      }
    }
  }
  return failures;
}

// columnFormIPM rows must hold a VALID combination of selector values.
// Some services (WorkSpaces Core is the canonical case) carry a
// cross-column constraint that nothing else enforces: the
// Operating-System × License pair is restricted to a fixed set of
// canonical tuples. A row outside that set ("Windows" + "Bring Your
// Own License", say) saves cleanly, passes every other predicate, and
// then misprices SILENTLY and DIFFERENTLY per region — one region
// overcharges (renders a sibling tuple's rate), another renders $0.
//
// The authoritative source of truth is the calculator's own
// primary-selector-aggregations.json per service+region: it lists every
// valid full selector tuple. A saved row whose tuple is not in that set
// is defective even if it happens to render a price (because the price
// is wrong). That file is fetched best-effort by canRehydrateFetch and
// threaded in as the `aggregations` Map (serviceCode → array of valid
// selector-tuple objects). When the Map is absent — offline tests,
// unreachable CDN, or a service with no aggregations — the predicate is
// a NO-OP, mirroring the regionList side-channel skip behavior.
//
// Saved cells store REMAPPED values (e.g. "WorkSpaces Core Windows" for
// selector "Windows"); the aggregation tuples use SELECTOR values. So
// each cell value is reverse-mapped (stored → selector) via the
// component's remap.keyValue before comparing. Values with no reverse
// entry pass through unchanged.
//
// Comparison is intersected on the keys present in BOTH the aggregation
// tuples and the saved row. The saved row may carry columns the
// aggregation doesn't track (and those are ignored); the aggregation may
// carry columns the row doesn't store (e.g. a derived "Product Family"),
// and those can't be compared so they're skipped too. The match is "does
// ANY aggregation tuple agree on every shared key" — which for WorkSpaces
// Core reduces to the Operating-System × License constraint.
//
// severity 'other' → drives a read-only verdict via decideServiceStatus.
// This bug genuinely misprices, so it must block the estimate.
function checkColumnFormTupleValid(svc, definition, aggregations) {
  if (!aggregations || typeof aggregations.get !== 'function') return [];
  const validTuples = aggregations.get(svc.serviceCode);
  if (!Array.isArray(validTuples) || validTuples.length === 0) return [];

  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];
  const cc = svc.calculationComponents || {};

  // The keys the aggregation tuples track — we compare only on these.
  const aggKeys = new Set();
  for (const t of validTuples) {
    if (t && typeof t === 'object') for (const k of Object.keys(t)) aggKeys.add(k);
  }
  if (aggKeys.size === 0) return [];

  const failures = [];
  for (const inp of iterateInputs(template)) {
    if (inp.subType !== 'columnFormIPM' && inp.type !== 'columnFormIPM') continue;
    const keyValue = inp.remap && inp.remap.keyValue;
    if (!keyValue || typeof keyValue !== 'object') continue;  // no remap → can't reverse-map → skip

    // Reverse map: stored → selector. Built once per component.
    const storedToSelector = {};
    for (const [selector, stored] of Object.entries(keyValue)) {
      storedToSelector[String(stored)] = selector;
    }
    const reverse = (stored) => (
      Object.prototype.hasOwnProperty.call(storedToSelector, stored)
        ? storedToSelector[stored]
        : stored  // no reverse entry → pass through unchanged
    );

    const entry = cc[inp.id];
    const rows = entry && entry.value;
    if (!Array.isArray(rows)) continue;  // table absent or non-array — handled elsewhere

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;

      // Build the selector tuple over the aggregation-tracked columns the
      // row actually carries — the shared keys. Reverse-map each stored
      // cell value to its selector value before comparing.
      const tuple = {};
      for (const cellKey of aggKeys) {
        const cell = row[cellKey];
        if (!cell || typeof cell !== 'object') continue;  // column not in this row — skip it
        // Pull the stored string per cell shape (mirrors the unremapped
        // predicate): plain cell at cell.value, utilization cell at
        // cell.value.selectedId.
        const stored = (cell.value && typeof cell.value === 'object')
          ? cell.value.selectedId
          : cell.value;
        if (typeof stored !== 'string') continue;
        tuple[cellKey] = reverse(stored);
      }
      const sharedKeys = Object.keys(tuple);
      // No comparable cells — can't judge this row; skip (don't false-positive).
      if (sharedKeys.length === 0) continue;

      const matches = validTuples.some(valid =>
        sharedKeys.every(k => String(valid[k]) === String(tuple[k]))
      );
      if (matches) continue;

      failures.push({
        predicate: PREDICATES.COLUMN_FORM_TUPLE_INVALID,
        severity: 'other',
        message: `columnFormIPM "${inp.id}" row tuple ${JSON.stringify(tuple)} is not a valid combination for ${svc.serviceCode} in region "${svc.region || svc.regionName || 'unknown'}" — it misprices silently (renders a wrong rate or $0)`,
        context: {
          serviceCode: svc.serviceCode,
          componentId: inp.id,
          region: svc.region || null,
          regionName: svc.regionName || null,
          observedTuple: tuple,
          comparedKeys: [...aggKeys],
        },
      });
    }
  }
  return failures;
}

// Standard/Convertible Reserved Instances are HIDDEN under shared
// tenancy in the calculator. The pricing engine still accepts the
// blob — but the rendered estimate goes Read-only because the form
// can't display the reserved-instance UI without dedicated/host
// tenancy. Pre-fix this lived as a silent rewrite in
// lib/ec2.js#buildPricingStrategy: when the agent sent
// `pricingStrategy: 'reserved'` under shared tenancy, the transform
// quietly remapped to `instance-savings`. That rewrite SHOULD continue
// to happen (otherwise every existing reserved+shared save would
// break), but a parallel diagnostic is needed for the case where an
// agent imports/builds a blob with shared+standard or shared+convertible
// directly (bypassing transformConfig — e.g. via import_estimate of a
// hand-edited blob, or a future direct-blob construction path). This
// predicate fires on that structurally-detectable case.
//
// Out of scope: detecting the asked-reserved-got-instance-savings
// remap inside transformConfig. That would require a breadcrumb on
// the saved blob carrying `_intentMismatch: { asked: 'reserved' }`,
// but the save API silently strips unknown keys — so the breadcrumb
// might not survive. Instead, lib/ec2.js emits a trace event when
// the remap fires; downstream observability can detect it from the
// trace stream.
function checkTenancyPricingMismatch(svc) {
  const cc = svc.calculationComponents || {};
  const tenancy = cc.tenancy?.value;
  const selected = cc.pricingStrategy?.value?.selectedOption;
  if (tenancy !== 'shared') return [];
  if (selected !== 'standard' && selected !== 'convertible') return [];
  return [{
    predicate: PREDICATES.TENANCY_PRICING_MISMATCH,
    severity: 'required-only',
    message: `${svc.serviceCode}: pricingStrategy "${selected}" is invalid under shared tenancy — calculator hides Standard/Convertible Reserved Instances and renders Read-only`,
    context: {
      serviceCode: svc.serviceCode,
      tenancy,
      selectedOption: selected,
    },
  }];
}

// Yields every input descendant of a node — used by predicates that need
// to walk a template's input component tree.
function* iterateInputs(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) yield* iterateInputs(x); return; }
  if (node.type === 'input' && node.id) yield node;
  for (const v of Object.values(node)) yield* iterateInputs(v);
}

// Collect (id → component, id → defaultValue) for displayIf evaluation
// inside checkColumnFormDefaultTrap.
function collectComponentDefaults(template) {
  const componentsById = new Map();
  const defaultsById = new Map();
  for (const inp of iterateInputs(template)) {
    componentsById.set(inp.id, inp);
    if (inp.defaultValue !== undefined) defaultsById.set(inp.id, inp.defaultValue);
  }
  return { componentsById, defaultsById };
}

function checkRequiredFieldPresence(svc, definition, catalogEntry) {
  const template = findTemplate(definition, svc.estimateFor);
  if (!template) return [];  // predicate 1 will fail; don't double-report
  const required = findRequiredComponentIds(template, catalogEntry, svc.calculationComponents);
  const cc = svc.calculationComponents || {};
  const failures = [];
  for (const id of required) {
    if (!(id in cc)) {
      failures.push({
        predicate: PREDICATES.REQUIRED_FIELD_PRESENCE,
        severity: 'required-only',
        message: `required component "${id}" missing from calculationComponents for ${svc.serviceCode}`,
        context: { serviceCode: svc.serviceCode, componentId: id },
      });
    }
  }
  return failures;
}

function getParentActiveList(definition) {
  // The parent envelope's "active list" is the union of:
  // - definition.templates[*].id (object-array shape: concrete services)
  // - definition.templates[*] when each is a string (string-array shape:
  //   sub-service-selector parents like SNS, DynamoDB; this is the
  //   common case for this predicate)
  // - any explicit children in definition.mappingDefinitions.children
  const out = new Set();
  for (const t of (definition.templates || [])) {
    if (typeof t === 'string') {
      out.add(t);
    } else if (t && typeof t === 'object' && t.id) {
      out.add(t.id);
    }
  }
  if (definition.mappingDefinitions) {
    const md = definition.mappingDefinitions;
    if (Array.isArray(md.children)) {
      for (const c of md.children) out.add(c);
    }
  }
  return out;
}

function checkSubServiceActiveList(svc, perServiceDefinitions) {
  const failures = [];
  if (!Array.isArray(svc.subServices) || svc.subServices.length === 0) return failures;

  const parentDef = perServiceDefinitions.get(svc.serviceCode);
  if (!parentDef) return failures;  // unknown predicate, skip

  // For sub-service envelopes the parent's "templates" are the
  // child template ids, OR mappingDefinitions.children are the child
  // service codes. We accept membership in either set.
  const allowed = getParentActiveList(parentDef);

  for (const child of svc.subServices) {
    if (!child.serviceCode) {
      failures.push({
        predicate: PREDICATES.SUB_SERVICE_ACTIVE_LIST,
        severity: 'other',
        message: `sub-service entry under ${svc.serviceCode} has no serviceCode`,
        context: { parentServiceCode: svc.serviceCode },
      });
      continue;
    }
    if (allowed.size > 0 && !allowed.has(child.serviceCode) && !allowed.has(child.estimateFor)) {
      failures.push({
        predicate: PREDICATES.SUB_SERVICE_ACTIVE_LIST,
        severity: 'other',
        message: `sub-service "${child.serviceCode}" not in parent ${svc.serviceCode}'s active list [${[...allowed].join(', ')}]`,
        context: { parentServiceCode: svc.serviceCode, childServiceCode: child.serviceCode, allowedActiveList: [...allowed] },
      });
    }
  }
  return failures;
}

function checkFlattenedSubService(svc, manifest) {
  // If a top-level service is itself a sub-service (subType: 'subService')
  // — it should have appeared inside a parent's subServices array, not at
  // top level. The frontend's loader template won't find it there.
  const m = manifest.get(svc.serviceCode);
  if (m && m.subType === 'subService') {
    return [{
      predicate: PREDICATES.SUB_SERVICE_ACTIVE_LIST,
      severity: 'other',
      message: `service "${svc.serviceCode}" is a sub-service but appears at top-level peer position; expected inside parent's subServices envelope`,
      context: { serviceCode: svc.serviceCode },
    }];
  }
  return [];
}

function decideServiceStatus(failures) {
  if (failures.length === 0) return STATUS.EDITABLE;
  const hasOther = failures.some(f => f.severity === 'other');
  if (hasOther) return STATUS.READ_ONLY;
  return STATUS.REQUIRED_INPUT;
}

// Priority order: read-only > required-input > unknown > editable.
// read-only wins because the calculator literally won't let the user edit a
// frozen service — one broken service poisons the whole estimate.
// unknown outranks editable so the linter's own gap (no definition provided)
// doesn't mask itself by falsely reporting "all good".
function rollUpStatus(serviceStatuses) {
  if (serviceStatuses.includes(STATUS.READ_ONLY)) return STATUS.READ_ONLY;
  if (serviceStatuses.includes(STATUS.REQUIRED_INPUT)) return STATUS.REQUIRED_INPUT;
  if (serviceStatuses.includes(STATUS.UNKNOWN)) return STATUS.UNKNOWN;
  return STATUS.EDITABLE;
}

function canRehydrate({ savedBlob, manifest, perServiceDefinitions, catalog, regionList, aggregations }) {
  const services = [];

  // An estimate with zero services rehydrates to a blank, frozen calculator
  // (Export disabled). The per-service predicates can't catch this — they
  // never run when iterateServices yields nothing — so check it explicitly
  // before the loop.
  const allServices = [...iterateServices(savedBlob)];
  if (allServices.length === 0) {
    return {
      status: STATUS.READ_ONLY,
      services: [{
        id: '(no services)',
        parentId: null,
        serviceCode: null,
        estimateFor: null,
        status: STATUS.READ_ONLY,
        failures: [{
          predicate: PREDICATES.EMPTY_ESTIMATE,
          severity: 'other',
          message: 'estimate has no services — saved blob would rehydrate as a blank read-only calculator',
          context: {},
        }],
      }],
    };
  }

  for (const { id, svc, parentId } of allServices) {
    const definition = perServiceDefinitions.get(svc.serviceCode);
    if (!definition) {
      services.push({
        id,
        parentId,
        serviceCode: svc.serviceCode,
        estimateFor: svc.estimateFor,
        status: STATUS.UNKNOWN,
        failures: [{
          predicate: PREDICATES.DEFINITION_UNAVAILABLE,
          severity: 'unknown',
          message: `no PCT definition provided for serviceCode "${svc.serviceCode}"`,
          context: { serviceCode: svc.serviceCode },
        }],
      });
      continue;
    }

    const failures = [];
    const tplFailure = checkTemplateExistence(svc, definition);
    if (tplFailure) failures.push(tplFailure);
    // Catalog entries are keyed by serviceCode (the per-service
    // envelope, child code for sub-service-selector parents). Look up
    // per-service so each service in the saved blob — including NAT
    // children of the VPC parent — gets its own catalog required[]
    // applied. catalog may be a Map (from loadCatalog) or undefined.
    const catalogEntry = catalog && typeof catalog.get === 'function'
      ? catalog.get(svc.serviceCode)
      : undefined;
    if (!tplFailure) {
      // Only check required fields if the template resolves — otherwise
      // we'd flag every required field for a doomed service and dilute
      // the diagnostic.
      failures.push(...checkRequiredFieldPresence(svc, definition, catalogEntry));
      failures.push(...checkValueParsability(svc, definition, catalogEntry));
      failures.push(...checkOneOfMutex(svc, definition));
      failures.push(...checkUnknownFieldIds(svc, definition));
      failures.push(...checkInvalidOptionIds(svc, definition));
      failures.push(...checkInvalidRegion(svc, regionList));
      failures.push(...checkColumnFormDefaultTrap(svc, definition));
      failures.push(...checkColumnFormUnremappedValue(svc, definition));
      // aggregations is optional (a Map keyed by serviceCode). When
      // undefined the predicate is a no-op — offline-test and
      // CDN-unreachable safe.
      failures.push(...checkColumnFormTupleValid(svc, definition, aggregations));
      failures.push(...checkTenancyPricingMismatch(svc));
      // Predicate 4 only applies to PARENT envelopes — not to the
      // sub-service children which iterateServices also yields.
      // `parentId === null` means "not iterated as a child of someone".
      if (parentId === null) {
        failures.push(...checkSubServiceActiveList(svc, perServiceDefinitions));
      }
    }
    if (parentId === null) {
      failures.push(...checkFlattenedSubService(svc, manifest));
    }

    services.push({
      id,
      parentId,
      serviceCode: svc.serviceCode,
      estimateFor: svc.estimateFor,
      status: decideServiceStatus(failures),
      failures,
    });
  }

  return {
    status: rollUpStatus(services.map(s => s.status)),
    services,
  };
}

module.exports = { canRehydrate, PREDICATES, STATUS, findRequiredComponentIds, findTemplate };
