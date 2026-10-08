'use strict';

/*
 * Sensor Log Studio — app.js
 *
 * Browser UI glue: import handlers, column mapping, plot rendering (SVG
 * string from core.renderSVGString, injected after XML-escaping every
 * user-derived string), zoom/pan/annotations, and offline downloads.
 *
 * All user strings (file names, channel names, labels, messages) are written
 * through textContent or are escaped by core.escapeXML — never raw HTML.
 *
 * Runs fully offline: no fetch, no storage, no telemetry.
 */

(function () {
  'use strict';

  const SL = window.SensorLog;
  if (!SL) {
    document.body.textContent = 'core.js failed to load — Sensor Log Studio cannot start.';
    return;
  }

  const $ = function (id) { return document.getElementById(id); };

  const els = {
    file: $('file-input'),
    example: $('btn-load-example'),
    delimiter: $('delimiter-select'),
    paste: $('paste-input'),
    loadPaste: $('btn-load-paste'),
    status: $('status-line'),
    error: $('error-line'),
    source: $('source-name'),
    mappingPanel: $('mapping-panel'),
    timeColumn: $('time-column'),
    sortByTime: $('sort-by-time'),
    channelList: $('channel-list'),
    notes: $('parse-notes'),
    plotPanel: $('plot-panel'),
    zoomIn: $('btn-zoom-in'),
    zoomOut: $('btn-zoom-out'),
    zoomReset: $('btn-zoom-reset'),
    plot: $('plot'),
    meta: $('meta-line'),
    legendBody: $('legend-body'),
    annotPanel: $('annot-panel'),
    annotTime: $('annotation-time'),
    annotLabel: $('annotation-label'),
    annotAdd: $('btn-add-annotation'),
    annotError: $('annotation-error'),
    annotList: $('annotation-list'),
    exportPanel: $('export-panel'),
    rangeMode: $('range-mode'),
    downloadCsv: $('btn-download-csv'),
    downloadSvg: $('btn-download-svg')
  };

  const VIEW_W = 980;
  const VIEW_H = 470;
  const DASH = '\u2014';

  const state = {
    text: '',
    sourceName: '',
    forceDelimiter: '',
    parsed: null,
    dataset: null,
    model: null,
    timeColumn: 0,
    selectedColumns: [],
    sortByTime: false,
    window: null,
    scales: {},
    annotations: []
  };

  /*
   * FICTIONAL example log — synthetic warm-up curve written for this tool.
   * Not from a real vehicle. The fixture lives in core.js (SL.EXAMPLE_CSV) so
   * the unit tests pin the exact same data; it demonstrates: semicolon
   * delimiter, a multi-row sensor-bus dropout (empty cells => gaps, no
   * interpolation), one non-numeric cell ("n/a") and one row with an
   * unparsable time ("--") that gets skipped.
   */
  const EXAMPLE_CSV = SL.EXAMPLE_CSV;

  // -------------------------------------------------------------------------
  // status helpers
  // -------------------------------------------------------------------------

  function showError(msg) {
    els.error.textContent = msg || '';
    els.error.hidden = !msg;
  }

  function setStatus(msg) {
    els.status.textContent = msg || '';
  }

  function placeholder(msg) {
    els.plot.className = 'plot-host msg';
    els.plot.textContent = msg;
  }

  // -------------------------------------------------------------------------
  // pipeline: text -> parsed -> dataset -> plot model -> svg
  // -------------------------------------------------------------------------

  function loadText(text, name) {
    state.text = text;
    state.sourceName = name;
    els.source.textContent = name;
    reparse();
  }

  function reparse() {
    showError('');
    const opts = state.forceDelimiter ? { delimiter: state.forceDelimiter } : undefined;
    const res = SL.parseCSV(state.text, opts);
    if (!res.ok) {
      state.parsed = null;
      state.dataset = null;
      state.model = null;
      showError(res.error.message);
      setStatus('');
      els.mappingPanel.hidden = true;
      els.plotPanel.hidden = true;
      els.annotPanel.hidden = true;
      els.exportPanel.hidden = true;
      els.legendBody.innerHTML = '';
      els.notes.innerHTML = '';
      els.meta.textContent = '';
      placeholder('Nothing loaded yet.');
      return;
    }

    state.parsed = res.value;
    state.window = null;
    state.scales = {};
    state.annotations = [];
    state.model = null;

    const cols = SL.classifyColumns(res.value);
    const suggested = SL.suggestTimeColumn(res.value);
    state.timeColumn = suggested >= 0 ? suggested : 0;
    state.selectedColumns = cols
      .filter(function (c) { return c.index !== state.timeColumn && c.numericCount > 0; })
      .map(function (c) { return c.index; });

    els.sortByTime.checked = state.sortByTime;
    buildMappingUI(cols);
    els.mappingPanel.hidden = false;
    renderAnnotationList();
    rebuild();
  }

  function buildMappingUI(cols) {
    els.timeColumn.innerHTML = '';
    cols.forEach(function (c) {
      const o = document.createElement('option');
      o.value = String(c.index);
      o.textContent = c.name + ' — column ' + (c.index + 1) + ' (' + c.numericCount + ' numeric value(s))';
      els.timeColumn.appendChild(o);
    });
    els.timeColumn.value = String(state.timeColumn);

    els.channelList.innerHTML = '';
    cols.forEach(function (c) {
      const isTime = c.index === state.timeColumn;
      const plottable = c.numericCount > 0 && !isTime;

      const label = document.createElement('label');
      label.className = 'channel';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-column', String(c.index));
      cb.checked = state.selectedColumns.indexOf(c.index) !== -1;
      cb.disabled = !plottable;
      cb.addEventListener('change', function () {
        if (cb.checked) {
          if (state.selectedColumns.indexOf(c.index) === -1) state.selectedColumns.push(c.index);
        } else {
          state.selectedColumns = state.selectedColumns.filter(function (i) { return i !== c.index; });
        }
        rebuild();
      });

      const span = document.createElement('span');
      let txt = c.name + ' — ' + c.numericCount + ' numeric value(s)';
      if (isTime) txt += ' — used as the time column';
      else if (c.numericCount === 0) txt += ' — not plottable';
      span.textContent = txt;

      label.appendChild(cb);
      label.appendChild(span);
      els.channelList.appendChild(label);
    });
  }

  function rebuild() {
    if (!state.parsed) return;
    const res = SL.buildDataset(state.parsed, {
      timeColumn: state.timeColumn,
      channelColumns: state.selectedColumns,
      sortByTime: state.sortByTime
    });

    if (!res.ok) {
      state.dataset = null;
      state.model = null;
      showError(res.error.message);
      els.legendBody.innerHTML = '';
      els.meta.textContent = '';
      renderNotes(null);
      placeholder('No usable data rows.');
      els.plotPanel.hidden = false;
      els.downloadCsv.disabled = true;
      els.downloadSvg.disabled = true;
      updateZoomButtons();
      return;
    }

    showError('');
    state.dataset = res.value;
    const full = SL.fullWindow(state.dataset.times);
    if (state.window) state.window = SL.clampWindow(state.window, full) || null;

    renderNotes(state.dataset);
    renderPlot();

    const ds = state.dataset;
    setStatus(
      state.sourceName + ': ' + state.parsed.dataRowCount + ' data row(s), delimiter ' +
      state.parsed.delimiterName + ' · ' + ds.acceptedCount + ' usable row(s), ' +
      state.selectedColumns.length + ' channel(s) selected.'
    );
  }

  function renderNotes(ds) {
    const items = [];
    if (state.parsed && state.parsed.warnings) items.push.apply(items, state.parsed.warnings);
    if (ds && ds.warnings) items.push.apply(items, ds.warnings);
    if (ds) {
      ds.channels.forEach(function (c) {
        if (c.unparsable > 0) {
          items.push(c.unparsable + ' non-numeric cell(s) in "' + c.name + '" treated as missing.');
        }
      });
    }
    els.notes.innerHTML = '';
    items.forEach(function (w) {
      const li = document.createElement('li');
      li.textContent = w;
      els.notes.appendChild(li);
    });
  }

  function renderPlot() {
    if (!state.dataset) return;

    const res = SL.buildPlotModel(state.dataset, {
      selectedColumns: state.selectedColumns,
      window: state.window,
      maxPoints: SL.LIMITS.MAX_POINTS_PER_CHANNEL,
      scales: state.scales,
      annotations: state.annotations,
      title: (state.sourceName || 'sensor log') + ' — sensor log'
    });

    els.plotPanel.hidden = false;
    els.annotPanel.hidden = false;
    els.exportPanel.hidden = false;

    if (!res.ok) {
      state.model = null;
      placeholder(res.error.message);
      els.meta.textContent = '';
      els.legendBody.innerHTML = '';
      // no plot model => no exports: a time-only CSV (or an SVG of nothing)
      // would be misleading, so both download buttons are disabled.
      els.downloadCsv.disabled = true;
      els.downloadSvg.disabled = true;
      updateZoomButtons();
      return;
    }

    state.model = res.value;
    els.plot.className = 'plot-host';
    els.plot.innerHTML = SL.renderSVGString(state.model, { width: VIEW_W, height: VIEW_H });
    els.downloadSvg.disabled = false;
    els.downloadCsv.disabled = false;
    buildLegend(state.model);
    updateMeta(state.model);
    updateZoomButtons();
  }

  function buildLegend(model) {
    els.legendBody.innerHTML = '';
    model.series.forEach(function (s) {
      const tr = document.createElement('tr');

      const tdColor = document.createElement('td');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = s.color;
      sw.setAttribute('aria-hidden', 'true');
      tdColor.appendChild(sw);

      const tdName = document.createElement('td');
      tdName.textContent = s.name;

      const tdScale = document.createElement('td');
      const scaleInput = document.createElement('input');
      scaleInput.type = 'number';
      scaleInput.step = 'any';
      scaleInput.className = 'scale-input';
      scaleInput.value = String(s.scale);
      scaleInput.setAttribute('aria-label', 'Display scale factor for ' + s.name);
      scaleInput.addEventListener('change', function () {
        let v = SL.parseNumber(scaleInput.value);
        if (v === null || v === 0) v = 1;
        state.scales[s.column] = v;
        renderPlot();
      });
      tdScale.appendChild(scaleInput);

      const tdDrawn = document.createElement('td');
      tdDrawn.textContent = s.drawn + ' / ' + s.available;

      function statCell(value) {
        const td = document.createElement('td');
        td.textContent = (value === null || value === undefined) ? DASH : SL.formatNumber(value * s.scale);
        return td;
      }

      const st = s.stats;
      tr.appendChild(tdColor);
      tr.appendChild(tdName);
      tr.appendChild(tdScale);
      tr.appendChild(tdDrawn);
      tr.appendChild(statCell(st ? st.min : null));
      tr.appendChild(statCell(st ? st.max : null));
      tr.appendChild(statCell(st ? st.mean : null));
      els.legendBody.appendChild(tr);
    });
  }

  function updateMeta(model) {
    const m = model.meta;
    let txt = 'window ' + SL.formatNumber(m.window.t0) + ' – ' + SL.formatNumber(m.window.t1) +
      ' (full ' + SL.formatNumber(m.full.t0) + ' – ' + SL.formatNumber(m.full.t1) + ')';
    txt += ' · ' + m.drawnTotal + ' of ' + m.availableTotal + ' samples drawn';
    if (m.downsampled) txt += ' · downsampled (extrema kept)';
    if (m.paddedTime) txt += ' · identical timestamps (axis padded)';
    if (m.gapCount > 0) txt += ' · ' + m.gapCount + ' gap(s) shown';
    els.meta.textContent = txt;
  }

  function updateZoomButtons() {
    const m = state.model;
    if (!m) {
      els.zoomIn.disabled = true;
      els.zoomOut.disabled = true;
      els.zoomReset.disabled = true;
      return;
    }
    const full = m.meta.full;
    const win = m.meta.window;
    const fullSpan = full.t1 - full.t0;
    const span = win.t1 - win.t0;
    const atFull = span >= fullSpan * (1 - 1e-9);
    els.zoomOut.disabled = atFull;
    els.zoomReset.disabled = atFull;
    els.zoomIn.disabled = span <= Math.max(fullSpan * 1e-6, 1e-9) * 1.000001;
  }

  // -------------------------------------------------------------------------
  // zoom / pan
  // -------------------------------------------------------------------------

  function zoom(factor, anchor01, defer) {
    if (!state.model) return;
    const full = state.model.meta.full;
    const win = state.window || full;
    const next = SL.zoomWindow(win, factor, anchor01, full);
    const fullSpan = full.t1 - full.t0;
    state.window = (next.t1 - next.t0 >= fullSpan * (1 - 1e-9)) ? null : next;
    if (defer) scheduleRender();
    else renderPlot();
  }

  function anchorFromClientX(clientX) {
    const svg = els.plot.querySelector('svg');
    if (!svg || !state.model) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    const vx = ((clientX - rect.left) / rect.width) * VIEW_W;
    const lay = SL.svgLayout(state.model, { width: VIEW_W, height: VIEW_H });
    return Math.min(1, Math.max(0, (vx - lay.plot.x) / lay.plot.w));
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(function () {
      rafPending = false;
      renderPlot();
    });
  }

  els.plot.addEventListener('wheel', function (e) {
    if (!state.model) return;
    e.preventDefault();
    const anchor = anchorFromClientX(e.clientX);
    if (anchor === null) return;
    // Wheel events can fire faster than the display refreshes: the window is
    // updated synchronously (so successive deltas accumulate) but the repaint
    // is coalesced through the rAF scheduler, like drag-pan does.
    zoom(e.deltaY > 0 ? 1.25 : 0.8, anchor, true);
  }, { passive: false });

  let drag = null;

  els.plot.addEventListener('pointerdown', function (e) {
    if (!state.model || e.button !== 0) return;
    drag = { x: e.clientX, moved: 0, win: state.window };
    try { els.plot.setPointerCapture(e.pointerId); } catch (err) { /* non-fatal */ }
    els.plot.classList.add('dragging');
  });

  els.plot.addEventListener('pointermove', function (e) {
    if (!drag || !state.model) return;
    const svg = els.plot.querySelector('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const dvx = ((e.clientX - drag.x) / rect.width) * VIEW_W;
    drag.moved += Math.abs(e.clientX - drag.x);
    const full = state.model.meta.full;
    const win = drag.win || full;
    const lay = SL.svgLayout(state.model, { width: VIEW_W, height: VIEW_H });
    const dt = -(dvx / lay.plot.w) * (win.t1 - win.t0);
    const next = SL.panWindow(win, dt, full);
    const fullSpan = full.t1 - full.t0;
    state.window = (next.t1 - next.t0 >= fullSpan * (1 - 1e-9)) ? null : next;
    scheduleRender();
  });

  els.plot.addEventListener('pointerup', function (e) {
    if (!drag) return;
    const wasClick = drag.moved < 4;
    drag = null;
    els.plot.classList.remove('dragging');
    if (wasClick) setAnnotationTimeFromX(e.clientX);
  });

  els.plot.addEventListener('pointercancel', function () {
    drag = null;
    els.plot.classList.remove('dragging');
  });

  function setAnnotationTimeFromX(clientX) {
    if (!state.model) return;
    const svg = els.plot.querySelector('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = ((clientX - rect.left) / rect.width) * VIEW_W;
    const lay = SL.svgLayout(state.model, { width: VIEW_W, height: VIEW_H });
    const a = Math.min(1, Math.max(0, (vx - lay.plot.x) / lay.plot.w));
    const win = state.model.meta.window;
    const t = win.t0 + a * (win.t1 - win.t0);
    els.annotTime.value = String(SL.formatNumber(t));
    els.annotTime.focus();
  }

  // -------------------------------------------------------------------------
  // annotations
  // -------------------------------------------------------------------------

  function addAnnotation() {
    const t = SL.parseNumber(els.annotTime.value);
    if (t === null) {
      els.annotError.textContent = 'Enter a numeric time value (same units as the time column).';
      els.annotError.hidden = false;
      return;
    }
    els.annotError.textContent = '';
    els.annotError.hidden = true;
    const label = els.annotLabel.value.trim() || 'annotation';
    state.annotations.push({ t: t, label: label });
    state.annotations.sort(function (a, b) { return a.t - b.t; });
    els.annotLabel.value = '';
    renderAnnotationList();
    renderPlot();
  }

  function renderAnnotationList() {
    els.annotList.innerHTML = '';
    state.annotations.forEach(function (a, idx) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = 't = ' + SL.formatNumber(a.t) + ' \u2014 \u201c' + a.label + '\u201d';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn tiny';
      btn.textContent = 'Remove';
      btn.setAttribute('aria-label', 'Remove annotation ' + a.label + ' at ' + SL.formatNumber(a.t));
      btn.addEventListener('click', function () {
        state.annotations.splice(idx, 1);
        renderAnnotationList();
        renderPlot();
      });
      li.appendChild(span);
      li.appendChild(btn);
      els.annotList.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // downloads (offline: Blob + object URL)
  // -------------------------------------------------------------------------

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function baseName() {
    return SL.sanitizeFilename(String(state.sourceName || 'sensor-log').replace(/\.csv$/i, ''), 'sensor-log');
  }

  function downloadCSV() {
    if (!state.dataset) return;
    const mode = els.rangeMode.value;
    const range = mode === 'zoom' && state.model ? state.model.meta.window : null;
    const csv = SL.exportCSV(state.dataset, { range: range });
    download(baseName() + '-' + (range ? 'zoom' : 'full') + '.csv', csv, 'text/csv;charset=utf-8');
    setStatus('CSV exported (' + (range ? 'current zoom window' : 'full data') +
      '). Raw values; text cells apostrophe-guarded against spreadsheet formulas.');
  }

  function downloadSVG() {
    if (!state.model) return;
    const svg = SL.renderSVGString(state.model, { width: VIEW_W, height: VIEW_H });
    download(baseName() + '-plot.svg', svg, 'image/svg+xml;charset=utf-8');
    setStatus('Standalone SVG exported.');
  }

  // -------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------

  els.file.addEventListener('change', function () {
    const f = els.file.files && els.file.files[0];
    if (!f) return;
    if (f.size > SL.LIMITS.MAX_BYTES) {
      showError('\u201c' + f.name + '\u201d is ' + SL.formatBytes(f.size) + '; the limit is ' +
        SL.formatBytes(SL.LIMITS.MAX_BYTES) + '. Trim or split the log before import.');
      els.file.value = '';
      return;
    }
    f.text().then(function (text) {
      els.file.value = '';
      loadText(text, f.name);
    }).catch(function (err) {
      els.file.value = '';
      showError('Could not read the file: ' + (err && err.message ? err.message : String(err)));
    });
  });

  els.loadPaste.addEventListener('click', function () {
    const text = els.paste.value;
    if (!text || text.trim() === '') {
      showError('Paste some CSV text first (header row + data rows).');
      return;
    }
    loadText(text, 'pasted-log');
  });

  els.example.addEventListener('click', function () {
    loadText(EXAMPLE_CSV, 'example-fictional-log');
    setStatus('Loaded the fictional example log — synthetic demo data, not from a real vehicle.');
  });

  els.delimiter.addEventListener('change', function () {
    state.forceDelimiter = els.delimiter.value;
    if (state.text) reparse();
  });

  els.timeColumn.addEventListener('change', function () {
    state.timeColumn = parseInt(els.timeColumn.value, 10) || 0;
    state.selectedColumns = state.selectedColumns.filter(function (i) { return i !== state.timeColumn; });
    if (state.parsed) buildMappingUI(SL.classifyColumns(state.parsed));
    rebuild();
  });

  els.sortByTime.addEventListener('change', function () {
    state.sortByTime = els.sortByTime.checked;
    rebuild();
  });

  els.zoomIn.addEventListener('click', function () { zoom(0.5, 0.5); });
  els.zoomOut.addEventListener('click', function () { zoom(2, 0.5); });
  els.zoomReset.addEventListener('click', function () {
    state.window = null;
    renderPlot();
  });

  els.annotAdd.addEventListener('click', addAnnotation);
  els.annotTime.addEventListener('keydown', function (e) { if (e.key === 'Enter') addAnnotation(); });
  els.annotLabel.addEventListener('keydown', function (e) { if (e.key === 'Enter') addAnnotation(); });

  els.downloadCsv.addEventListener('click', downloadCSV);
  els.downloadSvg.addEventListener('click', downloadSVG);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.model && state.window) {
      state.window = null;
      renderPlot();
    }
  });

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  placeholder('Load a CSV, paste text, or click \u201cLoad fictional example\u201d to see the plot.');
  setStatus('Ready. Everything runs locally in this page — no network calls.');
  updateZoomButtons();
})();
