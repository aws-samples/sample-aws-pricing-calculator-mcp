const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canRehydrate } = require('../lib/lint/can-rehydrate');

const ANY_MANIFEST = new Map();
const lambdaDef = {
  serviceCode: 'aWSLambda',
  templates: [
    { id: 'lambda-template-1' },
  ],
};
const PER_SVC_DEFS_LAMBDA = new Map([['aWSLambda', lambdaDef]]);

describe('canRehydrate — template existence (predicate 1)', () => {
  it('returns editable when template id matches', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: {},
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: ANY_MANIFEST,
      perServiceDefinitions: PER_SVC_DEFS_LAMBDA,
    });
    assert.equal(r.status, 'editable');
  });

  it('returns read-only when template id does not match', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'eC2Next',  // wrong template for Lambda
          calculationComponents: {},
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: ANY_MANIFEST,
      perServiceDefinitions: PER_SVC_DEFS_LAMBDA,
    });
    assert.equal(r.status, 'read-only');
    assert.equal(r.services[0].failures[0].predicate, 'template-existence');
  });

  it('rescues via mappingFromTemplate (real example: Lambda)', () => {
    // Real Lambda definition shape: lambdaWithFreeTier carries
    // mappingFromTemplate: 'lambdaWithoutFreeTier'. An estimate that
    // saved with the legacy estimateFor should rescue to the new template.
    const lambdaDefReal = {
      serviceCode: 'aWSLambda',
      templates: [
        { id: 'lambdaWithFreeTier', mappingFromTemplate: 'lambdaWithoutFreeTier' },
        { id: 'lambdaWithoutFreeTier', mappingFromTemplate: null },
      ],
    };
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambdaWithoutFreeTier',  // legacy id, rescues to lambdaWithFreeTier
          calculationComponents: {},
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefReal]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('handles sub-service-selector parent shape: templates as string array', () => {
    // Real shape: amazonSimpleNotificationService has
    // templates: ['standardTopics', 'fifoTopics'] (a string array).
    // A child code matching one of those strings must be acceptable.
    const snsParentDef = {
      serviceCode: 'amazonSimpleNotificationService',
      templates: ['standardTopics', 'fifoTopics'],  // string array, not object array
    };
    const blob = {
      services: {
        s1: {
          serviceCode: 'amazonSimpleNotificationService',
          estimateFor: 'standardTopics',  // matches one of the parent's template strings
          calculationComponents: {},
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map([['amazonSimpleNotificationService', snsParentDef]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('handles sub-service-selector parent shape: templateId names the wrapper', () => {
    // Real shape: SNS parent definition has templateId: 'amazonSnsClassesGroup'
    // and templates: ['standardTopics', 'fifoTopics']. Saved estimates
    // use the wrapper id ('amazonSnsClassesGroup') as estimateFor.
    // checkTemplateExistence must accept definition.templateId as a match.
    const def = {
      serviceCode: 'amazonSimpleNotificationService',
      templateId: 'amazonSnsClassesGroup',
      templates: ['standardTopics', 'fifoTopics'],
    };
    const blob = {
      services: { s1: {
        serviceCode: 'amazonSimpleNotificationService',
        estimateFor: 'amazonSnsClassesGroup',
        calculationComponents: {},
      }},
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map([['amazonSimpleNotificationService', def]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('returns unknown when service definition is not in perServiceDefinitions', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'unknownService',
          estimateFor: 'foo',
          calculationComponents: {},
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map(),
    });
    assert.equal(r.status, 'unknown');
  });
});

describe('canRehydrate — required-field presence (predicate 2)', () => {
  const lambdaDefWithRequired = {
    serviceCode: 'aWSLambda',
    templates: [
      {
        id: 'lambda-template-1',
        inputSections: [
          {
            components: [
              { id: 'numberOfRequests', validations: { required: true } },
              { id: 'requestDuration', validations: { required: true } },
              { id: 'optionalField' },  // not required
            ],
          },
        ],
      },
    ],
  };

  it('returns editable when all required fields are present', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: {
            numberOfRequests: { value: '1', unit: 'millionPerMonth' },
            requestDuration: { value: '200', unit: 'ms' },
          },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefWithRequired]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('returns required-input when only-required fields are missing', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: {},
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefWithRequired]]),
    });
    assert.equal(r.status, 'required-input');
    assert.equal(r.services[0].failures.length, 2);
    assert.equal(r.services[0].failures[0].predicate, 'required-field-presence');
    assert.equal(r.services[0].failures[0].severity, 'required-only');
  });

  it('skips required check when component has displayIf (conditional)', () => {
    const condDef = {
      serviceCode: 'svc',
      templates: [{
        id: 't',
        inputSections: [{
          components: [
            { id: 'condField', validations: { required: true }, displayIf: { foo: 'bar' } },
          ],
        }],
      }],
    };
    const blob = {
      services: {
        s1: { serviceCode: 'svc', estimateFor: 't', calculationComponents: {} },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['svc', condDef]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('skips required check when card has displayIf', () => {
    const condCardDef = {
      serviceCode: 'svc',
      templates: [{
        id: 't',
        inputSections: [{
          displayIf: { foo: 'bar' },
          components: [
            { id: 'normalField', validations: { required: true } },
          ],
        }],
      }],
    };
    const blob = {
      services: {
        s1: { serviceCode: 'svc', estimateFor: 't', calculationComponents: {} },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['svc', condCardDef]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('combines with predicate 1: missing required + bad template = read-only', () => {
    // Two failures, one is template-existence (severity 'other').
    // The required-only escape hatch must not apply.
    const blob = {
      services: {
        s1: { serviceCode: 'aWSLambda', estimateFor: 'wrongId', calculationComponents: {} },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefWithRequired]]),
    });
    // The template doesn't match, so the required-field check would
    // ideally not even run. But if predicate 2 short-circuits when
    // predicate 1 fails, we still expect read-only.
    assert.equal(r.status, 'read-only');
  });

  it('finds required components nested deeper than inputSections.components', () => {
    // Recursion contract: PCT structures nest below the top-level
    // components array (subSections, repeating groups, etc.). The walk
    // must descend into all containers, not just inputSections[*].components.
    const deepDef = {
      serviceCode: 'svc',
      templates: [{
        id: 't',
        inputSections: [{
          subSections: [{
            components: [
              { id: 'deepRequired', validations: { required: true } },
            ],
          }],
        }],
      }],
    };
    const blob = {
      services: {
        s1: { serviceCode: 'svc', estimateFor: 't', calculationComponents: {} },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['svc', deepDef]]),
    });
    assert.equal(r.status, 'required-input');
    assert.equal(r.services[0].failures.length, 1);
    assert.equal(r.services[0].failures[0].context.componentId, 'deepRequired');
  });
});

describe('canRehydrate — catalog-required-field presence', () => {
  // The Lambda manifest under-flags pricing-affecting fields:
  // sizeOfMemoryAllocated and storageAmountEphemeral (among others)
  // are NOT validations.required:true in the manifest, but the
  // catalog flags them required because saves omitting them rehydrate
  // at $0. The linter must consult both sources.
  const lambdaDefManifestUnderflagged = {
    serviceCode: 'aWSLambda',
    templates: [{
      id: 'lambdaWithFreeTier',
      inputSections: [{
        components: [
          { id: 'numberOfRequests' },
          { id: 'sizeOfMemoryAllocated' },
        ],
      }],
    }],
  };

  const lambdaCatalog = new Map([
    ['aWSLambda', {
      serviceCode: 'aWSLambda',
      required: [
        { field: 'numberOfRequests' },
        { field: 'sizeOfMemoryAllocated' },
      ],
    }],
  ]);

  it('flags catalog-required field as missing even when manifest does not flag it required', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambdaWithFreeTier',
          // numberOfRequests present, sizeOfMemoryAllocated missing.
          // Manifest does not mark either required, so without the
          // catalog this would lint editable. Adding the catalog
          // should turn the missing one into a required-only failure.
          calculationComponents: {
            numberOfRequests: { value: '1', unit: 'millionPerMonth' },
          },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefManifestUnderflagged]]),
      catalog: lambdaCatalog,
    });
    assert.equal(r.status, 'required-input');
    const failures = r.services[0].failures;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].predicate, 'required-field-presence');
    assert.equal(failures[0].context.componentId, 'sizeOfMemoryAllocated');
  });

  it('lints editable when all catalog-required fields are present (no manifest required)', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambdaWithFreeTier',
          calculationComponents: {
            numberOfRequests: { value: '1', unit: 'millionPerMonth' },
            sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' },
          },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefManifestUnderflagged]]),
      catalog: lambdaCatalog,
    });
    assert.equal(r.status, 'editable');
  });

  it('lints editable when no catalog is passed (manifest-only behavior preserved)', () => {
    // Backward-compat: callers that don't thread a catalog get the
    // pre-existing predicate behavior — manifest required only.
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambdaWithFreeTier',
          calculationComponents: {
            numberOfRequests: { value: '1', unit: 'millionPerMonth' },
          },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDefManifestUnderflagged]]),
      // catalog: omitted
    });
    assert.equal(r.status, 'editable');
  });

  it('does not double-report when manifest and catalog flag the same field', () => {
    const def = {
      serviceCode: 'svc',
      templates: [{
        id: 't',
        inputSections: [{
          components: [
            { id: 'sharedField', validations: { required: true } },
          ],
        }],
      }],
    };
    const catalog = new Map([
      ['svc', { serviceCode: 'svc', required: [{ field: 'sharedField' }] }],
    ]);
    const blob = {
      services: { s1: { serviceCode: 'svc', estimateFor: 't', calculationComponents: {} } },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['svc', def]]),
      catalog,
    });
    assert.equal(r.status, 'required-input');
    const failures = r.services[0].failures;
    assert.equal(failures.length, 1, 'shared required field must not produce two failures');
  });

  it('applies catalog required[] to sub-service children', () => {
    // Mirrors the NAT-inside-VPC shape that produced production
    // estimate B (1ecef0095a…). The parent envelope has no catalog
    // required fields, but the child does — and the linter walks
    // into subServices to evaluate each child against its own
    // catalog entry.
    // Real VPC parent has templateId === estimateFor — mirror that
    // here so the parent's template-existence check passes and the
    // test focuses on the child.
    const vpcParentDef = {
      serviceCode: 'amazonVirtualPrivateCloud',
      templateId: 'virtualPrivateCloudSubServiceSelector',
      templates: ['networkAddressTranslationGateway'],
    };
    const natChildDef = {
      serviceCode: 'networkAddressTranslationNatGatewayVpc',
      templates: [{ id: 'networkAddressTranslationGateway', inputSections: [] }],
    };
    const catalog = new Map([
      ['networkAddressTranslationNatGatewayVpc', {
        serviceCode: 'networkAddressTranslationNatGatewayVpc',
        required: [
          { field: 'regionalNatGatewayCount' },
          { field: 'regionalNatGatewayAzCount' },
          { field: 'regionalNatGatewayDataProcessed' },
        ],
      }],
    ]);
    const blob = {
      services: {
        s1: {
          serviceCode: 'amazonVirtualPrivateCloud',
          estimateFor: 'virtualPrivateCloudSubServiceSelector',
          subServices: [{
            serviceCode: 'networkAddressTranslationNatGatewayVpc',
            estimateFor: 'networkAddressTranslationGateway',
            // Missing regionalNatGatewayDataProcessed — exactly B.
            calculationComponents: {
              regionalNatGatewayCount: { value: '1' },
              regionalNatGatewayAzCount: { value: '1' },
            },
          }],
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([
        ['amazonVirtualPrivateCloud', vpcParentDef],
        ['networkAddressTranslationNatGatewayVpc', natChildDef],
      ]),
      catalog,
    });
    assert.equal(r.status, 'required-input');
    const childFailures = r.services
      .filter(s => s.serviceCode === 'networkAddressTranslationNatGatewayVpc')
      .flatMap(s => s.failures);
    assert.equal(childFailures.length, 1);
    assert.equal(childFailures[0].context.componentId, 'regionalNatGatewayDataProcessed');
  });
});

