// Spectra as SVG markup, ppm decreasing to the right as MRS convention has it.
// Pure: numbers and fixed labels in, a string out, so scaling is Node-tested
// and no file content reaches the markup unescaped.

const WIDTH = 800;
const MARGIN = { top: 12, right: 16, bottom: 34, left: 16 };

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Round step for about `count` ticks across `span`: 1, 2 or 5 times a power of ten. */
export function tickStep(span, count = 8) {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit >= Math.sqrt(50) ? 10 : unit >= Math.sqrt(10) ? 5 : unit >= Math.sqrt(2) ? 2 : 1) * power;
}

/**
 * Keep the points with lo <= ppm <= hi, and thin them to at most `max`
 * (min/max per bucket, so peaks survive).
 */
export function visibleIndices(ppm, values, lo, hi, max = 1600) {
  const idx = [];
  for (let k = 0; k < ppm.length; k += 1) if (ppm[k] >= lo && ppm[k] <= hi) idx.push(k);
  if (idx.length <= max) return idx;
  const bucket = Math.ceil(idx.length / (max / 2));
  const kept = [];
  for (let b = 0; b < idx.length; b += bucket) {
    const slice = idx.slice(b, b + bucket);
    let lo2 = slice[0];
    let hi2 = slice[0];
    for (const k of slice) {
      if (values[k] < values[lo2]) lo2 = k;
      if (values[k] > values[hi2]) hi2 = k;
    }
    kept.push(...(lo2 < hi2 ? [lo2, hi2] : lo2 === hi2 ? [lo2] : [hi2, lo2]));
  }
  return kept;
}

/**
 * Positions in `idx` grouped into runs that do not cross a gap in the ppm
 * axis: LCModel leaves the excluded window (PPMGAP) out of the .COORD file,
 * and a line drawn across it would look like fitted data.
 */
export function splitAtGaps(ppm, idx) {
  const steps = [];
  for (let k = 1; k < ppm.length; k += 1) steps.push(Math.abs(ppm[k] - ppm[k - 1]));
  const typical = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
  const runs = [];
  let run = [];
  idx.forEach((k, i) => {
    if (run.length) {
      const prev = idx[i - 1];
      for (let g = Math.min(prev, k) + 1; g <= Math.max(prev, k); g += 1) {
        if (Math.abs(ppm[g] - ppm[g - 1]) > 5 * typical) {
          runs.push(run);
          run = [];
          break;
        }
      }
    }
    run.push(i);
  });
  if (run.length) runs.push(run);
  return runs;
}

/**
 * @param {{
 *   ppm: number[],
 *   series: { values: number[], kind: string, label: string, offset?: number }[],
 *   range?: [number, number],
 *   height?: number,
 *   ariaLabel: string,
 * }} spec  `kind` selects the stroke style (data, fit, background, residual,
 *   metabolite, reference). Series with an `offset` are drawn shifted up.
 */
export function spectrumSvg({ ppm, series, range, height = 420, ariaLabel }) {
  const [hi, lo] = range ?? [Math.max(...ppm), Math.min(...ppm)];
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const idx = visibleIndices(ppm, series[0]?.values ?? [], lo, hi);
  const shifted = series.map((s) => idx.map((k) => (s.values[k] ?? 0) + (s.offset ?? 0)));
  const all = shifted.flat().filter(Number.isFinite);
  let ymin = Math.min(...all);
  let ymax = Math.max(...all);
  if (!(ymax > ymin)) {
    ymin -= 1;
    ymax += 1;
  }
  const pad = (ymax - ymin) * 0.04;
  ymin -= pad;
  ymax += pad;
  const x = (p) => (MARGIN.left + ((hi - p) / (hi - lo)) * plotWidth).toFixed(1);
  const y = (v) => (MARGIN.top + (1 - (v - ymin) / (ymax - ymin)) * plotHeight).toFixed(1);
  const parts = [];
  const step = tickStep(hi - lo);
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) {
    const tx = x(t);
    parts.push(`<line class="lcm-grid" x1="${tx}" x2="${tx}" y1="${MARGIN.top}" y2="${height - MARGIN.bottom}"/>`);
    parts.push(`<text x="${tx}" y="${height - MARGIN.bottom + 14}" text-anchor="middle">${Number(t.toFixed(3))}</text>`);
  }
  parts.push(`<line class="lcm-axis" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${height - MARGIN.bottom}" y2="${height - MARGIN.bottom}"/>`);
  parts.push(`<text x="${MARGIN.left + plotWidth / 2}" y="${height - 4}" text-anchor="middle">Chemical shift (ppm)</text>`);
  const runs = splitAtGaps(ppm, idx);
  series.forEach((s, j) => {
    for (const run of runs) {
      const points = run.map((i) => `${x(ppm[idx[i]])},${y(shifted[j][i])}`).join(" ");
      parts.push(`<polyline class="lcm-${escapeXml(s.kind)}" points="${points}"><title>${escapeXml(s.label)}</title></polyline>`);
    }
    if (s.kind === "metabolite") {
      const peak = shifted[j].reduce((best, v, i) => (v > shifted[j][best] ? i : best), 0);
      const tx = Math.min(Math.max(Number(x(ppm[idx[peak]])), MARGIN.left + 24), WIDTH - MARGIN.right - 24);
      parts.push(`<text class="lcm-label" x="${tx}" y="${Number(y(shifted[j][peak])) - 3}" text-anchor="middle">${escapeXml(s.label)}</text>`);
    }
  });
  return `<svg class="lcm-plot" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">${parts.join("")}</svg>`;
}

/** The LCModel fit: data, fit and baseline, with the residual above. */
export function fitSeries(coord) {
  const residual = coord.data.map((d, k) => d - coord.fit[k]);
  const dmax = Math.max(...coord.data);
  const dmin = Math.min(...coord.data, 0);
  const rmin = Math.min(...residual);
  const offset = dmax - rmin + (dmax - dmin) * 0.08;
  return [
    { values: coord.data, kind: "data", label: "Data" },
    { values: coord.fit, kind: "fit", label: "Fit" },
    { values: coord.background, kind: "background", label: "Baseline" },
    { values: residual, kind: "residual", label: "Residual", offset },
  ];
}

/** Each fitted metabolite (curve minus baseline), stacked, largest at the bottom. */
export function metaboliteSeries(coord, { limit = 12 } = {}) {
  const curves = coord.metabolites
    .map((m) => ({ name: m.name, values: m.curve.map((v, k) => v - (coord.background[k] ?? 0)) }))
    .filter((m) => m.values.some((v) => Math.abs(v) > 0))
    .map((m) => ({ ...m, peak: Math.max(...m.values) }))
    .sort((a, b) => b.peak - a.peak)
    .slice(0, limit);
  const gap = Math.max(...curves.map((c) => c.peak), 0) * 0.35;
  let offset = 0;
  return curves.map((c) => {
    const s = { values: c.values, kind: "metabolite", label: c.name, offset };
    offset += c.peak + gap;
    return s;
  });
}
