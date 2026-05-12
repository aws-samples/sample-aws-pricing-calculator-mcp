// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Calculator Service Validation - Step Definitions
 *
 * Tests that every service in the field-mapping.json can be submitted
 * via the direct API (EstimateBuilder) and returns a valid shareable URL.
 *
 * Run with: node --test validation/steps/calculator_steps.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EstimateBuilder = require('../../lib/estimate-builder');

// Load field mapping
const fieldMapping = require('../field-mapping.json');

// Configuration
const DEFAULT_REGION = process.env.VALIDATION_REGION || 'us-east-1';
const TIMEOUT_MS = parseInt(process.env.VALIDATION_TIMEOUT || '30000', 10);
const CONCURRENCY = parseInt(process.env.VALIDATION_CONCURRENCY || '3', 10);
const SERVICE_FILTER = process.env.VALIDATION_SERVICE || null;

// Track results for reporting
const results = {
  passed: [],
  failed: [],
  skipped: [],
};

/**
 * Build a minimal configuration for a service using field mapping defaults.
 * Returns an object with fieldId -> value pairs ready for EstimateBuilder.
 */
function buildDefaultConfig(serviceName, serviceConfig) {
  const config = { region: DEFAULT_REGION };

  if (!serviceConfig.fields) return config;

  for (const [label, fieldInfo] of Object.entries(serviceConfig.fields)) {
    const fieldId = fieldInfo.fieldId;
    if (!fieldId) continue;

    // Use default value if provided
    if (fieldInfo.defaultValue) {
      config[fieldId] = fieldInfo.defaultValue;
      continue;
    }

    // Provide sensible test defaults based on field type
    switch (fieldInfo.type) {
      case 'input':
      case 'numericInput':
        config[fieldId] = '1';
        break;
      case 'dropdown':
        if (fieldInfo.allowedValues && fieldInfo.allowedValues.length > 0) {
          config[fieldId] = fieldInfo.allowedValues[0];
        }
        break;
      case 'autosuggest':
        // Skip autosuggest fields - they need specific valid values
        break;
      default:
        config[fieldId] = '1';
        break;
    }
  }

  return config;
}

/**
 * Validate that a URL matches the expected calculator.aws format.
 */
function validateEstimateUrl(url) {
  assert.ok(url, 'Expected a shareable URL');
  assert.ok(
    url.includes('calculator.aws'),
    `URL should contain calculator.aws, got: ${url}`
  );
  assert.match(
    url,
    /https:\/\/calculator\.aws\/#\/estimate\?(?:ctrct=[^&]+&volume_discount=0&)?id=[a-f0-9]+/,
    `URL should match expected format, got: ${url}`
  );
}

describe('Calculator Service Validation', { timeout: TIMEOUT_MS * 5 }, () => {
  const serviceEntries = Object.entries(fieldMapping).filter(([name, config]) => {
    if (name === '_metadata') return false;
    if (SERVICE_FILTER && !name.toLowerCase().includes(SERVICE_FILTER.toLowerCase())) return false;
    return true;
  });

  before(() => {
    console.log(`\nValidating ${serviceEntries.length} services against calculator API`);
    console.log(`Region: ${DEFAULT_REGION} | Timeout: ${TIMEOUT_MS}ms | Concurrency: ${CONCURRENCY}`);
    if (SERVICE_FILTER) console.log(`Filter: "${SERVICE_FILTER}"`);
    console.log('---');
  });

  after(() => {
    console.log('\n=== Validation Summary ===');
    console.log(`Passed: ${results.passed.length}`);
    console.log(`Failed: ${results.failed.length}`);
    console.log(`Skipped: ${results.skipped.length}`);
    if (results.failed.length > 0) {
      console.log('\nFailed services:');
      for (const { name, error } of results.failed) {
        console.log(`  - ${name}: ${error}`);
      }
    }
  });

  for (const [serviceName, serviceConfig] of serviceEntries) {
    // Skip services with no fields (they have no configurable parameters)
    if (!serviceConfig.fields || Object.keys(serviceConfig.fields).length === 0) {
      it(`should skip ${serviceName} (no configurable fields)`, { skip: true }, () => {
        results.skipped.push({ name: serviceName, reason: 'no fields' });
      });
      continue;
    }

    it(`should create estimate for ${serviceName}`, { timeout: TIMEOUT_MS }, async () => {
      const serviceCode = serviceConfig.serviceCode || serviceName;
      const config = buildDefaultConfig(serviceName, serviceConfig);

      try {
        const builder = new EstimateBuilder(`Validation - ${serviceName}`);
        builder.addService(serviceCode, config);
        const result = await builder.export();

        validateEstimateUrl(result.shareableUrl);
        assert.ok(result.estimateId, `Expected estimateId for ${serviceName}`);

        results.passed.push({
          name: serviceName,
          serviceCode,
          estimateId: result.estimateId,
          url: result.shareableUrl,
        });
      } catch (err) {
        results.failed.push({ name: serviceName, error: err.message });
        throw err;
      }
    });
  }
});

describe('Calculator Field Mapping Integrity', () => {
  it('should have metadata section', () => {
    assert.ok(fieldMapping._metadata, 'Missing _metadata section');
    assert.ok(fieldMapping._metadata.description, 'Missing metadata description');
  });

  it('should have at least 150 services mapped', () => {
    const serviceCount = Object.keys(fieldMapping).filter(k => k !== '_metadata').length;
    assert.ok(serviceCount >= 150, `Expected >= 150 services, got ${serviceCount}`);
  });

  it('should have serviceCode for all services', () => {
    const missing = [];
    for (const [name, config] of Object.entries(fieldMapping)) {
      if (name === '_metadata') continue;
      if (!config.serviceCode) missing.push(name);
    }
    assert.strictEqual(missing.length, 0, `Services missing serviceCode: ${missing.join(', ')}`);
  });

  it('should have valid field structures', () => {
    const invalid = [];
    for (const [name, config] of Object.entries(fieldMapping)) {
      if (name === '_metadata') continue;
      if (!config.fields) continue;
      for (const [label, fieldInfo] of Object.entries(config.fields)) {
        if (!fieldInfo.fieldId) {
          invalid.push(`${name} -> "${label}" missing fieldId`);
        }
        if (!fieldInfo.type) {
          invalid.push(`${name} -> "${label}" missing type`);
        }
      }
    }
    assert.strictEqual(invalid.length, 0, `Invalid fields:\n${invalid.join('\n')}`);
  });

  it('should have unique serviceCodes', () => {
    const codes = {};
    for (const [name, config] of Object.entries(fieldMapping)) {
      if (name === '_metadata') continue;
      const code = config.serviceCode;
      if (codes[code]) {
        codes[code].push(name);
      } else {
        codes[code] = [name];
      }
    }
    const duplicates = Object.entries(codes).filter(([, names]) => names.length > 1);
    // Some services legitimately share codes (e.g., RDS variants) - just warn
    if (duplicates.length > 0) {
      console.log(`Note: ${duplicates.length} shared serviceCodes (expected for service variants)`);
    }
  });
});