describe('canRehydrate — math-operand-required walk', () => {
  // The math walk catches Lambda-class silent-$0 traps from manifest
  // data alone, without needing a catalog entry. It opts in to math
  // expressions whose user-input required operands are partially
  // populated, then flags the missing operands.

  const lambdaLikeDef = {
    serviceCode: 'aWSLambdaLike',
    templates: [{
      id: 'lambdaLike',
      cards: [{
        inputSection: {
          components: [
            { id: 'numberOfRequests', type: 'input', subType: 'frequency' },
            { id: 'durationOfEachRequest', type: 'input', subType: 'numericInput' },
            { id: 'sizeOfMemoryAllocated', type: 'input', subType: 'fileSize' },
          ],
        },
        mathsSection: [{
          components: [
            // Request-cost expression: requests × price.
            {
              type: 'maths', subType: 'basicMaths',
              operands: [
                { variableId: 'numberOfRequests', required: true },
                { variableId: '_internal_request_price', required: false },
              ],
            },
            // GB-second expression: requests × duration × memory × price.
            // All three user inputs are required; pricing zeros out
            // when any are missing.
            {
              type: 'maths', subType: 'basicMaths',
              operands: [
                { variableId: 'numberOfRequests', required: true },
                { variableId: 'durationOfEachRequest', required: true },
                { variableId: 'sizeOfMemoryAllocated', required: true },
                { variableId: '_internal_gb_second_price', required: false },
              ],
            },
          ],
        }],
      }],
    }],
  };

  it('flags missing required operands when the math expression has been opted into', () => {
    // Saved blob has duration but not memory — the GB-second math
    // is partly populated, so memory should be flagged.
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambdaLike',
        estimateFor: 'lambdaLike',
        calculationComponents: {
          numberOfRequests: { value: '100', unit: 'millionPerMonth' },
          durationOfEachRequest: { value: '200' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambdaLike', lambdaLikeDef]]),
    });
    assert.equal(r.status, 'required-input');
    const ids = r.services[0].failures.map(f => f.context.componentId);
    assert.ok(ids.includes('sizeOfMemoryAllocated'),
      `expected sizeOfMemoryAllocated flagged; got ${JSON.stringify(ids)}`);
  });

  it('does not flag operands when the math expression has not been opted into', () => {
    // Saved blob is empty — agent didn't opt into any math.
    // Math walk should flag nothing.
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambdaLike',
        estimateFor: 'lambdaLike',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambdaLike', lambdaLikeDef]]),
    });
    // Note: this empty blob will still trigger the empty-estimate
    // predicate at the canRehydrate layer if the savedBlob has no
    // services. Here we have one service with no components, so
    // empty-estimate doesn't fire — only required-field-presence.
    // With nothing populated, math walk shouldn't flag anything:
    const failures = r.services[0]?.failures || [];
    assert.equal(failures.length, 0,
      `expected no failures; got ${JSON.stringify(failures.map(f => f.message))}`);
  });

  it('does not flag siblings in independent suffix-numbered slots (MediaLive case)', () => {
    // MediaLive's mediaLiveOutput1 PCT exposes 6 Output slots (Output 1–6)
    // as 6 cards. Each card has a `_totalActiveHours` intermediate whose
    // operands are 2 user-inputs — both `validations.required: false` —
    // with non-zero defaults (730). The intermediate then feeds a
    // `_costMonthly` expression with required operands.
    //
    // Pre-fix: the closure activates `_totalActiveHours` immediately
    // because no operand is `required: true`. That activation falsely
    // signals card-opt-in for the cost expression, which then flags
    // `_numberOfOutputs` as missing — even though the user populated
    // ZERO fields in that card.
    //
    // Post-fix rule: an intermediate's closure activation requires at
    // least ONE user-input operand to be populated as non-default,
    // regardless of `required`. Otherwise the intermediate is "all
    // defaults" and isn't real evidence of opt-in.
    const slotDef = {
      serviceCode: 'mediaLiveLike',
      templates: [{
        id: 'mediaLikeTpl',
        cards: [
          // Card 0 (Output 1) — populated by the agent.
          {
            inputSection: {
              components: [
                { id: 'output1_count', type: 'input', subType: 'numericInput', defaultValue: 1 },
                { id: 'output1_hours', type: 'input', subType: 'numericInput', defaultValue: 730 },
              ],
            },
            mathsSection: [{
              components: [
                { type: 'maths', subType: 'basicMaths', id: 'output1_total',
                  operands: [{ variableId: 'output1_hours', required: false }] },
                { type: 'maths', subType: 'basicMaths', id: 'output1_cost',
                  operands: [
                    { variableId: 'output1_count', required: true },
                    { variableId: 'output1_total', required: true },
                  ] },
              ],
            }],
          },
          // Card 1 (Output 2) — NOT populated; should NOT be flagged.
          {
            inputSection: {
              components: [
                { id: 'output2_count', type: 'input', subType: 'numericInput', defaultValue: 0 },
                { id: 'output2_hours', type: 'input', subType: 'numericInput', defaultValue: 730 },
              ],
            },
            mathsSection: [{
              components: [
                { type: 'maths', subType: 'basicMaths', id: 'output2_total',
                  operands: [{ variableId: 'output2_hours', required: false }] },
                { type: 'maths', subType: 'basicMaths', id: 'output2_cost',
                  operands: [
                    { variableId: 'output2_count', required: true },
                    { variableId: 'output2_total', required: true },
                  ] },
              ],
            }],
          },
        ],
      }],
    };
    // Saved blob populates Output 1 only.
    const blob = {
      services: { s1: {
        serviceCode: 'mediaLiveLike',
        estimateFor: 'mediaLikeTpl',
        calculationComponents: {
          output1_count: { value: '2' },
          output1_hours: { value: '500' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['mediaLiveLike', slotDef]]),
    });
    const flagged = (r.services[0].failures || []).map(f => f.context?.componentId);
    assert.ok(!flagged.includes('output2_count'),
      `output2_count must not be flagged when Output 2 card is empty; got ${JSON.stringify(flagged)}`);
    assert.ok(!flagged.includes('output2_hours'),
      `output2_hours must not be flagged when Output 2 card is empty; got ${JSON.stringify(flagged)}`);
  });

  it('filters out internal math variables — only user-input fields are flagged', () => {
    // Even though `_internal_gb_second_price` is `required: true`
    // in the math, it's not a user-input field — never flagged.
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambdaLike',
        estimateFor: 'lambdaLike',
        calculationComponents: {
          numberOfRequests: { value: '100', unit: 'millionPerMonth' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambdaLike', lambdaLikeDef]]),
    });
    const flagged = r.services[0].failures.map(f => f.context.componentId);
    assert.ok(!flagged.some(id => id.startsWith('_internal_')),
      `internal variables should never be flagged; got ${JSON.stringify(flagged)}`);
  });

  // Feature-gate class. The calculator's math evaluator silently
  // returns 0 when ANY required operand is missing — no UI error, no
  // save block. Our lint should mirror that: flag a missing required
  // user-input operand ONLY when at least one OTHER required user-input
  // operand of the same expression is populated. 2-op expressions with
  // only one operand populated → don't flag; 3-op chains with 2 of 3
  // populated → still flag.
  const textractLikeDef = {
    serviceCode: 'amazonTextractLike',
    templates: [{
      id: 'textractLike',
      cards: [{
        inputSection: {
          components: [
            { id: 'numberOfPages', type: 'input', subType: 'numericInput' },
            // percentWithText has defaultValue 100 in real Textract — this
            // matters: user populating { value: '100' } matches the default
            // and isPopulatedAsNonDefault returns false. Without modeling
            // this, the test data doesn't reflect real production shape.
            { id: 'percentWithText', type: 'input', subType: 'percentInput', defaultValue: 100 },
            { id: 'percentWithFeatureA', type: 'input', subType: 'percentInput' },
            { id: 'percentWithFeatureB', type: 'input', subType: 'percentInput' },
            { id: 'percentWithFeatureC', type: 'input', subType: 'percentInput' },
            { id: 'percentWithFeatureD', type: 'input', subType: 'percentInput' },
          ],
        },
        mathsSection: [{
          components: [
            // 5 expressions all of shape [numberOfPages, percentWithX].
            // numberOfPages is the heavily-shared "magnitude"; each
            // percentWithX is a unique feature flag.
            { type: 'maths', subType: 'basicMaths', operands: [
              { variableId: 'numberOfPages', required: true },
              { variableId: 'percentWithText', required: true },
            ]},
            { type: 'maths', subType: 'basicMaths', operands: [
              { variableId: 'numberOfPages', required: true },
              { variableId: 'percentWithFeatureA', required: true },
            ]},
            { type: 'maths', subType: 'basicMaths', operands: [
              { variableId: 'numberOfPages', required: true },
              { variableId: 'percentWithFeatureB', required: true },
            ]},
            { type: 'maths', subType: 'basicMaths', operands: [
              { variableId: 'numberOfPages', required: true },
              { variableId: 'percentWithFeatureC', required: true },
            ]},
            { type: 'maths', subType: 'basicMaths', operands: [
              { variableId: 'numberOfPages', required: true },
              { variableId: 'percentWithFeatureD', required: true },
            ]},
          ],
        }],
      }],
    }],
  };

  it('does not flag feature-gate siblings when only the heavily-shared operand is populated (Textract case)', () => {
    // User wants Detect Document Text only — populates numberOfPages
    // and percentWithText. The 4 other percentWithFeatureN siblings
    // should NOT flag. Pre-fix behavior: all 4 flag (numberOfPages
    // populated → all 5 expressions opt in → 4 missing flagged).
    const blob = {
      services: { s1: {
        serviceCode: 'amazonTextractLike',
        estimateFor: 'textractLike',
        calculationComponents: {
          numberOfPages: { value: '1000' },
          percentWithText: { value: '100' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['amazonTextractLike', textractLikeDef]]),
    });
    const flagged = (r.services[0]?.failures || [])
      .filter(f => f.predicate === 'required-field-presence')
      .map(f => f.context.componentId);
    const featureGates = ['percentWithFeatureA', 'percentWithFeatureB', 'percentWithFeatureC', 'percentWithFeatureD'];
    for (const id of featureGates) {
      assert.ok(!flagged.includes(id),
        `${id} must NOT be flagged when only the shared operand is populated; got ${JSON.stringify(flagged)}`);
    }
  });

  it('flags missing operand when sibling IS populated (3-operand silent-zero trap, Lambda case)', () => {
    // The math walk's original purpose: when user populates 2 of 3
    // required operands, flag the missing one. Here memoryAllocated
    // is the silent-zero trap (cost goes to 0 if missing while requests
    // and duration are set).
    const lambda3OpDef = {
      serviceCode: 'aWSLambda3OpLike',
      templates: [{
        id: 'lambda3Op',
        cards: [{
          inputSection: {
            components: [
              { id: 'numberOfRequests', type: 'input', subType: 'frequency' },
              { id: 'durationOfEachRequest', type: 'input', subType: 'numericInput' },
              { id: 'sizeOfMemoryAllocated', type: 'input', subType: 'numericInput' },
            ],
          },
          mathsSection: [{
            components: [
              { type: 'maths', subType: 'basicMaths', operands: [
                { variableId: 'numberOfRequests', required: true },
                { variableId: 'durationOfEachRequest', required: true },
                { variableId: 'sizeOfMemoryAllocated', required: true },
              ]},
            ],
          }],
        }],
      }],
    };
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda3OpLike',
        estimateFor: 'lambda3Op',
        calculationComponents: {
          numberOfRequests: { value: '100', unit: 'millionPerMonth' },
          durationOfEachRequest: { value: '200' },
          // sizeOfMemoryAllocated MISSING — should still flag.
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda3OpLike', lambda3OpDef]]),
    });
    const flagged = (r.services[0]?.failures || [])
      .filter(f => f.predicate === 'required-field-presence')
      .map(f => f.context.componentId);
    assert.ok(flagged.includes('sizeOfMemoryAllocated'),
      `3-op silent-zero trap must still flag the missing operand; got ${JSON.stringify(flagged)}`);
  });

  it('does NOT flag a 2-operand expression when only one operand is populated (Fargate-shape regression)', () => {
    // Per the calculator's silent-zero Gate B: a 2-operand expression
    // with one missing operand silently returns 0. Mirror that: don't
    // flag. This is a behavior change vs. pre-fix — Fargate's
    // [numberOfTasks, taskDuration] shape used to flag taskDuration if
    // only numberOfTasks was populated.
    const fargateLikeDef = {
      serviceCode: 'awsFargateLike',
      templates: [{
        id: 'fargateLike',
        cards: [{
          inputSection: {
            components: [
              { id: 'numberOfTasks', type: 'input', subType: 'numericInput' },
              { id: 'taskDuration', type: 'input', subType: 'numericInput' },
            ],
          },
          mathsSection: [{
            components: [
              { type: 'maths', subType: 'basicMaths', operands: [
                { variableId: 'numberOfTasks', required: true },
                { variableId: 'taskDuration', required: true },
              ]},
            ],
          }],
        }],
      }],
    };
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargateLike',
        estimateFor: 'fargateLike',
        calculationComponents: {
          numberOfTasks: { value: '100' },
          // taskDuration MISSING.
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['awsFargateLike', fargateLikeDef]]),
    });
    const flagged = (r.services[0]?.failures || [])
      .filter(f => f.predicate === 'required-field-presence')
      .map(f => f.context.componentId);
    assert.ok(!flagged.includes('taskDuration'),
      `2-op expression with one populated operand must not flag the missing one (mirrors calculator Gate B); got ${JSON.stringify(flagged)}`);
    assert.ok(!flagged.includes('numberOfTasks'),
      `the populated operand must never flag itself; got ${JSON.stringify(flagged)}`);
  });

  it('does not flag when only a default-valued operand is "populated" (matches calculator silent-zero)', () => {
    // percentWithText.defaultValue = 100. User passes { value: '100' }
    // — matches the default. isPopulatedAsNonDefault returns false.
    // Per the calculator: this is NOT a meaningful opt-in signal. The
    // expression silently returns 0. Pre-fix behavior: would have
    // flagged percentWithFeatureA etc. via numberOfPages alone. This
    // test is the production-parity check — confirms the rule mirrors
    // calculator silent-zero behavior across the whole 2-op feature
    // gate set.
    const blob = {
      services: { s1: {
        serviceCode: 'amazonTextractLike',
        estimateFor: 'textractLike',
        calculationComponents: {
          numberOfPages: { value: '1000' },
          percentWithText: { value: '100' },  // matches default — not opt-in
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['amazonTextractLike', textractLikeDef]]),
    });
    const flagged = (r.services[0]?.failures || [])
      .filter(f => f.predicate === 'required-field-presence')
      .map(f => f.context.componentId);
    const featureGates = ['percentWithFeatureA', 'percentWithFeatureB', 'percentWithFeatureC', 'percentWithFeatureD'];
    for (const id of featureGates) {
      assert.ok(!flagged.includes(id),
        `${id} must NOT be flagged when only the shared (numberOfPages) and default-valued (percentWithText=100) operands are present; got ${JSON.stringify(flagged)}`);
    }
  });
});

