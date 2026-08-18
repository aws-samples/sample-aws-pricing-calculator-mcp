const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { nextStepFor, notFoundHintFor, invalidFieldIdsHintFor } = require('../lib/lint/lint-hints');

// Synthetic catalog mirroring the real shape: parent envelope with a
// trap line and a subServices array. Used to verify nextStepFor surfaces
// catalog guidance when the lint context names a parent-shaped service.
const CATALOG = new Map();
CATALOG.set('amazonSimpleStorageServiceGroup', {
  serviceCode: 'amazonSimpleStorageServiceGroup',
  displayName: 'Amazon S3',
  traps: [
    "amazonSimpleStorageServiceGroup is a subServiceSelector parent. Call addService('amazonS3Standard', ...) for storage.",
  ],
  subServices: [
    { serviceCode: 'amazonS3Standard', estimateFor: 's3Standard',
      required: [{ field: 's3StandardStorageSize', example: { value: '500', unit: 'gb|month' } }] },
    { serviceCode: 'awsS3DataTransfer', estimateFor: 'awsS3DataTransfer', required: [] },
  ],
});
CATALOG.set('dynamoDbOnDemand', {
  serviceCode: 'dynamoDbOnDemand',
  displayName: 'DynamoDB on-demand capacity',
  required: [
    { field: 'dataStorageSize', example: { value: '1', unit: 'gb|NA' } },
  ],
});

