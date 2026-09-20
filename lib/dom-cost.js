// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * DOM-based cost + config-summary extraction. Replacement for
 * csv-export.js when we need rendered cost numbers and/or the
 * "Configuration summary" column. Skips the Export-button → menu →
 * dialog → download flow entirely — every value the CSV would carry
 * is already in the page DOM (the CSV is generated client-side from
 * the same in-memory state).
 *
 * Strategy:
 *   - Open the saved-estimate URL.
 *   - Wait for the Export button to become enabled (signal that
 *     rehydration finished). Same probe csv-export.js uses.
 *   - Read the "Estimate summary" block at the top: three "X.XX USD"
 *     numbers in order (Upfront, Monthly, 12-month).
 *   - Read the Detailed Estimate table rows. Each row has cells in
 *     order: Service | Upfront | Monthly | Description | Region |
 *     Config Summary. Empty config cells render as "-" and we
 *     normalize those to null.
 *
 * Returns:
 *   {
 *     monthlyCost:     number|null,
 *     monthlyByService: Map<string, number>,
 *     configByService:  Map<string, string|null>,
 *     rows:            [{ service, monthly, config }],   // ordered, lossless
 *     rowsTotal:       number|null,                      // sum of rows[].monthly
 *   }
 *
 * Two rows can carry the same label, so the Maps are lossy by
 * construction: a grouped estimate renders the group label in the
 * first column, and an ungrouped one renders the AWS service display
 * name, which repeats across entries of the same service (four
 * ec2Enhancement entries all render "Amazon EC2"). Map.set() keeps the
 * last. `rows` preserves every row in document order; prefer it when
 * attributing cost, and keep the Maps for the single-service oracle
 * paths that predate this.
 *
 * `rowsTotal` exists to answer "is the per-row read complete?".
 * monthlyCost comes from the summary block, which the calculator
 * computes from its own in-memory state, while the rows come from the
 * rendered table - and a row can render stale or absent while the
 * summary is already correct (see issue #13: a drilled-into service
 * shows $0 until "Update estimate" forces a recompute). When
 * rowsTotal and monthlyCost disagree, monthlyCost is the trustworthy
 * one and the per-row values should not be attributed.
 *
 * The Config Summary mirrors what the rehydrated estimate exposes —
 * which is generally narrower than what was sent (the calculator
 * filters by displayInConfigSummary in the PCT). Pair with
 * lib/handler-helpers.js#predictSummaries for "what should surface"
 * to detect drift.
 *
 * ~5-7s end-to-end, vs ~12s for the CSV download flow. Same
 * Playwright dep — the constraint is "the calculator's pricing math
 * runs in the browser" (the CSV is generated client-side too;
 * there's no server-side CSV endpoint to fetch).
 */

let chromium;
try { chromium = require('playwright').chromium; } catch { chromium = null; }

const NAVIGATION_TIMEOUT_MS = 60_000;
const EXPORT_VISIBLE_TIMEOUT_MS = 30_000;
// Same polling cadence as csv-export.js — empirically settled after
// false-positive Read-only verdicts under concurrency-3 load.
const EXPORT_ENABLED_TIMEOUT_MS = 20_000;
const EXPORT_ENABLED_POLL_MS = 250;

const EXPORT_SELECTORS = [
  'button:has-text("Export")',
  'button:has-text("Export estimate")',
  'a:has-text("Export")',
  '[data-testid*="export"]',
  '[aria-label*="Export"]',
];

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

      // Five "<n.nn> USD" matches expected in order:
      //   [0] summary upfront cost
      //   [1] summary monthly cost     ← what we want
      //   [2] summary 12-month total
      //   [3..] per-service row costs (upfront/monthly pairs)
      const usdLocators = await page.locator('text=/USD/').all();
      const usdTexts = await Promise.all(usdLocators.map(l => l.innerText()));

      const monthlyCost = usdTexts.length >= 2
        ? parseUsd(usdTexts[1])
        : null;

      // Per-service: walk the Detailed Estimate rows. Header order is
      // observed empirically as `Service | Upfront | Monthly |
      // Description | Region | Config Summary`. We anchor on the first
      // USD cell rather than column index so an upstream column-order
      // change won't silently drop the wrong values — the row layout
      // hasn't changed since 2026-05 but we don't trust it.
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

      // Kept for the callers that predate `rows`. Lossy on duplicate
      // labels; see the header note.
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

module.exports = { fetchCostFromDOM, parseDetailRows, parseUsd };