describe('canRehydrate — math walk + displayIf gating', () => {
  // The math walk respects manifest displayIf rules on input
  // components. Fields gated off by the canonical config's choices
  // are skipped — matches the calculator's UI behavior, which
  // hides the field and auto-defaults the math operand.

  const rdsLikeDef = {
    serviceCode: 'rdsLike',
    templates: [{
      id: 'rdsTemplate',
      cards: [{
        inputSection: {
          components: [
            { id: 'storageVolume', type: 'input', subType: 'dropdown' },
            { id: 'storageAmount', type: 'input', subType: 'fileSize' },
            // gp3Iops is gated: only visible when storageVolume is
            // GP3 AND storageAmount >= 400.
            {
              id: 'gp3Iops', type: 'input', subType: 'numericInput',
              defaultValue: 3000,
              displayIf: {
                and: [
                  { '==': [{ type: 'component', id: 'storageVolume' }, 'General Purpose-GP3'] },
                  { '>=': [{ type: 'component', id: 'storageAmount' }, 400] },
                ],
              },
            },
          ],
        },
        mathsSection: [{
          components: [
            // Math expression that references gp3Iops as required.
            {
              type: 'maths', subType: 'basicMaths',
              operands: [
                { variableId: 'storageAmount', required: true },
                { variableId: 'gp3Iops', required: true },
                { variableId: '_internal_gp3_price', required: false },
              ],
            },
          ],
        }],
      }],
    }],
  };

  it('skips operands whose input displayIf evaluates false (auto-defaulted by calc)', () => {
    // Storage 100 GB → gp3Iops's displayIf condition (>= 400) fails
    // → field is hidden in the UI, calculator auto-defaults to 3000
    // → math walk should NOT flag gp3Iops as required.
    const blob = {
      services: { s1: {
        serviceCode: 'rdsLike',
        estimateFor: 'rdsTemplate',
        calculationComponents: {
          storageVolume: { value: 'General Purpose-GP3' },
          storageAmount: { value: '100', unit: 'gb|NA' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['rdsLike', rdsLikeDef]]),
    });
    assert.equal(r.status, 'editable',
      `expected editable; got ${r.status}, failures: ${JSON.stringify(r.services[0]?.failures)}`);
  });

  it('does NOT flag 2-operand math when only one user-input is populated (broad-fix trade-off)', () => {
    // 2-operand expressions with only ONE populated user-input no
    // longer flag — mirroring the calculator's silent-zero behavior:
    // any missing required operand makes the expression evaluate to 0
    // with no UI error.
    //
    // Pre-fix this test asserted the inverse: storageAmount populated,
    // gp3Iops missing → flag. Earlier production analysis cited the
    // RDS-PG gp3Iops case as a real catch.
    //
    // Post-fix: only 1 user-input operand of the 2-op math expression
    // (`[storageAmount, gp3Iops]`) is populated → no opt-in evidence →
    // no flag. Trade accepted: silencing this catch removes the
    // Textract false-positive class production case (16-22 false flags
    // per estimate). If the RDS gp3Iops case re-emerges as a real
    // problem, the catalog-driven required[] promotion path (source 2)
    // is still active — promote gp3Iops there for affected services.
    const blob = {
      services: { s1: {
        serviceCode: 'rdsLike',
        estimateFor: 'rdsTemplate',
        calculationComponents: {
          storageVolume: { value: 'General Purpose-GP3' },
          storageAmount: { value: '500', unit: 'gb|NA' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['rdsLike', rdsLikeDef]]),
    });
    const ids = (r.services[0]?.failures || []).map(f => f.context.componentId);
    assert.ok(!ids.includes('gp3Iops'),
      `gp3Iops must NOT be flagged with only 1 user-input operand populated; got ${JSON.stringify(ids)}`);
  });

  it('treats unknown displayIf operands as not-visible (conservative for math walk)', () => {
    // storageVolume isn't populated; we can't evaluate the
    // displayIf. Math walk's policy: skip flagging when unknown
    // (avoids false positives). Source 1 (form-side) and Source 2
    // (catalog) handle the stricter case for cataloged services.
    const blob = {
      services: { s1: {
        serviceCode: 'rdsLike',
        estimateFor: 'rdsTemplate',
        calculationComponents: {
          storageAmount: { value: '500', unit: 'gb|NA' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['rdsLike', rdsLikeDef]]),
    });
    // gp3Iops should NOT be flagged because displayIf can't be
    // evaluated cleanly (storageVolume missing).
    const ids = (r.services[0]?.failures || []).map(f => f.context.componentId);
    assert.ok(!ids.includes('gp3Iops'),
      `gp3Iops shouldn't fire on unknown displayIf; got ${JSON.stringify(ids)}`);
  });
});

describe('canRehydrate — oneOf mutex (predicate 5)', () => {
  // The oneOf rule fires when an addition expression sums variants
  // gated by the same field with disjoint values — e.g. Fargate's
  // memory variants gated by vcpuPerTask. If the gating field is
  // populated, the variant matching its value must also be populated.

  const fargateLikeDef = {
    serviceCode: 'awsFargate',
    templates: [{
      id: 'template',
      cards: [{
        inputSection: {
          components: [
            { id: 'vcpuPerTask', type: 'input', subType: 'dropdown',
              validations: { required: true } },
            { id: 'smallMemory', type: 'input', subType: 'dropdown',
              validations: { required: false },
              displayIf: { '==': [{ type: 'component', id: 'vcpuPerTask' }, 0.25] } },
            { id: 'memoryStandardFargateOnDemand', type: 'input', subType: 'fileSize',
              validations: { required: false },
              displayIf: { or: [
                { '==': [{ type: 'component', id: 'vcpuPerTask' }, '0.5'] },
                { '==': [{ type: 'component', id: 'vcpuPerTask' }, '1'] },
                { '==': [{ type: 'component', id: 'vcpuPerTask' }, '2'] },
                { '==': [{ type: 'component', id: 'vcpuPerTask' }, '4'] },
              ] } },
            { id: 'smallMemory_8', type: 'input', subType: 'dropdown',
              validations: { required: false },
              displayIf: { '==': [{ type: 'component', id: 'vcpuPerTask' }, 8] } },
            // Aliases that resolve back to the inputs.
            { type: 'maths', subType: 'variable', id: 'selectedSmallMemory', refer: 'smallMemory' },
            { type: 'maths', subType: 'variable', id: 'selectedSmallMemory8', refer: 'smallMemory_8' },
          ],
        },
        mathsSection: [{
          components: [{
            type: 'maths', subType: 'basicMaths',
            operation: 'addition',
            operands: [
              { variableId: 'memoryStandardFargateOnDemand', required: false },
              { variableId: 'selectedSmallMemory', required: false },
              { variableId: 'selectedSmallMemory8', required: false },
            ],
          }],
        }],
      }],
    }],
  };
  const PER_SVC = new Map([['awsFargate', fargateLikeDef]]);

  it('flags missing variant when gating field selects it', () => {
    // vcpuPerTask=1 → memoryStandardFargateOnDemand variant required
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargate',
        estimateFor: 'template',
        calculationComponents: { vcpuPerTask: '1' },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    assert.equal(r.status, 'required-input',
      `expected required-input; got ${r.status}, failures: ${JSON.stringify(r.services[0]?.failures)}`);
    const oneOfFailures = r.services[0].failures.filter(f => f.predicate === 'one-of-mutex');
    assert.equal(oneOfFailures.length, 1);
    assert.equal(oneOfFailures[0].context.expectedComponentId, 'memoryStandardFargateOnDemand');
    assert.equal(oneOfFailures[0].context.gatingField, 'vcpuPerTask');
    assert.equal(oneOfFailures[0].context.gatingValue, '1');
  });

  it('flags the alias-resolved variant when gating value matches', () => {
    // vcpuPerTask=0.25 → smallMemory (via selectedSmallMemory alias) required
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargate',
        estimateFor: 'template',
        calculationComponents: { vcpuPerTask: '0.25' },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const oneOfFailures = r.services[0].failures.filter(f => f.predicate === 'one-of-mutex');
    assert.equal(oneOfFailures.length, 1);
    assert.equal(oneOfFailures[0].context.expectedComponentId, 'smallMemory');
  });

  it('passes when the correct variant is populated', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargate',
        estimateFor: 'template',
        calculationComponents: {
          vcpuPerTask: '1',
          memoryStandardFargateOnDemand: { value: '2', unit: 'gb|NA' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const oneOfFailures = (r.services[0]?.failures || []).filter(f => f.predicate === 'one-of-mutex');
    assert.equal(oneOfFailures.length, 0);
  });

  it('skips when gating field is missing (form-side handles it)', () => {
    // No vcpuPerTask in saved blob; oneOf check shouldn't fire — the
    // form-side walk catches missing required gating fields.
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargate',
        estimateFor: 'template',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const oneOfFailures = (r.services[0]?.failures || []).filter(f => f.predicate === 'one-of-mutex');
    assert.equal(oneOfFailures.length, 0,
      `oneOf shouldn't fire when gating field is missing; got ${JSON.stringify(oneOfFailures)}`);
  });

  it('skips when gating value matches no member', () => {
    // vcpuPerTask=99 doesn't trigger any member — silent pass (info-only choice)
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargate',
        estimateFor: 'template',
        calculationComponents: { vcpuPerTask: '99' },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const oneOfFailures = (r.services[0]?.failures || []).filter(f => f.predicate === 'one-of-mutex');
    assert.equal(oneOfFailures.length, 0);
  });

  it('handles { value, unit } wrapping of gating field', () => {
    // Some saved entries wrap scalar dropdowns as { value: '1' }
    const blob = {
      services: { s1: {
        serviceCode: 'awsFargate',
        estimateFor: 'template',
        calculationComponents: { vcpuPerTask: { value: '1' } },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const oneOfFailures = r.services[0].failures.filter(f => f.predicate === 'one-of-mutex');
    assert.equal(oneOfFailures.length, 1);
    assert.equal(oneOfFailures[0].context.expectedComponentId, 'memoryStandardFargateOnDemand');
  });
});

describe('canRehydrate — unknown field IDs (typo defense)', () => {
  // Closes the gap between validateConfigKeys (runs at add_service)
  // and the lint path (runs at validate/export/import). A typo'd key
  // saves cleanly and the pricing engine ignores it; without this
  // predicate the lint catches "required field missing" but says
  // nothing about the unknown sibling that's masquerading as it.

  const lambdaLikeDef = {
    serviceCode: 'aWSLambda',
    templates: [{
      id: 'lambdaWithFreeTier',
      cards: [{
        inputSection: {
          components: [
            { id: 'numberOfRequests', type: 'input', subType: 'frequency',
              validations: { required: false } },
            { id: 'durationOfEachRequest', type: 'input', subType: 'numericInput',
              validations: { required: false } },
            { id: 'sizeOfMemoryAllocated', type: 'input', subType: 'fileSize',
              validations: { required: false } },
          ],
        },
      }],
    }],
  };
  const PER_SVC = new Map([['aWSLambda', lambdaLikeDef]]);

  it('flags a typo with a Levenshtein-near suggestion', () => {
    // 'durationOfEach' → close enough to 'durationOfEachRequest'
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {
          numberOfRequests: { value: '1', unit: 'millionPerMonth' },
          durationOfEach: '200',
          sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'unknown-field-id');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.componentId, 'durationOfEach');
    assert.ok(fails[0].context.suggestions.includes('durationOfEachRequest'),
      `expected durationOfEachRequest suggestion; got ${JSON.stringify(fails[0].context.suggestions)}`);
    assert.match(fails[0].message, /Did you mean/);
  });

  it('flags a far-off typo without a suggestion', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {
          numberOfRequests: { value: '1', unit: 'millionPerMonth' },
          totallyMadeUpKey: '200',
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'unknown-field-id');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.componentId, 'totallyMadeUpKey');
    assert.equal(fails[0].context.suggestions.length, 0);
    assert.doesNotMatch(fails[0].message, /Did you mean/);
  });

  it('does not flag known fields', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {
          numberOfRequests: { value: '1', unit: 'millionPerMonth' },
          durationOfEachRequest: '200',
          sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'unknown-field-id');
    assert.equal(fails.length, 0);
  });

  it('verdict goes to required-input (not read-only) when typo is the only failure', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {
          numberOfRequests: { value: '1', unit: 'millionPerMonth' },
          durationOfEachRequest: '200',
          sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' },
          extraTypo: 'whatever',
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    assert.equal(r.status, 'required-input',
      `expected required-input; got ${r.status}`);
  });

  it('skips when calculationComponents is empty (other predicates handle it)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'unknown-field-id');
    assert.equal(fails.length, 0);
  });
});

describe('canRehydrate — invalid option ids (dropdown + frequency)', () => {
  // Whitelists saved-blob values against the field's published options[].
  // Catches the "valid-as-shape, invalid-as-id" class — e.g. Step
  // Functions Standard's numberOfExecutions accepts the frequency
  // unit `millionPerMonth` schematically but the pricing engine
  // silently zeros because that template's options are
  // [perHour, perDay, perMonth].

  const sfStandardDef = {
    serviceCode: 'stepFunctionStandard',
    templates: [{
      id: 'template_0',
      cards: [{
        inputSection: {
          components: [
            { id: 'numberOfExecutions', type: 'input', subType: 'frequency',
              options: [{ id: 'perHour' }, { id: 'perDay' }, { id: 'perMonth' }],
              validations: { required: true } },
            { id: 'pricingMode', type: 'input', subType: 'dropdown',
              options: [{ id: 'standard' }, { id: 'express' }] },
          ],
        },
      }],
    }],
  };
  const PER_SVC = new Map([['stepFunctionStandard', sfStandardDef]]);

  it('flags an out-of-options frequency unit', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'stepFunctionStandard',
        estimateFor: 'template_0',
        calculationComponents: {
          numberOfExecutions: { value: '8', unit: 'millionPerMonth' },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = r.services[0].failures.filter(f => f.predicate === 'invalid-option-id');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.componentId, 'numberOfExecutions');
    assert.equal(fails[0].context.slot, 'unit');
    assert.equal(fails[0].context.observed, 'millionPerMonth');
  });

  it('flags an out-of-options dropdown value', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'stepFunctionStandard',
        estimateFor: 'template_0',
        calculationComponents: {
          numberOfExecutions: { value: '8', unit: 'perMonth' },
          pricingMode: { value: 'unknown-mode' },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = r.services[0].failures.filter(f => f.predicate === 'invalid-option-id');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.componentId, 'pricingMode');
    assert.equal(fails[0].context.slot, 'value');
  });

  it('passes when values are in the options enum', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'stepFunctionStandard',
        estimateFor: 'template_0',
        calculationComponents: {
          numberOfExecutions: { value: '8', unit: 'perMonth' },
          pricingMode: { value: 'standard' },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'invalid-option-id');
    assert.equal(fails.length, 0);
  });

  it('accepts a bare-scalar dropdown value (not wrapped)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'stepFunctionStandard',
        estimateFor: 'template_0',
        calculationComponents: {
          pricingMode: 'standard',
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'invalid-option-id');
    assert.equal(fails.length, 0);
  });
});

