'use strict';

/*
 * Sensor Log Studio — core.js
 *
 * Pure, dependency-free toolkit shared by the browser UI (app.js) and the
 * Node unit tests (tests/core.test.cjs). Works as a classic <script> in the
 * browser (exposes window.SensorLog) and as a CommonJS module in Node.
 *
 * Nothing here touches the network, storage, or the DOM. Every function is a
 * pure transform over strings/arrays so it can be unit-tested outside a
 * browser.
 *
 * Conventions
 *   - Fallible entry points return { ok:true, value } or
 *     { ok:false, error:{ code, message, ...details } }.
 *   - Missing or non-finite numeric samples are represented as null — never 0.
 *   - Lines that cannot be placed on the time axis are skipped (with a
 *     visible warning), not fabricated.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SensorLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.1.0';

  const LIMITS = Object.freeze({
    MAX_BYTES: 5 * 1024 * 1024,   // 5 MB CSV input bound
    MAX_ROWS: 50000,              // 50,000 data rows bound
    MAX_POINTS_PER_CHANNEL: 2000, // SVG point budget per channel after downsampling
    MAX_ERROR_DETAILS: 20         // how many skipped-row details we keep
  });

  // Accessible colors on a dark blue background. Colors are assigned by the
  // channel's position among the currently selected channels (selection order),
  // so they are not stable identities: deselecting an earlier channel shifts
  // the colors of the channels after it (newly selected channels are appended).
  const PALETTE = Object.freeze([
    '#6fb3ff', '#ffb454', '#7ee787', '#ff7b72', '#d2a8ff',
    '#63e6be', '#ffa8c5', '#e3b341', '#a5d6ff', '#f0883e'
  ]);

  const DELIMITERS = Object.freeze([',', ';', '\t']);
  const DELIMITER_NAMES = Object.freeze({ ',': 'comma', ';': 'semicolon', '\t': 'tab' });

  // -------------------------------------------------------------------------
  // tiny helpers
  // -------------------------------------------------------------------------

  function ok(value) {
    return { ok: true, value: value };
  }

  function fail(code, message, details) {
    const error = { code: code, message: message };
    if (details) Object.assign(error, details);
    return { ok: false, error: error };
  }

  function clamp01(v) {
    if (!(v >= 0)) return 0;
    if (v > 1) return 1;
    return v;
  }

  function clampNum(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function roundTo(v, sig) {
    const p = Number(v.toPrecision(sig || 12));
    return p === 0 ? 0 : p; // normalize -0
  }

  function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(str, 'utf8');
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c <= 0x7f) n += 1;
      else if (c <= 0x7ff) n += 2;
      else if (c <= 0xffff) n += 3;
      else n += 4;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // numbers
  // -------------------------------------------------------------------------

  const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

  /**
   * Strict finite-number parser. Returns null for empty cells, whitespace,
   * NaN/Infinity literals, hex, thousands separators, trailing units, etc.
   * Never coerces junk to 0.
   */
  function parseNumber(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s === '' || !NUMBER_RE.test(s)) return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }

  // -------------------------------------------------------------------------
  // CSV parsing
  // -------------------------------------------------------------------------

  function countOutsideQuotes(line, ch) {
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      const x = line[i];
      if (x === '"') {
        if (inQuotes && line[i + 1] === '"') { i++; continue; } // escaped ""
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && x === ch) count++;
    }
    return count;
  }

  /**
   * Detect the delimiter from the first few lines, ignoring characters inside
   * quoted fields. Ties prefer comma, then semicolon, then tab.
   */
  function detectDelimiter(text, sampleLines) {
    const clean = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const lines = clean.split(/\r\n|\n|\r/).slice(0, sampleLines || 5);
    const counts = {};
    for (const d of DELIMITERS) counts[d] = 0;
    for (const line of lines) {
      for (const d of DELIMITERS) counts[d] += countOutsideQuotes(line, d);
    }
    let best = null;
    let bestCount = 0;
    for (const d of DELIMITERS) {
      if (counts[d] > bestCount) { best = d; bestCount = counts[d]; }
    }
    return { delimiter: best || ',', found: best !== null, counts: counts };
  }

  /**
   * Tokenizer for RFC-4180-style CSV:
   *   - quotes only open a field at its start; "" is an escaped quote
   *   - embedded newlines inside quoted fields are preserved (normalized to \n)
   *   - CRLF / LF / CR line endings
   *   - returns rows as { line, cells }
   */
  function tokenizeCSV(text, delimiter) {
    const rows = [];
    let field = '';
    let cells = [];
    let line = 1;
    let rowLine = 1;
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        if (ch === '\r') {
          line++;
          if (text[i + 1] === '\n') i += 2; else i++;
          field += '\n';
          continue;
        }
        if (ch === '\n') { line++; i++; field += '\n'; continue; }
        field += ch; i++; continue;
      }

      if (ch === '"') {
        if (field === '') { inQuotes = true; i++; continue; }
        field += ch; i++; continue; // lenient: quotes mid-field are literal
      }
      if (ch === delimiter) { cells.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        cells.push(field);
        rows.push({ line: rowLine, cells: cells });
        field = '';
        cells = [];
        if (ch === '\r' && text[i + 1] === '\n') i += 2; else i++;
        line++;
        rowLine = line;
        continue;
      }
      field += ch; i++;
    }

    if (inQuotes) return { unterminated: true, line: rowLine };

    if (field !== '' || cells.length > 0) {
      cells.push(field);
      rows.push({ line: rowLine, cells: cells });
    }
    return { rows: rows };
  }

  /**
   * Parse CSV text into { headers, rows } where rows are data rows only.
   * Enforces the byte and row limits and rejects structurally malformed input
   * with actionable messages.
   */
  function parseCSV(text, options) {
    options = options || {};
    if (typeof text !== 'string') return fail('invalid_input', 'Input must be a string.');

    let src = text;
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // strip BOM

    const maxBytes = options.maxBytes || LIMITS.MAX_BYTES;
    const maxRows = options.maxRows || LIMITS.MAX_ROWS;
    const bytes = typeof options.bytes === 'number' ? options.bytes : utf8ByteLength(src);
    if (bytes > maxBytes) {
      return fail('too_large',
        'Input size is ' + formatBytes(bytes) + '; the limit is ' + formatBytes(maxBytes) +
        '. Trim or split the log before import.',
        { bytes: bytes, limitBytes: maxBytes });
    }
    if (src.trim() === '') return fail('empty_input', 'The input is empty.');

    if (options.delimiter !== undefined && options.delimiter !== null && options.delimiter !== '') {
      if (DELIMITERS.indexOf(options.delimiter) === -1) {
        return fail('invalid_option',
          'Unsupported delimiter ' + JSON.stringify(options.delimiter) +
          '. Use comma, semicolon or tab.');
      }
    }
    const delimiter = options.delimiter || detectDelimiter(src).delimiter;

    const tokenized = tokenizeCSV(src, delimiter);
    if (tokenized.unterminated) {
      return fail('unterminated_quote',
        'Unterminated quoted field — a double quote was opened near line ' +
        tokenized.line + ' and never closed. Check the quoted fields.',
        { line: tokenized.line });
    }

    const warnings = [];
    let blankLines = 0;
    const allRows = tokenized.rows.filter(function (r) {
      if (r.cells.length === 1 && r.cells[0].trim() === '') { blankLines++; return false; }
      return true;
    });
    if (blankLines > 0) warnings.push(blankLines + ' blank line(s) skipped.');
    if (allRows.length === 0) return fail('empty_input', 'No header row found.');

    const headerRow = allRows[0];
    const headers = headerRow.cells.map(function (h, idx) {
      const t = h.trim();
      return t === '' ? '(column ' + (idx + 1) + ')' : t;
    });

    const seen = {};
    for (const h of headers) seen[h] = (seen[h] || 0) + 1;
    for (const h in seen) {
      if (seen[h] > 1) warnings.push('Duplicate column name "' + h + '" appears ' + seen[h] + ' times.');
    }

    const dataRows = allRows.slice(1);
    if (dataRows.length === 0) return fail('no_data_rows', 'The file has a header row but no data rows.');
    if (dataRows.length > maxRows) {
      return fail('too_many_rows',
        'The input has ' + dataRows.length + ' data rows; the limit is ' + maxRows +
        ' rows. Split the log or trim it before import.',
        { rows: dataRows.length, limitRows: maxRows });
    }

    let raggedShort = 0;
    let trimmedTrailing = 0;
    for (const r of dataRows) {
      const cells = r.cells;
      while (cells.length > headers.length && cells[cells.length - 1] === '') {
        cells.pop();
        trimmedTrailing++;
      }
      if (cells.length > headers.length) {
        return fail('row_too_long',
          'Line ' + r.line + ' has ' + cells.length + ' fields but the header defines ' +
          headers.length + '. Check the delimiter or the quoted fields.',
          { line: r.line, fields: cells.length, headerFields: headers.length });
      }
      if (cells.length < headers.length) raggedShort++;
    }
    if (raggedShort > 0) warnings.push(raggedShort + ' row(s) have fewer fields than the header; missing cells are treated as empty.');
    if (trimmedTrailing > 0) warnings.push(trimmedTrailing + ' trailing empty field(s) beyond the header were ignored.');

    return ok({
      headers: headers,
      rows: dataRows,
      delimiter: delimiter,
      delimiterName: DELIMITER_NAMES[delimiter] || delimiter,
      dataRowCount: dataRows.length,
      totalBytes: bytes,
      warnings: warnings
    });
  }

  function cellAt(row, index) {
    const c = row.cells[index];
    return c === undefined ? '' : c;
  }

  // -------------------------------------------------------------------------
  // column classification & time-column suggestion
  // -------------------------------------------------------------------------

  /** Per-column numeric statistics used to build the channel picker. */
  function classifyColumns(parsed) {
    const out = [];
    for (let col = 0; col < parsed.headers.length; col++) {
      let numericCount = 0;
      let nonEmptyCount = 0;
      let unparsableCount = 0;
      let min = Infinity;
      let max = -Infinity;
      let inversions = 0;
      let prev = null;
      for (const row of parsed.rows) {
        const raw = cellAt(row, col);
        if (raw.trim() !== '') nonEmptyCount++;
        const v = parseNumber(raw);
        if (v === null) {
          if (raw.trim() !== '') unparsableCount++;
          continue;
        }
        numericCount++;
        if (v < min) min = v;
        if (v > max) max = v;
        if (prev !== null && v < prev) inversions++;
        prev = v;
      }
      out.push({
        index: col,
        name: parsed.headers[col],
        numericCount: numericCount,
        nonEmptyCount: nonEmptyCount,
        unparsableCount: unparsableCount,
        min: numericCount ? min : null,
        max: numericCount ? max : null,
        inversions: inversions
      });
    }
    return out;
  }

  /** Pick the most likely elapsed-time column, or -1 if there is none. */
  function suggestTimeColumn(parsed) {
    const cols = classifyColumns(parsed);
    let best = -1;
    let bestScore = -Infinity;
    for (const c of cols) {
      if (c.numericCount < 1) continue;
      const nameHint = /time|elapsed|stamp|sec|\bms\b|\bt\b/i.test(c.name) ? 2 : 0;
      const score = nameHint + (c.index === 0 ? 1 : 0) + (c.inversions === 0 ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = c.index; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // dataset construction
  // -------------------------------------------------------------------------

  /**
   * Build the aligned dataset: accepted rows (finite time), per-channel value
   * arrays with null for gaps, segment index lists (line breaks) and stats.
   *
   * options: { timeColumn=0, channelColumns=[all except time], sortByTime=false }
   */
  function buildDataset(parsed, options) {
    options = options || {};
    const headers = parsed.headers;
    const timeColumn = options.timeColumn == null ? 0 : options.timeColumn;
    if (!Number.isInteger(timeColumn) || timeColumn < 0 || timeColumn >= headers.length) {
      return fail('invalid_column', 'Time column index ' + timeColumn + ' is out of range.');
    }

    let channelColumns;
    if (options.channelColumns) {
      channelColumns = [];
      for (const c of options.channelColumns) {
        if (!Number.isInteger(c) || c < 0 || c >= headers.length) {
          return fail('invalid_column', 'Channel column index ' + c + ' is out of range.');
        }
        if (c !== timeColumn && channelColumns.indexOf(c) === -1) channelColumns.push(c);
      }
    } else {
      channelColumns = headers.map(function (_, i) { return i; })
        .filter(function (i) { return i !== timeColumn; });
    }

    const sortByTime = !!options.sortByTime;
    const accepted = [];
    const skipped = { count: 0, invalidTime: 0, details: [] };
    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      const t = parseNumber(cellAt(row, timeColumn));
      if (t === null) {
        skipped.count++;
        skipped.invalidTime++;
        if (skipped.details.length < LIMITS.MAX_ERROR_DETAILS) {
          skipped.details.push({ line: row.line, reason: 'invalid_time' });
        }
        continue;
      }
      accepted.push({ orig: i, line: row.line, t: t, cells: row.cells });
    }
    if (accepted.length === 0) {
      return fail('no_valid_rows',
        'No data row has a finite numeric value in the time column "' + headers[timeColumn] + '".');
    }

    let inversions = 0;
    let firstInversionLine = null;
    for (let i = 1; i < accepted.length; i++) {
      if (accepted[i].t < accepted[i - 1].t) {
        inversions++;
        if (firstInversionLine === null) firstInversionLine = accepted[i].line;
      }
    }

    // A skipped row (no usable time) leaves a hole in the file sequence, and
    // the trace must never be drawn across a hole. Compute one break per hole
    // in FILE order, carried on the sample that followed the hole, so that
    // sorting reorders the samples but keeps every skipped-row break: sorting
    // changes the drawing order, it never invents a sample at an unknown time.
    for (let i = 0; i < accepted.length; i++) {
      accepted[i].breakBefore = i === 0 ? false : accepted[i].orig !== accepted[i - 1].orig + 1;
    }

    const warnings = [];
    if (inversions > 0 && sortByTime) {
      accepted.sort(function (a, b) { return a.t - b.t; }); // stable in modern engines
      warnings.push(inversions + ' time inversion(s) found; samples sorted by time for plotting.');
    } else if (inversions > 0) {
      warnings.push('Time column is not monotonic: ' + inversions +
        ' inversion(s) (first at line ' + firstInversionLine +
        '). Samples are plotted in file order unless "Sort by time" is enabled.');
    }
    if (skipped.count > 0) {
      warnings.push(skipped.count + ' row(s) skipped: no numeric value in the time column.');
    }

    const gapBefore = accepted.map(function (a, i) {
      return i === 0 ? false : a.breakBefore;
    });

    // The break carrier can be the globally earliest sample: after the sort it
    // sits at index 0, where there is no preceding sample to break away from,
    // so the break would be masked and the trace would merge across the hole.
    // Transfer it onto the first free adjacency (index 1 when free, otherwise
    // scanning past breaks that other holes already own) so every skipped row
    // keeps one visible break and none collapse into a single one.
    if (accepted.length > 1 && accepted[0].breakBefore) {
      let k = 1;
      while (k < accepted.length && accepted[k].breakBefore) k++;
      if (k < accepted.length) gapBefore[k] = true;
    }

    const times = accepted.map(function (a) { return a.t; });
    const channels = channelColumns.map(function (col) {
      const values = [];
      let present = 0;
      let unparsable = 0;
      for (const a of accepted) {
        const raw = cellAt(a, col);
        const v = parseNumber(raw);
        if (v === null && raw.trim() !== '') unparsable++;
        if (v !== null) present++;
        values.push(v);
      }
      const segments = [];
      let start = -1;
      for (let k = 0; k < values.length; k++) {
        const has = values[k] !== null;
        if (start >= 0 && gapBefore[k]) { segments.push([start, k - 1]); start = -1; }
        if (has) { if (start < 0) start = k; }
        else if (start >= 0) { segments.push([start, k - 1]); start = -1; }
      }
      if (start >= 0) segments.push([start, values.length - 1]);
      return {
        column: col,
        name: headers[col],
        values: values,
        segments: segments,
        stats: computeStats(values),
        present: present,
        unparsable: unparsable
      };
    });

    return ok({
      headers: headers,
      timeColumn: timeColumn,
      timeName: headers[timeColumn],
      times: times,
      channels: channels,
      acceptedCount: accepted.length,
      skipped: skipped,
      inversions: inversions,
      firstInversionLine: firstInversionLine,
      sorted: sortByTime && inversions > 0,
      warnings: warnings
    });
  }

  /** count / min / max / mean over finite values, ignoring null gaps. */
  function computeStats(values) {
    let count = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of values) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      count++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (count === 0) return null;
    return { count: count, min: min, max: max, mean: sum / count };
  }

  // -------------------------------------------------------------------------
  // windows (zoom / pan) and axis ticks
  // -------------------------------------------------------------------------

  function fullWindow(times) {
    if (!Array.isArray(times) || times.length === 0) return null;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const t of times) {
      if (!Number.isFinite(t)) continue;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    if (!Number.isFinite(t0)) return null;
    return { t0: t0, t1: t1 };
  }

  /** Clamp a window into a domain; null when nothing overlaps. */
  function clampWindow(win, domain) {
    if (!win || !domain) return null;
    const t0 = Math.max(win.t0, domain.t0);
    const t1 = Math.min(win.t1, domain.t1);
    if (!(t1 > t0)) return null;
    return { t0: t0, t1: t1 };
  }

  /** Zoom around anchor01 (0..1 fraction of the current window). */
  function zoomWindow(win, factor, anchor01, domain, minSpan) {
    const fullSpan = domain.t1 - domain.t0;
    if (!(fullSpan > 0)) return { t0: domain.t0, t1: domain.t1 };
    const span = win.t1 - win.t0;
    const a01 = clamp01(anchor01 == null ? 0.5 : anchor01);
    const floorSpan = minSpan || Math.max(fullSpan * 1e-6, 1e-9);
    let ns = span * factor;
    if (ns >= fullSpan) return { t0: domain.t0, t1: domain.t1 };
    if (ns < floorSpan) ns = floorSpan;
    const a = win.t0 + a01 * span;
    let t0 = a - a01 * ns;
    let t1 = t0 + ns;
    if (t0 < domain.t0) { t0 = domain.t0; t1 = t0 + ns; }
    if (t1 > domain.t1) { t1 = domain.t1; t0 = t1 - ns; }
    if (t0 < domain.t0) t0 = domain.t0;
    return { t0: t0, t1: t1 };
  }

  /** Shift a window by delta; clamped so it never leaves the domain. */
  function panWindow(win, delta, domain) {
    const span = win.t1 - win.t0;
    let t0 = win.t0 + delta;
    let t1 = t0 + span;
    if (t0 < domain.t0) { t0 = domain.t0; t1 = t0 + span; }
    if (t1 > domain.t1) { t1 = domain.t1; t0 = t1 - span; }
    return { t0: t0, t1: t1 };
  }

  /** Round a raw step up to the next 1/2/5 * 10^k. */
  function niceStep(rawStep) {
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }

  /** Axis ticks with clean steps, all inside [min, max]. */
  function niceTicks(min, max, target) {
    target = target || 6;
    if (!(max > min)) return { ticks: [roundTo(min, 12)], step: 0 };
    const step = niceStep((max - min) / target);
    const ticks = [];
    const start = Math.ceil(min / step - 1e-9) * step;
    const tol = step * 1e-9 + Math.abs(max) * 1e-12;
    let v = start;
    let guard = 0;
    while (v <= max + tol && guard++ < 1000) {
      ticks.push(roundTo(v, 12));
      v += step;
    }
    if (ticks.length === 0) ticks.push(roundTo(min, 12));
    return { ticks: ticks, step: step };
  }

  /** Linear scale with map() and invert(); degenerate domains are guarded. */
  function makeScale(d0, d1, r0, r1) {
    const span = d1 - d0;
    const rspan = r1 - r0;
    return {
      map: function (v) {
        if (Math.abs(span) < 1e-300) return (r0 + r1) / 2;
        return r0 + ((v - d0) / span) * rspan;
      },
      invert: function (p) {
        if (Math.abs(rspan) < 1e-300) return (d0 + d1) / 2;
        return d0 + ((p - r0) / rspan) * span;
      }
    };
  }

  // -------------------------------------------------------------------------
  // downsampling (min/max envelope — keeps extrema, bounded point count)
  // -------------------------------------------------------------------------

  /**
   * Normalize a point budget to a safe finite integer. Undefined, null, NaN,
   * Infinity, zero and negative inputs fall back to the documented per-channel
   * limit, so a bad maxPoints can never remove the bound; fractions floor.
   */
  function normalizePointBudget(maxPoints) {
    const n = Math.floor(Number(maxPoints));
    if (!Number.isFinite(n) || n < 1) return LIMITS.MAX_POINTS_PER_CHANNEL;
    return n;
  }

  /**
   * Reduce points to at most maxPoints while keeping the series endpoints and,
   * when the budget allows, its global min and max. points: [{ t, v }] in
   * ascending index order. The result length never exceeds the requested
   * budget: 1 keeps the first sample, 2 keeps both endpoints, larger budgets
   * keep the endpoints plus a min/max envelope of the interior samples.
   */
  function downsamplePoints(points, maxPoints) {
    const src = Array.isArray(points) ? points : [];
    const limit = normalizePointBudget(maxPoints);
    const n = src.length;
    if (n <= limit) return { points: src, downsampled: false };
    if (limit === 1) return { points: [src[0]], downsampled: true };
    if (limit === 2) return { points: [src[0], src[n - 1]], downsampled: true };

    const keep = new Set();
    keep.add(0);
    keep.add(n - 1);

    // Interior extremes and the mean (ties prefer the sample farther from it).
    let minI = 0;
    let maxI = 0;
    let sum = 0;
    for (let i = 1; i < n; i++) {
      if (src[i].v < src[minI].v) minI = i;
      if (src[i].v > src[maxI].v) maxI = i;
      sum += src[i].v;
    }
    sum += src[0].v;
    const mean = sum / n;

    const slots = limit - 2; // interior samples this budget can still afford
    const reserved = [];
    if (minI > 0 && minI < n - 1) reserved.push(minI);
    if (maxI > 0 && maxI < n - 1 && maxI !== minI) reserved.push(maxI);
    if (reserved.length > slots) {
      reserved.sort(function (a, b) {
        return Math.abs(src[b].v - mean) - Math.abs(src[a].v - mean);
      });
      reserved.length = slots;
    }
    for (const idx of reserved) keep.add(idx);

    let fill = slots - reserved.length;
    if (fill > 0) {
      const lo = 1;
      const interior = n - 2; // >= 2 because n > limit >= 3
      const buckets = Math.max(1, Math.ceil(slots / 2));
      for (let b = 0; b < buckets && fill > 0; b++) {
        const i0 = lo + Math.floor((b * interior) / buckets);
        const i1 = lo + Math.floor(((b + 1) * interior) / buckets);
        if (i1 <= i0) continue;
        let bMin = i0;
        let bMax = i0;
        for (let k = i0 + 1; k < i1; k++) {
          if (src[k].v < src[bMin].v) bMin = k;
          if (src[k].v > src[bMax].v) bMax = k;
        }
        const emit = bMin === bMax ? [bMin] : (bMin < bMax ? [bMin, bMax] : [bMax, bMin]);
        for (const idx of emit) {
          if (keep.has(idx)) continue;
          keep.add(idx);
          fill--;
          if (fill <= 0) break;
        }
      }
    }

    const out = Array.from(keep).sort(function (a, b) { return a - b; })
      .map(function (i) { return src[i]; });
    return { points: out, downsampled: true };
  }

  /**
   * One representative sample of a segment: the extreme (min or max) farther
   * from the segment's mean; ties prefer the minimum. Deterministic.
   */
  function representativePoint(seg) {
    if (seg.length <= 1) return seg[0];
    let minI = 0;
    let maxI = 0;
    let sum = 0;
    for (let i = 0; i < seg.length; i++) {
      const v = seg[i].v;
      sum += v;
      if (v < seg[minI].v) minI = i;
      if (v > seg[maxI].v) maxI = i;
    }
    const mean = sum / seg.length;
    return Math.abs(seg[maxI].v - mean) > Math.abs(seg[minI].v - mean) ? seg[maxI] : seg[minI];
  }

  /**
   * `count` distinct ascending indices in [0, n-1], spread evenly across the
   * range and including 0 and n-1 when count >= 2 (count must be <= n).
   */
  function evenIndices(count, n) {
    const out = [];
    if (count <= 0 || n <= 0) return out;
    if (count === 1) { out.push(Math.floor((n - 1) / 2)); return out; }
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i * (n - 1)) / (count - 1));
      if (out.length === 0 || out[out.length - 1] !== idx) out.push(idx);
    }
    return out;
  }

  /**
   * Split one channel's visible points across its segments so that the drawn
   * total never exceeds maxPoints. Every drawn path stays inside its own
   * segment (missing data is never bridged), time order is kept and the
   * selection is deterministic:
   *   - more segments than budget: one sample for maxPoints evenly spread
   *     segments, always including the segments holding the global min/max
   *     (a budget of 1 keeps the extreme farther from the mean);
   *   - segments within budget: every segment keeps at least one sample and
   *     the rest of the budget is shared proportionally to segment length
   *     (largest remainder), each segment reduced by its min/max envelope.
   */
  function budgetPaths(segPoints, maxPoints) {
    const S = segPoints.length;
    const out = [];

    // Channel-wide extremes and mean, in one pass over the visible points.
    let gMinSeg = 0;
    let gMinIdx = 0;
    let gMinV = Infinity;
    let gMaxSeg = 0;
    let gMaxIdx = 0;
    let gMaxV = -Infinity;
    let sum = 0;
    let count = 0;
    for (let s = 0; s < S; s++) {
      const seg = segPoints[s];
      for (let i = 0; i < seg.length; i++) {
        const v = seg[i].v;
        sum += v;
        count++;
        if (v < gMinV) { gMinV = v; gMinSeg = s; gMinIdx = i; }
        if (v > gMaxV) { gMaxV = v; gMaxSeg = s; gMaxIdx = i; }
      }
    }
    const mean = sum / count;

    if (S > maxPoints) {
      // More segments than budget: one sample each for up to maxPoints
      // segments, spread across the range, plus the global min/max samples.
      const chosen = new Map();
      if (gMinSeg === gMaxSeg) {
        const seg = segPoints[gMinSeg];
        chosen.set(gMinSeg, Math.abs(gMaxV - mean) > Math.abs(gMinV - mean) ? seg[gMaxIdx] : seg[gMinIdx]);
      } else {
        chosen.set(gMinSeg, segPoints[gMinSeg][gMinIdx]);
        chosen.set(gMaxSeg, segPoints[gMaxSeg][gMaxIdx]);
      }
      if (chosen.size > maxPoints) { // budget of 1: keep the farther extreme
        const segIdx = Math.abs(gMaxV - mean) > Math.abs(gMinV - mean) ? gMaxSeg : gMinSeg;
        const idx = segIdx === gMaxSeg ? gMaxIdx : gMinIdx;
        chosen.clear();
        chosen.set(segIdx, segPoints[segIdx][idx]);
      }
      const remaining = maxPoints - chosen.size;
      if (remaining > 0) {
        for (const idx of evenIndices(remaining, S)) {
          if (!chosen.has(idx)) chosen.set(idx, representativePoint(segPoints[idx]));
        }
      }
      for (let s = 0; s < S; s++) {
        if (chosen.has(s)) out.push([chosen.get(s)]);
      }
      return out;
    }

    // Segments fit inside the budget: at least one sample per segment, the
    // rest shared proportionally to length, leftover by largest remainder.
    const d = new Array(S);
    const extras = maxPoints - S;
    let assigned = 0;
    const remainders = [];
    for (let s = 0; s < S; s++) {
      const len = segPoints[s].length;
      d[s] = 1;
      if (extras > 0) {
        const share = (extras * len) / count;
        const base = Math.min(len - 1, Math.floor(share));
        d[s] = 1 + base;
        assigned += base;
        remainders.push({ s: s, rem: share - Math.floor(share) });
      }
    }
    let left = extras - assigned;
    if (left > 0) {
      remainders.sort(function (a, b) { return (b.rem - a.rem) || (a.s - b.s); });
      for (const item of remainders) {
        if (left <= 0) break;
        if (d[item.s] < segPoints[item.s].length) { d[item.s]++; left--; }
      }
    }
    for (let s = 0; s < S; s++) {
      const seg = segPoints[s];
      if (d[s] >= seg.length) out.push(seg);
      else if (d[s] === 1) out.push([representativePoint(seg)]);
      else out.push(downsamplePoints(seg, d[s]).points);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // plot model
  // -------------------------------------------------------------------------

  /**
   * Build the render-agnostic plot model: domains, ticks, per-channel paths
   * (one array of points per visible sub-segment, so gaps stay gaps),
   * annotations and honesty metadata (drawn vs available, downsampled, gaps).
   */
  function buildPlotModel(dataset, options) {
    options = options || {};
    if (!dataset || !Array.isArray(dataset.times) || dataset.times.length === 0) {
      return fail('no_data', 'No usable data rows.');
    }
    const maxPoints = normalizePointBudget(options.maxPoints);
    const scales = options.scales || {};
    const selected = options.selectedColumns
      ? options.selectedColumns.slice()
      : dataset.channels.map(function (c) { return c.column; });
    const anySelected = dataset.channels.some(function (c) { return selected.indexOf(c.column) !== -1; });
    if (!anySelected) return fail('no_channels', 'Select at least one numeric channel to plot.');

    const rawFull = fullWindow(dataset.times);
    let ft0 = rawFull.t0;
    let ft1 = rawFull.t1;
    let paddedTime = false;
    if (ft1 === ft0) { ft0 -= 0.5; ft1 += 0.5; paddedTime = true; }

    let win = { t0: ft0, t1: ft1 };
    if (options.window) {
      const clamped = clampWindow(options.window, { t0: ft0, t1: ft1 });
      if (!clamped) return fail('empty_window', 'The zoom window contains no samples. Reset the zoom.');
      win = clamped;
    }

    const series = [];
    let yMin = Infinity;
    let yMax = -Infinity;
    let drawnTotal = 0;
    let availableTotal = 0;
    let gapCount = 0;
    let anyDownsampled = false;

    dataset.channels.forEach(function (ch, ci) {
      if (selected.indexOf(ch.column) === -1) return;
      let scale = Number(scales[ch.column]);
      if (!Number.isFinite(scale) || scale === 0) scale = 1;

      const segPoints = [];
      let available = 0;
      let cMin = Infinity;
      let cMax = -Infinity;
      for (const seg of ch.segments) {
        const arr = [];
        for (let k = seg[0]; k <= seg[1]; k++) {
          const t = dataset.times[k];
          if (t < win.t0 || t > win.t1) continue;
          const v = ch.values[k];
          if (v === null || v === undefined) continue;
          const sv = v * scale;
          arr.push({ t: t, v: sv });
          if (sv < cMin) cMin = sv;
          if (sv > cMax) cMax = sv;
        }
        if (arr.length > 0) { segPoints.push(arr); available += arr.length; }
      }

      let paths;
      let down = false;
      if (available === 0) {
        paths = [];
      } else if (available <= maxPoints) {
        paths = segPoints;
      } else {
        down = true;
        paths = budgetPaths(segPoints, maxPoints);
      }

      let drawn = 0;
      for (const p of paths) drawn += p.length;
      gapCount += Math.max(0, segPoints.length - 1);
      if (available > 0) {
        if (cMin < yMin) yMin = cMin;
        if (cMax > yMax) yMax = cMax;
      }
      drawnTotal += drawn;
      availableTotal += available;
      anyDownsampled = anyDownsampled || down;

      series.push({
        column: ch.column,
        name: ch.name,
        color: PALETTE[ci % PALETTE.length], // by selected-position; not a stable identity (see PALETTE note)
        scale: scale,
        paths: paths,
        stats: ch.stats,
        drawn: drawn,
        available: available,
        downsampled: down
      });
    });

    if (availableTotal === 0) {
      return fail('no_points', 'No samples in the selected channels within this range. Widen the zoom or pick other channels.');
    }

    let span = yMax - yMin;
    if (span === 0) {
      const pad = Math.abs(yMax) * 0.1 || 1;
      yMin -= pad;
      yMax += pad;
    } else {
      const pad = span * 0.05;
      yMin -= pad;
      yMax += pad;
    }

    const xTicks = niceTicks(win.t0, win.t1, 6);
    const yTicks = niceTicks(yMin, yMax, 5);
    const annotations = (options.annotations || [])
      .filter(function (a) { return a && Number.isFinite(a.t) && a.t >= win.t0 && a.t <= win.t1; })
      .map(function (a) { return { t: a.t, label: String(a.label == null ? '' : a.label) }; });

    return ok({
      title: options.title || 'Sensor log',
      x: { min: win.t0, max: win.t1, ticks: xTicks.ticks, step: xTicks.step, title: dataset.timeName },
      y: { min: yMin, max: yMax, ticks: yTicks.ticks, step: yTicks.step, title: 'value (scaled per legend)' },
      series: series,
      annotations: annotations,
      meta: {
        window: { t0: win.t0, t1: win.t1 },
        full: { t0: ft0, t1: ft1 },
        paddedTime: paddedTime,
        drawnTotal: drawnTotal,
        availableTotal: availableTotal,
        downsampled: anyDownsampled,
        gapCount: gapCount
      }
    });
  }

  // -------------------------------------------------------------------------
  // SVG rendering (string builder — the only place user strings appear in
  // markup, always escaped via escapeXML)
  // -------------------------------------------------------------------------

  function escapeXML(s) {
    const str = String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // C0 controls — invalid XML 1.0 characters
      .replace(/[\uD800-\uDFFF]/gu, '')                          // lone surrogates — invalid XML 1.0 characters
      .replace(/\p{Noncharacter_Code_Point}/gu, '');             // noncharacters (U+FFFE/FFFF, U+FDD0–FDEF, plane ends) — invalid XML
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function truncate(s, max) {
    const str = String(s == null ? '' : s);
    if (str.length <= max) return str;
    return str.slice(0, Math.max(0, max - 1)) + '\u2026';
  }

  function formatNumber(v) {
    if (!Number.isFinite(v)) return '';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e7 || a < 1e-4) {
      return v.toExponential(3).replace(/\.?0+e/, 'e');
    }
    return String(Number(v.toPrecision(7)));
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function sanitizeFilename(name, fallback) {
    let s = String(name == null ? '' : name).trim();
    s = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').replace(/-+$/, '');
    if (s === '') s = fallback || 'sensor-log';
    return s.slice(0, 80);
  }

  function round1(v) {
    const r = Math.round(v * 10) / 10;
    return r === 0 ? 0 : r;
  }

  function textEl(x, y, str, attrs) {
    let a = '';
    if (attrs) {
      for (const k in attrs) a += ' ' + k + '="' + escapeXML(String(attrs[k])) + '"';
    }
    return '<text x="' + round1(x) + '" y="' + round1(y) + '"' + a + '>' + escapeXML(str) + '</text>';
  }

  function layoutLegend(model, width, l, r) {
    const maxX = width - r;
    const charW = 6.6;
    const rows = [];
    let row = [];
    let x = l;
    for (const s of model.series) {
      const label = truncate(s.name, 26) +
        (s.scale !== 1 ? ' \u00d7' + formatNumber(s.scale) : '') +
        ' (' + s.drawn + ')';
      const w = 12 + 4 + label.length * charW + 16;
      if (x + w > maxX && row.length > 0) { rows.push(row); row = []; x = l; }
      row.push({ x: x, color: s.color, label: label, fullName: s.name });
      x += w;
    }
    if (row.length > 0) rows.push(row);
    if (rows.length > 4) {
      const kept = rows.slice(0, 4);
      const shown = kept.reduce(function (n, r2) { return n + r2.length; }, 0);
      if (model.series.length > shown) {
        kept[3].push({ x: l, color: null, label: '+' + (model.series.length - shown) + ' more', fullName: '' });
      }
      return { rows: kept };
    }
    return { rows: rows };
  }

  /** Shared geometry for the on-screen SVG and hit-testing in app.js. */
  function svgLayout(model, options) {
    options = options || {};
    const width = options.width || 960;
    const height = options.height || 460;
    const l = options.marginLeft || 78;
    const r = 20;
    const b = 58;
    const legend = layoutLegend(model, width, l, r);
    const legendTop = 64;
    const t = legendTop + legend.rows.length * 18 + 4;
    const w = Math.max(60, width - l - r);
    const h = Math.max(60, height - t - b);
    return {
      width: width,
      height: height,
      margin: { l: l, r: r, t: t, b: b },
      plot: { x: l, y: t, w: w, h: h },
      legendTop: legendTop,
      legendRows: legend.rows
    };
  }

  function describeModel(model) {
    const parts = [];
    parts.push(model.title + '. Line chart. X axis: ' + model.x.title +
      ' from ' + formatNumber(model.x.min) + ' to ' + formatNumber(model.x.max) + '.');
    for (const s of model.series) {
      if (s.stats && s.stats.count > 0) {
        parts.push(s.name + ': min ' + formatNumber(s.stats.min) +
          ', max ' + formatNumber(s.stats.max) +
          ', mean ' + formatNumber(s.stats.mean) +
          ', showing ' + s.drawn + ' of ' + s.available + ' samples.');
      } else {
        parts.push(s.name + ': no samples in range.');
      }
    }
    return parts.join(' ');
  }

  function subtitleFor(model) {
    const m = model.meta;
    let s = model.series.length + ' channel(s) \u00b7 showing ' + m.drawnTotal + ' of ' + m.availableTotal + ' samples';
    if (m.downsampled) s += ' \u00b7 downsampled (min/max kept)';
    s += ' \u00b7 window ' + formatNumber(m.window.t0) + ' \u2013 ' + formatNumber(m.window.t1);
    return s;
  }

  function footerFor(model) {
    const m = model.meta;
    const bits = [];
    if (m.gapCount > 0) bits.push(m.gapCount + ' gap(s) \u2014 missing samples are not interpolated');
    else bits.push('no gaps in range');
    if (m.paddedTime) bits.push('all timestamps identical \u2014 X axis padded');
    return bits.join(' \u00b7 ');
  }

  /**
   * Render a standalone SVG string for the plot model. All user-derived text
   * (channel names, annotation labels, title) is XML-escaped.
   */
  function renderSVGString(model, options) {
    options = options || {};
    const W = options.width || 960;
    const H = options.height || 460;
    const lay = svgLayout(model, options);
    const plot = lay.plot;
    const sx = makeScale(model.x.min, model.x.max, plot.x, plot.x + plot.w);
    const sy = makeScale(model.y.min, model.y.max, plot.y + plot.h, plot.y);

    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H +
      '" width="100%" role="img" class="sl-svg" font-family="system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">');
    parts.push('<title>' + escapeXML(model.title) + '</title>');
    parts.push('<desc>' + escapeXML(describeModel(model)) + '</desc>');
    parts.push('<rect class="sl-bg" x="0" y="0" width="' + W + '" height="' + H + '" fill="#0b1c33"/>');

    parts.push(textEl(plot.x, 24, model.title, { fill: '#e6f0ff', 'font-size': 16, 'font-weight': 600 }));
    parts.push(textEl(plot.x, 41, subtitleFor(model), { fill: '#8fb0d6', 'font-size': 11.5 }));

    // legend (swatch + truncated name; full name in a nested <title> for tooltip)
    for (let rIdx = 0; rIdx < lay.legendRows.length; rIdx++) {
      const y = lay.legendTop + rIdx * 18;
      for (const e of lay.legendRows[rIdx]) {
        if (e.color) parts.push('<rect x="' + round1(e.x) + '" y="' + round1(y - 9) + '" width="10" height="10" rx="2" fill="' + e.color + '"/>');
        let inner = '';
        if (e.fullName) inner += '<title>' + escapeXML(e.fullName) + '</title>';
        inner += escapeXML(e.label);
        parts.push('<text x="' + round1(e.x + 15) + '" y="' + round1(y) + '" fill="#cfe3ff" font-size="11.5">' + inner + '</text>');
      }
    }

    parts.push('<rect x="' + round1(plot.x) + '" y="' + round1(plot.y) + '" width="' + round1(plot.w) +
      '" height="' + round1(plot.h) + '" fill="#0a1a2e" stroke="#2c4f77"/>');

    // y grid + labels
    for (const ty of model.y.ticks) {
      const y = sy.map(ty);
      parts.push('<line x1="' + round1(plot.x) + '" y1="' + round1(y) + '" x2="' + round1(plot.x + plot.w) +
        '" y2="' + round1(y) + '" stroke="#22405e" stroke-dasharray="3 4"/>');
      parts.push(textEl(plot.x - 8, y + 3.5, formatNumber(ty), { fill: '#9db8d9', 'font-size': 11, 'text-anchor': 'end' }));
    }
    // x grid + labels
    for (const tx of model.x.ticks) {
      const x = sx.map(tx);
      parts.push('<line x1="' + round1(x) + '" y1="' + round1(plot.y) + '" x2="' + round1(x) +
        '" y2="' + round1(plot.y + plot.h) + '" stroke="#22405e" stroke-dasharray="3 4"/>');
      parts.push(textEl(x, plot.y + plot.h + 16, formatNumber(tx), { fill: '#9db8d9', 'font-size': 11, 'text-anchor': 'middle' }));
    }

    // axis titles — explicit about units/scaling
    parts.push(textEl(plot.x + plot.w / 2, plot.y + plot.h + 40,
      model.x.title + ' \u2014 elapsed time (units as in file)',
      { fill: '#cfe3ff', 'font-size': 12, 'text-anchor': 'middle' }));
    const cy = plot.y + plot.h / 2;
    parts.push('<text x="16" y="' + round1(cy) + '" transform="rotate(-90 16 ' + round1(cy) +
      ')" text-anchor="middle" fill="#cfe3ff" font-size="12">' + escapeXML(model.y.title) + '</text>');

    // series
    for (const s of model.series) {
      for (const pathPts of s.paths) {
        if (pathPts.length === 0) continue;
        if (pathPts.length === 1) {
          const p0 = pathPts[0];
          parts.push('<circle cx="' + round1(sx.map(p0.t)) + '" cy="' + round1(sy.map(p0.v)) + '" r="2.6" fill="' + s.color + '"/>');
          continue;
        }
        let d = '';
        for (let i = 0; i < pathPts.length; i++) {
          d += (i === 0 ? 'M' : 'L') + round1(sx.map(pathPts[i].t)) + ',' + round1(sy.map(pathPts[i].v));
        }
        parts.push('<path d="' + d + '" fill="none" stroke="' + s.color +
          '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>');
        if (s.drawn <= 150) {
          for (const p0 of pathPts) {
            parts.push('<circle cx="' + round1(sx.map(p0.t)) + '" cy="' + round1(sy.map(p0.v)) + '" r="2.2" fill="' + s.color + '"/>');
          }
        }
      }
    }

    // annotations (staggered labels to reduce overlap)
    let rowN = 0;
    let lastX = -1e9;
    for (const a of model.annotations) {
      const x = clampNum(sx.map(a.t), plot.x, plot.x + plot.w);
      if (x - lastX < 70) rowN = (rowN + 1) % 3;
      else rowN = 0;
      lastX = x;
      parts.push('<line x1="' + round1(x) + '" y1="' + round1(plot.y) + '" x2="' + round1(x) +
        '" y2="' + round1(plot.y + plot.h) + '" stroke="#ffcf7a" stroke-dasharray="4 3" opacity="0.85"/>');
      parts.push(textEl(Math.min(x + 4, plot.x + plot.w - 8), plot.y + 14 + rowN * 14,
        a.label || 'annotation',
        { fill: '#ffdf9e', 'font-size': 11, 'text-anchor': x > plot.x + plot.w - 90 ? 'end' : 'start' }));
    }

    // footer
    parts.push(textEl(plot.x, H - 12, footerFor(model), { fill: '#7f9cc0', 'font-size': 10.5 }));
    parts.push(textEl(W - lay.margin.r, H - 12, 'Sensor Log Studio \u2014 offline, no network',
      { fill: '#7f9cc0', 'font-size': 10.5, 'text-anchor': 'end' }));

    parts.push('</svg>');
    return parts.join('');
  }

  // -------------------------------------------------------------------------
  // CSV export
  // -------------------------------------------------------------------------

  /**
   * Prefix spreadsheet-formula-looking text cells with an apostrophe so
   * imported CSVs cannot execute formulas (CSV injection guard). Plain
   * negative numbers are left untouched.
   */
  function guardFormula(value) {
    const s = String(value == null ? '' : value);
    if (s === '') return s;
    const c = s[0];
    if (c === '=' || c === '+' || c === '@' || c === '\t' || c === '\r') return "'" + s;
    if (c === '-' && !NUMBER_RE.test(s)) return "'" + s;
    return s;
  }

  function csvCell(cell, delimiter) {
    const s = String(cell);
    if (s.indexOf('"') !== -1 || s.indexOf(delimiter) !== -1 ||
        s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Export the dataset as CSV: time column + chosen channels, rows filtered
   * by an optional time range. Missing samples are empty cells (never 0).
   */
  function exportCSV(dataset, options) {
    options = options || {};
    const delimiter = options.delimiter || ',';
    const newline = options.newline || '\r\n';
    const guard = options.guardFormulas !== false;
    const range = options.range || null;
    const cols = options.channelColumns
      ? dataset.channels.filter(function (c) { return options.channelColumns.indexOf(c.column) !== -1; })
      : dataset.channels;

    const out = [];
    const header = [dataset.timeName].concat(cols.map(function (c) { return c.name; }));
    out.push(header.map(function (h) {
      return csvCell(guard ? guardFormula(h) : String(h), delimiter);
    }).join(delimiter));

    for (let i = 0; i < dataset.times.length; i++) {
      const t = dataset.times[i];
      if (range && (t < range.t0 || t > range.t1)) continue;
      const cells = [String(t)];
      for (const c of cols) {
        const v = c.values[i];
        cells.push(v === null || v === undefined ? '' : String(v));
      }
      out.push(cells.map(function (cell) { return csvCell(cell, delimiter); }).join(delimiter));
    }
    return out.join(newline) + newline;
  }

  // -------------------------------------------------------------------------
  // fictional example log
  // -------------------------------------------------------------------------

  /*
   * Synthetic warm-up curve written for this tool — not from a real vehicle.
   * Shared by the UI's "Load fictional example" button and the regression
   * tests so both pin the exact same fixture. It exercises: semicolon
   * delimiter, a multi-row sensor-bus dropout (empty cells => gaps, no
   * interpolation), one non-numeric cell ("n/a") and one row with an
   * unparsable time ("--") that gets skipped.
   */
  const EXAMPLE_CSV = [
    'time_s;RPM;Coolant_C;TPS_pct;MAP_kPa;Lambda',
    '0.0;760;17.5;4.0;30;1.00',
    '0.5;860;17.8;5.5;33;0.99',
    '1.0;1040;18.2;8.0;38;0.98',
    '1.5;1320;18.6;12.5;46;0.96',
    '2.0;1650;19.0;18.0;58;0.94',
    '2.5;1980;19.4;24.5;72;0.92',
    '3.0;2320;19.9;32.0;88;0.90',
    '3.5;2640;20.4;41.5;96;0.88',
    '4.0;2950;20.9;52.0;101;0.86',
    '4.5;3180;21.4;63.5;104;0.85',
    '5.0;3310;21.9;74.0;102;0.84',
    '5.5;3360;22.4;82.5;99;0.84',
    '6.0;3380;22.9;88.0;97;0.83',
    '6.5;3390;23.4;90.5;96;0.83',
    '7.0;3400;23.9;91.0;96;0.83',
    '7.5;3410;24.4;91.5;95;0.83',
    '8.0;3420;24.9;92.0;95;0.83',
    '8.5;3430;25.3;93.0;95;0.83',
    '9.0;3440;25.8;94.0;94;0.83',
    '9.5;3450;26.2;95.0;94;0.83',
    '10.0;3460;26.6;95.5;94;0.83',
    '10.5;3465;27.0;95.0;94;0.83',
    '11.0;3460;27.4;94.0;94;0.83',
    '11.5;3450;27.8;92.5;93;0.83',
    '12.0;;28.2;;;',
    '12.5;;28.6;;;',
    '13.0;;29.0;;;',
    '13.5;;29.3;;;',
    '14.0;3440;29.6;90.0;92;0.83',
    '14.5;3470;30.0;93.0;93;0.83',
    '15.0;3520;30.4;97.0;94;0.84',
    '15.5;3600;30.8;99.0;n/a;0.85',
    '16.0;3710;31.2;99.5;99;0.87',
    '16.5;3850;31.6;99.5;103;0.89',
    '17.0;3980;32.1;99.5;107;0.91',
    '17.5;4100;32.5;99.5;111;0.93',
    '18.0;4220;32.9;99.5;114;0.95',
    '18.5;4350;33.3;99.5;117;0.97',
    '19.0;4480;33.8;99.5;119;0.99',
    '--;4590;34.2;99.5;121;1.00',
    '20.0;4620;34.6;97.0;120;1.00',
    '20.5;4400;35.0;90.0;117;0.99',
    '21.0;4100;35.4;80.0;112;0.97',
    '21.5;3800;35.8;70.0;107;0.95',
    '22.0;3500;36.2;60.0;102;0.93',
    '22.5;3200;36.5;50.0;97;0.91',
    '23.0;2900;36.9;40.0;92;0.90',
    '23.5;2600;37.2;30.0;84;0.90',
    '24.0;2300;37.5;20.0;76;0.92',
    '24.5;2000;37.8;12.0;66;0.95',
    '25.0;1700;38.0;8.0;56;0.98',
    '25.5;1400;38.2;5.0;48;1.00',
    '26.0;1100;38.4;3.0;40;1.02',
    '26.5;900;38.6;2.0;35;1.03',
    '27.0;820;38.7;1.5;33;1.04'
  ].join('\n') + '\n';

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  return {
    VERSION: VERSION,
    LIMITS: LIMITS,
    PALETTE: PALETTE,
    DELIMITERS: DELIMITERS,
    DELIMITER_NAMES: DELIMITER_NAMES,
    EXAMPLE_CSV: EXAMPLE_CSV,

    parseNumber: parseNumber,
    detectDelimiter: detectDelimiter,
    parseCSV: parseCSV,
    classifyColumns: classifyColumns,
    suggestTimeColumn: suggestTimeColumn,
    buildDataset: buildDataset,
    computeStats: computeStats,

    fullWindow: fullWindow,
    clampWindow: clampWindow,
    zoomWindow: zoomWindow,
    panWindow: panWindow,
    niceTicks: niceTicks,
    makeScale: makeScale,
    downsamplePoints: downsamplePoints,

    buildPlotModel: buildPlotModel,
    svgLayout: svgLayout,
    renderSVGString: renderSVGString,

    exportCSV: exportCSV,
    guardFormula: guardFormula,

    escapeXML: escapeXML,
    formatNumber: formatNumber,
    formatBytes: formatBytes,
    truncate: truncate,
    sanitizeFilename: sanitizeFilename
  };
});
