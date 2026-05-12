#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Validation Runner
 *
 * Orchestrates the full validation pipeline:
 * 1. API Validation: Uses EstimateBuilder to create estimates for all mapped services
 * 2. Visual Validation (optional): Opens generated URLs in Playwright to verify rendering
 *
 * Usage:
 *   node validation/run-validation.js                    # API-only validation
 *   node validation/run-validation.js --visual           # API + Playwright visual checks
 *   node validation/run-validation.js --service lambda   # Filter to specific service
 *   node validation/run-validation.js --region eu-west-1 # Override region
 *   node validation/run-validation.js --report           # Output JSON report
 *   node validation/run-validation.js --help             # Show help
 */

const path = require('node:path');
const fs = require('node:fs');
const EstimateBuilder = require('../lib/estimate-builder');
const fieldMapping = require('./field-mapping.json');

// Parse CLI arguments
const args = process.argv.slice(2);
const flags = {
  visual: args.includes('--visual'),
  report: args.includes('--report'),
  help: args.includes('--help') || args.includes('-h'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  service: getArgValue('--service'),
  region: getArgValue('--region') || 'us-east-1',
  concurrency: parseInt(getArgValue('--concurrency') || '3', 10),
  timeout: parseInt(getArgValue('--timeout') || '30000', 10),
};

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

function showHelp() {
  console.log(`
AWS Calculator Validation Runner

Validates that all 159 service field mappings produce working estimates
via the direct API, and optionally validates rendering with Playwright.

USAGE:
  node validation/run-validation.js [options]

OPTIONS:
  --visual          Enable Playwright visual validation (requires playwright)
  --service <name>  Filter to services matching <name> (case-insensitive)
  --region <id>     Override default region (default: us-east-1)
  --concurrency <n> Max parallel API calls (default: 3)
  --timeout <ms>    Timeout per service (default: 30000)
  --report          Output JSON report to validation/report.json
  --verbose, -v     Show detailed output for each service
  --help, -h        Show this help message

ENVIRONMENT VARIABLES:
  VALIDATION_REGION       Override region
  VALIDATION_TIMEOUT      Override timeout (ms)
  VALIDATION_CONCURRENCY  Override concurrency
  VALIDATION_SERVICE      Filter to matching services

EXAMPLES:
  # Validate all services
  node validation/run-validation.js

  # Validate only Lambda with visual check
  node validation/run-validation.js --service Lambda --visual

  # Validate in sa-east-1 region
  node validation/run-validation.js --region sa-east-1

  # Generate a JSON report
  node validation/run-validation.js --report
`);
}

/**
 * Build a minimal valid configuration for a service.
 */
function buildConfig(serviceName, serviceConfig, region) {
  const config = { region };

  if (!serviceConfig.fields) return config;

  for (const [label, fieldInfo] of Object.entries(serviceConfig.fields)) {
    const fieldId = fieldInfo.fieldId;
    if (!fieldId) continue;

    // Use default value if available
    if (fieldInfo.defaultValue) {
      config[fieldId] = fieldInfo.defaultValue;
      continue;
    }

    // Use first allowed value for dropdowns
    if (fieldInfo.allowedValues && fieldInfo.allowedValues.length > 0) {
      config[fieldId] = fieldInfo.allowedValues[0];
      continue;
    }

    // Skip autosuggest fields (require specific valid values)
    if (fieldInfo.type === 'autosuggest') continue;

    // Provide a sensible default for numeric inputs
    config[fieldId] = '1';
  }

  return config;
}

/**
 * Run API validation for a single service.
 */
async function validateService(serviceName, serviceConfig, region) {
  const startTime = Date.now();
  const serviceCode = serviceConfig.serviceCode || serviceName;
  const config = buildConfig(serviceName, serviceConfig, region);

  try {
    const builder = new EstimateBuilder(`Validation - ${serviceName}`);
    builder.addService(serviceCode, config);
    const result = await builder.export();

    const duration = Date.now() - startTime;
    return {
      service: serviceName,
      serviceCode,
      status: 'passed',
      estimateId: result.estimateId,
      url: result.shareableUrl,
      duration,
      fieldCount: Object.keys(serviceConfig.fields || {}).length,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      service: serviceName,
      serviceCode,
      status: 'failed',
      error: err.message,
      duration,
      fieldCount: Object.keys(serviceConfig.fields || {}).length,
    };
  }
}

/**
 * Run validation in batches with concurrency control.
 */
async function runBatch(services, region, concurrency) {
  const results = [];
  const queue = [...services];

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency);
    const batchResults = await Promise.all(
      batch.map(([name, config]) => validateService(name, config, region))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Run Playwright visual validation on generated URLs.
 */
async function runVisualValidation(apiResults) {
  let validateEstimate;
  try {
    ({ validateEstimate } = require('./playwright/validate-estimate'));
  } catch (err) {
    console.error('\nPlaywright not available. Install with:');
    console.error('  npm install --save-dev playwright && npx playwright install chromium\n');
    return [];
  }

  const passedResults = apiResults.filter(r => r.status === 'passed' && r.url);
  console.log(`\nRunning visual validation on ${passedResults.length} estimates...`);

  const visualResults = [];
  for (const result of passedResults) {
    process.stdout.write(`  Visual: ${result.service}... `);
    const validation = await validateEstimate(
      result.url,
      [{ name: result.service }],
      { headless: true }
    );
    visualResults.push({
      service: result.service,
      url: result.url,
      ...validation,
    });
    console.log(validation.success ? 'OK' : 'FAIL');
  }

  return visualResults;
}

/**
 * Print results summary.
 */
function printSummary(apiResults, visualResults = []) {
  const passed = apiResults.filter(r => r.status === 'passed');
  const failed = apiResults.filter(r => r.status === 'failed');
  const skipped = apiResults.filter(r => r.status === 'skipped');

  console.log('\n' + '='.repeat(60));
  console.log('  AWS Calculator Validation Results');
  console.log('='.repeat(60));
  console.log(`\n  API Validation:`);
  console.log(`    Passed:  ${passed.length}`);
  console.log(`    Failed:  ${failed.length}`);
  console.log(`    Skipped: ${skipped.length}`);
  console.log(`    Total:   ${apiResults.length}`);

  const totalDuration = apiResults.reduce((sum, r) => sum + (r.duration || 0), 0);
  console.log(`    Duration: ${(totalDuration / 1000).toFixed(1)}s`);

  if (failed.length > 0) {
    console.log(`\n  Failed services:`);
    for (const result of failed) {
      console.log(`    - ${result.service}: ${result.error}`);
    }
  }

  if (visualResults.length > 0) {
    const visualPassed = visualResults.filter(r => r.success);
    const visualFailed = visualResults.filter(r => !r.success);
    console.log(`\n  Visual Validation:`);
    console.log(`    Passed: ${visualPassed.length}`);
    console.log(`    Failed: ${visualFailed.length}`);
    if (visualFailed.length > 0) {
      for (const result of visualFailed) {
        console.log(`    - ${result.service}: ${result.errors.join(', ')}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));

  return failed.length === 0;
}

/**
 * Write JSON report.
 */
function writeReport(apiResults, visualResults) {
  const report = {
    timestamp: new Date().toISOString(),
    region: flags.region,
    summary: {
      total: apiResults.length,
      passed: apiResults.filter(r => r.status === 'passed').length,
      failed: apiResults.filter(r => r.status === 'failed').length,
      skipped: apiResults.filter(r => r.status === 'skipped').length,
    },
    apiResults,
    visualResults: visualResults.length > 0 ? visualResults : undefined,
  };

  const reportPath = path.join(__dirname, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to: ${reportPath}`);
}

/**
 * Main entry point.
 */
async function main() {
  if (flags.help) {
    showHelp();
    process.exit(0);
  }

  console.log('AWS Calculator Validation Runner');
  console.log(`Region: ${flags.region} | Concurrency: ${flags.concurrency} | Visual: ${flags.visual}`);
  if (flags.service) console.log(`Service filter: "${flags.service}"`);
  console.log('');

  // Collect services to validate
  const services = Object.entries(fieldMapping).filter(([name, config]) => {
    if (name === '_metadata') return false;
    if (flags.service && !name.toLowerCase().includes(flags.service.toLowerCase())) return false;
    return true;
  });

  console.log(`Found ${services.length} services to validate\n`);

  // Run API validation
  console.log('Phase 1: API Validation');
  console.log('-'.repeat(40));

  const apiResults = [];
  const queue = [...services];
  let completed = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, flags.concurrency);
    const batchResults = await Promise.all(
      batch.map(([name, config]) => {
        if (!config.fields || Object.keys(config.fields).length === 0) {
          return Promise.resolve({
            service: name,
            serviceCode: config.serviceCode,
            status: 'skipped',
            reason: 'no configurable fields',
            duration: 0,
            fieldCount: 0,
          });
        }
        return validateService(name, config, flags.region);
      })
    );

    for (const result of batchResults) {
      completed++;
      const icon = result.status === 'passed' ? 'OK' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
      if (flags.verbose || result.status === 'failed') {
        console.log(`  [${completed}/${services.length}] ${icon} ${result.service} (${result.duration || 0}ms)`);
        if (result.error) console.log(`       Error: ${result.error}`);
      } else {
        process.stdout.write(`\r  Progress: ${completed}/${services.length}`);
      }
    }

    apiResults.push(...batchResults);
  }

  if (!flags.verbose) console.log(''); // newline after progress

  // Run visual validation if requested
  let visualResults = [];
  if (flags.visual) {
    console.log('\nPhase 2: Visual Validation');
    console.log('-'.repeat(40));
    visualResults = await runVisualValidation(apiResults);
  }

  // Print summary
  const allPassed = printSummary(apiResults, visualResults);

  // Write report if requested
  if (flags.report) {
    writeReport(apiResults, visualResults);
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