describe('canRehydrate — invalid region', () => {
  // Region whitelist gates services against partition-specific
  // region-list. Caller passes regionList in (loaded by
  // canRehydrateFetch from the partition's region resource); when
  // the list is unreachable we skip silently — matches the
  // validation.js behavior at add_service time.

  const def = {
    serviceCode: 'aWSLambda',
    templates: [{ id: 'lambdaWithFreeTier' }],
  };
  const PER_SVC = new Map([['aWSLambda', def]]);
  const regionList = { aWSLambda: ['us-east-1', 'us-east-2', 'eu-west-1'] };

  it('flags a region not in the service list', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        region: 'us-fake-1',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, regionList });
    const fails = r.services[0].failures.filter(f => f.predicate === 'invalid-region');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.observed, 'us-fake-1');
  });

  it('passes when region is in the service list', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        region: 'eu-west-1',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, regionList });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'invalid-region');
    assert.equal(fails.length, 0);
  });

  it('skips when regionList is not provided (best-effort)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        region: 'us-fake-1',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'invalid-region');
    assert.equal(fails.length, 0);
  });

  it('skips when service is missing from regionList (incomplete coverage)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        region: 'us-fake-1',
        estimateFor: 'lambdaWithFreeTier',
        calculationComponents: {},
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, regionList: { someOtherService: ['us-east-1'] } });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'invalid-region');
    assert.equal(fails.length, 0);
  });
});

