'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'test-results');
const results = [];
async function eqText(page, selector, text) {
  await page.waitForFunction(({s,t}) => document.querySelector(s)?.textContent.trim() === t, {s:selector,t:text}, {timeout:5000});
}
async function count(page, selector, n) {
  await page.waitForFunction(({s,n}) => document.querySelectorAll(s).length === n, {s:selector,n}, {timeout:5000});
}
async function download(page, selector, name) {
  const event = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await event;
  assert.equal(await file.failure(), null);
  const dest = path.join(ART, name);
  await file.saveAs(dest);
  return fs.readFile(dest,'utf8');
}
async function mobile(page) {
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    const overflow=await page.evaluate(() => Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth);
    assert.ok(overflow<=1, 'Mobile body overflow at '+width+' px: '+overflow+' px');
  }
  await page.setViewportSize({width:1440,height:1000});
}
async function execute(browser, name, callback, storageBlocked=false) {
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  if(storageBlocked) await context.addInitScript(() => Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('blocked for test','SecurityError');}}));
  const page=await context.newPage();
  const errors=[]; const requests=[];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console', m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('request', r=>{if(/^https?:/i.test(r.url())) requests.push(r.url());});
  try {
    await callback(page);
    assert.deepEqual(errors,[],'Unexpected page/console errors');
    assert.deepEqual(requests,[],'Unexpected network requests');
    results.push({name,status:'pass',errors,externalRequests:requests});
    console.log('PASS '+name);
  } catch(error) {
    results.push({name,status:'fail',message:error.message,stack:error.stack,errors,externalRequests:requests});
    console.error('FAIL '+name+'\n'+error.stack);
    await page.screenshot({path:path.join(ART,name.replace(/\W+/g,'-')+'-failure.png'),fullPage:true});
  } finally {await context.close();}
}
async function open(page, repo) {
  await page.goto(pathToFileURL(path.join(ROOT,'index.html')).href,{waitUntil:'load'});
}
async function sensor(page) {
  await open(page,'Sensor-Log-Studio');
  assert.equal(await page.locator('#plot-panel').isVisible(),false);
  await page.locator('#btn-load-example').click();
  await page.locator('#plot > svg').waitFor();
  assert.ok(await page.locator('#legend-body tr').count()>=1);
  // "Sort samples by time" must keep the skipped-row trace breaks: the example
  // keeps 10 gap breaks and 15 drawn path segments (the '--' time row breaks it).
  assert.match(await page.locator('#meta-line').textContent(),/10 gap\(s\) shown/);
  await page.locator('#sort-by-time').check();
  await page.waitForFunction(() => document.querySelector('#meta-line').textContent.includes('10 gap(s) shown')
    && document.querySelectorAll('#plot svg path').length===15);
  assert.equal(await page.locator('#plot svg path').count(),15,'sorted mode must keep all 15 path segments');
  await page.locator('#sort-by-time').uncheck();
  const before=await page.locator('#meta-line').textContent();
  await page.locator('#btn-zoom-in').click();
  assert.notEqual(await page.locator('#meta-line').textContent(),before,'Zoom must update range');
  await page.locator('#btn-zoom-reset').click();
  // wheel zoom keeps working through the rAF-scheduled repaint
  const metaBeforeWheel=await page.locator('#meta-line').textContent();
  await page.evaluate(()=>{document.querySelector('#plot').dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:480,clientY:300,cancelable:true,bubbles:true}));});
  await page.waitForFunction(prev=>document.querySelector('#meta-line').textContent!==prev,metaBeforeWheel);
  await page.locator('#btn-zoom-reset').click();
  await page.locator('#file-input').setInputFiles({name:'fictional-gap.csv',mimeType:'text/csv',buffer:Buffer.from('\ufefftime;rpm;boost\r\n0;1000;0.1\r\n1;;0.2\r\n2;2000;0.3\r\n3;3000;0.4\r\n')});
  // wait for the new source to land ("4 usable" alone is a substring of the
  // example's "54 usable", so it must be pinned to the imported file name)
  await page.waitForFunction(()=>{const t=document.querySelector('#status-line').textContent;return t.includes('fictional-gap.csv')&&t.includes('4 usable row(s)');});
  assert.match(await page.locator('#legend-body').textContent(),/rpm/);
  await page.locator('#annotation-time').fill('1');
  await page.locator('#annotation-label').fill('Fictional dropout <tag>');
  await page.locator('#btn-add-annotation').click();
  await count(page,'#annotation-list li',1);
  const csv=await download(page,'#btn-download-csv','sensor-full.csv');
  assert.match(csv,/1,,0\.2/,'Missing rpm must remain empty in actual export');
  assert.equal(csv.trim().split(/\r?\n/).length,5);
  await page.locator('#btn-zoom-in').click();
  await page.locator('#range-mode').selectOption('zoom');
  const filtered=await download(page,'#btn-download-csv','sensor-zoom.csv');
  assert.ok(filtered.trim().split(/\r?\n/).length<5,'Zoom export must filter rows');
  const svg=await download(page,'#btn-download-svg','sensor-plot.svg');
  assert.match(svg,/Fictional dropout &lt;tag&gt;/);
  assert.equal(await page.evaluate(text=>new DOMParser().parseFromString(text,'image/svg+xml').querySelector('parsererror')===null,svg),true);
  await mobile(page);
  await page.screenshot({path:path.join(ART,'sensor.png'),fullPage:true});
  await page.locator('#paste-input').fill('time,rpm\n0,"unterminated');
  await page.locator('#btn-load-paste').click();
  assert.equal(await page.locator('#error-line').isVisible(),true);
  assert.match(await page.locator('#error-line').textContent(),/quot/i);
}

