'use strict';

/*
 * Sensor Log Studio — core unit tests.
 *
 * These tests define the core API contract and were written BEFORE the
 * implementation (TDD RED step). Run with:
 *
 *     node --test tests/core.test.cjs
 *
 * The very first run (before core.js existed) failed with a module-load
 * error; the output is recorded in reports/test-run-initial-fail.txt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const SL = require('../core.js');

const {
  LIMITS,
  PALETTE,
  DELIMITERS,
  EXAMPLE_CSV,
  parseNumber,
  detectDelimiter,
  parseCSV,
  classifyColumns,
  suggestTimeColumn,
  buildDataset,
  computeStats,
  fullWindow,
  clampWindow,
  zoomWindow,
  panWindow,
  niceTicks,
  makeScale,
  downsamplePoints,
  buildPlotModel,
  svgLayout,
  renderSVGString,
  exportCSV,
  guardFormula,
  escapeXML,
  formatNumber,
  formatBytes,
  truncate,
  sanitizeFilename
} = SL;

function assertClose(actual, expected, eps, message) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message || 'values differ'}: got ${actual}, expected ~${expected}`
  );
}

function parsedOk(text, opts) {
  const res = parseCSV(text, opts);
  assert.equal(res.ok, true, `parseCSV failed: ${res.ok ? '' : res.error.message}`);
  return res.value;
}

function datasetOk(text, parseOpts, dsOpts) {
  const res = buildDataset(parsedOk(text, parseOpts), dsOpts);
  assert.equal(res.ok, true, `buildDataset failed: ${res.ok ? '' : res.error.message}`);
  return res.value;
}

function modelOk(dataset, opts) {
  const res = buildPlotModel(dataset, opts);
  assert.equal(res.ok, true, `buildPlotModel failed: ${res.ok ? '' : res.error.message}`);
  return res.value;
}

// ---------------------------------------------------------------------------
// API surface & limits
// ---------------------------------------------------------------------------

test('core exposes the documented API and sane limits', () => {
  const fns = [
    'parseNumber', 'detectDelimiter', 'parseCSV', 'classifyColumns', 'suggestTimeColumn',
    'buildDataset', 'computeStats', 'fullWindow', 'clampWindow', 'zoomWindow', 'panWindow',
    'niceTicks', 'makeScale', 'downsamplePoints', 'buildPlotModel', 'svgLayout',
    'renderSVGString', 'exportCSV', 'guardFormula', 'escapeXML', 'formatNumber',
    'formatBytes', 'truncate', 'sanitizeFilename'
  ];
  for (const name of fns) {
    assert.equal(typeof SL[name], 'function', `SL.${name} should be a function`);
  }
  assert.equal(LIMITS.MAX_ROWS, 50000);
  assert.equal(LIMITS.MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(LIMITS.MAX_POINTS_PER_CHANNEL, 2000);
  assert.deepEqual(DELIMITERS, [',', ';', '\t']);
  assert.ok(Array.isArray(PALETTE) && PALETTE.length >= 8, 'PALETTE should have >= 8 colors');
  assert.equal(new Set(PALETTE).size, PALETTE.length, 'PALETTE colors should be unique');
  assert.equal(typeof EXAMPLE_CSV, 'string', 'EXAMPLE_CSV should be the shared fictional example fixture');
  assert.ok(EXAMPLE_CSV.startsWith('time_s;'), 'EXAMPLE_CSV should keep its semicolon header');
});

// ---------------------------------------------------------------------------
// parseNumber
// ---------------------------------------------------------------------------

test('parseNumber: strict finite parsing, junk never becomes 0', () => {
  assert.equal(parseNumber(' 1.5 '), 1.5);
  assert.equal(parseNumber('-2e3'), -2000);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('5.'), 5);
  assert.equal(parseNumber('+0.25'), 0.25);
  assert.equal(parseNumber(3.25), 3.25);
  const junk = ['', '   ', 'abc', 'NaN', 'Infinity', '-Infinity', '1e999', '0x10', '1,5', '1 2', '--5', '"3"', '5mV'];
  for (const s of junk) {
    assert.equal(parseNumber(s), null, `expected null for ${JSON.stringify(s)}`);
  }
  assert.equal(parseNumber(NaN), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(undefined), null);
});

// ---------------------------------------------------------------------------
// delimiter detection
// ---------------------------------------------------------------------------

test('detectDelimiter: comma, semicolon, tab; quotes respected', () => {
  assert.equal(detectDelimiter('a,b\n1,2').delimiter, ',');
  assert.equal(detectDelimiter('a;b\n1;2').delimiter, ';');
  assert.equal(detectDelimiter('a\tb\n1\t2').delimiter, '\t');
  // semicolons inside quoted fields must not beat the real comma delimiter
  assert.equal(detectDelimiter('a,b\n"x;y",2').delimiter, ',');
  // quoted headers with commas
  assert.equal(detectDelimiter('"a","b"\n1,2').delimiter, ',');
  const none = detectDelimiter('abc\ndef');
  assert.equal(none.found, false);
  assert.equal(none.delimiter, ',');
});

// ---------------------------------------------------------------------------
// parseCSV: quoting, BOM, newlines
// ---------------------------------------------------------------------------

test('parseCSV: quoted fields, escaped quotes, embedded newlines', () => {
  const r = parseCSV('a,b\n"He said ""hi""",2\n"multi\nline",3\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.headers, ['a', 'b']);
  assert.equal(r.value.rows.length, 2);
  assert.equal(r.value.rows[0].line, 2);
  assert.deepEqual(r.value.rows[0].cells, ['He said "hi"', '2']);
  assert.equal(r.value.rows[1].line, 3);
  assert.deepEqual(r.value.rows[1].cells, ['multi\nline', '3']);
  // file without trailing newline
  assert.equal(parseCSV('a,b\n1,2').value.rows.length, 1);
});

test('parseCSV: BOM, CRLF and CR-only line endings', () => {
  const bom = parseCSV('\uFEFFt;v\r\n0;1\r\n1;2\r\n');
  assert.equal(bom.ok, true);
  assert.equal(bom.value.delimiter, ';');
  assert.deepEqual(bom.value.headers, ['t', 'v']);
  assert.equal(bom.value.dataRowCount, 2);
  assert.deepEqual(bom.value.rows[1].cells, ['1', '2']);

  const cr = parseCSV('a,b\r1,2\r3,4');
  assert.equal(cr.ok, true);
  assert.equal(cr.value.dataRowCount, 2);
  assert.deepEqual(cr.value.rows[1].cells, ['3', '4']);
});

test('parseCSV: rejects empty input and header-only files', () => {
  const e1 = parseCSV('');
  assert.equal(e1.ok, false);
  assert.equal(e1.error.code, 'empty_input');

  const e2 = parseCSV('   \n  \n');
  assert.equal(e2.ok, false);
  assert.equal(e2.error.code, 'empty_input');

  const e3 = parseCSV('a,b\n');
  assert.equal(e3.ok, false);
  assert.equal(e3.error.code, 'no_data_rows');
});

test('parseCSV: rejects unsupported delimiter option', () => {
  const r = parseCSV('a,b\n1,2\n', { delimiter: '|' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid_option');
});

test('parseCSV: enforces the row and byte limits with clear errors', () => {
  const rows = ['t,v'];
  for (let i = 0; i < LIMITS.MAX_ROWS + 1; i++) rows.push(i + ',' + i);
  const big = parseCSV(rows.join('\n') + '\n');
  assert.equal(big.ok, false);
  assert.equal(big.error.code, 'too_many_rows');
  assert.match(big.error.message, /50001/);
  assert.match(big.error.message, /50000/);

  const bytes = parseCSV('a,b\n1,2\n', { maxBytes: 4 });
  assert.equal(bytes.ok, false);
  assert.equal(bytes.error.code, 'too_large');
  assert.match(bytes.error.message, /limit is/);
});

test('parseCSV: ragged rows — extra fields rejected, short rows tolerated', () => {
  const extra = parseCSV('a,b\n1,2,3\n');
  assert.equal(extra.ok, false);
  assert.equal(extra.error.code, 'row_too_long');
  assert.match(extra.error.message, /Line 2/);

  const short = parseCSV('a,b,c\n1,2\n3,4,5\n');
  assert.equal(short.ok, true);
  assert.ok(short.value.warnings.some((w) => /fewer fields/.test(w)), 'expected a warning about short rows');

  const trailing = parseCSV('a,b\n1,2,,\n');
  assert.equal(trailing.ok, true);
  assert.ok(trailing.value.warnings.some((w) => /trailing empty field/.test(w)), 'expected trailing-empty warning');
});

test('parseCSV: unterminated quoted field is rejected', () => {
  const r = parseCSV('a,b\n"oops,2\n');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unterminated_quote');
});

test('parseCSV: quoted-empty fields and quotes at EOF', () => {
  const qe = parsedOk('t,v\n0,""\n1,2\n');
  assert.deepEqual(qe.rows[0].cells, ['0', ''], 'an empty quoted field is an empty cell, not a literal quote');
  assert.deepEqual(qe.rows[1].cells, ['1', '2']);
  const ds = buildDataset(qe, {}).value;
  assert.equal(ds.channels[0].values[0], null, 'a quoted-empty cell stays missing, never 0');

  // a quoted field closed exactly at EOF (no trailing newline)
  const eof = parsedOk('t,v\n0,"abc"');
  assert.deepEqual(eof.rows[0].cells, ['0', 'abc']);
  assert.equal(eof.dataRowCount, 1);

  // a quote left open at EOF is rejected with its line
  const open = parseCSV('t,v\n0,"abc');
  assert.equal(open.ok, false);
  assert.equal(open.error.code, 'unterminated_quote');
  assert.equal(open.error.line, 2);
});

test('parseCSV: explicit tab delimiter overrides (quoted tabs stay inside fields)', () => {
  // a forced tab wins even when the text looks semicolon-separated
  const forced = parsedOk('a;b\n1;2\n', { delimiter: '\t' });
  assert.deepEqual(forced.headers, ['a;b']);
  assert.deepEqual(forced.rows[0].cells, ['1;2']);
  assert.equal(forced.delimiter, '\t');
  assert.equal(forced.delimiterName, 'tab');

  // a tab inside a quoted field must not split the field
  const quoted = parsedOk('t\tv\n0\t"x\ty"\n', { delimiter: '\t' });
  assert.deepEqual(quoted.headers, ['t', 'v']);
  assert.deepEqual(quoted.rows[0].cells, ['0', 'x\ty']);
});

// ---------------------------------------------------------------------------
// buildDataset
// ---------------------------------------------------------------------------

test('buildDataset: validates the time column and reports skipped rows', () => {
  const p = parsedOk('t,v\nnotime,1\n2,3\n');
  const ds = buildDataset(p, { timeColumn: 0 });
  assert.equal(ds.ok, true);
  assert.equal(ds.value.timeName, 't');
  assert.deepEqual(ds.value.times, [2]);
  assert.equal(ds.value.acceptedCount, 1);
  assert.equal(ds.value.skipped.count, 1);
  assert.equal(ds.value.skipped.details[0].line, 2);
  assert.equal(ds.value.skipped.details[0].reason, 'invalid_time');
  assert.equal(ds.value.channels[0].name, 'v');
  assert.deepEqual(ds.value.channels[0].values, [3]);

  const badCol = buildDataset(p, { timeColumn: 9 });
  assert.equal(badCol.ok, false);
  assert.equal(badCol.error.code, 'invalid_column');

  const noneValid = buildDataset(parsedOk('t,v\nx,1\n'), { timeColumn: 0 });
  assert.equal(noneValid.ok, false);
  assert.equal(noneValid.error.code, 'no_valid_rows');
});

test('buildDataset: configurable time column', () => {
  const ds = datasetOk('v,t\n7,0\n8,1\n', null, { timeColumn: 1 });
  assert.deepEqual(ds.times, [0, 1]);
  assert.equal(ds.timeName, 't');
  assert.deepEqual(ds.channels.map((c) => c.name), ['v']);
  assert.deepEqual(ds.channels[0].values, [7, 8]);
});

test('buildDataset: missing values stay null, split segments, and never become zero', () => {
  const ds = datasetOk('t,a\n0,1\n1,\n2,3\n3,4\n');
  const ch = ds.channels[0];
  assert.equal(ch.values.length, 4, 'no fabricated rows');
  assert.deepEqual(ch.values, [1, null, 3, 4]);
  assert.equal(ch.values[1], null, 'missing must be null, not 0');
  assert.deepEqual(ch.segments, [[0, 0], [2, 3]]);
  assert.equal(ch.present, 3);
  assert.equal(ch.unparsable, 0);
  assert.equal(ch.stats.count, 3);
  assert.equal(ch.stats.min, 1);
  assert.equal(ch.stats.max, 4);
  assertClose(ch.stats.mean, 8 / 3, 1e-12, 'mean of [1,3,4]');
});

test('buildDataset: non-numeric cells are counted, blank cells are just missing', () => {
  const ds = datasetOk('t,a\n0,1\n1,n/a\n2,3\n');
  const ch = ds.channels[0];
  assert.deepEqual(ch.values, [1, null, 3]);
  assert.equal(ch.unparsable, 1);
  assert.equal(ch.present, 2);

  const ds2 = datasetOk('t,a\n0,1\n1,   \n2,3\n');
  assert.equal(ds2.channels[0].unparsable, 0, 'whitespace-only cells are missing, not unparsable');
  assert.deepEqual(ds2.channels[0].values, [1, null, 3]);
});

test('buildDataset: rows skipped for bad time break the trace (file order)', () => {
  const ds = datasetOk('t,a\n0,1\nx,2\n2,3\n');
  assert.deepEqual(ds.times, [0, 2]);
  assert.deepEqual(ds.channels[0].values, [1, 3]);
  assert.deepEqual(ds.channels[0].segments, [[0, 0], [1, 1]]);
  assert.equal(ds.skipped.count, 1);
});

test('buildDataset: time inversions warn by default and can be sorted on request', () => {
  const p = parsedOk('t,v\n3,30\n1,10\n2,20\n');
  const plain = buildDataset(p, { timeColumn: 0 }).value;
  assert.deepEqual(plain.times, [3, 1, 2]);
  assert.equal(plain.inversions, 1);
  assert.equal(plain.firstInversionLine, 3);
  assert.equal(plain.sorted, false);
  assert.ok(plain.warnings.some((w) => /not monotonic/.test(w)), 'expected a monotonic-ity warning');

  const sorted = buildDataset(p, { timeColumn: 0, sortByTime: true }).value;
  assert.deepEqual(sorted.times, [1, 2, 3]);
  assert.deepEqual(sorted.channels[0].values, [10, 20, 30], 'channel values must follow their sorted rows');
  assert.equal(sorted.sorted, true);
  assert.ok(sorted.warnings.some((w) => /sorted by time/.test(w)));

  // equal timestamps keep file order (stable)
  const stable = datasetOk('t,v\n1,10\n1,20\n');
  assert.deepEqual(stable.times, [1, 1]);
  assert.deepEqual(stable.channels[0].values, [10, 20]);
});

test('buildDataset: sort-by-time keeps the trace breaks caused by skipped rows (fictional example)', () => {
  const p = parsedOk(EXAMPLE_CSV);
  const plain = buildDataset(p, {}).value;
  const sorted = buildDataset(p, { sortByTime: true }).value;

  // One '--' time row, no inversions: enabling the sort must not delete the
  // break that row causes (skipped rows break the drawn trace, always).
  assert.equal(plain.skipped.count, 1);
  assert.equal(plain.inversions, 0);
  assert.equal(sorted.skipped.count, 1);
  assert.deepEqual(
    sorted.channels.map((c) => c.segments),
    plain.channels.map((c) => c.segments),
    'sorted mode must keep exactly the file-order segmentation'
  );
  assert.deepEqual(sorted.channels.map((c) => c.segments.length), [3, 2, 3, 4, 3]);

  const mPlain = modelOk(plain);
  const mSorted = modelOk(sorted);
  assert.equal(mPlain.meta.gapCount, 10);
  assert.equal(mSorted.meta.gapCount, 10, 'sorted mode must keep all 10 gap breaks');
  const pathsPlain = mPlain.series.reduce((n, s) => n + s.paths.length, 0);
  const pathsSorted = mSorted.series.reduce((n, s) => n + s.paths.length, 0);
  assert.equal(pathsPlain, 15);
  assert.equal(pathsSorted, 15, 'sorted mode must draw the same 15 path segments');
  assert.equal(mSorted.meta.drawnTotal, mPlain.meta.drawnTotal);
  assert.equal(mSorted.meta.availableTotal, mPlain.meta.availableTotal);

  const svg = renderSVGString(mSorted, { width: 980, height: 470 });
  assert.equal((svg.match(/<path\b/g) || []).length, 15, 'the standalone SVG keeps the breaks too');
});

test('buildDataset: sort-by-time keeps skipped-row breaks when it reorders samples', () => {
  // one '--' time row between t=1 and t=3, plus an inversion (t=3 before t=2)
  const p = parsedOk('t,v\n0,10\n1,11\n--,99\n3,13\n2,12\n');
  const plain = buildDataset(p, {}).value;
  assert.deepEqual(plain.times, [0, 1, 3, 2]);
  assert.deepEqual(plain.channels[0].segments, [[0, 1], [2, 3]], 'file order: the skipped row breaks the trace');

  const sorted = buildDataset(p, { sortByTime: true }).value;
  assert.deepEqual(sorted.times, [0, 1, 2, 3], 'samples are reordered by time');
  assert.deepEqual(sorted.channels[0].values, [10, 11, 12, 13], 'values follow their rows');
  assert.deepEqual(sorted.channels[0].segments, [[0, 2], [3, 3]],
    'the skipped-row break survives sorting, attached to the sample that followed the hole in file order');
  assert.equal(modelOk(sorted).meta.gapCount, 1, 'sorted mode must not connect across the skipped row');
});

test('buildDataset: a skip-break carried to sorted index 0 stays visible (no merged path)', () => {
  // The sample that followed the hole ('--') is the globally earliest sample:
  // in sorted order it lands at index 0, where there is no preceding sample,
  // so the break used to be masked and the trace merged across the hole.
  const p = parsedOk('t,v\n5,50\n--,9\n1,10\n');
  const plain = buildDataset(p, {}).value;
  const sorted = buildDataset(p, { sortByTime: true }).value;

  assert.equal(plain.skipped.count, 1);
  assert.deepEqual(plain.times, [5, 1]);
  assert.deepEqual(plain.channels[0].segments, [[0, 0], [1, 1]],
    'file order: the skipped row breaks the trace into two segments');

  assert.equal(sorted.sorted, true);
  assert.deepEqual(sorted.times, [1, 5]);
  assert.deepEqual(sorted.channels[0].segments, [[0, 0], [1, 1]],
    'sorted: the transferred break keeps the two samples in separate segments');

  const mPlain = modelOk(plain);
  const mSorted = modelOk(sorted);
  assert.equal(mPlain.meta.gapCount, 1, 'unsorted mode shows 1 gap');
  assert.equal(mSorted.meta.gapCount, 1, 'sorted mode must keep the same 1 visible gap');
  assert.equal(mPlain.series[0].paths.length, 2);
  assert.equal(mSorted.series[0].paths.length, 2, 'sorted mode must draw 2 paths, never one merged path');
});

test('buildDataset: two holes keep one break per hole when a carrier lands at sorted index 0', () => {
  // Two skipped rows (two holes). The carrier of the first hole (t=1) is the
  // earliest sample and moves to sorted index 0; the carrier of the second
  // hole (t=9) keeps its own break at the end. Expected counts: 5 accepted,
  // 2 skipped, 2 visible gaps and 3 path segments in both modes.
  const text = 't,v\n5,50\n--,9\n1,10\n4,40\n--,9\n9,90\n7,70\n';
  const plain = buildDataset(parsedOk(text), {}).value;
  const sorted = buildDataset(parsedOk(text), { sortByTime: true }).value;

  assert.equal(plain.acceptedCount, 5);
  assert.equal(plain.skipped.count, 2);
  assert.deepEqual(plain.channels[0].segments, [[0, 0], [1, 2], [3, 4]],
    'file order: [5] [1 4] [9 7] — two breaks');

  assert.deepEqual(sorted.channels[0].segments, [[0, 0], [1, 3], [4, 4]],
    'sorted: [1] [4 5 7] [9] — the moved break plus the carrier break, still two breaks');

  const mPlain = modelOk(plain);
  const mSorted = modelOk(sorted);
  assert.equal(mPlain.meta.gapCount, 2);
  assert.equal(mSorted.meta.gapCount, 2, 'sorted mode must keep both hole breaks (one per hole)');
  assert.equal(mPlain.series[0].paths.length, 3);
  assert.equal(mSorted.series[0].paths.length, 3);
});

test('buildDataset: a transferred break never collapses into another hole\'s break', () => {
  // The two carriers are adjacent in sorted order: t=1 (at index 0, moved) and
  // t=2 (at index 1, owns its own break). The moved break must scan past the
  // occupied adjacency instead of collapsing: 2 holes stay 2 breaks.
  const text = 't,v\n9,90\n--,9\n1,10\n--,9\n2,20\n';
  const plain = buildDataset(parsedOk(text), {}).value;
  const sorted = buildDataset(parsedOk(text), { sortByTime: true }).value;

  assert.deepEqual(plain.channels[0].segments, [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(sorted.channels[0].segments, [[0, 0], [1, 1], [2, 2]],
    'both holes keep a visible break; no double-break and no collapse');

  assert.equal(modelOk(plain).meta.gapCount, 2);
  assert.equal(modelOk(sorted).meta.gapCount, 2);
  assert.equal(modelOk(sorted).series[0].paths.length, 3);
});

test('buildDataset: a single sample stays a single segment with no phantom break', () => {
  const one = datasetOk('t,v\n5,50\n');
  assert.equal(one.acceptedCount, 1);
  assert.deepEqual(one.channels[0].segments, [[0, 0]], 'one sample = one segment');
  const m1 = modelOk(one);
  assert.equal(m1.meta.gapCount, 0);
  assert.equal(m1.series[0].paths.length, 1);
  assert.equal(m1.series[0].paths[0].length, 1);

  // A skipped row before the only sample cannot fabricate a break either —
  // even with sort enabled there is no adjacency to transfer anything onto.
  const skippedFirst = datasetOk('t,v\n--,9\n5,50\n', null, { sortByTime: true });
  assert.equal(skippedFirst.acceptedCount, 1);
  assert.equal(skippedFirst.skipped.count, 1);
  assert.deepEqual(skippedFirst.channels[0].segments, [[0, 0]]);
  assert.equal(modelOk(skippedFirst).meta.gapCount, 0);
  assert.equal(modelOk(skippedFirst).series[0].paths.length, 1);
});

// ---------------------------------------------------------------------------
// column classification
// ---------------------------------------------------------------------------

test('classifyColumns / suggestTimeColumn', () => {
  const p = parsedOk('note,t,rpm\nx,0,800\ny,1,900\n');
  const cols = classifyColumns(p);
  assert.equal(cols.length, 3);
  assert.equal(cols[0].numericCount, 0);
  assert.equal(cols[0].nonEmptyCount, 2);
  assert.equal(cols[0].unparsableCount, 2);
  assert.equal(cols[1].numericCount, 2);
  assert.equal(cols[2].numericCount, 2);
  assert.equal(cols[1].inversions, 0);
  assert.equal(suggestTimeColumn(p), 1);

  assert.equal(suggestTimeColumn(parsedOk('note,elapsed_ms\nx,10\ny,11\n')), 1);
  assert.equal(suggestTimeColumn(parsedOk('t\n5\n6\n')), 0);

  const allText = parsedOk('note,x\na,b\nc,d\n');
  assert.equal(suggestTimeColumn(allText), -1);
});

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

test('computeStats: min/max/mean/count, ignores gaps, handles empty', () => {
  assert.deepEqual(computeStats([1, 2, 3]), { count: 3, min: 1, max: 3, mean: 2 });
  assert.deepEqual(computeStats([null, 5]), { count: 1, min: 5, max: 5, mean: 5 });
  assert.equal(computeStats([]), null);
  assert.equal(computeStats([null]), null);
  assert.equal(computeStats([undefined, NaN]), null);
  const s = computeStats([1, undefined, NaN, 3]);
  assert.equal(s.count, 2);
  assert.equal(s.mean, 2);
  assertClose(computeStats([1, 2]).mean, 1.5, 1e-12);
});

// ---------------------------------------------------------------------------
// ticks & scales
// ---------------------------------------------------------------------------

test('niceTicks: clean steps inside the range without float noise', () => {
  const t1 = niceTicks(0, 100, 6);
  assert.deepEqual(t1.ticks, [0, 20, 40, 60, 80, 100]);
  const t2 = niceTicks(0, 1, 5);
  assert.deepEqual(t2.ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  const t3 = niceTicks(0.1, 0.2, 3);
  assert.deepEqual(t3.ticks, [0.1, 0.15, 0.2]);
  for (const [t, lo, hi] of [[t1, 0, 100], [t2, 0, 1], [t3, 0.1, 0.2]]) {
    assert.ok(t.ticks.length >= 2 && t.ticks.length <= 10, 'tick count should stay reasonable');
    for (const v of t.ticks) {
      assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `tick ${v} outside range [${lo}, ${hi}]`);
    }
  }
  const degenerate = niceTicks(5, 5, 4);
  assert.deepEqual(degenerate.ticks, [5]);
});

test('makeScale: maps and inverts; degenerate domains are guarded', () => {
  const s = makeScale(0, 100, 0, 500);
  assert.equal(s.map(50), 250);
  assert.equal(s.invert(250), 50);
  assert.equal(s.map(0), 0);
  assert.equal(s.map(100), 500);

  const flat = makeScale(2, 2, 0, 100);
  assert.equal(flat.map(2), 50);
  assert.equal(flat.invert(50), 2);
});

// ---------------------------------------------------------------------------
// windows (zoom / pan)
// ---------------------------------------------------------------------------

test('windows: fullWindow, clampWindow, zoomWindow, panWindow stay in-domain', () => {
  assert.deepEqual(fullWindow([3, 1, 2]), { t0: 1, t1: 3 });
  assert.equal(fullWindow([]), null);
  assert.deepEqual(fullWindow([5, 5]), { t0: 5, t1: 5 });

  assert.deepEqual(clampWindow({ t0: -5, t1: 105 }, { t0: 0, t1: 100 }), { t0: 0, t1: 100 });
  assert.equal(clampWindow({ t0: 200, t1: 300 }, { t0: 0, t1: 100 }), null);

  const dom = { t0: 0, t1: 100 };
  assert.deepEqual(zoomWindow({ t0: 0, t1: 100 }, 0.5, 0.5, dom), { t0: 25, t1: 75 });
  assert.deepEqual(zoomWindow({ t0: 0, t1: 100 }, 0.5, 0, dom), { t0: 0, t1: 50 });
  assert.deepEqual(zoomWindow({ t0: 0, t1: 100 }, 2, 0.5, dom), { t0: 0, t1: 100 });

  let win = { t0: 0, t1: 100 };
  for (let i = 0; i < 40; i++) win = zoomWindow(win, 0.5, 0.5, dom);
  assert.ok(win.t1 - win.t0 >= 1e-4 - 1e-12, 'zoom-in must respect the minimum span');
  assert.ok(win.t0 >= dom.t0 - 1e-9 && win.t1 <= dom.t1 + 1e-9, 'window must stay in domain');

  assert.deepEqual(panWindow({ t0: 0, t1: 10 }, 5, dom), { t0: 5, t1: 15 });
  assert.deepEqual(panWindow({ t0: 0, t1: 10 }, -3, dom), { t0: 0, t1: 10 });
  assert.deepEqual(panWindow({ t0: 90, t1: 100 }, 5, dom), { t0: 90, t1: 100 });
});

// ---------------------------------------------------------------------------
// downsampling
// ---------------------------------------------------------------------------

test('downsamplePoints: bounded output, extrema preserved, order kept', () => {
  const points = [];
  for (let i = 0; i < 5000; i++) points.push({ t: i, v: Math.sin(i / 50) });
  points[1234].v = 999;
  points[4321].v = -999;

  const res = downsamplePoints(points, 2000);
  assert.equal(res.downsampled, true);
  assert.ok(res.points.length <= 2000, `expected <= 2000 points (the requested budget), got ${res.points.length}`);
  assert.equal(res.points[0], points[0], 'first sample kept');
  assert.equal(res.points[res.points.length - 1], points[4999], 'last sample kept');
  assert.ok(res.points.some((p) => p.v === 999), 'global max preserved');
  assert.ok(res.points.some((p) => p.v === -999), 'global min preserved');
  for (let i = 1; i < res.points.length; i++) {
    assert.ok(res.points[i].t > res.points[i - 1].t, 'point order must be ascending by time');
  }

  const small = points.slice(0, 100);
  const res2 = downsamplePoints(small, 2000);
  assert.equal(res2.downsampled, false);
  assert.equal(res2.points, small, 'small series returned untouched (same array)');
});

// ---------------------------------------------------------------------------
// plot model
// ---------------------------------------------------------------------------

test('buildPlotModel: domains, series, window, annotations and errors', () => {
  const ds = datasetOk('t,a,b\n0,0,10\n1,1,11\n2,2,12\n3,3,13\n');
  const m = modelOk(ds);
  assert.equal(m.series.length, 2);
  assert.equal(m.series[0].name, 'a');
  assert.equal(m.series[0].color, PALETTE[0]);
  assert.equal(m.series[1].color, PALETTE[1]);
  assert.equal(m.x.min, 0);
  assert.equal(m.x.max, 3);
  assert.equal(m.x.title, 't');
  assert.ok(m.y.min < 0, 'y domain padded below the data');
  assert.ok(m.y.max > 13, 'y domain padded above the data');
  assert.ok(m.x.ticks.length >= 2 && m.y.ticks.length >= 2);
  assert.equal(m.series[0].paths.length, 1);
  assert.equal(m.series[0].paths[0].length, 4);
  assert.equal(m.meta.availableTotal, 8);
  assert.equal(m.meta.drawnTotal, 8);
  assert.equal(m.meta.downsampled, false);
  assert.equal(m.meta.gapCount, 0);

  const mw = modelOk(ds, { window: { t0: 1, t1: 2 } });
  assert.deepEqual(mw.meta.window, { t0: 1, t1: 2 });
  assert.equal(mw.series[0].drawn, 2);
  assert.equal(mw.series[0].paths[0].length, 2);
  assert.equal(mw.series[0].paths[0][0].t, 1);

  const ma = modelOk(ds, { annotations: [{ t: 1.5, label: 'mark' }, { t: 99, label: 'out' }, { t: -1, label: 'neg' }] });
  assert.equal(ma.annotations.length, 1);
  assert.equal(ma.annotations[0].t, 1.5);
  assert.equal(ma.annotations[0].label, 'mark');

  const ms = modelOk(ds, { scales: { 1: 2 } });
  assert.equal(ms.series[0].scale, 2);
  assert.equal(ms.series[1].scale, 1);
  assert.equal(ms.series[0].paths[0][1].v, 2, 'scaled plotted value = raw x scale');
  assert.equal(ms.series[0].stats.min, 0, 'stats remain raw values');

  const msel = modelOk(ds, { selectedColumns: [2] });
  assert.equal(msel.series.length, 1);
  assert.equal(msel.series[0].name, 'b');

  const none = buildPlotModel(ds, { selectedColumns: [] });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'no_channels');

  const out = buildPlotModel(ds, { window: { t0: 50, t1: 60 } });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'empty_window');
});

test('buildPlotModel: annotation boundary times are inclusive at the window edges', () => {
  const ds = datasetOk('t,a\n0,1\n1,2\n2,3\n3,4\n');
  const full = modelOk(ds, {
    annotations: [
      { t: 0, label: 'lo' }, { t: 3, label: 'hi' },
      { t: -0.001, label: 'below' }, { t: 3.001, label: 'above' }
    ]
  });
  assert.deepEqual(full.annotations.map((a) => a.t), [0, 3], 'full-window edges are included; outside is dropped');

  const zoomed = modelOk(ds, {
    window: { t0: 1, t1: 2 },
    annotations: [
      { t: 1, label: 'lo' }, { t: 2, label: 'hi' },
      { t: 0.999, label: 'below' }, { t: 2.001, label: 'above' }
    ]
  });
  assert.deepEqual(zoomed.annotations.map((a) => a.t), [1, 2], 'custom-window edges are included too');
});

test('buildPlotModel: no_points when the selection has no samples in range', () => {
  const allNull = datasetOk('t,a\n0,\n1,\n');
  const r1 = buildPlotModel(allNull, {});
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'no_points');
  assert.match(r1.error.message, /Widen the zoom or pick other channels/);

  const outOfWindow = datasetOk('t,a\n0,5\n10,\n');
  const r2 = buildPlotModel(outOfWindow, { window: { t0: 5, t1: 6 } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'no_points');
});

test('buildPlotModel: identical timestamps are padded, not NaN', () => {
  const ds = datasetOk('t,a\n5,1\n5,2\n');
  const m = modelOk(ds);
  assert.equal(m.meta.paddedTime, true);
  assert.ok(m.x.min < 5 && m.x.max > 5);
  assert.ok(Number.isFinite(m.y.min) && Number.isFinite(m.y.max));
});

test('buildPlotModel: large data is downsampled inside the model', () => {
  const rows = ['t,v'];
  for (let i = 0; i < 6000; i++) rows.push(i + ',' + (i % 100));
  const ds = datasetOk(rows.join('\n') + '\n');
  const m = modelOk(ds, { maxPoints: 500 });
  assert.equal(m.series[0].downsampled, true);
  assert.ok(m.series[0].drawn <= 500, `drawn ${m.series[0].drawn} should be <= the requested budget 500`);
  assert.equal(m.meta.downsampled, true);
  assert.equal(m.meta.availableTotal, 6000);
  const vals = new Set();
  m.series[0].paths.forEach((path) => path.forEach((pt) => vals.add(pt.v)));
  assert.ok(vals.has(0) && vals.has(99), 'global min and max survive downsampling');
});

// ---------------------------------------------------------------------------
// point-budget regressions (dense and gap-heavy logs)
// ---------------------------------------------------------------------------

test('downsamplePoints: finite budgets are never exceeded; endpoints and extrema stay within budget', () => {
  const points = [];
  for (let i = 0; i < 5000; i++) points.push({ t: i, v: Math.sin(i / 50) });
  points[1234].v = 999;
  points[4321].v = -999;

  for (const budget of [1, 2, 3, 4, 7]) {
    const res = downsamplePoints(points, budget);
    assert.equal(res.downsampled, true);
    assert.ok(res.points.length <= budget, `budget ${budget}: got ${res.points.length} points`);
    for (let i = 1; i < res.points.length; i++) {
      assert.ok(res.points[i].t > res.points[i - 1].t, `budget ${budget}: order must ascend`);
    }
  }

  const two = downsamplePoints(points, 2);
  assert.equal(two.points.length, 2);
  assert.equal(two.points[0], points[0], 'budget 2 keeps the first sample');
  assert.equal(two.points[1], points[4999], 'budget 2 keeps the last sample');

  for (const budget of [4, 7]) {
    const res = downsamplePoints(points, budget);
    assert.equal(res.points[0], points[0], `budget ${budget}: first sample kept`);
    assert.equal(res.points[res.points.length - 1], points[4999], `budget ${budget}: last sample kept`);
    assert.ok(res.points.some((p) => p.v === 999), `budget ${budget}: global max kept`);
    assert.ok(res.points.some((p) => p.v === -999), `budget ${budget}: global min kept`);
  }

  const dflt = downsamplePoints(points);
  assert.ok(dflt.points.length <= LIMITS.MAX_POINTS_PER_CHANNEL, 'default budget is the documented per-channel limit');
  assert.equal(points.length, 5000, 'input array must not be mutated');
});

test('buildPlotModel: 50k alternating gaps stay inside the 2000-point channel budget', () => {
  const pattern = (i) => i % 2 === 0;
  const rows = ['t,v'];
  for (let i = 0; i < 50000; i++) rows.push(i + ',' + (pattern(i) ? Math.sin(i / 10) : ''));
  const ds = datasetOk(rows.join('\n') + '\n');
  const s = modelOk(ds).series[0];

  const count = s.paths.reduce((n, p) => n + p.length, 0);
  assert.equal(s.drawn, count, 'drawn metadata must equal the plotted point count');
  assert.ok(count <= LIMITS.MAX_POINTS_PER_CHANNEL, `drawn ${count} must stay <= ${LIMITS.MAX_POINTS_PER_CHANNEL}`);
  assert.ok(count > 0, 'something must be drawn');
  assert.equal(s.available, 25000);
  assert.ok(s.available > count, 'available must exceed the downsampled draw');
  assert.equal(s.downsampled, true);

  for (const points of s.paths) {
    for (let i = 1; i < points.length; i++) {
      for (let t = points[i - 1].t; t <= points[i].t; t++) {
        assert.ok(pattern(t), 'path bridges a missing sample at t=' + t);
      }
    }
  }

  const again = modelOk(ds).series[0];
  assert.equal(again.drawn, s.drawn, 'selection must be deterministic');
  assert.deepEqual(again.paths, s.paths, 'selection must be deterministic');
});

test('buildPlotModel: 50k four-on/one-off gaps stay inside the 2000-point channel budget', () => {
  const pattern = (i) => i % 5 !== 4;
  const rows = ['t,v'];
  for (let i = 0; i < 50000; i++) rows.push(i + ',' + (pattern(i) ? Math.sin(i / 10) : ''));
  const ds = datasetOk(rows.join('\n') + '\n');
  const s = modelOk(ds).series[0];

  const count = s.paths.reduce((n, p) => n + p.length, 0);
  assert.equal(s.drawn, count);
  assert.ok(count <= LIMITS.MAX_POINTS_PER_CHANNEL, `drawn ${count} must stay <= ${LIMITS.MAX_POINTS_PER_CHANNEL}`);
  assert.equal(s.available, 40000);
  assert.ok(s.available > count);
  assert.equal(s.downsampled, true);

  for (const points of s.paths) {
    for (let i = 1; i < points.length; i++) {
      for (let t = points[i - 1].t; t <= points[i].t; t++) {
        assert.ok(pattern(t), 'path bridges a missing sample at t=' + t);
      }
    }
  }
});

test('buildPlotModel: multiple dense segments share one channel-wide budget without bridging the gap', () => {
  const gapIndex = 25000;
  const rows = ['t,v'];
  for (let i = 0; i < 50000; i++) rows.push(i + ',' + (i === gapIndex ? '' : Math.sin(i / 10)));
  const ds = datasetOk(rows.join('\n') + '\n');
  const s = modelOk(ds).series[0];

  assert.equal(s.paths.length, 2, 'both dense segments must be represented');
  const count = s.paths.reduce((n, p) => n + p.length, 0);
  assert.equal(s.drawn, count);
  assert.ok(count <= LIMITS.MAX_POINTS_PER_CHANNEL, `drawn ${count} must stay <= ${LIMITS.MAX_POINTS_PER_CHANNEL}`);
  assert.equal(s.available, 49999);
  assert.equal(s.downsampled, true);

  for (const points of s.paths) {
    const left = points.filter((p) => p.t < gapIndex).length;
    const right = points.filter((p) => p.t > gapIndex).length;
    assert.ok(left === 0 || right === 0, 'a single path must never span the missing row');
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i].t > points[i - 1].t, 'points must stay in time order');
    }
  }

  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of ds.channels[0].values) {
    if (v === null) continue;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const drawnValues = new Set();
  for (const points of s.paths) for (const p of points) drawnValues.add(p.v);
  assert.ok(drawnValues.has(minV), 'global min survives the shared budget');
  assert.ok(drawnValues.has(maxV), 'global max survives the shared budget');
});

test('buildPlotModel: small and custom budgets are respected exactly', () => {
  const pattern = (i) => i % 3 !== 2;
  const rows = ['t,v'];
  for (let i = 0; i < 50000; i++) rows.push(i + ',' + (pattern(i) ? Math.sin(i / 10) : ''));
  const ds = datasetOk(rows.join('\n') + '\n');

  const seven = modelOk(ds, { maxPoints: 7 }).series[0];
  const count7 = seven.paths.reduce((n, p) => n + p.length, 0);
  assert.equal(seven.drawn, count7);
  assert.ok(count7 <= 7, `custom budget 7: drawn ${count7}`);
  assert.equal(seven.available, 33334);
  assert.equal(seven.downsampled, true);
  for (const points of seven.paths) {
    for (let i = 1; i < points.length; i++) {
      for (let t = points[i - 1].t; t <= points[i].t; t++) {
        assert.ok(pattern(t), 'path bridges a missing sample at t=' + t);
      }
    }
  }

  const one = modelOk(ds, { maxPoints: 1 }).series[0];
  assert.equal(one.drawn, 1, 'a budget of 1 draws exactly one sample');
  assert.equal(one.downsampled, true);

  const denseRows = ['t,v'];
  for (let i = 0; i < 40000; i++) denseRows.push(i + ',' + Math.sin(i / 10));
  const dense = datasetOk(denseRows.join('\n') + '\n');
  const three = modelOk(dense, { maxPoints: 3 }).series[0];
  assert.equal(three.drawn, 3);
  assert.equal(three.paths.length, 1);
  assert.equal(three.paths[0][0].t, 0);
  assert.equal(three.paths[0][three.paths[0].length - 1].t, 39999);

  for (const bad of [0, -5, NaN, Infinity, 'nonsense']) {
    const s = modelOk(dense, { maxPoints: bad }).series[0];
    assert.ok(s.drawn <= LIMITS.MAX_POINTS_PER_CHANNEL, `budget ${String(bad)}: drawn ${s.drawn}`);
    assert.equal(s.downsampled, true);
  }
});

test('renderSVGString: SVG node count stays inside the point budget for dense and gappy 50k logs', () => {
  function seriesNodeCount(svg) {
    const circles = (svg.match(/<circle\b/g) || []).length;
    let pathPoints = 0;
    const paths = svg.match(/<path\b[^>]*\bd="[^"]*"/g) || [];
    for (const tag of paths) {
      const d = tag.match(/\bd="([^"]*)"/)[1];
      pathPoints += (d.match(/[ML]/g) || []).length;
    }
    return circles + pathPoints;
  }

  const denseRows = ['t,v'];
  for (let i = 0; i < 50000; i++) denseRows.push(i + ',' + Math.sin(i / 10));
  const denseModel = modelOk(datasetOk(denseRows.join('\n') + '\n'));
  const denseSvg = renderSVGString(denseModel, { width: 960, height: 460 });
  const denseNodes = seriesNodeCount(denseSvg);
  assert.ok(denseNodes <= LIMITS.MAX_POINTS_PER_CHANNEL, `dense SVG carries ${denseNodes} series point nodes`);
  assert.equal(denseModel.series[0].drawn, denseNodes, 'path vertices must match the drawn count');

  const altRows = ['t,v'];
  for (let i = 0; i < 50000; i++) altRows.push(i + ',' + (i % 2 === 0 ? Math.sin(i / 10) : ''));
  const altModel = modelOk(datasetOk(altRows.join('\n') + '\n'));
  const altSvg = renderSVGString(altModel, { width: 960, height: 460 });
  const circles = (altSvg.match(/<circle\b/g) || []).length;
  assert.ok(circles <= LIMITS.MAX_POINTS_PER_CHANNEL, `alternating SVG draws ${circles} circles`);
  assert.equal(altModel.series[0].drawn, circles, 'each single-sample path draws exactly one circle');
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

test('exportCSV: guarded headers, empty for gaps, CRLF, filtering', () => {
  const ds = datasetOk('t,=SUM(A1:A2)\n0,1\n1,\n2,3\n');
  const out = exportCSV(ds);
  assert.ok(out.endsWith('\r\n'), 'output ends with CRLF');
  const lines = out.split('\r\n');
  assert.deepEqual(lines.slice(0, 4), ["t,'=SUM(A1:A2)", '0,1', '1,', '2,3']);
  assert.equal(lines.length, 5, 'trailing newline produces final empty segment');

  const ranged = exportCSV(ds, { range: { t0: 1, t1: 2 } });
  assert.deepEqual(ranged.split('\r\n').slice(0, 3), ["t,'=SUM(A1:A2)", '1,', '2,3']);

  const raw = exportCSV(ds, { guardFormulas: false });
  assert.equal(raw.split('\r\n')[0], 't,=SUM(A1:A2)');

  // channel subset + semicolon delimiter quoting
  const ds2 = datasetOk('t,a;b,c\n0,1,2\n');
  assert.equal(exportCSV(ds2, { channelColumns: [2] }).split('\r\n')[0], 't,c');
  assert.equal(exportCSV(ds2, { channelColumns: [2] }).split('\r\n')[1], '0,2');
  assert.equal(exportCSV(ds2, { channelColumns: [1], delimiter: ';' }).split('\r\n')[0], 't;"a;b"');
});

test('guardFormula: spreadsheet injection guard', () => {
  assert.equal(guardFormula('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(guardFormula('+cmd'), "'+cmd");
  assert.equal(guardFormula('@x'), "'@x");
  assert.equal(guardFormula('plain'), 'plain');
  assert.equal(guardFormula('-5'), '-5', 'plain negative numbers stay untouched');
  assert.equal(guardFormula('-5abc'), "'-5abc");
});

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

test('renderSVGString: standalone SVG with escaped user strings', () => {
  const payload = 'RPM</text><script>alert(1)</script>';
  const p = parsedOk('t,"' + payload + '"\n0,5\n1,6\n2,7\n');
  const ds = buildDataset(p, { timeColumn: 0 }).value;
  const m = modelOk(ds, { annotations: [{ t: 1, label: 'spike & <check>' }], title: 'Unit test' });

  const svg = renderSVGString(m, { width: 900, height: 420 });
  assert.ok(svg.startsWith('<svg'), 'svg starts with <svg');
  assert.ok(svg.endsWith('</svg>'), 'svg ends with </svg>');
  assert.ok(svg.includes('viewBox="0 0 900 420"'));
  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes('<title>Unit test</title>'));
  assert.ok(!svg.includes('<script'), 'raw script must never appear');
  assert.ok(svg.includes('&lt;script&gt;'), 'escaped script entity appears');
  assert.ok(svg.includes('&lt;/text&gt;'), 'escaped closing tag appears');
  assert.ok(svg.includes('spike &amp; &lt;check&gt;'), 'annotation label escaped');
  assert.ok(svg.includes('<path '), 'series path present');

  const layout = svgLayout(m, { width: 900, height: 420 });
  assert.ok(layout.plot.x > 0 && layout.plot.x + layout.plot.w <= 900);
  assert.ok(layout.plot.y > 0 && layout.plot.y + layout.plot.h <= 420);
});

test('escapeXML: escapes the five XML entities and strips control chars', () => {
  assert.equal(escapeXML('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
  assert.equal(escapeXML('x\u0000\u0007y'), 'xy');
  assert.equal(escapeXML(null), '');
  assert.equal(escapeXML('line\tbreak\nok'), 'line\tbreak\nok');

  // characters that are invalid in XML 1.0 must not survive into the markup
  assert.equal(escapeXML('a\uFFFFb'), 'ab', 'U+FFFF must be stripped');
  assert.equal(escapeXML('a\uFFFEb'), 'ab', 'U+FFFE must be stripped');
  assert.equal(escapeXML('a\uFDD0b'), 'ab', 'noncharacters must be stripped');
  assert.equal(escapeXML('a\uD800b'), 'ab', 'lone surrogates must be stripped');
  assert.equal(escapeXML('x\uFFFDb'), 'x\uFFFDb', 'U+FFFD is valid XML and stays');
  assert.equal(escapeXML('a\u{1F600}b'), 'a\u{1F600}b', 'astral pairs are valid and stay');
});

test('renderSVGString: noncharacter headers cannot make the standalone SVG invalid XML', () => {
  const header = 'a\uFFFFb';
  const p = parsedOk('t,"' + header + '"\n0,1\n1,2\n');
  const ds = buildDataset(p, { timeColumn: 0 }).value;
  assert.equal(ds.channels[0].name, header, 'the raw name is kept in the dataset');

  const svg = renderSVGString(modelOk(ds), { width: 900, height: 420 });
  assert.ok(!/[\uFFFE\uFFFF]/.test(svg), 'U+FFFE/U+FFFF must not appear in the SVG markup');
  assert.ok(svg.includes('ab: min 1'), 'the sanitized name is what gets drawn');
  assert.ok(!svg.includes('<script'), 'sanity: element escaping still applies');
});

// ---------------------------------------------------------------------------
// small formatters
// ---------------------------------------------------------------------------

test('formatNumber / formatBytes / truncate / sanitizeFilename', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(12.5), '12.5');
  assert.equal(formatNumber(-3.25), '-3.25');
  assert.equal(formatNumber(NaN), '');
  assert.ok(formatNumber(1e-7).includes('e-7'));
  assert.ok(formatNumber(12345678).includes('e'));

  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.ok(formatBytes(2048).includes('KB'));

  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdefgh', 5).length, 5);
  assert.ok(truncate('abcdefgh', 5).endsWith('\u2026'));

  const fn = sanitizeFilename('engine log <>.csv');
  assert.ok(/^[A-Za-z0-9._-]+$/.test(fn), `sanitized name should be safe, got ${fn}`);
  assert.ok(fn.includes('engine-log'));
  assert.equal(sanitizeFilename('', 'fallback'), 'fallback');
  assert.equal(sanitizeFilename('>>>', 'fallback'), 'fallback');
  assert.ok(sanitizeFilename('x'.repeat(200)).length <= 80);
});