describe('canRehydrate — column-form-default-trap', () => {
  // Production case 2026-06-03 (estimate a6738f91...): user asked for
  // "3 m6g.large data nodes"; agent saved columnFormIPM_1 only;
  // calculator silently auto-defaulted columnFormIPM_2 (3 master nodes
  // at r5.2xlarge.search) + columnFormIPM (2 UltraWarm). User's
  // rendered cost was $2394/mo for what they thought was a $280/mo
  // cluster. Lint had no predicate to detect "table absent while
  // manifest defaults price it >0."

  const defWithMasterDefault = {
    serviceCode: 'amazonElasticsearchService',
    templates: [{
      id: 'elasticSearchService',
      cards: [{
        components: [
          {
            id: 'columnFormIPM_1',
            type: 'input',
            subType: 'columnFormIPM',
            label: 'Data instance',
            row: [
              { type: 'textInput', selectorId: 'Number of Nodes Data instance',
                defaultValue: 1, validations: { required: true } },
              { type: 'autoSuggest', defaultValue: 'm5.large.search' },
            ],
          },
          {
            id: 'columnFormIPM_2',
            type: 'input',
            subType: 'columnFormIPM',
            label: 'Dedicated master',
            row: [
              { type: 'textInput', selectorId: 'Number of Nodes Dedicated master',
                defaultValue: 3, validations: { required: true, allowedValues: [0, 3, 5] } },
              { type: 'autoSuggest', defaultValue: 'r5.2xlarge.search' },
            ],
          },
        ],
      }],
    }],
  };
  const PER_SVC = new Map([['amazonElasticsearchService', defWithMasterDefault]]);

  it('flags a columnFormIPM with non-zero default that is absent from saved blob', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'amazonElasticsearchService',
        estimateFor: 'elasticSearchService',
        calculationComponents: {
          columnFormIPM_1: { value: [{ 'Number of Nodes Data instance': { value: '3' } }] },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC });
    const fails = r.services[0].failures.filter(f => f.predicate === 'column-form-default-trap');
    assert.equal(fails.length, 1, JSON.stringify(r.services[0].failures));
    assert.equal(fails[0].context.componentId, 'columnFormIPM_2');
    assert.equal(fails[0].context.defaultCount, 3);
    assert.equal(fails[0].context.defaultInstanceType, 'r5.2xlarge.search');
    assert.match(fails[0].message, /silently default/);
    // Severity is required-only → maps to required-input verdict, which
    // export refuses on. Crucial: do NOT use 'other' severity, as that
    // would push to read-only and dilute the diagnostic.
    assert.equal(fails[0].severity, 'required-only');
  });

  it('passes when the columnFormIPM is explicitly populated (even with 0 nodes)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'amazonElasticsearchService',
        estimateFor: 'elasticSearchService',
        calculationComponents: {
          columnFormIPM_1: { value: [{ 'Number of Nodes Data instance': { value: '3' } }] },
          columnFormIPM_2: { value: [{ 'Number of Nodes Dedicated master': { value: '0' } }] },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-default-trap');
    assert.equal(fails.length, 0);
  });

  it('skips columnFormIPM where the count default is 0 (absence is harmless)', () => {
    const def = {
      serviceCode: 'svc',
      templates: [{
        id: 'tpl',
        cards: [{ components: [{
          id: 'optionalIPM',
          type: 'input',
          subType: 'columnFormIPM',
          label: 'Optional add-on',
          row: [
            { type: 'textInput', selectorId: 'count', defaultValue: 0, validations: { required: false } },
          ],
        }] }],
      }],
    };
    const blob = { services: { s1: { serviceCode: 'svc', estimateFor: 'tpl', calculationComponents: {} } } };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['svc', def]]) });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-default-trap');
    assert.equal(fails.length, 0);
  });

  it('skips columnFormIPM with no count row at all (table is structural-only)', () => {
    const def = {
      serviceCode: 'svc',
      templates: [{
        id: 'tpl',
        cards: [{ components: [{
          id: 'noCountIPM',
          type: 'input',
          subType: 'columnFormIPM',
          label: 'Pure dropdown table',
          row: [
            { type: 'dropDown', selectorId: 'Foo' },
          ],
        }] }],
      }],
    };
    const blob = { services: { s1: { serviceCode: 'svc', estimateFor: 'tpl', calculationComponents: {} } } };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['svc', def]]) });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-default-trap');
    assert.equal(fails.length, 0);
  });
});

