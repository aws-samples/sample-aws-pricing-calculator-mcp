# AWS Calculator Validation Suite

Validates that all 159 service field mappings produce working estimates via the AWS Pricing Calculator direct API, and optionally verifies rendering with Playwright.

## Architecture

```
validation/
  field-mapping.json         # Maps UI labels to API field IDs for 159 services
  run-validation.js          # Combined runner (API + optional visual)
  features/
    calculator_services.feature  # BDD feature file (333+ scenarios)
  steps/
    calculator_steps.js      # Node.js test runner using node:test
  playwright/
    validate-estimate.js     # Headless browser visual validator
```

## How it works

1. **Field Mapping** (`field-mapping.json`) bridges the human-readable labels visible in the calculator.aws UI with the internal API field IDs used by the calculator's JSON payload. Each of the 159 services has a `serviceCode`, `estimateFor` template ID, and a map of fields with their `fieldId` and `type`.

2. **API Validation** uses `EstimateBuilder` from the project's `lib/` to construct estimate payloads for each service and submit them to the calculator save API. A valid response with a `savedKey` proves the field mapping is correct.

3. **Visual Validation** (optional) opens generated estimate URLs in Playwright/Chromium to verify that the calculator renders the services with visible cost values.

## Quick Start

```bash
# Install dependencies
npm install

# Run API-only validation (fast, no browser needed)
node validation/run-validation.js

# Run with verbose output
node validation/run-validation.js --verbose

# Validate a specific service
node validation/run-validation.js --service "Lambda"

# Validate in a specific region
node validation/run-validation.js --region sa-east-1

# Run with visual validation (requires playwright)
npm install --save-dev playwright && npx playwright install chromium
node validation/run-validation.js --visual

# Generate a JSON report
node validation/run-validation.js --report
```

## Using the Node.js Test Runner

```bash
# Run step definitions with node --test
node --test validation/steps/calculator_steps.js

# Filter to specific tests
node --test --test-name-pattern="Lambda" validation/steps/calculator_steps.js
```

## npm Scripts

```bash
npm run validate            # API-only validation
npm run validate:visual     # API + Playwright visual checks
npm run validate:report     # API validation with JSON report output
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VALIDATION_REGION` | `us-east-1` | AWS region for estimates |
| `VALIDATION_TIMEOUT` | `30000` | Timeout per service (ms) |
| `VALIDATION_CONCURRENCY` | `3` | Max parallel API calls |
| `VALIDATION_SERVICE` | (all) | Filter to matching service names |

## BDD Feature File

The `features/calculator_services.feature` file contains 333+ scenarios in Gherkin format, adapted for the direct API approach. Each scenario specifies:

- The service name and region
- Configuration fields using API field IDs (from field-mapping.json)
- Expected outcome (estimate saved, URL accessible)

Example:
```gherkin
@compute @lambda
Scenario Outline: Configure AWS Lambda - <architecture> architecture
  When I create an estimate with:
    | service      | AWS Lambda |
    | region       | us-east-1  |
  And I configure the service with:
    | field                            | value         |
    | architecture                     | <architecture>|
    | numberOfRequests                 | 1000000       |
    | durationOfEachRequest            | 250           |
    | amountOfMemoryAllocated          | 1024          |
    | amountOfEphemeralStorageAllocated | 512           |
    | concurrency                      | 100           |
  Then the estimate should be saved successfully
  And the estimate URL should be accessible

  Examples: Architecture variants
    | architecture |
    | x86          |
    | Arm          |
```

## What It Validates

- **Field mapping correctness**: Every `fieldId` in `field-mapping.json` produces a valid estimate
- **API availability**: The calculator save API accepts payloads for all 159 services
- **URL format**: Generated URLs match `https://calculator.aws/#/estimate?id=...`
- **Service discovery**: The CDN manifest resolves all `serviceCode` values
- **Visual rendering** (with `--visual`): The estimate page loads and displays services

## Output

Without `--report`, results are printed to stdout:
```
============================================================
  AWS Calculator Validation Results
============================================================

  API Validation:
    Passed:  155
    Failed:  2
    Skipped: 2
    Total:   159
    Duration: 45.3s

  Failed services:
    - AWS Cloud Map: Definition fetch failed...
============================================================
```

With `--report`, a `validation/report.json` is generated with full details for CI integration.
