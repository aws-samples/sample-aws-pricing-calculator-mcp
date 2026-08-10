const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { transformConfig } = require('../lib/ec2');

describe('EC2 transformConfig', () => {
  it('produces required fields with minimal config', () => {
    const result = transformConfig({});
    assert.equal(result.tenancy.value, 'shared');
    assert.equal(result.selectedOS.value, 'linux');
    assert.equal(result.workloadSelection.value, 'consistent');
    assert.equal(result.instanceType.value, '');
    assert.deepEqual(result.workload.value, { workloadType: 'consistent', data: '1' });
    assert.equal(result.pricingStrategy.value.selectedOption, 'on-demand');
    assert.equal(result.ec2AdvancedPricingMetrics.value, 1);
    assert.equal(result.detailedMonitoringCheckbox.value, false);
    // dataTransferForEC2 is no longer injected by transformConfig — that
    // responsibility moved to lib/handler-helpers.js#applyDefaultFields
    // (sub-task A 2026-06-03), which reads the catalog's defaultFields
    // block. transformConfig now passes through whatever the merged
    // config supplied.
    assert.equal(result.dataTransferForEC2, undefined,
      'transformConfig must not auto-populate dataTransferForEC2 — that lives in catalog defaultFields now');
  });

  it('passes dataTransferForEC2 through when supplied (post-defaultFields-merge)', () => {
    const dt = { value: [{ entryType: 'INBOUND', value: '5', unit: 'gb_month' }] };
    const result = transformConfig({ dataTransferForEC2: dt });
    assert.deepEqual(result.dataTransferForEC2, dt);
  });

  it('maps quantity to workload data', () => {
    const result = transformConfig({ quantity: 4 });
    assert.equal(result.workload.value.data, '4');
  });

  it('passes through instanceType and OS', () => {
    const result = transformConfig({ instanceType: 'g6.12xlarge', selectedOS: 'windows' });
    assert.equal(result.instanceType.value, 'g6.12xlarge');
    assert.equal(result.selectedOS.value, 'windows');
  });

  it('includes storage when provided', () => {
    const result = transformConfig({ storageType: 'gp3', storageAmount: '100' });
    assert.equal(result.storageType.value, 'Storage General Purpose gp3 GB Mo');
    assert.deepEqual(result.storageAmount, { value: '100', unit: 'gb|NA' });
  });

  it('accepts storage as object', () => {
    const result = transformConfig({ storageAmount: { value: '50', unit: 'gb|NA' } });
    assert.deepEqual(result.storageAmount, { value: '50', unit: 'gb|NA' });
  });

  it('omits storage when not provided', () => {
    const result = transformConfig({});
    assert.equal(result.storageType, undefined);
    assert.equal(result.storageAmount, undefined);
  });

  // Production regression 2026-06-07: agents pass workload as an object
  // that does NOT match the canonical { value: { workloadType, data } }
  // envelope. Pre-fix: lib/ec2.js fell through to `String(workloadInput)`
  // which produced "[object Object]" in the saved blob, rendering the
  // estimate read-only. Post-fix: malformed object input gets a
  // best-effort coercion (numeric-shaped value extracted if findable)
  // or falls back to the default of '1' rather than stringifying the
  // object. Either way "[object Object]" must never appear.
  it('does not stringify a malformed workload object to "[object Object]"', () => {
    const result = transformConfig({
      workload: { type: 'constant', values: { utilization: 80 } },
    });
    assert.notEqual(result.workload.value.data, '[object Object]',
      'malformed workload object must not produce literal "[object Object]" in the saved data');
  });

  it('falls back to default workload when input is malformed object', () => {
    const result = transformConfig({
      workload: { type: 'constant', values: { utilization: 80 } },
    });
    // Default is '1' (one instance). Better defaults than "[object Object]".
    assert.equal(result.workload.value.data, '1',
      'malformed object input should fall back to the default workload data');
  });

  it('accepts canonical envelope workload unchanged', () => {
    const wl = { value: { workloadType: 'consistent', data: '5' } };
    const result = transformConfig({ workload: wl });
    assert.deepEqual(result.workload, wl);
  });

  it('wraps scalar workload into the canonical envelope', () => {
    const result = transformConfig({ workload: 3 });
    assert.equal(result.workload.value.data, '3');
    assert.equal(result.workload.value.workloadType, 'consistent');
  });
});