describe('canRehydrate — value parsability (predicate 3)', () => {
  const def = {
    serviceCode: 'aWSLambda',
    templates: [{
      id: 'lambda-template-1',
      inputSections: [{
        components: [
          { id: 'numberOfRequests', validations: { required: true } },
        ],
      }],
    }],
  };

  it('flags value: undefined as read-only', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: { value: undefined } },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'read-only');
    assert.equal(r.services[0].failures[0].predicate, 'value-parsability');
  });

  it('flags empty object as read-only', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: {} },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'read-only');
  });

  it('flags empty-string value as read-only', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: { value: '' } },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'read-only');
  });

  it('passes valid {value, unit} object', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: { value: '1', unit: 'millionPerMonth' } },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('passes valid scalar value (string number)', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: { value: '1' } },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'editable');
  });

  it('flags whitespace-only value as read-only', () => {
    const def = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambda-template-1', inputSections: [{
        components: [{ id: 'numberOfRequests', validations: { required: true } }],
      }] }],
    };
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: { value: '   ' } },
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'read-only');
    assert.equal(r.services[0].failures[0].predicate, 'value-parsability');
  });

  it('flags whitespace-only bare-string entry as read-only', () => {
    const def = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambda-template-1', inputSections: [{
        components: [{ id: 'numberOfRequests', validations: { required: true } }],
      }] }],
    };
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: '   ' },  // bare string entry
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'read-only');
  });

  it('reports BOTH predicate 2 and predicate 3 failures when missing AND unparseable', () => {
    // Two required components: one missing, one unparseable.
    // Severity 'other' (predicate 3) should still drive read-only.
    const def = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambda-template-1', inputSections: [{
        components: [
          { id: 'numberOfRequests', validations: { required: true } },
          { id: 'requestDuration', validations: { required: true } },
        ],
      }] }],
    };
    const blob = {
      services: {
        s1: {
          serviceCode: 'aWSLambda',
          estimateFor: 'lambda-template-1',
          calculationComponents: { numberOfRequests: { value: undefined } },  // requestDuration missing
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', def]]),
    });
    assert.equal(r.status, 'read-only');
    assert.equal(r.services[0].failures.length, 2);
    const predicates = r.services[0].failures.map(f => f.predicate).sort();
    assert.deepEqual(predicates, ['required-field-presence', 'value-parsability']);
  });
});

describe('canRehydrate — sub-service active-list (predicate 4)', () => {
  const snsParentDef = {
    serviceCode: 'amazonSimpleNotificationService',
    templates: [
      { id: 'snsParentTemplate' },
    ],
    mappingDefinitions: { children: ['standardTopics', 'fifoTopics'] },
  };
  const snsChildDef = {
    serviceCode: 'standardTopics',
    templates: [{ id: 'standardTopicsTemplate' }],
  };

  it('passes when sub-service code is in parent mappingDefinitions', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'amazonSimpleNotificationService',
          estimateFor: 'snsParentTemplate',
          calculationComponents: {},
          subServices: [
            {
              serviceCode: 'standardTopics',
              estimateFor: 'standardTopicsTemplate',
              calculationComponents: { numberOfRequests: { value: '1', unit: 'millionPerMonth' } },
            },
          ],
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([
        ['amazonSimpleNotificationService', snsParentDef],
        ['standardTopics', snsChildDef],
      ]),
    });
    assert.equal(r.status, 'editable');
  });

  it('flags sub-service whose serviceCode is not in parent active-list', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'amazonSimpleNotificationService',
          estimateFor: 'snsParentTemplate',
          subServices: [{ serviceCode: 'wrongChild', estimateFor: 't', calculationComponents: {} }],
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([
        ['amazonSimpleNotificationService', snsParentDef],
        ['wrongChild', { serviceCode: 'wrongChild', templates: [{ id: 't' }] }],
      ]),
    });
    assert.equal(r.status, 'read-only');
    assert.ok(r.services[0].failures.find(f => f.predicate === 'sub-service-active-list'));
  });

  it('flags flattened children at top-level peer position', () => {
    // The parent has subType subServiceSelector, but children are at
    // top-level (not inside parent.subServices). This is the
    // sub-service-merge-wrong shape from the project memory.
    const blob = {
      services: {
        s1: {
          serviceCode: 'standardTopics',  // child at top level — no parent envelope
          estimateFor: 'standardTopicsTemplate',
          calculationComponents: {},
        },
      },
    };
    // Manifest has standardTopics flagged as a sub-service whose parent
    // is amazonSimpleNotificationService.
    const manifest = new Map([
      ['standardTopics', { key: 'standardTopics', subType: 'subService' }],
      ['amazonSimpleNotificationService', { key: 'amazonSimpleNotificationService', subType: 'subServiceSelector', templates: ['standardTopics', 'fifoTopics'] }],
    ]);
    const r = canRehydrate({
      savedBlob: blob,
      manifest,
      perServiceDefinitions: new Map([['standardTopics', snsChildDef]]),
    });
    assert.equal(r.status, 'read-only');
    assert.ok(r.services[0].failures.find(f => f.predicate === 'sub-service-active-list'));
  });

  it('flags a sub-service entry with no serviceCode', () => {
    const blob = {
      services: {
        s1: {
          serviceCode: 'amazonSimpleNotificationService',
          estimateFor: 'snsParentTemplate',
          subServices: [
            { /* no serviceCode */ estimateFor: 'standardTopicsTemplate', calculationComponents: {} },
          ],
        },
      },
    };
    const r = canRehydrate({
      savedBlob: blob,
      manifest: new Map(),
      perServiceDefinitions: new Map([['amazonSimpleNotificationService', snsParentDef]]),
    });
    assert.equal(r.status, 'read-only');
    assert.ok(
      r.services.some(s =>
        s.failures.some(f =>
          f.predicate === 'sub-service-active-list' &&
          /has no serviceCode/.test(f.message)
        )
      ),
      'expected at least one sub-service-active-list failure with "has no serviceCode" message',
    );
  });
});

