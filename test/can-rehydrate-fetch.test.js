const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

let canRehydrateFetch;
beforeEach(() => {
  delete require.cache[require.resolve('../lib/lint/can-rehydrate-fetch')];
  delete require.cache[require.resolve('../lib/aws/aws-client')];
});

describe('canRehydrateFetch', () => {
  it('fetches all referenced service definitions and runs the linter', async () => {
    const fakeManifest = new Map([
      ['aWSLambda', { key: 'aWSLambda', subType: undefined }],
    ]);
    const fakeDef = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambda-template-1' }],
    };
    const fakeAwsClient = {
      loadManifest: mock.fn(async () => fakeManifest),
      fetchServiceDefinition: mock.fn(async (_m, code) => {
        if (code === 'aWSLambda') return fakeDef;
        return null;
      }),
    };
    require.cache[require.resolve('../lib/aws/aws-client')] = { exports: fakeAwsClient };

    canRehydrateFetch = require('../lib/lint/can-rehydrate-fetch').canRehydrateFetch;

    const r = await canRehydrateFetch({
      savedBlob: {
        services: {
          s1: { serviceCode: 'aWSLambda', estimateFor: 'lambda-template-1', calculationComponents: {} },
        },
      },
    });
    assert.equal(r.status, 'editable');
    assert.equal(fakeAwsClient.loadManifest.mock.calls.length, 1);
    assert.equal(fakeAwsClient.fetchServiceDefinition.mock.calls.length, 1);
  });

  it('also fetches sub-service child definitions', async () => {
    const fakeManifest = new Map([
      ['parent', { key: 'parent', subType: 'subServiceSelector', templates: ['child'] }],
      ['child', { key: 'child', subType: 'subService' }],
    ]);
    const parentDef = {
      serviceCode: 'parent',
      templates: [{ id: 'parentT' }],
      mappingDefinitions: { children: ['child'] },
    };
    const childDef = { serviceCode: 'child', templates: [{ id: 'childT' }] };
    const fetched = [];
    const fakeAwsClient = {
      loadManifest: mock.fn(async () => fakeManifest),
      fetchServiceDefinition: mock.fn(async (_m, code) => {
        fetched.push(code);
        if (code === 'parent') return parentDef;
        if (code === 'child') return childDef;
        return null;
      }),
    };
    require.cache[require.resolve('../lib/aws/aws-client')] = { exports: fakeAwsClient };

    canRehydrateFetch = require('../lib/lint/can-rehydrate-fetch').canRehydrateFetch;

    const r = await canRehydrateFetch({
      savedBlob: {
        services: {
          s1: {
            serviceCode: 'parent',
            estimateFor: 'parentT',
            subServices: [{ serviceCode: 'child', estimateFor: 'childT', calculationComponents: {} }],
          },
        },
      },
    });
    assert.equal(r.status, 'editable');
    assert.deepEqual(fetched.sort(), ['child', 'parent']);
  });

  it('walks services inside groups[*].services', async () => {
    const fakeManifest = new Map([
      ['aWSLambda', { key: 'aWSLambda' }],
    ]);
    const fakeDef = {
      serviceCode: 'aWSLambda',
      templates: [{ id: 'lambda-template-1' }],
    };
    const fetched = [];
    const fakeAwsClient = {
      loadManifest: mock.fn(async () => fakeManifest),
      fetchServiceDefinition: mock.fn(async (_m, code) => {
        fetched.push(code);
        return code === 'aWSLambda' ? fakeDef : null;
      }),
    };
    require.cache[require.resolve('../lib/aws/aws-client')] = { exports: fakeAwsClient };

    canRehydrateFetch = require('../lib/lint/can-rehydrate-fetch').canRehydrateFetch;

    const r = await canRehydrateFetch({
      savedBlob: {
        services: {},
        groups: {
          g1: {
            services: {
              s1: { serviceCode: 'aWSLambda', estimateFor: 'lambda-template-1', calculationComponents: {} },
            },
          },
        },
      },
    });
    assert.equal(r.status, 'editable');
    assert.deepEqual(fetched, ['aWSLambda']);
  });

  it('wires selector aggregations for a columnFormIPM SUB-SERVICE using region CODE (no regionName)', async () => {
    // Reality: columnFormIPM services like workSpacesCore are sub-services
    // nested under a parent envelope. The sub-service node carries `region`
    // (the CODE) but NO `regionName` (only the parent envelope has that).
    // The aggregation wiring must resolve from the region CODE, otherwise it
    // skips the sub-service and the tuple predicate silently no-ops.
    const fakeManifest = new Map([
      ['amazonWorkSpaces', { key: 'amazonWorkSpaces', subType: 'subServiceSelector', templates: ['workSpacesCore'] }],
      ['workSpacesCore', { key: 'workSpacesCore', subType: 'subService' }],
    ]);
    const parentDef = {
      serviceCode: 'amazonWorkSpaces',
      templates: ['workSpacesCore'],
      templateId: 'amazonWorkSpacesGroup',
      mappingDefinitions: { children: ['workSpacesCore'] },
    };
    const childDef = {
      serviceCode: 'workSpacesCore',
      templates: [{
        id: 'workSpacesCoreTemplate',
        cards: [{ inputSection: { components: [{
          id: 'columnFormIPM_1',
          type: 'input',
          subType: 'columnFormIPM',
          mappingDefinitionName: 'wsCoreMap',
          label: 'WorkSpaces',
          remap: { keyValue: { Windows: 'WorkSpaces Core Windows', Any: 'WorkSpaces Core Windows BYOL' } },
        }] } }],
      }],
    };
    const validTuples = [
      { 'Operating System': 'Any', 'License': 'Bring Your Own License' },
      { 'Operating System': 'Windows', 'License': 'Included' },
    ];
    const aggCalls = [];
    const fakeAwsClient = {
      loadManifest: mock.fn(async () => fakeManifest),
      fetchServiceDefinition: mock.fn(async (_m, code) => {
        if (code === 'amazonWorkSpaces') return parentDef;
        if (code === 'workSpacesCore') return childDef;
        return null;
      }),
      // Assert the wiring hands us a region CODE, not undefined.
      loadSelectorAggregations: mock.fn(async (_def, _field, region) => {
        aggCalls.push(region);
        return validTuples;
      }),
    };
    require.cache[require.resolve('../lib/aws/aws-client')] = { exports: fakeAwsClient };

    canRehydrateFetch = require('../lib/lint/can-rehydrate-fetch').canRehydrateFetch;

    const r = await canRehydrateFetch({
      savedBlob: {
        services: {
          s1: {
            serviceCode: 'amazonWorkSpaces',
            estimateFor: 'amazonWorkSpacesGroup',
            region: 'eu-west-1',
            regionName: 'Europe (Ireland)',
            subServices: [{
              serviceCode: 'workSpacesCore',
              estimateFor: 'workSpacesCoreTemplate',
              region: 'eu-west-1',
              // NOTE: no regionName — the sub-service node lacks it.
              calculationComponents: {
                columnFormIPM_1: { value: [{
                  'Operating System': { value: 'WorkSpaces Core Windows' },  // → Windows
                  'License': { value: 'Bring Your Own License' },            // Windows+BYOL: invalid
                }] },
              },
            }],
          },
        },
      },
    });

    // The wiring must have called loadSelectorAggregations with the region CODE.
    assert.deepEqual(aggCalls, ['eu-west-1'],
      `aggregations must be fetched using the sub-service region CODE; got ${JSON.stringify(aggCalls)}`);
    // And the tuple predicate must fire read-only on the invalid Windows+BYOL row.
    assert.equal(r.status, 'read-only',
      `invalid sub-service tuple must drive read-only; got ${r.status}`);
    const childResult = r.services.find(s => s.serviceCode === 'workSpacesCore');
    const fails = (childResult?.failures || []).filter(f => f.predicate === 'column-form-tuple-invalid');
    assert.equal(fails.length, 1,
      `tuple predicate must fire on the sub-service; got ${JSON.stringify(childResult?.failures)}`);
  });

  it('throws TypeError when savedBlob is null/undefined', async () => {
    canRehydrateFetch = require('../lib/lint/can-rehydrate-fetch').canRehydrateFetch;
    await assert.rejects(
      () => canRehydrateFetch({ savedBlob: null }),
      /requires a savedBlob/
    );
    await assert.rejects(
      () => canRehydrateFetch({}),  // savedBlob undefined
      /requires a savedBlob/
    );
  });
});
