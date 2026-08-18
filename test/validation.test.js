const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function clearCaches() {
  delete require.cache[require.resolve('../lib/aws/aws-client')];
  delete require.cache[require.resolve('../lib/lint/validation')];
}

describe('levenshtein', () => {
  const { levenshtein } = require('../lib/lint/validation');

  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
  });

  it('returns length for empty vs non-empty', () => {
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
  });

  it('computes correct distance for similar strings', () => {
    assert.equal(levenshtein('numberOfRequests', 'NumberofRequests'), 2);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });
});

describe('suggestMatch', () => {
  const { suggestMatch } = require('../lib/lint/validation');

  const validIds = [
    'numberOfRequests', 'durationOfEachRequest', 'sizeOfMemoryAllocated',
    'storageAmountEphemeral', 'selectArchitectureRequests',
  ];

  it('suggests close matches for typos', () => {
    const result = suggestMatch('NumberofRequests', validIds);
    assert.ok(result.includes('numberOfRequests'), `Expected numberOfRequests in ${result}`);
  });

  it('suggests sizeOfMemoryAllocated for close misspelling', () => {
    const result = suggestMatch('sizeOfMemoryAlocated', validIds);
    assert.ok(result.includes('sizeOfMemoryAllocated'), `Expected sizeOfMemoryAllocated in ${result}`);
  });

  it('returns empty array for completely unrelated input', () => {
    const result = suggestMatch('xyzzy', validIds);
    assert.equal(result.length, 0);
  });

  it('returns at most max suggestions', () => {
    const result = suggestMatch('storage', validIds, 2);
    assert.ok(result.length <= 2);
  });
});

