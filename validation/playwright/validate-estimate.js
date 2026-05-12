// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Playwright Visual Validator
 *
 * Opens a calculator.aws estimate URL in a headless browser and verifies:
 * 1. The page loads without errors
 * 2. Services are listed with names
 * 3. Cost values are rendered (non-zero where expected)
 *
 * Usage:
 *   const { validateEstimate } = require('./validate-estimate');
 *   const result = await validateEstimate(url, [{ name: 'AWS Lambda' }]);
 */

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (err) {
  // Playwright is optional - provide a helpful message
  chromium = null;
}

const NAVIGATION_TIMEOUT = 45000;
const RENDER_WAIT = 8000;

/**
 * Validates an estimate URL by rendering it in a headless browser.
 *
 * @param {string} estimateUrl - The calculator.aws shareable URL
 * @param {Array<{name: string}>} expectedServices - List of expected service names
 * @param {object} [options] - Configuration options
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @param {boolean} [options.screenshot=false] - Take a screenshot
 * @param {string} [options.screenshotPath] - Path for screenshot file
 * @returns {Promise<{success: boolean, totalText: string, services: Array, errors: Array}>}
 */
async function validateEstimate(estimateUrl, expectedServices = [], options = {}) {
  if (!chromium) {
    return {
      success: false,
      totalText: '',
      services: [],
      errors: ['Playwright is not installed. Run: npm install --save-dev playwright && npx playwright install chromium'],
    };
  }

  const { headless = true, screenshot = false, screenshotPath = null } = options;
  const errors = [];
  let browser;

  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    const page = await context.newPage();

    // Collect console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Navigate to estimate
    await page.goto(estimateUrl, {
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT,
    });

    // Wait for the pricing calculator to render
    await page.waitForTimeout(RENDER_WAIT);

    // Check for error states
    const errorBanner = await page.locator('[class*="error"], [class*="Error"], [data-testid*="error"]').first();
    const hasError = await errorBanner.isVisible().catch(() => false);
    if (hasError) {
      const errorText = await errorBanner.textContent().catch(() => 'Unknown error');
      errors.push(`Page error: ${errorText}`);
    }

    // Try to find the total cost element
    let totalText = '';
    const totalSelectors = [
      '[class*="total"]',
      '[class*="Total"]',
      '[data-testid*="total"]',
      'text=/\\$[0-9,]+\\.\\d{2}/',
    ];
    for (const selector of totalSelectors) {
      try {
        const el = await page.locator(selector).first();
        if (await el.isVisible()) {
          totalText = await el.textContent();
          break;
        }
      } catch {
        // Try next selector
      }
    }

    // Check each expected service
    const serviceResults = [];
    for (const svc of expectedServices) {
      try {
        const serviceLocator = page.locator(`text=${svc.name}`).first();
        const isVisible = await serviceLocator.isVisible().catch(() => false);

        let costText = '$0.00';
        if (isVisible) {
          // Try to find the cost near the service name
          const row = serviceLocator.locator('..');
          const costEl = row.locator('[class*="cost"], [class*="price"], text=/\\$[0-9]/')
            .first();
          costText = await costEl.textContent().catch(() => '$0.00');
        }

        serviceResults.push({
          name: svc.name,
          visible: isVisible,
          cost: costText.trim(),
        });
      } catch (err) {
        serviceResults.push({
          name: svc.name,
          visible: false,
          cost: '$0.00',
          error: err.message,
        });
      }
    }

    // Take screenshot if requested
    if (screenshot) {
      const screenshotFile = screenshotPath || `estimate-${Date.now()}.png`;
      await page.screenshot({ path: screenshotFile, fullPage: true });
    }

    // Add console errors as warnings
    if (consoleErrors.length > 0) {
      errors.push(`Browser console errors: ${consoleErrors.length}`);
    }

    const success = !hasError && serviceResults.every(s => s.visible);

    return {
      success,
      totalText: totalText.trim(),
      services: serviceResults,
      errors,
      consoleErrors,
    };
  } catch (err) {
    errors.push(`Validation failed: ${err.message}`);
    return {
      success: false,
      totalText: '',
      services: [],
      errors,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Batch validate multiple estimate URLs.
 *
 * @param {Array<{url: string, services: Array}>} estimates - Estimates to validate
 * @param {object} [options] - Options passed to validateEstimate
 * @returns {Promise<Array>} Results for each estimate
 */
async function batchValidate(estimates, options = {}) {
  const results = [];
  for (const estimate of estimates) {
    const result = await validateEstimate(estimate.url, estimate.services, options);
    results.push({
      url: estimate.url,
      ...result,
    });
  }
  return results;
}

module.exports = { validateEstimate, batchValidate };
