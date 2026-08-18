const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { estimateToMarkdown } = require('../lib/aws/aws-client');

describe('estimateToMarkdown', () => {
  it('renders estimate name and total cost', () => {
    const data = {
      name: 'Test Estimate',
      totalCost: { monthly: 1234.56, upfront: 0 },
      services: {},
      groups: {},
    };
    const md = estimateToMarkdown(data);
    assert.ok(md.includes('# Test Estimate'));
    assert.ok(md.includes('$1234.56'));
  });

  it('renders ungrouped services', () => {
    const data = {
      name: 'My Estimate',
      totalCost: { monthly: 100 },
      services: {
        'aWSLambda-abc': {
          serviceName: 'AWS Lambda',
          regionName: 'US East (N. Virginia)',
          serviceCost: { monthly: 50 },
          description: 'Compute',
          configSummary: 'requests (1M)',
        },
      },
      groups: {},
    };
    const md = estimateToMarkdown(data);
    assert.ok(md.includes('**AWS Lambda**'));
    assert.ok(md.includes('US East (N. Virginia)'));
    assert.ok(md.includes('$50.00/mo'));
    assert.ok(md.includes('Compute'));
    assert.ok(md.includes('requests (1M)'));
  });

  it('renders grouped services', () => {
    const data = {
      name: 'Grouped',
      totalCost: { monthly: 200 },
      services: {},
      groups: {
        'Prod-123': {
          name: 'Production',
          totalCost: { monthly: 200 },
          services: {
            's3-456': {
              serviceName: 'Amazon S3',
              regionName: 'Europe (Frankfurt)',
              serviceCost: { monthly: 200 },
              description: 'Storage',
            },
          },
        },
      },
    };
    const md = estimateToMarkdown(data);
    assert.ok(md.includes('## Production'));
    assert.ok(md.includes('**Amazon S3**'));
    assert.ok(md.includes('$200.00'));
  });

  it('handles upfront costs', () => {
    const data = {
      name: 'RI Estimate',
      totalCost: { monthly: 500, upfront: 1000 },
      services: {},
      groups: {},
    };
    const md = estimateToMarkdown(data);
    assert.ok(md.includes('$500.00'));
    assert.ok(md.includes('Upfront'));
    assert.ok(md.includes('$1000.00'));
  });
});