describe('EC2 pricing strategy', () => {
  it('parses shorthand: computeSavings1yrNoUpfront', () => {
    const result = transformConfig({ pricingStrategy: 'computeSavings1yrNoUpfront' });
    const ps = result.pricingStrategy.value;
    assert.equal(ps.selectedOption, 'compute-savings');
    assert.equal(ps.term, '1 Year');
    assert.equal(ps.upfrontPayment, 'None');
  });

  it('parses shorthand: instanceSavings3yrAllUpfront', () => {
    const result = transformConfig({ pricingStrategy: 'instanceSavings3yrAllUpfront' });
    const ps = result.pricingStrategy.value;
    assert.equal(ps.selectedOption, 'instance-savings');
    assert.equal(ps.term, '3 Year');
    assert.equal(ps.upfrontPayment, 'All');
  });

  it('parses object format', () => {
    const result = transformConfig({
      pricingStrategy: { model: 'computeSavings', term: '1yr', upfrontPayment: 'None' },
    });
    const ps = result.pricingStrategy.value;
    assert.equal(ps.selectedOption, 'compute-savings');
    assert.equal(ps.term, '1 Year');
  });

  it('object format: documented "3 Year" yields 3-Year term (issue #33)', () => {
    // Regression: object-form term was forwarded verbatim and missed the
    // old `=== '3yr'` check, silently pricing as 1-Year.
    const result = transformConfig({
      pricingStrategy: { model: 'computeSavings', term: '3 Year', upfrontPayment: 'None' },
    });
    assert.equal(result.pricingStrategy.value.term, '3 Year');
  });

  it('object format: term is case-insensitive ("3 year" -> "3 Year")', () => {
    const result = transformConfig({
      pricingStrategy: { model: 'instanceSavings', term: '3 year', upfrontPayment: 'All' },
    });
    assert.equal(result.pricingStrategy.value.term, '3 Year');
  });

  it('object format: explicit "1 Year" is honored', () => {
    const result = transformConfig({
      pricingStrategy: { model: 'computeSavings', term: '1 Year', upfrontPayment: 'None' },
    });
    assert.equal(result.pricingStrategy.value.term, '1 Year');
  });

  it('object format: omitted term defaults to 3 Year (cheapest commitment)', () => {
    const result = transformConfig({
      pricingStrategy: { model: 'computeSavings', upfrontPayment: 'None' },
    });
    assert.equal(result.pricingStrategy.value.term, '3 Year');
  });

  it('remaps reserved to instanceSavings for shared tenancy', () => {
    const result = transformConfig({ pricingStrategy: 'reserved1yrNoUpfront', tenancy: 'shared' });
    assert.equal(result.pricingStrategy.value.selectedOption, 'instance-savings');
  });

  it('remaps convertible to computeSavings for shared tenancy', () => {
    const result = transformConfig({ pricingStrategy: 'convertible1yrNoUpfront', tenancy: 'shared' });
    assert.equal(result.pricingStrategy.value.selectedOption, 'compute-savings');
  });

  it('keeps reserved for dedicated tenancy', () => {
    const result = transformConfig({ pricingStrategy: 'reserved1yrNoUpfront', tenancy: 'dedicated' });
    assert.equal(result.pricingStrategy.value.selectedOption, 'standard');
  });

  it('handles on-demand with utilization', () => {
    const result = transformConfig({ pricingStrategy: 'ondemand', utilization: 75 });
    const ps = result.pricingStrategy.value;
    assert.equal(ps.selectedOption, 'on-demand');
    assert.equal(ps.utilizationValue, '75');
  });

  it('reads utilizationValue from a full pricingStrategy envelope (manifest shape)', () => {
    // Production case 2026-06-03 (estimate d12990538f21...): user asked
    // for 80% utilization, agent sent the manifest-canonical envelope
    // shape, transform silently coerced to 100%. The user pushed back
    // twice; agent gave up blaming the calculator UI. Lint can't catch
    // this — the saved blob is structurally valid.
    const result = transformConfig({
      pricingStrategy: {
        value: {
          selectedOption: 'on-demand',
          term: '1 Year',
          utilizationValue: '80',
          utilizationUnit: '%Utilized/Month',
        },
      },
    });
    assert.equal(result.pricingStrategy.value.utilizationValue, '80');
    assert.equal(result.pricingStrategy.value.selectedOption, 'on-demand');
  });

  it('reads utilizationValue from a half-envelope without .value layer', () => {
    // Some agents skip the .value wrapper; accept both shapes so we
    // don't silently default to 100% when the agent's intent is clear.
    const result = transformConfig({
      pricingStrategy: { utilizationValue: '50' },
    });
    assert.equal(result.pricingStrategy.value.utilizationValue, '50');
  });

  it('top-level utilization wins over envelope utilizationValue (explicit beats implicit)', () => {
    // If both are sent, top-level utilization is the explicit shorthand
    // and should take precedence — keeps existing behavior for callers
    // that mix the two shapes.
    const result = transformConfig({
      utilization: 60,
      pricingStrategy: { value: { utilizationValue: '99' } },
    });
    assert.equal(result.pricingStrategy.value.utilizationValue, '60');
  });

  it('defaults to on-demand when no pricingStrategy', () => {
    const result = transformConfig({});
    assert.equal(result.pricingStrategy.value.selectedOption, 'on-demand');
  });
});

