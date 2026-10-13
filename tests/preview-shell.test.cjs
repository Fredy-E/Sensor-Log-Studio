'use strict';
/*
 * Sensor Log Studio — preview-shell regression (new UI contract).
 * RED on old UI, GREEN after workbench redesign.
 * Checks: data-ui-revision shell, visible honest #prototype-notice in first
 * 900px, --ui-* family tokens, grouped channel/time workspace + plot frame +
 * true export actions, no network/errors, no desktop body overflow.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { return null; }
}
const pw = loadPlaywright();
const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
let browser;
before(async () => {
  if (!pw) throw new Error('playwright missing');
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
  try { browser = await pw.chromium.launch({ channel, headless: true }); }
  catch { browser = await pw.chromium.launch({ headless: true }); }
});
after(async () => { if (browser) await browser.close(); });

test('preview shell: revision, honest notice, tokens, workspace, no overflow', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], reqs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (/^https?:/i.test(r.url())) reqs.push(r.url()); });
  try {
    await page.goto(APP_URL, { waitUntil: 'load' });
    const o = await page.evaluate(() => {
      const shell = document.querySelector('[data-ui-revision="portfolio-preview-1"]');
      const n = document.getElementById('prototype-notice');
      const r = n ? n.getBoundingClientRect() : null;
      const cs = n ? getComputedStyle(n) : null;
      const t = n ? (n.innerText || '') : '';
      const st = getComputedStyle(document.documentElement);
      return {
        shell: !!shell,
        rect: r ? { top: r.top, bottom: r.bottom, w: r.width, h: r.height } : null,
        visible: !!r && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight &&
          cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
        text: t.slice(0, 500),
        exact: t.includes('Experimental concept prototype — idea exploration only.'),
        notFinished: /not a finished|not finished/i.test(t),
        prodReady: /production.ready/i.test(t),
        tokens: ['--ui-bg', '--ui-surface', '--ui-ink', '--ui-muted', '--ui-accent', '--ui-border', '--ui-radius']
          .map(k => [k, st.getPropertyValue(k).trim()]),
        h1: document.querySelector('h1') ? document.querySelector('h1').textContent : '',
        overflow: document.documentElement.scrollWidth - innerWidth,
        workspace: !!document.querySelector('#workspace-channels, [data-testid="workspace-channels"]') ||
          (!!document.querySelector('#mapping-panel') && !!document.querySelector('#time-column') && !!document.querySelector('#channel-list')),
        plotFrame: !!document.querySelector('#plot'),
        exportActions: !!document.querySelector('#btn-download-csv') && !!document.querySelector('#btn-download-svg'),
        ids: ['file-input', 'btn-load-example', 'time-column', 'channel-list', 'plot', 'meta-line', 'legend-body', 'annotation-list', 'btn-download-csv', 'btn-download-svg']
          .map(id => [id, !!document.getElementById(id)])
      };
    });
    assert.ok(o.shell, 'missing [data-ui-revision="portfolio-preview-1"] shell');
    assert.ok(o.visible, 'prototype notice not visible in viewport: ' + JSON.stringify(o.rect));
    assert.ok(o.rect.bottom <= 900, 'notice below first 900px: ' + JSON.stringify(o.rect));
    assert.ok(o.exact, 'notice missing exact phrase, got: ' + o.text);
    assert.ok(o.notFinished && o.prodReady, 'notice missing not-finished/production-ready, got: ' + o.text);
    for (const [k, v] of o.tokens) assert.ok(v.length > 0, 'token ' + k + ' empty');
    assert.ok(o.workspace, 'grouped channel/time workspace missing');
    assert.ok(o.plotFrame, '#plot frame missing');
    assert.ok(o.exportActions, 'export actions missing');
    for (const [id, ok] of o.ids) assert.ok(ok, 'preserved id missing: ' + id);
    assert.ok(o.overflow <= 1, 'desktop body overflow: ' + o.overflow);
    assert.deepEqual(errors, [], 'page errors: ' + JSON.stringify(errors));
    assert.deepEqual(reqs, [], 'network: ' + JSON.stringify(reqs));
  } finally { await ctx.close(); }
});