describe('nextStepFor', () => {
  it('returns null for an editable verdict', () => {
    assert.equal(nextStepFor({ status: 'editable', services: [] }), null);
  });

  it('returns null when the lintResult is missing/falsy', () => {
    assert.equal(nextStepFor(null), null);
    assert.equal(nextStepFor(undefined), null);
  });

  it('hints add_service for an empty estimate', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'empty-estimate',
          severity: 'other',
          message: 'estimate has no services — saved blob would rehydrate as a blank read-only calculator',
          context: {},
        }],
      }],
    });
    assert.match(out, /no services/i);
    assert.match(out, /add_service/);
  });

  it('hints with available templates when estimateFor is unrecognized', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'template-existence',
          severity: 'other',
          message: 'estimateFor "wrong" not in service "awsLambda" templates [lambdaWithFreeTier, lambdaProvisionedConcurrency]',
          context: { serviceCode: 'awsLambda', estimateFor: 'wrong', availableTemplates: ['lambdaWithFreeTier', 'lambdaProvisionedConcurrency'] },
        }],
      }],
    });
    assert.match(out, /awsLambda/);
    assert.match(out, /lambdaWithFreeTier/);
    assert.match(out, /add_service/);
  });

  it('hints when estimateFor is missing entirely (no catalog)', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'template-existence',
          severity: 'other',
          message: 'service "amazonDynamoDb" has no estimateFor',
          context: { serviceCode: 'amazonDynamoDb' },
        }],
      }],
    });
    assert.match(out, /amazonDynamoDb/);
    assert.match(out, /parent envelope/);
    assert.match(out, /search_services/);
  });

  it('names the missing component for required-field-presence', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'required-field-presence',
          severity: 'required-only',
          message: 'required component "storageVolume" missing from calculationComponents for amazonRDSPostgreSQLDB',
          context: { serviceCode: 'amazonRDSPostgreSQLDB', componentId: 'storageVolume' },
        }],
      }],
    });
    assert.match(out, /storageVolume/);
    assert.match(out, /add_service/);
  });

  it('hints sub-service composite key for sub-service-active-list with allowed list', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'sub-service-active-list',
          severity: 'other',
          message: 'sub-service "Standard" not in parent amazonS3 active list',
          context: { parentServiceCode: 'amazonS3', childServiceCode: 'Standard', allowedActiveList: ['amazonS3:Standard', 'amazonS3:IA'] },
        }],
      }],
    });
    assert.match(out, /amazonS3:Standard/);
    assert.match(out, /add_service/);
  });

  it('hints provider-code redirect for product-level orphan via productCodes', () => {
    // Synthetic catalog modeling Bedrock's productCodes[] redirect.
    // titanTextEmbeddingsV2 is in the manifest as subType:'subService' but
    // amazonBedrock.templates[] only lists provider codes (amazon, anthropic, ...).
    // The catalog's productCodes[] tells the hint to redirect.
    const bedrockCatalog = new Map();
    bedrockCatalog.set('amazonBedrock', {
      serviceCode: 'amazonBedrock',
      displayName: 'Amazon Bedrock',
      traps: ['Three model dropdowns must agree.'],
      subServices: [
        { serviceCode: 'anthropic', estimateFor: 'anthropic', required: [] },
        {
          serviceCode: 'amazon',
          estimateFor: 'Amazon',
          required: [],
          productCodes: ['titanTextEmbeddingsV2', 'novaPro'],
        },
      ],
    });
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'sub-service-active-list',
          severity: 'other',
          message: 'service "titanTextEmbeddingsV2" is a sub-service but appears at top-level peer position',
          context: { serviceCode: 'titanTextEmbeddingsV2' },
        }],
      }],
    }, bedrockCatalog);
    assert.match(out, /titanTextEmbeddingsV2/);
    assert.match(out, /amazon/);  // provider code named
    assert.match(out, /amazonBedrock/);
    assert.match(out, /per-provider/);  // distinct phrasing from default
    assert.match(out, /get_service_fields/);
    // Ensure we did NOT fall through to the default flattened-sub-service hint
    assert.doesNotMatch(out, /amazonS3:Standard/);
  });

  it('hints proper parent path for flattened sub-service (no catalog)', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'sub-service-active-list',
          severity: 'other',
          message: 'service "appSyncCaching" is a sub-service but appears at top-level peer position',
          context: { serviceCode: 'appSyncCaching' },
        }],
      }],
    });
    assert.match(out, /appSyncCaching/);
    assert.match(out, /sub-service/);
    assert.match(out, /search_services/);
  });

  it('batches required-field-presence failures for the same service into one hint', () => {
    // Production observability 2026-06-03: NAT averaged 8 retries per
    // estimate because the hint named one missing field at a time.
    // With 3 required fields and a "fix one, retry, get refused next"
    // loop, agents iterated 3-4 cycles per save attempt. Batching all
    // missing-field IDs into a single hint should cut retries to 1-2.
    const out = nextStepFor({
      status: 'required-input',
      services: [{
        failures: [
          {
            predicate: 'required-field-presence',
            severity: 'required-only',
            message: 'required component "regionalNatGatewayCount" missing',
            context: { serviceCode: 'networkAddressTranslationNatGatewayVpc',
                       componentId: 'regionalNatGatewayCount' },
          },
          {
            predicate: 'required-field-presence',
            severity: 'required-only',
            message: 'required component "regionalNatGatewayAzCount" missing',
            context: { serviceCode: 'networkAddressTranslationNatGatewayVpc',
                       componentId: 'regionalNatGatewayAzCount' },
          },
          {
            predicate: 'required-field-presence',
            severity: 'required-only',
            message: 'required component "regionalNatGatewayDataProcessed" missing',
            context: { serviceCode: 'networkAddressTranslationNatGatewayVpc',
                       componentId: 'regionalNatGatewayDataProcessed' },
          },
        ],
      }],
    });
    // All three fields named in the same hint.
    assert.match(out, /regionalNatGatewayCount/);
    assert.match(out, /regionalNatGatewayAzCount/);
    assert.match(out, /regionalNatGatewayDataProcessed/);
    assert.match(out, /missing 3 required fields/);
    assert.match(out, /ALL of them populated in one call/);
    // Should NOT use the "(N more issues to fix)" suffix that the
    // un-batched path emits — that's the agent-loop trigger we're
    // eliminating.
    assert.doesNotMatch(out, /more issue/);
  });

  it('does NOT batch when failures are mixed predicates (different fix recipes)', () => {
    // A required-field + an invalid-region need different remediation
    // shapes (re-call add_service with field vs change region). Keeping
    // the existing "primary + N more" flow forces the agent to address
    // them in separate cycles, which is correct here.
    const out = nextStepFor({
      status: 'required-input',
      services: [{
        failures: [
          {
            predicate: 'required-field-presence',
            severity: 'required-only',
            message: 'required component "x" missing',
            context: { serviceCode: 'svc1', componentId: 'x' },
          },
          {
            predicate: 'invalid-region',
            severity: 'required-only',
            message: 'region "us-fake-1" invalid',
            context: { serviceCode: 'svc1', observed: 'us-fake-1', validRegions: ['us-east-1'] },
          },
        ],
      }],
    });
    assert.match(out, /more issue/);
  });

  it('does NOT batch when required-field failures are across different services', () => {
    // Naming both services' fields in one hint is confusing — agent
    // might miss that they're separate add_service calls. Keep the
    // existing "primary + N more" flow.
    const out = nextStepFor({
      status: 'required-input',
      services: [
        { failures: [{ predicate: 'required-field-presence', severity: 'required-only',
                       message: 'm', context: { serviceCode: 'svcA', componentId: 'x' } }] },
        { failures: [{ predicate: 'required-field-presence', severity: 'required-only',
                       message: 'm', context: { serviceCode: 'svcB', componentId: 'y' } }] },
      ],
    });
    assert.match(out, /more issue/);
  });

  it('hints zero-out shape for column-form-default-trap', () => {
    // Production case 2026-06-03: OpenSearch agent saved
    // columnFormIPM_1 only; calculator silently auto-defaulted master
    // (3× r5.2xlarge.search). The hint must name the auto-default count
    // + instance type so the agent knows what cost it accidentally added.
    const out = nextStepFor({
      status: 'required-input',
      services: [{
        failures: [{
          predicate: 'column-form-default-trap',
          severity: 'required-only',
          message: 'columnFormIPM "columnFormIPM_2" is absent — auto-defaults 3 r5.2xlarge.search',
          context: {
            serviceCode: 'amazonElasticsearchService',
            componentId: 'columnFormIPM_2',
            tableLabel: 'Amazon OpenSearch Service dedicated master instance cost',
            countRowLabel: 'Number of Nodes Dedicated master',
            defaultCount: 3,
            defaultInstanceType: 'r5.2xlarge.search',
          },
        }],
      }],
    });
    assert.match(out, /columnFormIPM_2/);
    assert.match(out, /3 × "r5\.2xlarge\.search"/);
    assert.match(out, /set to "0"/);
    assert.match(out, /Number of Nodes Dedicated master/);
    assert.match(out, /silently default/);
  });

  it('hints both recovery paths for tenancy-pricing-mismatch', () => {
    // The shared+standard combo silently goes Read-only because the
    // calculator hides Standard/Convertible RIs under shared tenancy.
    // Hint must name BOTH recovery paths: switch tenancy to dedicated,
    // OR switch pricingStrategy to instance-savings.
    const out = nextStepFor({
      status: 'required-input',
      services: [{
        failures: [{
          predicate: 'tenancy-pricing-mismatch',
          severity: 'required-only',
          message: 'ec2Enhancement: pricingStrategy "standard" is invalid under shared tenancy',
          context: {
            serviceCode: 'ec2Enhancement',
            tenancy: 'shared',
            selectedOption: 'standard',
          },
        }],
      }],
    });
    assert.match(out, /standard/, 'names the offending pricingStrategy value');
    assert.match(out, /shared/, 'names the gating tenancy value');
    assert.match(out, /dedicated/, 'names recovery path (a) — switch tenancy');
    assert.match(out, /instance-savings/, 'names recovery path (b) — switch strategy');
    assert.match(out, /add_service/, 'tells agent how to apply the fix');
  });

  it('hints re-add with accepted form for ec2-pricing-invalid-value', () => {
    // Backstop predicate for blobs built outside add_service (which
    // rejects invalid pricingStrategy values since the 2026-08-12 fix).
    const out = nextStepFor({
      status: 'required-input',
      services: [{
        failures: [{
          predicate: 'ec2-pricing-invalid-value',
          severity: 'required-only',
          message: 'ec2Enhancement: pricingStrategy carries invalid selectedOption',
          context: {
            serviceCode: 'ec2Enhancement',
            invalid: ['selectedOption "EC2 Instance Savings Plans" (valid: on-demand, standard, convertible, instance-savings, compute-savings, spot)'],
            selectedOption: 'EC2 Instance Savings Plans',
            term: '1 Year',
            upfrontPayment: 'None',
          },
        }],
      }],
    });
    assert.match(out, /EC2 Instance Savings Plans/, 'names the offending value');
    assert.match(out, /On-Demand/, 'states the silent consequence');
    assert.match(out, /add_service/, 'tells agent the recovery tool');
    assert.match(out, /instanceSavings/, 'shows the accepted form');
  });

  it('points to search_services for unknown service code', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'definition-unavailable',
          severity: 'unknown',
          message: 'no PCT definition provided for serviceCode "fakeService"',
          context: { serviceCode: 'fakeService' },
        }],
      }],
    });
    assert.match(out, /fakeService/);
    assert.match(out, /search_services/);
  });

  it('appends a count when there are multiple failures', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [
        { failures: [{ predicate: 'empty-estimate', severity: 'other', message: '...', context: {} }] },
        { failures: [{ predicate: 'template-existence', severity: 'other', message: '...', context: { serviceCode: 'svc' } }] },
        { failures: [{ predicate: 'required-field-presence', severity: 'required-only', message: '...', context: {} }] },
      ],
    });
    assert.match(out, /add_service/);
    assert.match(out, /more issues to fix/);
  });

  it('surfaces required-only severities when verdict is required-input', () => {
    // required-input verdicts are now refusal verdicts (alongside
    // read-only): the calculator silently defaults missing required
    // fields, producing a costed estimate against a value the user
    // never chose. The next-step hint must surface those failures
    // so the agent knows what to add before retrying.
    const out = nextStepFor({
      status: 'required-input',
      services: [{
        failures: [{
          predicate: 'required-field-presence',
          severity: 'required-only',
          message: 'required component "fld" missing from calculationComponents for svc',
          context: { serviceCode: 'svc', componentId: 'fld' },
        }],
      }],
    });
    assert.ok(out, `expected a hint string, got ${JSON.stringify(out)}`);
    assert.match(out, /fld/);
  });

  describe('with catalog wired in', () => {
    it('lists actual child service codes when parent has no estimateFor', () => {
      const out = nextStepFor({
        status: 'read-only',
        services: [{
          failures: [{
            predicate: 'template-existence',
            severity: 'other',
            message: 'service "amazonSimpleStorageServiceGroup" has no estimateFor',
            context: { serviceCode: 'amazonSimpleStorageServiceGroup' },
          }],
        }],
      }, CATALOG);
      assert.match(out, /amazonS3Standard/);
      assert.match(out, /awsS3DataTransfer/);
      assert.match(out, /add_service/);
    });

    it('quotes catalog traps when the parent has them', () => {
      const out = nextStepFor({
        status: 'read-only',
        services: [{
          failures: [{
            predicate: 'template-existence',
            severity: 'other',
            message: 'service "amazonSimpleStorageServiceGroup" has no estimateFor',
            context: { serviceCode: 'amazonSimpleStorageServiceGroup' },
          }],
        }],
      }, CATALOG);
      assert.match(out, /Catalog hint:/);
      assert.match(out, /subServiceSelector parent/);
    });

    it('detects synthetic _generated_ slot keys and steers to children', () => {
      const out = nextStepFor({
        status: 'read-only',
        services: [{
          failures: [{
            predicate: 'required-field-presence',
            severity: 'required-only',
            message: 'required component "s3Services_generated_0" missing',
            context: { serviceCode: 'amazonSimpleStorageServiceGroup',
                       componentId: 's3Services_generated_0' },
          }],
        }],
      }, CATALOG);
      assert.match(out, /parent envelope/);
      assert.match(out, /amazonS3Standard/);
      assert.doesNotMatch(out, /populated/);
    });

    it('inlines catalog example for a real missing field', () => {
      const out = nextStepFor({
        status: 'read-only',
        services: [{
          failures: [{
            predicate: 'required-field-presence',
            severity: 'required-only',
            message: 'required component "dataStorageSize" missing',
            context: { serviceCode: 'dynamoDbOnDemand', componentId: 'dataStorageSize' },
          }],
        }],
      }, CATALOG);
      assert.match(out, /dataStorageSize/);
      assert.match(out, /Example:/);
      assert.match(out, /gb\|NA/);
    });

    it('names the parent and other valid children for flattened sub-service', () => {
      const out = nextStepFor({
        status: 'read-only',
        services: [{
          failures: [{
            predicate: 'sub-service-active-list',
            severity: 'other',
            message: 'service "amazonS3Standard" is a sub-service but appears at top-level',
            context: { serviceCode: 'amazonS3Standard' },
          }],
        }],
      }, CATALOG);
      assert.match(out, /amazonS3Standard/);
      assert.match(out, /amazonSimpleStorageServiceGroup/);
      assert.match(out, /awsS3DataTransfer/);
      assert.match(out, /Catalog hint:/);
    });

    it('still works when catalog is omitted (graceful fallback)', () => {
      const out = nextStepFor({
        status: 'read-only',
        services: [{
          failures: [{
            predicate: 'template-existence',
            severity: 'other',
            message: 'service "anything" has no estimateFor',
            context: { serviceCode: 'anything' },
          }],
        }],
      });
      assert.match(out, /search_services/);
      assert.doesNotMatch(out, /Catalog hint:/);
    });
  });

  it('falls back to a generic hint for an unknown predicate', () => {
    const out = nextStepFor({
      status: 'read-only',
      services: [{
        failures: [{
          predicate: 'some-future-predicate',
          severity: 'other',
          message: 'something exotic happened',
          context: {},
        }],
      }],
    });
    assert.match(out, /something exotic happened/);
    assert.match(out, /add_service/);
  });
});