describe('canRehydrate — empty estimate', () => {
  it('flags a blob with zero services as read-only', () => {
    const r = canRehydrate({
      savedBlob: { services: {}, groups: {} },
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map(),
    });
    assert.equal(r.status, 'read-only');
    assert.equal(r.services.length, 1);
    assert.equal(r.services[0].failures[0].predicate, 'empty-estimate');
  });

  it('flags a blob with only empty groups as read-only', () => {
    const r = canRehydrate({
      savedBlob: { services: {}, groups: { 'g1': { services: {} } } },
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map(),
    });
    assert.equal(r.status, 'read-only');
    assert.equal(r.services[0].failures[0].predicate, 'empty-estimate');
  });

  it('does not fire when at least one service is present', () => {
    const r = canRehydrate({
      savedBlob: {
        services: {
          s1: { serviceCode: 'aWSLambda', estimateFor: 'lambda-template-1', calculationComponents: {} },
        },
      },
      manifest: ANY_MANIFEST,
      perServiceDefinitions: PER_SVC_DEFS_LAMBDA,
    });
    const hasEmptyPredicate = r.services.some(s =>
      s.failures.some(f => f.predicate === 'empty-estimate'),
    );
    assert.equal(hasEmptyPredicate, false, 'empty-estimate should not fire when a service is present');
  });
});

describe('canRehydrate — tenancy-pricing-mismatch', () => {
  // Synthetic EC2-shaped definition is enough — the predicate doesn't
  // walk the template, only reads calculationComponents.
  const ec2Def = {
    serviceCode: 'ec2Enhancement',
    templates: [{ id: 'template' }],
  };
  const PER_SVC = new Map([['ec2Enhancement', ec2Def]]);

  function blob(cc) {
    return {
      services: { s1: { serviceCode: 'ec2Enhancement', estimateFor: 'template', calculationComponents: cc } },
    };
  }

  it('flags shared+standard combination', () => {
    const r = canRehydrate({
      savedBlob: blob({
        tenancy: { value: 'shared' },
        pricingStrategy: { value: { selectedOption: 'standard', term: '1 Year', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'tenancy-pricing-mismatch');
    assert.equal(fails.length, 1);
    assert.match(fails[0].message, /standard/);
    assert.match(fails[0].message, /shared/);
  });

  it('flags shared+convertible combination', () => {
    const r = canRehydrate({
      savedBlob: blob({
        tenancy: { value: 'shared' },
        pricingStrategy: { value: { selectedOption: 'convertible', term: '3 Year', upfrontPayment: 'All' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'tenancy-pricing-mismatch');
    assert.equal(fails.length, 1);
  });

  it('does NOT flag shared+instance-savings (the post-remap legitimate state)', () => {
    const r = canRehydrate({
      savedBlob: blob({
        tenancy: { value: 'shared' },
        pricingStrategy: { value: { selectedOption: 'instance-savings', term: '1 Year', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'tenancy-pricing-mismatch');
    assert.equal(fails.length, 0,
      'shared+instance-savings is the legitimate post-remap state — must not flag');
  });

  it('does NOT flag dedicated+standard (the legitimate RI combination)', () => {
    const r = canRehydrate({
      savedBlob: blob({
        tenancy: { value: 'dedicated' },
        pricingStrategy: { value: { selectedOption: 'standard', term: '1 Year', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'tenancy-pricing-mismatch');
    assert.equal(fails.length, 0,
      'dedicated+standard is the recovery path — must not flag');
  });

  it('does NOT flag when tenancy or pricingStrategy is absent', () => {
    const r = canRehydrate({
      savedBlob: blob({ instanceType: { value: 'm5.large' } }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'tenancy-pricing-mismatch');
    assert.equal(fails.length, 0,
      'absent fields are caught by other predicates; no spurious mismatch flag');
  });
});

describe('canRehydrate — ec2-pricing-invalid-value', () => {
  // Backstop for the 2026-08-12 silent-fallback fix in lib/aws/ec2.js.
  // add_service now rejects invalid pricingStrategy values, so this
  // predicate only fires on bypass paths (import_estimate of hand-edited
  // blobs, external construction). Same role column-form-unremapped-value
  // plays for the remap fix.
  const ec2Def = {
    serviceCode: 'ec2Enhancement',
    templates: [{ id: 'template' }],
  };
  const PER_SVC = new Map([['ec2Enhancement', ec2Def]]);

  function blob(cc, serviceCode = 'ec2Enhancement') {
    return {
      services: { s1: { serviceCode, estimateFor: 'template', calculationComponents: cc } },
    };
  }

  it('flags an invalid selectedOption (the pre-fix fallback artifact)', () => {
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'EC2 Instance Savings Plans', term: '1 Year', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 1);
    assert.match(fails[0].message, /selectedOption "EC2 Instance Savings Plans"/);
  });

  it('flags an invalid term (lowercase / shorthand leaked into the blob)', () => {
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'instance-savings', term: '3yr', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 1);
    assert.match(fails[0].message, /term "3yr"/);
  });

  it('flags an invalid upfrontPayment and reports multiple invalids together', () => {
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'banana', term: 'forever', upfrontPayment: 'half' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 1, 'one failure per service, listing all invalid keys');
    assert.match(fails[0].message, /selectedOption/);
    assert.match(fails[0].message, /term/);
    assert.match(fails[0].message, /upfrontPayment/);
  });

  it('does NOT flag a canonical committed-pricing envelope', () => {
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'instance-savings', term: '3 Year', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 0);
  });

  it('does NOT flag the on-demand envelope (no upfrontPayment key)', () => {
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'on-demand', term: '1 Year', utilizationValue: '80', utilizationUnit: '%Utilized/Month' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = r.services[0].failures.filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 0,
      'on-demand envelopes omit upfrontPayment — absence must not flag');
  });

  it('does NOT flag when pricingStrategy is absent', () => {
    const r = canRehydrate({
      savedBlob: blob({ instanceType: { value: 'm5.large' } }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 0);
  });

  it('does NOT fire on non-EC2 services with a pricingStrategy-shaped component', () => {
    const otherDef = { serviceCode: 'someOtherService', templates: [{ id: 'template' }] };
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'weird-thing' } },
      }, 'someOtherService'),
      manifest: ANY_MANIFEST,
      perServiceDefinitions: new Map([['someOtherService', otherDef]]),
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'ec2-pricing-invalid-value');
    assert.equal(fails.length, 0, 'predicate is scoped to ec2Enhancement only');
  });

  it('service status goes to required-input (refuses export) on an invalid value', () => {
    const r = canRehydrate({
      savedBlob: blob({
        pricingStrategy: { value: { selectedOption: 'banana', term: '1 Year', upfrontPayment: 'None' } },
      }),
      manifest: ANY_MANIFEST, perServiceDefinitions: PER_SVC,
    });
    assert.equal(r.services[0].status, 'required-input');
  });
});

describe('canRehydrate — column-form-unremapped-value', () => {
  // columnFormIPM cells must store REMAPPED (target) values, not raw
  // selector (UI) values. The service definition's columnFormIPM carries
  // remap.keyValue mapping selector → stored value. The calculator writes
  // the stored value; the pricing engine reads it back. A saved blob that
  // still holds a raw selector value (a KEY in keyValue) can't be resolved
  // by the pricing engine — the service rehydrates READ-ONLY at $0.
  //
  // The builder now applies the remap (verified). This predicate is
  // defense-in-depth for paths that bypass the builder: import_estimate,
  // re-validation of externally-produced blobs, future services. It fires
  // ONLY on the unambiguous bug signal (cell value is a KEY but not also a
  // VALUE in keyValue) and never false-positives on a correctly-remapped
  // blob.

  // workSpacesCore-style remap: selector → stored.
  const workSpacesCoreDef = {
    serviceCode: 'workSpacesCore',
    templates: [{
      id: 'workSpacesCoreTemplate',
      cards: [{
        inputSection: {
          components: [
            {
              id: 'columnFormIPM_1',
              type: 'input',
              subType: 'columnFormIPM',
              label: 'WorkSpaces',
              remap: {
                keyValue: {
                  AlwaysOn: 'Monthly',
                  AutoStop: 'Hourly',
                  Windows: 'WorkSpaces Core Windows',
                  Any: 'WorkSpaces Core Windows BYOL',
                },
              },
            },
          ],
        },
      }],
    }],
  };
  const PER_SVC = new Map([['workSpacesCore', workSpacesCoreDef]]);

  it('fires read-only when a plain cell holds an un-remapped selector value (a KEY)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              { 'Operating System': { value: 'Windows' } },  // raw selector KEY — broken
            ],
          },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    assert.equal(r.status, 'read-only',
      `expected read-only; got ${r.status}, failures: ${JSON.stringify(r.services[0]?.failures)}`);
    const fails = r.services[0].failures.filter(f => f.predicate === 'column-form-unremapped-value');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.componentId, 'columnFormIPM_1');
    assert.equal(fails[0].context.cellKey, 'Operating System');
    assert.equal(fails[0].context.observed, 'Windows');
    assert.equal(fails[0].context.expectedRemapped, 'WorkSpaces Core Windows');
  });

  it('does NOT fire when a plain cell holds the correctly-remapped value', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              { 'Operating System': { value: 'WorkSpaces Core Windows' } },  // mapped — correct
            ],
          },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-unremapped-value');
    assert.equal(fails.length, 0,
      `correctly-remapped value must not fire; got ${JSON.stringify(fails)}`);
  });

  it('fires on a utilization cell whose selectedId is an un-remapped KEY', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              { 'Running Mode': { value: { selectedId: 'AlwaysOn' } } },  // raw selector KEY — broken
            ],
          },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = r.services[0].failures.filter(f => f.predicate === 'column-form-unremapped-value');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.cellKey, 'Running Mode');
    assert.equal(fails[0].context.observed, 'AlwaysOn');
    assert.equal(fails[0].context.expectedRemapped, 'Monthly');
  });

  it('does NOT fire when a utilization cell selectedId is the mapped value', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              { 'Running Mode': { value: { selectedId: 'Monthly' } } },  // mapped — correct
            ],
          },
        },
      } },
    };
    const r = canRehydrate({ savedBlob: blob, manifest: new Map(), perServiceDefinitions: PER_SVC });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-unremapped-value');
    assert.equal(fails.length, 0);
  });

  it('is a no-op when the columnFormIPM has no remap block', () => {
    const noRemapDef = {
      serviceCode: 'svc',
      templates: [{
        id: 'tpl',
        cards: [{
          inputSection: {
            components: [
              { id: 'columnFormIPM_1', type: 'input', subType: 'columnFormIPM', label: 'Nodes' },
            ],
          },
        }],
      }],
    };
    const blob = {
      services: { s1: {
        serviceCode: 'svc',
        estimateFor: 'tpl',
        calculationComponents: {
          columnFormIPM_1: { value: [{ 'Foo': { value: 'Windows' } }] },
        },
      } },
    };
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['svc', noRemapDef]]),
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-unremapped-value');
    assert.equal(fails.length, 0,
      `no remap block → no-op; got ${JSON.stringify(fails)}`);
  });
});