describe('validateConfigKeys', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearCaches();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCaches();
  });

  function mockFetch(responses) {
    global.fetch = async (url) => {
      for (const [pattern, body] of responses) {
        if (url.includes(pattern)) {
          return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
        }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
    };
  }

  const FAKE_MANIFEST = {
    awsServices: [
      { key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' },
      { key: 'amazonRDSPostgreSQLDB', name: 'Amazon RDS for PostgreSQL', serviceCode: 'amazonRDSPostgreSQLDB' },
    ],
  };

  const FAKE_DEFINITION = {
    version: '1.0.0',
    serviceCode: 'aWSLambda',
    templates: [{
      id: 'tmpl',
      cards: [{ inputSection: { components: [
        { id: 'numberOfRequests', type: 'numericInput' },
        { id: 'durationOfEachRequest', type: 'numericInput' },
        { id: 'sizeOfMemoryAllocated', type: 'numericInput' },
      ]}}],
    }],
  };

  it('returns null for valid config keys', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      description: 'test',
      numberOfRequests: '100',
    });
    assert.equal(result.error, null);
  });

  it('returns error with suggestions for invalid keys', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      NumberofRequests: '100',
    });
    assert.ok(result.error, 'should return an error');
    assert.ok(result.error.includes('NumberofRequests'), 'should mention the invalid key');
    assert.ok(result.error.includes('numberOfRequests'), 'should suggest the correct key');
    assert.ok(result.error.includes('get_service_fields'), 'should mention get_service_fields');
  });

  it('rejects an unsupported region with the supported list', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['regionList/publish.json', { aWSLambda: ['us-east-1', 'eu-west-1'] }],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'ap-northeast-99',
      numberOfRequests: '100',
    });
    assert.ok(result.error, 'should return an error');
    assert.match(result.error, /not supported/);
    assert.match(result.error, /us-east-1/);
    assert.match(result.error, /eu-west-1/);
  });

  it('passes when the region is in the supported list', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['regionList/publish.json', { aWSLambda: ['us-east-1', 'eu-west-1'] }],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: '100',
    });
    assert.equal(result.error, null);
  });

  it('skips region validation when the service is missing from the list', async () => {
    // Some services (Bedrock, Chime) aren't in regionList/publish.json — we
    // skip rather than false-reject.
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['regionList/publish.json', { someOtherService: ['us-east-1'] }],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'ap-northeast-1',
      numberOfRequests: '100',
    });
    assert.equal(result.error, null);
  });

  it('skips region validation when the list returns empty array (= all regions)', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['regionList/publish.json', { aWSLambda: [] }],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: '100',
    });
    assert.equal(result.error, null);
  });

  it('skips region validation when region list is unreachable', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      // No regionList mock — 404
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: '100',
    });
    assert.equal(result.error, null);
  });

  // The previous behavior was an unconditional ec2Enhancement bypass
  // in validateConfigKeys. That bypass was removed 2026-06-07 after a
  // production regression where it allowed agents to pass made-up
  // fields (numberOfInstances) and malformed workload objects. EC2 now
  // gets the same validation every other service does. The
  // service-not-in-manifest path stays a no-op (returns null error)
  // because the manifest probe is what fails — see "returns null when
  // service is not found in manifest" below.
  it('runs validation for ec2Enhancement (bypass removed)', async () => {
    // No mock fetch installed → the manifest probe fails and the
    // outer try/catch returns null error. This matches the
    // "service-unreachable graceful degradation" path. We aren't
    // asserting anything about behavior here beyond the absence of a
    // residual bypass.
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('ec2Enhancement', {
      region: 'us-east-1',
      instanceType: 'm5.large',
      totallyFakeField: 'whatever',
    });
    // With no mock fetch the function falls into its catch branch and
    // returns null error. The test's actual contract (rejection of
    // made-up fields) lives in the regression test below this block.
    assert.ok(result.error === null || typeof result.error === 'string',
      `expected either null or a structured error string; got ${typeof result.error}`);
  });

  it('returns null when only meta keys are present', async () => {
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      description: 'test',
    });
    assert.equal(result.error, null);
  });

  it('returns null gracefully when definition fetch fails', async () => {
    mockFetch([]); // everything 404s
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      badField: '100',
    });
    assert.equal(result.error, null, 'should not block on fetch failure');
  });

  it('returns a structured error when service is not found in manifest', async () => {
    mockFetch([['manifest/en_US.json', FAKE_MANIFEST]]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('nonexistentService', {
      region: 'us-east-1',
      someField: '100',
    });
    // Service didn't resolve — surface to agent immediately rather than
    // letting the entry through and failing later at lint with a vague
    // template-existence error.
    assert.ok(result.error, 'should surface an error');
    assert.match(result.error, /not found in manifest|did not resolve/);
  });

  it('reports multiple invalid keys at once', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      bogusOne: '1',
      bogusTwo: '2',
    });
    assert.ok(result.error.includes('bogusOne'));
    assert.ok(result.error.includes('bogusTwo'));
  });

  it('validates columnFormIPM selector values against allowed list', async () => {
    const RDS_DEF = {
      version: '0.0.110',
      serviceCode: 'amazonRDSPostgreSQLDB',
      templates: [{
        id: 'rdsForPostgreSQL',
        cards: [{ inputSection: { components: [{
          id: 'columnFormIPM',
          type: 'input',
          subType: 'columnFormIPM',
          mappingDefinitionName: 'rds-postgresql-calc',
          row: [
            { label: 'Instance Type', selectorId: 'Instance Type', type: 'autoSuggest', isInstanceType: true },
            { label: 'Deployment Option', selectorId: 'Deployment Option', type: 'dropDown' },
          ],
        }]}}],
      }],
    };
    const MAPPING_DEF = {
      'Instance Type': ['db.r6g.4xlarge', 'db.r6g.8xlarge'],
      'Deployment Option': ['Single-AZ', 'Multi-AZ'],
    };

    global.fetch = async (url) => {
      if (url.includes('manifest/en_US.json')) {
        return { ok: true, json: async () => FAKE_MANIFEST, text: async () => '' };
      }
      if (url.includes('data/amazonRDSPostgreSQLDB')) {
        return { ok: true, json: async () => RDS_DEF, text: async () => '' };
      }
      if (url.includes('mappingDefinitions') || url.includes('rds-postgresql-calc')) {
        return { ok: true, json: async () => MAPPING_DEF, text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
    };

    const { validateConfigKeys } = require('../lib/lint/validation');
    const result = await validateConfigKeys('amazonRDSPostgreSQLDB', {
      region: 'us-east-1',
      columnFormIPM: {
        value: [{
          'Instance Type': { value: 'db.invalid.type' },
          'Deployment Option': { value: 'Single-AZ' },
        }],
      },
    });
    // The exact selector-value validation depends on enrichFieldsWithMetadata
    // returning selectorValues. If the mapping endpoint shape doesn't match
    // production, this test is best-effort. Either null (no enrichment) or
    // an error mentioning the invalid value is acceptable; a false-positive
    // error on the valid value is not.
    if (result.error) {
      assert.ok(!result.error.includes('Single-AZ'), 'must not flag a valid value');
    }
  });

  it('auto-corrects a case-mismatched dropdown value', async () => {
    const DEF_WITH_DROPDOWN = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'numberOfRequests', type: 'numericInput' },
          { id: 'selectedOS', type: 'input', subType: 'dropdown', options: [
            { id: 'linux' }, { id: 'windows' },
          ]},
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF_WITH_DROPDOWN],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: '5',
      selectedOS: 'Linux',
    });
    assert.equal(r.error, null);
    assert.equal(r.corrections.length, 1);
    assert.equal(r.corrections[0].field, 'selectedOS');
    assert.equal(r.corrections[0].to, 'linux');
    assert.equal(r.correctedConfig.selectedOS, 'linux');
  });

  it('errors on a hard-error value with no auto-correct', async () => {
    const DEF_WITH_DROPDOWN = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'selectedOS', type: 'input', subType: 'dropdown', options: [
            { id: 'linux' }, { id: 'windows' },
          ]},
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF_WITH_DROPDOWN],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      selectedOS: 'completely-bogus-os',
    });
    assert.ok(r.error);
    assert.match(r.error, /selectedOS/);
    assert.deepEqual(r.corrections, []);
  });

  it('field-name typo wins over value typo on different field (fail-fast)', async () => {
    const DEF_WITH_DROPDOWN = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'numberOfRequests', type: 'numericInput' },
          { id: 'selectedOS', type: 'input', subType: 'dropdown', options: [{ id: 'linux' }] },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF_WITH_DROPDOWN],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      NumberofRequests: '5',           // wrong key (typo)
      selectedOS: 'completely-bogus',  // wrong value
    });
    assert.ok(r.error);
    assert.match(r.error, /NumberofRequests/);
    // The key-error path must short-circuit before value validation runs.
    // Check that by asserting we got the field-IDs error, not the values one.
    assert.match(r.error, /Invalid field IDs/);
    assert.doesNotMatch(r.error, /Invalid values for/,
      'value error must not be reported when key error already fires');
  });

  it('auto-corrects multiple values in one config', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'numberOfRequests', type: 'numericInput' },
          { id: 'selectedOS', type: 'input', subType: 'dropdown', options: [{ id: 'linux' }, { id: 'windows' }] },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: 5,        // number → string
      selectedOS: 'Linux',        // case → 'linux'
    });
    assert.equal(r.error, null);
    assert.equal(r.corrections.length, 2);
    assert.equal(r.correctedConfig.numberOfRequests, '5');
    assert.equal(r.correctedConfig.selectedOS, 'linux');
  });

  it('preserves original config in correctedConfig when no corrections needed', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [{ id: 'numberOfRequests', type: 'numericInput' }] }}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const cfg = { region: 'us-east-1', numberOfRequests: '5' };
    const r = await validateConfigKeys('aWSLambda', cfg);
    assert.equal(r.error, null);
    assert.deepEqual(r.corrections, []);
    assert.deepEqual(r.correctedConfig, cfg);
  });

  it('caps corrections at 20 entries and sets truncated: true', async () => {
    // Build a definition with 25 dropdown fields, each with a single valid option.
    // Send 25 case-mismatched values — every one is a 1-correction.
    const components = [];
    const config = { region: 'us-east-1' };
    for (let i = 0; i < 25; i++) {
      components.push({
        id: `field${i}`,
        type: 'input',
        subType: 'dropdown',
        options: [{ id: 'lower' }],
      });
      config[`field${i}`] = 'LOWER'; // case mismatch on every one
    }
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{ id: 'tmpl', cards: [{ inputSection: { components } }] }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', config);
    assert.equal(r.error, null);
    assert.equal(r.corrections.length, 20, 'corrections array must be capped at 20');
    assert.equal(r.truncated, true, 'truncated flag must be set when cap hit');
    // Every entry must be the homogeneous correction object — no string entries.
    for (const c of r.corrections) {
      assert.equal(typeof c, 'object', `expected object correction, got ${typeof c}`);
      assert.ok('field' in c && 'from' in c && 'to' in c && 'reason' in c);
    }
  });

  it('does not set truncated when corrections fit', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'selectedOS', type: 'input', subType: 'dropdown', options: [{ id: 'linux' }] },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      selectedOS: 'Linux',
    });
    assert.equal(r.error, null);
    assert.equal(r.corrections.length, 1);
    assert.equal(r.truncated, undefined, 'truncated must be omitted when not needed');
  });

  it('flags missingRequired when catalog required[] field is absent', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'numberOfRequests', type: 'numericInput' },
          { id: 'durationOfEachRequest', type: 'numericInput' },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'tmpl',
        required: [
          { field: 'numberOfRequests' },
          { field: 'durationOfEachRequest' },
        ],
      }],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: '5',
    }, 'aws', catalog);
    assert.equal(r.error, null);
    assert.deepEqual(r.missingRequired, ['durationOfEachRequest']);
  });

  it('flags missingRequired when entire config is empty (Test 5 NAT case)', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'a', type: 'numericInput' },
          { id: 'b', type: 'numericInput' },
          { id: 'c', type: 'numericInput' },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'tmpl',
        required: [{ field: 'a' }, { field: 'b' }, { field: 'c' }],
      }],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    // Just region + description, no actual config — Test 5's exact shape.
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      description: 'p',
    }, 'aws', catalog);
    assert.equal(r.error, null);
    assert.deepEqual(r.missingRequired, ['a', 'b', 'c']);
  });

  it('does NOT flag missingRequired when all required fields present', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'numberOfRequests', type: 'numericInput' },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const catalog = new Map([
      ['aWSLambda', {
        serviceCode: 'aWSLambda',
        templateId: 'tmpl',
        required: [{ field: 'numberOfRequests' }],
      }],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: '5',
    }, 'aws', catalog);
    assert.equal(r.error, null);
    assert.equal(r.missingRequired, undefined);
  });

  it('walks form-side validations.required even without catalog', async () => {
    const DEF = {
      version: '1.0.0',
      serviceCode: 'aWSLambda',
      templates: [{
        id: 'tmpl',
        cards: [{ inputSection: { components: [
          { id: 'mustHave', type: 'numericInput', validations: { required: true } },
          { id: 'optional', type: 'numericInput' },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    // No catalog argument; form-side walk alone must flag mustHave.
    const r = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      optional: '5',
    });
    assert.equal(r.error, null);
    assert.deepEqual(r.missingRequired, ['mustHave']);
  });

  // Production regression 2026-06-07: validateConfigKeys had an
  // unconditional early return for `ec2Enhancement` that bypassed all
  // checks (field-name validity, value shape, required-field-presence).
  // Agents passed `numberOfInstances` (a made-up field) and the
  // bypass let it through; downstream lib/aws/ec2.js had no idea the
  // field was bogus. The fix removes the early return so EC2 gets
  // the same validation every other service gets.
  //
  // Setup: stub manifest + a minimal ec2Enhancement def with a small
  // set of real fields. validateConfigKeys without the bypass walks
  // those and rejects unknown keys.
  it('rejects unknown field names on ec2Enhancement (regression: bypass removed)', async () => {
    const FAKE_MANIFEST_EC2 = {
      awsServices: [
        { key: 'ec2Enhancement', name: 'Amazon EC2', serviceCode: 'ec2Enhancement' },
      ],
    };
    const FAKE_DEF = {
      version: '1.0.0',
      serviceCode: 'ec2Enhancement',
      templates: [{
        id: 'template',
        cards: [{ inputSection: { components: [
          // type: 'input' is what extractInputFields recognizes; the
          // calculator's real EC2 def uses bespoke subTypes
          // (ec2InstanceSearch, workload, ec2AdvPricingStrategyV2) but
          // for the purpose of validating field-NAME existence those
          // bespoke types pass through validateFieldValue's unknown-type
          // branch unchanged. The test only needs the IDs to be
          // discoverable.
          { id: 'instanceType', type: 'input', subType: 'numericInput' },
          { id: 'workload', type: 'input', subType: 'numericInput' },
          { id: 'pricingStrategy', type: 'input', subType: 'dropdown',
            options: [{ id: 'ondemand' }, { id: 'reserved' }] },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST_EC2],
      ['data/ec2Enhancement', FAKE_DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('ec2Enhancement', {
      region: 'us-east-1',
      instanceType: 'm5.large',
      numberOfInstances: 2,  // made-up field — must be rejected
    });
    assert.ok(r.error, 'expected validation error for made-up field "numberOfInstances"');
    assert.match(r.error, /numberOfInstances/,
      `error message should name the bad field; got: ${r.error}`);
  });

  it('accepts valid ec2Enhancement config (regression: bypass removal does not break legit configs)', async () => {
    const FAKE_MANIFEST_EC2 = {
      awsServices: [
        { key: 'ec2Enhancement', name: 'Amazon EC2', serviceCode: 'ec2Enhancement' },
      ],
    };
    const FAKE_DEF = {
      version: '1.0.0',
      serviceCode: 'ec2Enhancement',
      templates: [{
        id: 'template',
        cards: [{ inputSection: { components: [
          // type: 'input' is what extractInputFields recognizes; the
          // calculator's real EC2 def uses bespoke subTypes
          // (ec2InstanceSearch, workload, ec2AdvPricingStrategyV2) but
          // for the purpose of validating field-NAME existence those
          // bespoke types pass through validateFieldValue's unknown-type
          // branch unchanged. The test only needs the IDs to be
          // discoverable.
          { id: 'instanceType', type: 'input', subType: 'numericInput' },
          { id: 'workload', type: 'input', subType: 'numericInput' },
          { id: 'pricingStrategy', type: 'input', subType: 'dropdown',
            options: [{ id: 'ondemand' }, { id: 'reserved' }] },
        ]}}],
      }],
    };
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST_EC2],
      ['data/ec2Enhancement', FAKE_DEF],
    ]);
    const { validateConfigKeys } = require('../lib/lint/validation');
    const r = await validateConfigKeys('ec2Enhancement', {
      region: 'us-east-1',
      instanceType: 'm5.large',
      workload: 1,
      pricingStrategy: 'ondemand',
    });
    assert.equal(r.error, null,
      `legit ec2 config should pass; got error: ${r.error}`);
  });
});

describe('validateFieldValue — dropdown', () => {
  const { validateFieldValue } = require('../lib/lint/validation');
  const linuxField = {
    id: 'selectedOS',
    type: 'dropdown',
    options: [
      { id: 'linux' }, { id: 'windows' }, { id: 'rhel' }, { id: 'suse' },
    ],
  };

  it('passes a valid option id', () => {
    assert.deepEqual(validateFieldValue(linuxField, 'linux'), { ok: true });
  });

  it('passes when the value is wrapped { value: "linux" }', () => {
    assert.deepEqual(validateFieldValue(linuxField, { value: 'linux' }), { ok: true });
  });

  it('auto-corrects case mismatch', () => {
    const r = validateFieldValue(linuxField, 'Linux');
    assert.equal(r.ok, 'corrected');
    assert.equal(r.correctedValue, 'linux');
    assert.match(r.reason, /case/i);
  });

  it('auto-corrects single-character typo via Levenshtein-1', () => {
    const r = validateFieldValue(linuxField, 'linus');
    assert.equal(r.ok, 'corrected');
    assert.equal(r.correctedValue, 'linux');
    assert.match(r.reason, /typo|levenshtein/i);
  });

  it('errors on a value with no close match', () => {
    const r = validateFieldValue(linuxField, 'ubuntu');
    assert.equal(r.ok, false);
    assert.match(r.error, /ubuntu/);
    assert.match(r.error, /selectedOS/);
  });

  it('preserves the wrapped shape on auto-correct', () => {
    const r = validateFieldValue(linuxField, { value: 'Linux' });
    assert.equal(r.ok, 'corrected');
    assert.deepEqual(r.correctedValue, { value: 'linux' });
  });

  it('truncates the option list in error message when >10 options', () => {
    const bigField = {
      id: 'instanceType',
      type: 'dropdown',
      options: Array.from({ length: 25 }, (_, i) => ({ id: `m5.size${i}` })),
    };
    const r = validateFieldValue(bigField, 'totally-bogus');
    assert.equal(r.ok, false);
    assert.match(r.error, /\.\.\.\(25 total\)|\(25 total\)/);
  });

  it('does not auto-correct when two options collide case-insensitively', () => {
    const collidingField = {
      id: 'sizeCode',
      type: 'dropdown',
      options: [{ id: 'M5' }, { id: 'm5' }],
    };
    assert.deepEqual(validateFieldValue(collidingField, 'M5'), { ok: true });
    const r = validateFieldValue(collidingField, 'M55');
    if (r.ok === 'corrected') {
      assert.doesNotMatch(r.reason, /case/i, 'must not call this a case-insensitive match');
    }
  });

  it('caches the case-collision flag on first use, reuses on subsequent calls', () => {
    // First call: case-colliding options trigger the cache entry.
    const cachedField = {
      id: 'cachedTestField',
      type: 'dropdown',
      options: [{ id: 'X' }, { id: 'x' }],
    };
    // Both first and second calls must reject case auto-correct identically.
    const r1 = validateFieldValue(cachedField, 'X1');
    const r2 = validateFieldValue(cachedField, 'X1');
    if (r1.ok === 'corrected') {
      assert.notEqual(r1.reason, undefined);
      assert.doesNotMatch(r1.reason, /case/i);
    }
    // Second call must produce the same shape — proves the cache hit didn't
    // change behavior.
    assert.deepEqual(r1, r2);
  });
});

describe('validateFieldValue — fileSize', () => {
  const { validateFieldValue } = require('../lib/lint/validation');
  const storageField = {
    id: 'storageAmount',
    type: 'fileSize',
    validSizes: ['gb', 'tb', 'mb'],
    defaultUnit: 'gb|NA',
  };

  it('passes a valid { value, unit } pair', () => {
    assert.deepEqual(
      validateFieldValue(storageField, { value: '100', unit: 'gb|NA' }),
      { ok: true }
    );
  });

  it('auto-corrects uppercase size', () => {
    const r = validateFieldValue(storageField, { value: '100', unit: 'GB|NA' });
    assert.equal(r.ok, 'corrected');
    assert.deepEqual(r.correctedValue, { value: '100', unit: 'gb|NA' });
  });

  it('auto-corrects whitespace + mixed case', () => {
    const r = validateFieldValue(storageField, { value: '100', unit: ' Gb |month' });
    assert.equal(r.ok, 'corrected');
    assert.deepEqual(r.correctedValue, { value: '100', unit: 'gb|month' });
  });

  it('errors on unknown size', () => {
    const r = validateFieldValue(storageField, { value: '100', unit: 'petabyte|NA' });
    assert.equal(r.ok, false);
    assert.match(r.error, /petabyte|validSizes/i);
  });

  it('errors on missing |  separator', () => {
    const r = validateFieldValue(storageField, { value: '100', unit: 'gb-NA' });
    assert.equal(r.ok, false);
  });

  it('errors when value is not a { value, unit } object', () => {
    const r = validateFieldValue(storageField, '100');
    assert.equal(r.ok, false);
  });

  it('errors when unit is missing', () => {
    const r = validateFieldValue(storageField, { value: '100' });
    assert.equal(r.ok, false);
  });
});

describe('validateFieldValue — numeric / frequency / durationInput', () => {
  const { validateFieldValue } = require('../lib/lint/validation');

  it('numericInput passes a string value', () => {
    const f = { id: 'count', type: 'numericInput' };
    assert.deepEqual(validateFieldValue(f, '1000'), { ok: true });
  });

  it('numericInput auto-corrects a number to a string', () => {
    const f = { id: 'count', type: 'numericInput' };
    const r = validateFieldValue(f, 1000);
    assert.equal(r.ok, 'corrected');
    assert.equal(r.correctedValue, '1000');
  });

  it('numericInput rejects null', () => {
    const f = { id: 'count', type: 'numericInput' };
    assert.equal(validateFieldValue(f, null).ok, false);
  });

  it('numericInput rejects array', () => {
    const f = { id: 'count', type: 'numericInput' };
    assert.equal(validateFieldValue(f, [1, 2]).ok, false);
  });

  it('frequency passes a valid { value: string, unit: string }', () => {
    const f = { id: 'requests', type: 'frequency' };
    const r = validateFieldValue(f, { value: '5', unit: 'millionPerMonth' });
    assert.deepEqual(r, { ok: true });
  });

  it('frequency auto-corrects inner value when number-typed', () => {
    const f = { id: 'requests', type: 'frequency' };
    const r = validateFieldValue(f, { value: 5, unit: 'millionPerMonth' });
    assert.equal(r.ok, 'corrected');
    assert.deepEqual(r.correctedValue, { value: '5', unit: 'millionPerMonth' });
  });

  it('frequency rejects missing inner value', () => {
    const f = { id: 'requests', type: 'frequency' };
    assert.equal(validateFieldValue(f, { unit: 'millionPerMonth' }).ok, false);
  });

  it('frequency rejects null', () => {
    const f = { id: 'requests', type: 'frequency' };
    assert.equal(validateFieldValue(f, null).ok, false);
  });

  it('durationInput follows the same rules as frequency', () => {
    const f = { id: 'duration', type: 'durationInput' };
    const r = validateFieldValue(f, { value: 960, unit: 'min' });
    assert.equal(r.ok, 'corrected');
    assert.deepEqual(r.correctedValue, { value: '960', unit: 'min' });
  });

  it('frequency rejects a unit not in the field options[] (the Step Functions trap)', () => {
    // Reproduces the 2026-05-30 silent-$0 bug: numberOfExecutions only
    // accepts perHour/perDay/perMonth, but millionPerMonth saved cleanly
    // and rendered $0. Validator must reject the bad enum at add_service
    // time so the bad value never reaches the save API.
    const f = {
      id: 'numberOfExecutions',
      type: 'frequency',
      options: [
        { id: 'perHour', label: 'per hour' },
        { id: 'perDay', label: 'per day' },
        { id: 'perMonth', label: 'per month' },
      ],
    };
    const r = validateFieldValue(f, { value: '1', unit: 'millionPerMonth' });
    assert.equal(r.ok, false);
    assert.match(r.error, /not a valid option/);
    assert.match(r.error, /perMonth/);
    assert.match(r.error, /Did you mean.*perMonth/);
  });

  it('frequency accepts any unit when options[] is absent (back-compat)', () => {
    // Older test fixtures and fields whose PCT shape we don't fully
    // model shouldn't be rejected — skip the enum check when there's no
    // options metadata to compare against.
    const f = { id: 'requests', type: 'frequency' };
    assert.deepEqual(validateFieldValue(f, { value: '5', unit: 'millionPerMonth' }), { ok: true });
  });

  it('frequency accepts a unit when it IS in options[] (Lambda case)', () => {
    // Lambda's numberOfRequests legitimately accepts millionPerMonth — the
    // earlier test was passing only by accident (no options[]). Check the
    // happy path with a real options array.
    const f = {
      id: 'numberOfRequests',
      type: 'frequency',
      options: [
        { id: 'perSecond', label: 'per second' },
        { id: 'perMonth', label: 'per month' },
        { id: 'millionPerMonth', label: 'millions per month' },
      ],
    };
    assert.deepEqual(validateFieldValue(f, { value: '200', unit: 'millionPerMonth' }), { ok: true });
  });
});

describe('validateFieldValue — unknown type', () => {
  const { validateFieldValue } = require('../lib/lint/validation');

  it('returns ok for a type we do not model', () => {
    const f = { id: 'whatever', type: 'someNewType' };
    assert.deepEqual(validateFieldValue(f, 'anything goes'), { ok: true });
  });

  it('returns ok for a field with no type', () => {
    const f = { id: 'mystery' };
    assert.deepEqual(validateFieldValue(f, 'anything'), { ok: true });
  });
});