describe('EC2 tenancy-remap trace event', () => {
  // The remap inside buildPricingStrategy stays (otherwise existing
  // shared+reserved saves would break). Sub-task C 2026-06-04 added
  // a trace event so observability can detect the asked-X-got-Y
  // divergence, since the saved blob alone shows only the post-remap
  // state. Capture the trace stream by stubbing trace-logger.
  const TRACE_LOGGER_PATH = require.resolve('../lib/trace-logger');
  const TRACE_EVENTS_PATH = require.resolve('../lib/trace-events');
  const EC2_PATH = require.resolve('../lib/ec2');

  function withCapturedEmits(fn) {
    delete require.cache[TRACE_LOGGER_PATH];
    delete require.cache[TRACE_EVENTS_PATH];
    delete require.cache[EC2_PATH];
    const captured = [];
    require.cache[TRACE_LOGGER_PATH] = {
      exports: {
        emit: (event, payload) => { captured.push({ event, payload }); },
      },
    };
    const { transformConfig: tc } = require('../lib/ec2');
    fn(tc);
    delete require.cache[TRACE_LOGGER_PATH];
    delete require.cache[TRACE_EVENTS_PATH];
    delete require.cache[EC2_PATH];
    return captured;
  }

  it('emits ec2.tenancy_remap when shared tenancy remaps reserved → instance-savings', () => {
    const captured = withCapturedEmits((tc) => {
      tc({ pricingStrategy: 'reserved1yrNoUpfront', tenancy: 'shared' });
    });
    const remaps = captured.filter(c => c.event === 'ec2.tenancy_remap');
    assert.equal(remaps.length, 1, 'expected one remap event');
    assert.equal(remaps[0].payload.asked, 'reserved');
    assert.equal(remaps[0].payload.got, 'instanceSavings');
    assert.equal(remaps[0].payload.tenancy, 'shared');
  });

  it('emits ec2.tenancy_remap when shared tenancy remaps convertible → compute-savings', () => {
    const captured = withCapturedEmits((tc) => {
      tc({ pricingStrategy: 'convertible1yrAllUpfront', tenancy: 'shared' });
    });
    const remaps = captured.filter(c => c.event === 'ec2.tenancy_remap');
    assert.equal(remaps.length, 1);
    assert.equal(remaps[0].payload.asked, 'convertible');
    assert.equal(remaps[0].payload.got, 'computeSavings');
  });

  it('does NOT emit ec2.tenancy_remap when no remap happens (dedicated tenancy)', () => {
    const captured = withCapturedEmits((tc) => {
      tc({ pricingStrategy: 'reserved1yrNoUpfront', tenancy: 'dedicated' });
    });
    const remaps = captured.filter(c => c.event === 'ec2.tenancy_remap');
    assert.equal(remaps.length, 0,
      'dedicated tenancy preserves reserved — no remap, no event');
  });

  it('does NOT emit ec2.tenancy_remap for on-demand or savings-plan inputs', () => {
    const captured = withCapturedEmits((tc) => {
      tc({ pricingStrategy: 'ondemand', tenancy: 'shared' });
      tc({ pricingStrategy: 'instanceSavings1yrNoUpfront', tenancy: 'shared' });
    });
    const remaps = captured.filter(c => c.event === 'ec2.tenancy_remap');
    assert.equal(remaps.length, 0);
  });
});