describe('notFoundHintFor', () => {
  it('detects a calcmcp estimate_id (UUID v4 shape) and points at TTL', () => {
    const out = notFoundHintFor('408076ed-f94c-4aa8-a5f4-4546b8f9e039');
    assert.match(out, /right shape/);
    assert.match(out, /24h/);
    assert.match(out, /create_estimate/);
  });

  it('detects a calculator save id (40-char hex) and steers to import_estimate', () => {
    const out = notFoundHintFor('8c4a32d00746a4fe9d6de92f00d72b0fe2d1fd74');
    assert.match(out, /calculator save id/);
    assert.match(out, /import_estimate/);
    assert.match(out, /create_estimate/);
  });

  it('flags free-text / names with the estimate_id-vs-name distinction', () => {
    const out = notFoundHintFor('ADC June Deployment - Capacity Estimate');
    assert.match(out, /name or free text/);
    assert.match(out, /create_estimate/);
    assert.match(out, /36-char/);
  });

  it('handles empty / null gracefully (still produces a hint)', () => {
    assert.match(notFoundHintFor(''), /create_estimate/);
    assert.match(notFoundHintFor(null), /create_estimate/);
    assert.match(notFoundHintFor(undefined), /create_estimate/);
  });

  it('treats partial UUIDs as non-UUIDs', () => {
    // Right pattern but truncated — should fall through to the free-text branch.
    const out = notFoundHintFor('408076ed-f94c-4aa8');
    assert.doesNotMatch(out, /right shape/);
    assert.match(out, /create_estimate/);
  });
});

