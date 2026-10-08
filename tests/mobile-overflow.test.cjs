'use strict';

/*
 * Mobile-overflow regression test (real browser).
 *
 * Reproduces the shared-QA acceptance flow state (example log -> fictional
 * gap CSV import -> annotation -> zoom) and asserts that the page body never
 * scrolls sideways (<= 1 px) at 390 px and 320 px viewports — while the plot
 * and the legend table keep their own contained horizontal scroll instead of
 * squishing or widening the page.
 *
 * Needs Playwright with a usable browser: $PLAYWRIGHT_CHANNEL when set, otherwise
 * installed Chrome on Windows or bundled Chromium elsewhere, falling back to the
 * bundled Chromium when the requested channel cannot launch. It resolves
 * Playwright from:
 *   1. $PLAYWRIGHT_MODULE (explicit path), 2. an app-local install,
 *   3. the shared `qa/node_modules` sibling used by the workspace QA runner.
 * When none is found — or no browser can launch — the test skips cleanly
 * (it never fails the core suite).
 *
 * Run:  node --test tests/mobile-overflow.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright');
  candidates.push(path.join(__dirname, '..', '..', 'qa', 'node_modules', 'playwright'));
  for (const candidate of candidates) {
    try { return require(candidate); } catch (err) { /* try the next one */ }
  }
  return null;
}

const playwright = loadPlaywright();

async function assertNoBodyOverflow(page, width, label) {
  await page.setViewportSize({ width, height: 844 });
  await page.waitForTimeout(120);
  const overflow = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  assert.ok(overflow <= 1, label + ': page body overflows by ' + overflow + ' px at ' + width + ' px viewport');
}

/*
 * Browser selection mirrors tests/browser.cjs: an explicit $PLAYWRIGHT_CHANNEL
 * wins, otherwise installed Chrome is preferred on Windows and bundled
 * Chromium elsewhere. When a channel cannot launch we retry with the bundled
 * Chromium, and the test skips cleanly when no browser is usable at all.
 */
function launchAttempts() {
  const attempts = [];
  const explicit = process.env.PLAYWRIGHT_CHANNEL;
  if (explicit) attempts.push({ channel: explicit });
  else if (process.platform === 'win32') attempts.push({ channel: 'chrome' });
  attempts.push({}); // bundled Chromium (also the last resort after a failed channel)
  return attempts;
}

async function launchBrowser() {
  let lastError = null;
  for (const opts of launchAttempts()) {
    try {
      return await playwright.chromium.launch(Object.assign({ headless: true }, opts));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

test('mobile layout: page body must not overflow at 390 px / 320 px (real browser)',
  { skip: playwright ? false : 'Playwright not installed — skipping real-browser mobile test' },
  async (t) => {
    let browser = null;
    try {
      browser = await launchBrowser();
    } catch (err) {
      t.skip('No usable Chrome/Chromium for Playwright — skipping real-browser mobile test (' +
        (err && err.message ? err.message.split('\n')[0] : String(err)) + ')');
      return;
    }
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const problems = [];
      page.on('pageerror', (err) => problems.push('pageerror: ' + err.message));
      page.on('console', (msg) => { if (msg.type() === 'error') problems.push('console: ' + msg.text()); });

      await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href, { waitUntil: 'load' });

      await assertNoBodyOverflow(page, 390, 'initial');
      await assertNoBodyOverflow(page, 320, 'initial');

      await page.locator('#btn-load-example').click();
      await page.locator('#plot > svg').waitFor();
      await assertNoBodyOverflow(page, 390, 'example loaded');
      await assertNoBodyOverflow(page, 320, 'example loaded');

      // exact fictional file + flow from the shared QA acceptance case
      await page.locator('#file-input').setInputFiles({
        name: 'fictional-gap.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('\ufefftime;rpm;boost\r\n0;1000;0.1\r\n1;;0.2\r\n2;2000;0.3\r\n3;3000;0.4\r\n')
      });
      // pin the wait to the new source: "4 usable" is a substring of the
      // example's "54 usable" and would match before the file read lands
      await page.waitForFunction(() => {
        const t = document.querySelector('#status-line').textContent;
        return t.includes('fictional-gap.csv') && t.includes('4 usable row(s)');
      });
      await page.locator('#annotation-time').fill('1');
      await page.locator('#annotation-label').fill('Fictional dropout <tag>');
      await page.locator('#btn-add-annotation').click();
      await page.locator('#btn-zoom-in').click();

      await assertNoBodyOverflow(page, 390, 'imported + annotated');
      await assertNoBodyOverflow(page, 320, 'imported + annotated');

      // at narrow widths the plot and legend table keep a contained scroll
      const contained = await page.evaluate(() => {
        const plot = document.querySelector('#plot');
        const wrap = document.querySelector('.table-scroll');
        return {
          hasWrapper: !!wrap,
          plotScrolls: plot.scrollWidth > plot.clientWidth,
          tableScrolls: !!wrap && wrap.scrollWidth > wrap.clientWidth
        };
      });
      assert.ok(contained.hasWrapper, 'legend table must sit in a .table-scroll container');
      assert.ok(contained.plotScrolls, 'plot must scroll inside its host instead of widening the page');
      assert.ok(contained.tableScrolls, 'legend table must scroll inside its container at narrow widths');

      // desktop layout stays normal: fits, renders, no overflow
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.waitForTimeout(120);
      const desktopOverflow = await page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      assert.ok(desktopOverflow <= 1, 'desktop overflow: ' + desktopOverflow);
      assert.equal(await page.locator('#legend-body tr').count(), 2);
      assert.equal(await page.locator('#annotation-list li').count(), 1);

      assert.deepEqual(problems, [], 'unexpected page/console errors');
      await context.close();
    } finally {
      await browser.close();
    }
  });
