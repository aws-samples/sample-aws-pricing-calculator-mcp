// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSurfaceabilityIndex,
  surfaceableLabels,
  EC2_ENHANCEMENT_SURFACED,
  NEVER_SURFACES_SUBTYPES,
} = require('../lib/aws/surfaceability');

describe('buildSurfaceabilityIndex', () => {
  it('returns empty for falsy input', () => {
    const r = buildSurfaceabilityIndex(null);
    assert.equal(r.fields.size, 0);
    const r2 = buildSurfaceabilityIndex(undefined);
    assert.equal(r2.fields.size, 0);
  });

  it('marks displayInConfigSummary:true fields as surfaceable for generic services', () => {
    const def = {
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'lambda',
        inputSections: [{
          components: [
            { id: 'numberOfRequests', subType: 'frequency', label: 'Number of requests', displayInConfigSummary: true },
            { id: 'durationOfEachRequest', subType: 'numericInput', label: 'Duration of each request (in ms)', displayInConfigSummary: false },
            { id: 'sizeOfMemoryAllocated', subType: 'fileSize', label: 'Amount of memory allocated' },
          ],
        }],
      }],
    };
    const { fields, source } = buildSurfaceabilityIndex(def);
    assert.equal(source, 'displayInConfigSummary');
    assert.equal(fields.get('numberOfRequests').surfaceable, true);
    assert.equal(fields.get('durationOfEachRequest').surfaceable, false);
    assert.equal(fields.get('sizeOfMemoryAllocated').surfaceable, false,
      'undefined displayInConfigSummary defaults to not-surfaceable (matches container code)');
  });

  it('overrides PCT for ec2Enhancement using the curated picklist', () => {
    const def = {
      serviceCode: 'ec2Enhancement',
      templates: [{
        id: 'template',
        inputSections: [{
          components: [
            // tenancy is in EC2_ENHANCEMENT_SURFACED but we set displayInConfigSummary:false in PCT —
            // the curated list still surfaces it.
            { id: 'tenancy', subType: 'dropdown', label: 'Tenancy', displayInConfigSummary: false },
            // numberOfRequests is NOT a real ec2Enhancement field; even with displayInConfigSummary:true
            // here, it shouldn't surface because the EC2 path ignores the PCT flag for non-listed ids.
            { id: 'someUnrelated', subType: 'numericInput', label: 'Unrelated', displayInConfigSummary: true },
          ],
        }],
      }],
    };
    const { fields, source } = buildSurfaceabilityIndex(def);
    assert.equal(source, 'ec2Enhancement-curated');
    assert.equal(fields.get('tenancy').surfaceable, true,
      'EC2 curated picklist surfaces tenancy regardless of PCT flag');
    assert.equal(fields.get('someUnrelated').surfaceable, false,
      'EC2 curated picklist suppresses non-listed components even when PCT marks them surfaceable');
  });

  it('intermediate component subTypes are never surfaceable even with displayInConfigSummary:true', () => {
    const def = {
      serviceCode: 'someService',
      inputSections: [{
        components: [
          { id: 'mathRef', subType: 'basicMaths', label: 'math', displayInConfigSummary: true },
          { id: 'tier', subType: 'tieredPricingMath', label: 't', displayInConfigSummary: true },
          { id: 'v', subType: 'variable', label: 'v', displayInConfigSummary: true },
        ],
      }],
    };
    const { fields } = buildSurfaceabilityIndex(def);
    for (const id of ['mathRef', 'tier', 'v']) {
      assert.equal(fields.get(id).surfaceable, false,
        `${id}'s container hard-codes configSummaryString=null; PCT flag is irrelevant`);
    }
  });

  it('deduplicates by id, keeping the first occurrence', () => {
    const def = {
      serviceCode: 'svc',
      templates: [
        {
          id: 't1',
          inputSections: [{ components: [
            { id: 'numberOfRequests', subType: 'frequency', label: 'first', displayInConfigSummary: true },
          ]}],
        },
        {
          id: 't2',
          inputSections: [{ components: [
            { id: 'numberOfRequests', subType: 'frequency', label: 'second', displayInConfigSummary: false },
          ]}],
        },
      ],
    };
    const { fields } = buildSurfaceabilityIndex(def);
    assert.equal(fields.get('numberOfRequests').label, 'first');
    assert.equal(fields.get('numberOfRequests').surfaceable, true);
  });

  it('captures fields nested at arbitrary depth', () => {
    const def = {
      serviceCode: 'svc',
      templates: [{
        inputSections: [{
          subSections: [{
            components: [
              { id: 'deeplyNested', subType: 'numericInput', label: 'Deep', displayInConfigSummary: true },
            ],
          }],
        }],
      }],
    };
    const { fields } = buildSurfaceabilityIndex(def);
    assert.equal(fields.get('deeplyNested').surfaceable, true);
  });

  it('exports the EC2 picklist constant for inspection', () => {
    assert.ok(EC2_ENHANCEMENT_SURFACED.has('tenancy'));
    assert.ok(EC2_ENHANCEMENT_SURFACED.has('pricingStrategy'));
    assert.ok(EC2_ENHANCEMENT_SURFACED.has('dataTransferForEC2'));
  });

  it('exports the never-surfaces subtypes constant', () => {
    assert.ok(NEVER_SURFACES_SUBTYPES.has('basicMaths'));
    assert.ok(NEVER_SURFACES_SUBTYPES.has('tieredPricingMath'));
  });

  it('marks displayIf-gated surfaceable fields as conditional', () => {
    // Mirrors the KMS asymmetric-requests case: displayInConfigSummary
    // is true, but the field is gated by a displayIf — the calculator
    // only surfaces it when the gate evaluates true at rehydrate time.
    const def = {
      serviceCode: 'awsKeyManagementService',
      inputSections: [{
        components: [
          { id: 'gated', subType: 'numericInput', label: 'Gated requests', displayInConfigSummary: true,
            displayIf: { exists: { type: 'meteredUnit', meteredUnit: 'someUnit' } } },
        ],
      }],
    };
    const { fields } = buildSurfaceabilityIndex(def);
    const f = fields.get('gated');
    assert.equal(f.surfaceable, 'conditional');
    assert.equal(f.conditional, true);
  });

  it('marks descendants of a displayIf ancestor as conditional', () => {
    // displayIf on the parent card propagates to nested children — even
    // when the child has no displayIf of its own.
    const def = {
      serviceCode: 'someService',
      inputSections: [{
        // Card with displayIf — the components below inherit conditional state
        displayIf: { exists: { type: 'option', selectedId: 'enable' } },
        components: [
          { id: 'nested', subType: 'numericInput', label: 'Nested under gated card', displayInConfigSummary: true },
        ],
      }],
    };
    const { fields } = buildSurfaceabilityIndex(def);
    assert.equal(fields.get('nested').surfaceable, 'conditional');
  });

  it('a non-conditional surfaceable field stays surfaceable: true', () => {
    const def = {
      serviceCode: 'svc',
      inputSections: [{
        components: [
          { id: 'plain', subType: 'numericInput', label: 'plain', displayInConfigSummary: true },
        ],
      }],
    };
    const { fields } = buildSurfaceabilityIndex(def);
    assert.equal(fields.get('plain').surfaceable, true);
    assert.equal(fields.get('plain').conditional, false);
  });
});

