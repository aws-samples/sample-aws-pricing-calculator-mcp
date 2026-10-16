// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Rendered-cost extraction from the AWS Pricing Calculator. Two readers,
 * because the calculator computes pricing in the browser (there is no
 * server-side cost API):
 *
 *  - fetchCostFromDOM(url): lightweight single-page DOM scrape. Reads the
 *    "Estimate summary" monthly number and the Detailed Estimate table
 *    rows that are currently rendered. Fast, read-only, no mutation. Used
 *    by the eval/catalog oracles, which probe small single-row estimates
 *    where the 10-row table pagination never bites.
 *
 *  - fetchPricedEstimateId(url): re-shares the estimate through the UI
 *    ("Update estimate" → "Share") so the calculator PERSISTS its computed
 *    costs, and returns the new estimate id. The caller then reads that
 *    id with fetchEstimate() + extractCostsFromSavedBlob() — the saved
 *    JSON carries every group/line's serviceCost and the totalCost, with
 *    no pagination, DOM scrape, or file download. This is the complete,
 *    headless-safe source for get_estimate_cost (issue #47). The file
 *    download route was rejected: the calculator's Export save does not
 *    fire a capturable download in headless Chromium.
 *
 * fetchCostFromDOM returns:
 *   { monthlyCost, monthlyByService, configByService, rows, rowsTotal }
 * where rows is [{ service, monthly, config }] in document order. The
 * Maps are lossy on duplicate labels (grouped estimates repeat group
 * labels; ungrouped repeat the service display name) — prefer rows.
 * monthlyCost (summary block) is authoritative over the per-row table,
 * which can render stale/$0 until "Update estimate" recomputes (issue
 * #13); when rowsTotal disagrees, trust monthlyCost.
 */

let chromium;
try { chromium = require('playwright').chromium; } catch { chromium = null; }

const fs = require('node:fs');

const NAVIGATION_TIMEOUT_MS = 60_000;
const EXPORT_VISIBLE_TIMEOUT_MS = 30_000;
// Same polling cadence as csv-export.js — empirically settled after
// false-positive Read-only verdicts under concurrency-3 load.
const EXPORT_ENABLED_TIMEOUT_MS = 20_000;
const EXPORT_ENABLED_POLL_MS = 250;

// Re-share flow timeouts (fetchPricedEstimateId).
const RECOMPUTE_TIMEOUT_MS = 20_000;
const SHARE_DIALOG_TIMEOUT_MS = 10_000;
const SHARE_LINK_TIMEOUT_MS = 20_000;

const EXPORT_SELECTORS = [
  'button:has-text("Export")',
  'button:has-text("Export estimate")',
  'a:has-text("Export")',
  '[data-testid*="export"]',
  '[aria-label*="Export"]',
];

// On-demand dependency preflight. Playwright + the Chromium browser
// binary are NOT installed by default (playwright is a devDependency and
// the browser is a separate ~150MB download). Rather than let a tool
// crash deep inside chromium.launch(), classify availability up front and
// distinguish the two install states so the caller can surface the right
// remediation:
//   - playwright-missing: the `playwright` npm module isn't resolvable.
//   - chromium-missing:   the module is present but the browser binary
//                         it points at hasn't been downloaded.
//
// Pure helper (chromium module + fs.existsSync injected) so every branch
// is unit-testable without actually installing/uninstalling anything.
function classifyPlaywright(chromiumModule, existsSyncFn) {
  if (!chromiumModule) {
    return {
      available: false,
      reason: 'playwright-missing',
      message:
        'The Playwright library is not installed. It is an on-demand dependency ' +
        'used only to render calculator-computed costs.',
      install: ['npm install playwright', 'npx playwright install chromium', 'npx playwright install-deps chromium'],
    };
  }
  let execPath = null;
  try {
    execPath = chromiumModule.executablePath();
  } catch {
    // Older Playwright throws from executablePath() when the browser was
    // never downloaded; treat that the same as a missing binary.
    execPath = null;
  }
  if (!execPath || !existsSyncFn(execPath)) {
    return {
      available: false,
      reason: 'chromium-missing',
      message:
        'Playwright is installed but the Chromium browser binary is not. ' +
        'It is an on-demand ~150MB download.',
      install: ['npx playwright install chromium'],
    };
  }
  return { available: true };
}

// Bound to the real module + fs. Returns { available: true } or an
// { available: false, reason, message, install[] } descriptor.
function checkPlaywrightAvailability() {
  return classifyPlaywright(chromium, fs.existsSync);
}

async function fetchCostFromDOM(url) {
  if (!chromium) {
    throw new Error('Playwright is not installed. Run: npm install --save-dev playwright && npx playwright install chromium');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });

      const exportSelector = await firstVisible(page, EXPORT_SELECTORS, EXPORT_VISIBLE_TIMEOUT_MS);
      if (!exportSelector) {
        throw new Error('Export button not found on page');
      }

      // Polling for enabled-state distinguishes "still rehydrating"
      // from "rehydration failed" (the eC2Next read-only trap).
      const enabled = await waitForExportEnabled(page, exportSelector);
      if (!enabled) {
        throw new Error('rehydration failed: calculator disabled the Export button (estimate is in Read-only mode)');
      }

      // Three "<n.nn> USD" summary matches in order: [0] upfront,
      // [1] monthly, [2] 12-month. We only need monthly here.
      const usdLocators = await page.locator('text=/USD/').all();
      const usdTexts = await Promise.all(usdLocators.map(l => l.innerText()));
      const monthlyCost = usdTexts.length >= 2 ? parseUsd(usdTexts[1]) : null;

      // Per-service: walk the Detailed Estimate rows. Header order is
      // observed empirically as `Service | Upfront | Monthly |
      // Description | Region | Config Summary`. We anchor on the first
      // USD cell rather than column index so an upstream column-order
      // change won't silently drop the wrong values.
      const domRows = await page.locator('tr, [role="row"]').all();
      const cellTextRows = [];
      for (const row of domRows) {
        const cells = await row.locator('td, [role="cell"]').all().catch(() => []);
        if (cells.length < 6) continue;
        cellTextRows.push(await Promise.all(
          cells.map(c => c.innerText().catch(() => '')),
        ));
      }

      const rows = parseDetailRows(cellTextRows);

      const monthlyByService = new Map();
      const configByService = new Map();
      for (const { service, monthly, config } of rows) {
        monthlyByService.set(service, monthly);
        configByService.set(service, config);
      }

      const rowsTotal = rows.length
        ? rows.reduce((sum, r) => sum + r.monthly, 0)
        : null;

      return { monthlyCost, monthlyByService, configByService, rows, rowsTotal };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function waitClickable(locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await locator.isVisible().catch(() => false);
    if (ok && !(await locator.isDisabled().catch(() => true))) return true;
    await new Promise(f => setTimeout(f, 250));
  }
  return false;
}

/**
 * Re-share a saved estimate through the calculator UI so the calculator
 * PERSISTS its computed costs, then return the new estimate id. Validated
 * headless (issue #47):
 *   1. open the estimate; dismiss the cookie banner (it overlays the app
 *      and intercepts the Share/Update clicks).
 *   2. click "Update estimate" to recompute to current pricing. On a
 *      read-only shared estimate this is what yields a fresh, costed save.
 *   3. click "Share" -> "Agree and continue" -> read the public link.
 *
 * The returned id's read-API JSON (fetchEstimate) then carries full
 * serviceCost / totalCost — so the caller needs no DOM scrape, pagination,
 * or file download (none of which work reliably in headless). On a
 * read-only shared estimate this creates a NEW saved id; the original is
 * untouched. Returns { estimateId, shareUrl }.
 */
async function fetchPricedEstimateId(url, { update = true } = {}) {
  if (!chromium) {
    throw new Error('Playwright is not installed. Run: npm install --save-dev playwright && npx playwright install chromium');
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });

      // The cookie consent banner overlays the app and intercepts clicks,
      // so Share/Update won't fire underneath it — dismiss it first.
      const accept = page.getByRole('button', { name: /Accept all cookies/i }).first();
      if (await accept.isVisible().catch(() => false)) {
        await accept.click().catch(() => {});
        await page.waitForTimeout(500);
      }

      // Wait until the estimate has rehydrated enough to act on.
      const exportBtn = page.getByRole('button', { name: 'Export' }).first();
      if (!(await waitClickable(exportBtn, EXPORT_VISIBLE_TIMEOUT_MS))) {
        throw new Error('rehydration failed: the estimate never became ready (it may be read-only or broken)');
      }

      const shareBtn = page.getByRole('button', { name: 'Share' }).first();
      if (update) {
        const updateBtn = page.getByRole('button', { name: /Update estimate/ }).first();
        if (await updateBtn.count().then(c => c > 0).catch(() => false)) {
          await updateBtn.click().catch(() => {});
          // Recompute settles when the editable actions (Share) appear.
          await waitClickable(shareBtn, RECOMPUTE_TIMEOUT_MS);
          await page.waitForTimeout(1500);
        }
      }

      if (!(await waitClickable(shareBtn, EXPORT_VISIBLE_TIMEOUT_MS))) {
        throw new Error('Share button never became available');
      }
      await shareBtn.click();

      // First share in a session shows a public-server acknowledgment.
      const agree = page.getByRole('button', { name: /Agree and continue/i }).first();
      if (await agree.waitFor({ state: 'visible', timeout: SHARE_DIALOG_TIMEOUT_MS }).then(() => true).catch(() => false)) {
        await agree.click().catch(() => {});
      }

      // The public link populates one of the dialog's text inputs — poll
      // every input's value for the id= URL.
      let shareUrl = null;
      const deadline = Date.now() + SHARE_LINK_TIMEOUT_MS;
      while (Date.now() < deadline && !shareUrl) {
        const values = await page.locator('input').evaluateAll(
          els => els.map(e => e.value).filter(Boolean),
        ).catch(() => []);
        shareUrl = values.find(v => /[?&]id=[a-f0-9]+/.test(v)) || null;
        if (!shareUrl) await page.waitForTimeout(400);
      }
      if (!shareUrl) throw new Error('could not read the public share link after sharing');
      const m = shareUrl.match(/[?&]id=([a-f0-9]+)/);
      return { estimateId: m[1], shareUrl };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Turn raw per-row cell text into ordered detail rows. Pure, so the
 * row-shape assumptions below are testable without a browser.
 *
 * Row layout is observed empirically as
 *   Service | Upfront | Monthly | Description | Region | Config Summary
 * but we anchor on the first USD cell rather than a column index, so an
 * upstream column-order change cannot silently shift the wrong values
 * into place.
 *
 * @param {string[][]} cellTextRows one array of cell strings per candidate row
 * @returns {{service: string, monthly: number, config: string|null}[]}
 */
function parseDetailRows(cellTextRows) {
  const out = [];
  for (const cellTexts of cellTextRows) {
    if (!Array.isArray(cellTexts) || cellTexts.length < 6) continue;
    // Need >=2 USD-like cells for this to be a data row (header and any
    // non-data rows carry no USD content).
    if (cellTexts.filter(t => /USD/.test(t)).length < 2) continue;
    const firstUsdIdx = cellTexts.findIndex(t => /USD/.test(t));
    // The label sits in the cell before the first USD cell, so a row
    // whose first cell is already USD has no label to attribute to.
    if (firstUsdIdx < 1) continue;
    const service = cellTexts[firstUsdIdx - 1].trim();
    const monthly = parseUsd(cellTexts[firstUsdIdx + 1] || '');
    // Config summary lives 4 cells after the Monthly cell:
    //   firstUsdIdx+1 = Monthly, +2 = Description, +3 = Region,
    //   +4 = Config Summary. Empty/unused config renders as "-" which we
    //   normalize to null.
    const rawConfig = (cellTexts[firstUsdIdx + 4] || '').trim();
    const config = rawConfig && rawConfig !== '-' ? rawConfig : null;
    if (service && Number.isFinite(monthly)) {
      out.push({ service, monthly, config });
    }
  }
  return out;
}

async function firstVisible(page, selectors, timeoutMs) {
  for (const sel of selectors) {
    const opts = timeoutMs ? { timeout: timeoutMs } : undefined;
    const visible = await page.locator(sel).first().isVisible(opts).catch(() => false);
    if (visible) return sel;
  }
  return null;
}

async function waitForExportEnabled(page, exportSelector) {
  const locator = page.locator(exportSelector).first();
  const deadline = Date.now() + EXPORT_ENABLED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const disabled = await locator.isDisabled().catch(() => true);
    if (!disabled) return true;
    await page.waitForTimeout(EXPORT_ENABLED_POLL_MS);
  }
  return false;
}

function parseUsd(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  fetchCostFromDOM,
  fetchPricedEstimateId,
  parseDetailRows,
  parseUsd,
  classifyPlaywright,
  checkPlaywrightAvailability,
};