describe('canRehydrate — column-form-tuple-valid', () => {
  // WorkSpaces Core has an Operating-System × License constraint that
  // nothing else enforces. The only canonical (OS-selector, License)
  // pairs are "Any" + "Bring Your Own License" and "Windows" + "Included".
  // A saved row with "Windows" + BYOL is INVALID but fails silently and
  // DIFFERENTLY per region (53% overcharge in one region, $0 in another).
  //
  // The authoritative source of truth for valid tuples is the
  // calculator's own primary-selector-aggregations.json per service+
  // region — every valid full selector tuple. A saved row whose tuple
  // is NOT in that set is defective even if it happens to render a price.
  //
  // Saved cells store REMAPPED values (e.g. "WorkSpaces Core Windows"
  // for selector "Windows"); the aggregation tuples use SELECTOR values.
  // The predicate reverse-maps each cell value (stored → selector) using
  // the component's remap.keyValue before comparing.
  //
  // aggregations is passed in as a Map keyed by serviceCode → array of
  // valid selector-tuple objects. Absent/undefined → no-op (offline
  // safety, mirrors the regionList side-channel).

  const workSpacesCoreDef = {
    serviceCode: 'workSpacesCore',
    templates: [{
      id: 'workSpacesCoreTemplate',
      cards: [{
        inputSection: {
          components: [
            {
              id: 'columnFormIPM_1',
              type: 'input',
              subType: 'columnFormIPM',
              label: 'WorkSpaces',
              remap: {
                keyValue: {
                  AlwaysOn: 'Monthly',
                  AutoStop: 'Hourly',
                  Windows: 'WorkSpaces Core Windows',
                  Any: 'WorkSpaces Core Windows BYOL',
                },
              },
            },
          ],
        },
      }],
    }],
  };
  const PER_SVC = new Map([['workSpacesCore', workSpacesCoreDef]]);

  // Valid tuples in SELECTOR terms: the only two canonical combinations.
  const validTuples = [
    { 'Operating System': 'Any', 'License': 'Bring Your Own License' },
    { 'Operating System': 'Windows', 'License': 'Included' },
  ];

  it('(a) fires read-only when a row reverse-maps to an invalid tuple (Windows + BYOL)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        region: 'il-central-1',
        regionName: 'Middle East (Tel Aviv)',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              {
                // Stored "WorkSpaces Core Windows" reverse-maps to selector
                // "Windows"; License "Bring Your Own License" → Windows+BYOL
                // is NOT a valid tuple.
                'Operating System': { value: 'WorkSpaces Core Windows' },
                'License': { value: 'Bring Your Own License' },
              },
            ],
          },
        },
      } },
    };
    const aggregations = new Map([['workSpacesCore', validTuples]]);
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, aggregations,
    });
    assert.equal(r.status, 'read-only',
      `expected read-only; got ${r.status}, failures: ${JSON.stringify(r.services[0]?.failures)}`);
    const fails = r.services[0].failures.filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 1);
    assert.equal(fails[0].context.serviceCode, 'workSpacesCore');
    assert.equal(fails[0].context.observedTuple['Operating System'], 'Windows');
    assert.equal(fails[0].context.observedTuple['License'], 'Bring Your Own License');
    assert.match(fails[0].message, /not a valid/i);
  });

  it('(b) does NOT fire when a row reverse-maps to a valid tuple (Any + BYOL)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        region: 'il-central-1',
        regionName: 'Middle East (Tel Aviv)',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              {
                // Stored "WorkSpaces Core Windows BYOL" reverse-maps to
                // selector "Any"; Any+BYOL IS a valid tuple.
                'Operating System': { value: 'WorkSpaces Core Windows BYOL' },
                'License': { value: 'Bring Your Own License' },
              },
            ],
          },
        },
      } },
    };
    const aggregations = new Map([['workSpacesCore', validTuples]]);
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, aggregations,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 0,
      `valid tuple must not fire; got ${JSON.stringify(fails)}`);
  });

  it('(c) is a no-op when aggregations Map is absent (offline safety)', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        region: 'il-central-1',
        regionName: 'Middle East (Tel Aviv)',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              {
                'Operating System': { value: 'WorkSpaces Core Windows' },  // invalid tuple
                'License': { value: 'Bring Your Own License' },
              },
            ],
          },
        },
      } },
    };
    // No aggregations passed — predicate must skip cleanly.
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 0,
      `absent aggregations → no-op; got ${JSON.stringify(fails)}`);
    assert.equal(r.status, 'editable',
      `absent aggregations should leave status editable; got ${r.status}`);
  });

  it('(c2) is a no-op when aggregations Map has no entry for this service', () => {
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        region: 'il-central-1',
        regionName: 'Middle East (Tel Aviv)',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              {
                'Operating System': { value: 'WorkSpaces Core Windows' },  // invalid tuple
                'License': { value: 'Bring Your Own License' },
              },
            ],
          },
        },
      } },
    };
    const aggregations = new Map([['someOtherService', validTuples]]);
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, aggregations,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 0,
      `service absent from aggregations → no-op; got ${JSON.stringify(fails)}`);
  });

  it('(d) is a no-op for a columnFormIPM with no remap block', () => {
    const noRemapDef = {
      serviceCode: 'svc',
      templates: [{
        id: 'tpl',
        cards: [{
          inputSection: {
            components: [
              { id: 'columnFormIPM_1', type: 'input', subType: 'columnFormIPM', label: 'Nodes' },
            ],
          },
        }],
      }],
    };
    const blob = {
      services: { s1: {
        serviceCode: 'svc',
        region: 'il-central-1',
        regionName: 'Middle East (Tel Aviv)',
        estimateFor: 'tpl',
        calculationComponents: {
          columnFormIPM_1: { value: [{ 'Operating System': { value: 'Whatever' } }] },
        },
      } },
    };
    const aggregations = new Map([['svc', validTuples]]);
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['svc', noRemapDef]]), aggregations,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 0,
      `no remap block → no-op; got ${JSON.stringify(fails)}`);
  });

  it('(d2) is a no-op for a non-columnFormIPM service', () => {
    const lambdaDef = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambda-template-1' }],
    };
    const blob = {
      services: { s1: {
        serviceCode: 'aWSLambda',
        estimateFor: 'lambda-template-1',
        calculationComponents: {},
      } },
    };
    const aggregations = new Map([['aWSLambda', validTuples]]);
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: new Map([['aWSLambda', lambdaDef]]), aggregations,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 0);
    assert.equal(r.status, 'editable');
  });

  it('intersects only on keys the aggregation tuples carry (ignores untracked columns)', () => {
    // The saved row carries extra columns (Running Mode) that the
    // aggregation tuple set may not enumerate. The predicate must
    // compare only on the shared keys present in the aggregation tuples
    // — a valid OS/License tuple should pass even with extra cells.
    const blob = {
      services: { s1: {
        serviceCode: 'workSpacesCore',
        region: 'il-central-1',
        regionName: 'Middle East (Tel Aviv)',
        estimateFor: 'workSpacesCoreTemplate',
        calculationComponents: {
          columnFormIPM_1: {
            value: [
              {
                'Operating System': { value: 'WorkSpaces Core Windows BYOL' },  // → Any
                'License': { value: 'Bring Your Own License' },
                'Running Mode': { value: { selectedId: 'Monthly' } },  // untracked by agg
              },
            ],
          },
        },
      } },
    };
    const aggregations = new Map([['workSpacesCore', validTuples]]);
    const r = canRehydrate({
      savedBlob: blob, manifest: new Map(),
      perServiceDefinitions: PER_SVC, aggregations,
    });
    const fails = (r.services[0]?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 0,
      `valid OS/License tuple must pass even with untracked extra columns; got ${JSON.stringify(fails)}`);
  });
});
