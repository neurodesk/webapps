// Output files of a run: CSV tables and SVG plots. Pure, so Node tests check them.

const SVG_NS = 'http://www.w3.org/2000/svg';

function number(value, digits = 7) {
  if (value === null || value === undefined) return '';
  if (Number.isNaN(value)) return 'NaN';
  return String(Number(value.toPrecision(digits)));
}

/** Output name stem from the input movie's name. */
export function outputStem(name) {
  return String(name || 'movie').replace(/\.(ome\.)?tiff?$/i, '').replace(/[^\w.-]+/g, '_') || 'movie';
}

/**
 * Per-frame shifts: the rigid [dy, dx] applied to register each frame and, for a
 * piecewise-rigid run, the shift of every patch (row r, column c of the patch grid).
 */
export function shiftsCsv({ shifts, patches, grid }, frameRate) {
  const header = ['frame', 'time_s', 'shift_y_px', 'shift_x_px'];
  const patchNames = [];
  if (patches && grid) {
    grid.ys.forEach((_, r) => grid.xs.forEach((_, c) => patchNames.push(`patch_r${r + 1}_c${c + 1}`)));
    for (const name of patchNames) header.push(`${name}_y_px`, `${name}_x_px`);
  }
  const rows = shifts.map(([dy, dx], f) => {
    const row = [f + 1, number(f / frameRate), number(dy, 6), number(dx, 6)];
    if (patches && grid) for (const [py, px] of patches[f]) row.push(number(py, 6), number(px, 6));
    return row.join(',');
  });
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

/** Reads the rigid columns back from shiftsCsv (used by tests and automation checks). */
export function parseShiftsCsv(text) {
  const [header, ...lines] = text.trim().split('\n');
  const columns = header.split(',');
  const y = columns.indexOf('shift_y_px');
  const x = columns.indexOf('shift_x_px');
  return lines.map((line) => {
    const cells = line.split(',');
    return [Number(cells[y]), Number(cells[x])];
  });
}

/** One row per frame; per ROI: F, neuropil, corrected F, ΔF/F and, when run, denoised calcium and spikes. */
export function tracesCsv(cells, frames, frameRate) {
  const header = ['frame', 'time_s'];
  for (const cell of cells) {
    const k = `roi${cell.id}`;
    header.push(`${k}_F`, `${k}_Fneu`, `${k}_Fcorrected`, `${k}_dFF`);
    if (cell.deconvolution) header.push(`${k}_denoised`, `${k}_spikes`);
  }
  const rows = [];
  for (let t = 0; t < frames; t++) {
    const row = [t + 1, number(t / frameRate)];
    for (const cell of cells) {
      row.push(number(cell.F[t]), number(cell.Fneu[t]), number(cell.corrected[t]), number(cell.dff[t]));
      if (cell.deconvolution) row.push(number(cell.deconvolution.c[t] + cell.deconvolution.baseline), number(cell.deconvolution.s[t]));
    }
    rows.push(row.join(','));
  }
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

/** One row per ROI: geometry, neuropil size, ΔF/F validity and the deconvolution parameters. */
export function roisCsv(cells) {
  const header = ['roi', 'area_px', 'centroid_y_px', 'centroid_x_px', 'neuropil_px', 'undefined_dff_samples', 'ar1_g', 'noise_sd_dff', 'baseline_dff', 'lambda', 'spike_sum'];
  const rows = cells.map((cell) => {
    const d = cell.deconvolution;
    const spikes = d ? d.s.reduce((sum, value) => sum + value, 0) : null;
    return [
      cell.id,
      cell.area,
      number(cell.centroid[0], 5),
      number(cell.centroid[1], 5),
      cell.neuropilPixels,
      cell.undefinedSamples,
      d ? number(d.g, 6) : '',
      d ? number(d.sn, 6) : '',
      d ? number(d.baseline, 6) : '',
      d ? number(d.lambda, 6) : '',
      d ? number(spikes, 6) : '',
    ].join(',');
  });
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

function polyline(values, x, y) {
  const points = [];
  values.forEach((value, t) => {
    if (Number.isFinite(value)) points.push(`${x(t).toFixed(1)},${y(value).toFixed(1)}`);
  });
  return points.join(' ');
}

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Stacked ΔF/F traces, one row per ROI with its denoised calcium, as standalone SVG text.
 * Colour comes from `currentColor` and the page's .nd-chart classes, never literals.
 */
export function traceSvg(cells, frames, frameRate, { width = 720, rowHeight = 44, title = 'ΔF/F per ROI' } = {}) {
  const left = 52;
  const right = 12;
  const top = 22;
  const bottom = 30;
  const shown = cells.slice(0, 60);
  const height = top + bottom + Math.max(1, shown.length) * rowHeight;
  const duration = (frames - 1) / frameRate || 1;
  const x = (t) => left + ((t / frameRate) / duration) * (width - left - right);
  const parts = [
    `<svg xmlns="${SVG_NS}" class="nd-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(title)}" font-family="sans-serif" font-size="9">`,
    `<title>${escape(title)}</title>`,
    `<text x="${left}" y="12" fill="currentColor">${escape(title)}${cells.length > shown.length ? ` (first ${shown.length} of ${cells.length})` : ''}</text>`,
  ];
  shown.forEach((cell, row) => {
    const values = cell.dff;
    let low = Infinity;
    let high = -Infinity;
    for (const value of values) {
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    if (!Number.isFinite(low)) {
      low = 0;
      high = 1;
    }
    const span = high - low || 1;
    const base = top + (row + 1) * rowHeight - 4;
    const y = (value) => base - ((value - low) / span) * (rowHeight - 8);
    parts.push(`<line class="nd-chart-gridline" x1="${left}" x2="${width - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-opacity="0.2"/>`);
    parts.push(`<polyline fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="0.8" points="${polyline(values, x, y)}"/>`);
    if (cell.deconvolution) {
      const { c, baseline } = cell.deconvolution;
      parts.push(`<polyline class="nd-chart-median" fill="none" stroke="currentColor" stroke-width="1.3" points="${polyline(Array.from(c, (value) => value + baseline), x, y)}"/>`);
    }
    parts.push(`<text x="4" y="${(base - rowHeight / 2 + 6).toFixed(1)}" fill="currentColor">ROI ${cell.id}</text>`);
    parts.push(`<text x="${left - 4}" y="${(base - rowHeight + 14).toFixed(1)}" text-anchor="end" fill="currentColor">${number(span, 2)}</text>`);
  });
  const axis = height - bottom + 6;
  parts.push(`<line class="nd-chart-axis" x1="${left}" x2="${width - right}" y1="${axis}" y2="${axis}" stroke="currentColor" stroke-opacity="0.4"/>`);
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const seconds = (duration * i) / ticks;
    const px = left + (i / ticks) * (width - left - right);
    parts.push(`<text x="${px.toFixed(1)}" y="${axis + 12}" text-anchor="middle" fill="currentColor">${number(seconds, 3)}</text>`);
  }
  parts.push(`<text x="${width - right}" y="${axis + 23}" text-anchor="end" fill="currentColor">time (s); row labels give each ROI's ΔF/F range</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/** The rigid shifts over time, as standalone SVG text. */
export function shiftSvg(shifts, frameRate, { width = 720, height = 160 } = {}) {
  const left = 52;
  const right = 12;
  const top = 22;
  const bottom = 30;
  let low = 0;
  let high = 0;
  for (const [dy, dx] of shifts) {
    low = Math.min(low, dy, dx);
    high = Math.max(high, dy, dx);
  }
  const span = high - low || 1;
  const frames = shifts.length;
  const duration = (frames - 1) / frameRate || 1;
  const x = (t) => left + ((t / frameRate) / duration) * (width - left - right);
  const y = (value) => height - bottom - ((value - low) / span) * (height - top - bottom);
  return [
    `<svg xmlns="${SVG_NS}" class="nd-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Rigid shifts" font-family="sans-serif" font-size="9">`,
    '<title>Rigid shifts</title>',
    `<text x="${left}" y="12" fill="currentColor">Rigid shift (px): y solid, x dashed</text>`,
    `<line class="nd-chart-gridline" x1="${left}" x2="${width - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-opacity="0.2"/>`,
    `<polyline class="nd-chart-median" fill="none" stroke="currentColor" stroke-width="1.2" points="${polyline(shifts.map((s) => s[0]), x, y)}"/>`,
    `<polyline class="nd-chart-range" fill="none" stroke="currentColor" stroke-dasharray="3 2" points="${polyline(shifts.map((s) => s[1]), x, y)}"/>`,
    `<text x="${left - 4}" y="${(y(high) + 3).toFixed(1)}" text-anchor="end" fill="currentColor">${number(high, 3)}</text>`,
    `<text x="${left - 4}" y="${(y(low) + 3).toFixed(1)}" text-anchor="end" fill="currentColor">${number(low, 3)}</text>`,
    `<text x="${width - right}" y="${height - 6}" text-anchor="end" fill="currentColor">time (s), ${number(duration, 4)} s</text>`,
    '</svg>',
  ].join('\n');
}

/** The registered movie in the input's sample type: integers are rounded and clamped. */
export function toInputType(registered, dtype) {
  const ranges = {
    uint8: [Uint8Array, 0, 255],
    uint16: [Uint16Array, 0, 65535],
    uint32: [Uint32Array, 0, 4294967295],
    int8: [Int8Array, -128, 127],
    int16: [Int16Array, -32768, 32767],
    int32: [Int32Array, -2147483648, 2147483647],
  };
  const range = ranges[dtype];
  if (!range) return Float32Array.from(registered);
  const [Type, min, max] = range;
  const out = new Type(registered.length);
  for (let i = 0; i < registered.length; i++) out[i] = Math.min(max, Math.max(min, Math.round(registered[i])));
  return out;
}