describe('surfaceableLabels', () => {
  it('returns labels of unconditionally surfaceable fields only', () => {
    const def = {
      serviceCode: 'svc',
      inputSections: [{ components: [
        { id: 'a', subType: 'frequency', label: 'Show me', displayInConfigSummary: true },
        { id: 'b', subType: 'numericInput', label: 'Hide me', displayInConfigSummary: false },
        { id: 'c', subType: 'dropdown', label: 'Also show', displayInConfigSummary: true },
      ]}],
    };
    const labels = surfaceableLabels(def);
    assert.deepEqual([...labels].sort(), ['Also show', 'Show me']);
  });

  it('excludes conditional fields (displayIf-gated) from the set', () => {
    // The KMS pattern: surfaceable per PCT but gated by a displayIf.
    // The matcher should NOT expect this label — the calculator only
    // emits it when the gate evaluates true at rehydrate time.
    const def = {
      serviceCode: 'svc',
      inputSections: [{ components: [
        { id: 'a', subType: 'numericInput', label: 'Always shown', displayInConfigSummary: true },
        { id: 'b', subType: 'numericInput', label: 'Conditionally shown', displayInConfigSummary: true,
          displayIf: { exists: { type: 'meteredUnit', meteredUnit: 'x' } } },
      ]}],
    };
    const labels = surfaceableLabels(def);
    assert.deepEqual([...labels], ['Always shown']);
  });

  it('returns empty for empty input', () => {
    assert.equal(surfaceableLabels(null).size, 0);
    assert.equal(surfaceableLabels({}).size, 0);
  });
});