describe('invalidFieldIdsHintFor', () => {
  it('detects empty validIds as a parent envelope and lists catalog children', () => {
    const out = invalidFieldIdsHintFor({
      serviceKey: 'amazonSimpleStorageServiceGroup',
      validIds: [],
      catalog: CATALOG,
    });
    assert.match(out, /parent envelope/);
    assert.match(out, /amazonS3Standard/);
    assert.match(out, /Catalog hint:/);
  });

  it('treats all-synthetic-slot validIds as a parent envelope and redirects to children', () => {
    // Real shape: amazonS3's PCT exposes s3Services_generated_0..3 — synthetic
    // slot markers, not field IDs the pricing engine accepts. Without this
    // branch the agent gets handed those IDs as "valid" and walks off a cliff.
    const out = invalidFieldIdsHintFor({
      serviceKey: 'amazonS3',
      validIds: ['s3Services_generated_0', 's3Services_generated_1',
                 's3Services_generated_2', 's3Services_generated_3'],
      catalog: CATALOG,
    });
    assert.match(out, /parent envelope/);
    assert.match(out, /amazonS3Standard/);
    assert.match(out, /Catalog hint:/);
    assert.doesNotMatch(out, /s3Services_generated_/);
  });

  it('handles parent envelope with no catalog entry by suggesting search_services', () => {
    const out = invalidFieldIdsHintFor({
      serviceKey: 'amazonWorkSpaces',
      validIds: [],
      catalog: new Map(),
    });
    assert.match(out, /no input fields/);
    assert.match(out, /search_services/);
    assert.doesNotMatch(out, /Catalog hint:/);
  });

  it('shows a sample of valid field IDs when fields exist', () => {
    const ids = ['fieldA', 'fieldB', 'fieldC', 'fieldD', 'fieldE'];
    const out = invalidFieldIdsHintFor({
      serviceKey: 'someService',
      validIds: ids,
      catalog: new Map(),
    });
    assert.match(out, /Valid field IDs for someService/);
    for (const id of ids) assert.match(out, new RegExp(id));
    assert.doesNotMatch(out, /more/);  // <12 fields total
  });

  it('caps the displayed sample and indicates how many more exist', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `f${i}`);
    const out = invalidFieldIdsHintFor({
      serviceKey: 'big',
      validIds: ids,
      catalog: new Map(),
    });
    assert.match(out, /f0/);
    assert.match(out, /f11/);
    assert.doesNotMatch(out, /f12,/);
    assert.match(out, /and 13 more/);
    assert.match(out, /get_service_fields/);
  });
});