// Keyboard focus: the file input is visually hidden (1x1, clipped), so its own
// :focus-visible ring would be invisible — the visible label must show it instead.
async function sensorKeyboardFocus(page) {
  await open(page,'Sensor-Log-Studio');
  const before=await page.evaluate(() => {
    const label=document.querySelector('label.btn'); const input=document.querySelector('#file-input');
    return {labelOutline:getComputedStyle(label).outlineStyle,inputW:input.getBoundingClientRect().width,inputH:input.getBoundingClientRect().height};
  });
  assert.equal(before.labelOutline,'none','no focus ring before anything is focused');
  assert.ok(before.inputW<=2&&before.inputH<=2,'the file input must be the visually hidden 1x1 control');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement&&document.activeElement.id==='file-input');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('label.btn')).outlineStyle==='solid');
  const ring=await page.evaluate(() => {
    const label=document.querySelector('label.btn'); const s=getComputedStyle(label);
    return {style:s.outlineStyle,width:parseFloat(s.outlineWidth),boxW:label.getBoundingClientRect().width};
  });
  assert.equal(ring.style,'solid','keyboard focus must show a ring on the visible "Choose CSV file" label');
  assert.ok(ring.width>=2,'focus ring must be at least 2px, got '+ring.width);
  assert.ok(ring.boxW>40,'the ringed control must be the visible label, not the clipped input');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('label.btn')).outlineStyle==='none');
}

// Export guards: no plot model => both download buttons disabled; U+FFFF in a
// header cannot make the standalone SVG invalid XML.
async function sensorExportGuard(page) {
  await open(page,'Sensor-Log-Studio');
  await page.locator('#btn-load-example').click();
  await page.locator('#plot > svg').waitFor();
  assert.equal(await page.locator('#btn-download-csv').isDisabled(),false);
  assert.equal(await page.locator('#btn-download-svg').isDisabled(),false);
  const channels=page.locator('#channel-list input[type="checkbox"]:not(:disabled)');
  const total=await channels.count();
  assert.ok(total>=5,'the example should offer 5 selectable channels, got '+total);
  for(let i=0;i<total;i++) await channels.nth(i).uncheck();
  await page.waitForFunction(() => document.querySelector('#plot').textContent.includes('Select at least one numeric channel'));
  assert.equal(await page.locator('#btn-download-csv').isDisabled(),true,'CSV export must be disabled when no channel can be plotted');
  assert.equal(await page.locator('#btn-download-svg').isDisabled(),true,'SVG export must be disabled when no channel can be plotted');
  await channels.nth(0).check();
  await page.locator('#plot > svg').waitFor();
  assert.equal(await page.locator('#btn-download-csv').isDisabled(),false,'CSV export must come back once a channel is selected again');
  assert.equal(await page.locator('#btn-download-svg').isDisabled(),false);
  await page.locator('#paste-input').fill('t,a\uFFFFb\n0,1\n1,2\n');
  await page.locator('#btn-load-paste').click();
  await page.locator('#plot > svg').waitFor();
  const svg=await download(page,'#btn-download-svg','sensor-noncharacter.svg');
  assert.ok(!svg.includes('\uFFFF'),'U+FFFF must be stripped from the exported SVG');
  assert.equal(await page.evaluate(text=>new DOMParser().parseFromString(text,'image/svg+xml').querySelector('parsererror')===null,svg),true,'the exported SVG must parse as valid XML');
}

(async()=>{
  await fs.mkdir(ART,{recursive:true});
  const launch={headless:true};
  const channel=process.env.PLAYWRIGHT_CHANNEL || (process.platform==='win32' ? 'chrome' : '');
  if(channel) launch.channel=channel;
  const browser=await chromium.launch(launch);
  try {
    await execute(browser,"sensor-main",sensor,false);
    await execute(browser,"sensor-keyboard-focus",sensorKeyboardFocus,false);
    await execute(browser,"sensor-export-guard",sensorExportGuard,false);
  } finally {await browser.close();}
  await fs.writeFile(path.join(ART,'browser-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
  const failed=results.filter(x=>x.status==='fail');
  console.log(JSON.stringify({cases:results.length,pass:results.length-failed.length,fail:failed.length}));
  if(!results.length || failed.length)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
