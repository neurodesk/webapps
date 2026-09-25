// The flow-curve chart as SVG markup. Pure: numbers and fixed labels in, a string out, so the
// scaling is Node-tested and no user text ever reaches the markup.
const WIDTH = 320;
const HEIGHT = 180;
const MARGIN = { top: 10, right: 10, bottom: 28, left: 42 };

/** Round step for about `count` ticks across `span`: 1, 2, 5 or 10 times a power of ten. */
export function tickStep(span, count = 4) {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit >= Math.sqrt(50) ? 10 : unit >= Math.sqrt(10) ? 5 : unit >= Math.sqrt(2) ? 2 : 1) * power;
}

/**
 * @param {{ values: ArrayLike<number>, color: string, label: string }[]} series
 * @param {{ yLabel: string, xLabel: string }} axes
 */
export function flowChartSvg(series, axes) {
  const frames = Math.max(...series.map((s) => s.values.length));
  const all = series.flatMap((s) => Array.from(s.values));
  const step = tickStep(Math.max(...all) - Math.min(0, ...all) || 1);
  const low = Math.min(0, Math.floor(Math.min(...all) / step) * step);
  const high = Math.ceil(Math.max(...all) / step) * step || step;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (t) => Number((MARGIN.left + (frames > 1 ? (t / (frames - 1)) * plotWidth : 0)).toFixed(1));
  const y = (value) => Number((MARGIN.top + (1 - (value - low) / (high - low)) * plotHeight).toFixed(1));
  const parts = [];
  for (let value = low; value <= high + step / 2; value += step) {
    parts.push(`<line class="cf-grid" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y(value)}" y2="${y(value)}"/>`);
    parts.push(`<text x="${MARGIN.left - 4}" y="${y(value) + 3}" text-anchor="end">${Number(value.toPrecision(6))}</text>`);
  }
  const frameStep = Math.max(1, tickStep(frames - 1, 4));
  for (let t = 0; t < frames; t += frameStep) {
    parts.push(`<text x="${x(t)}" y="${HEIGHT - MARGIN.bottom + 12}" text-anchor="middle">${t + 1}</text>`);
  }
  parts.push(`<line class="cf-axis" x1="${MARGIN.left}" x2="${MARGIN.left}" y1="${MARGIN.top}" y2="${HEIGHT - MARGIN.bottom}"/>`);
  parts.push(`<line class="cf-axis" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${HEIGHT - MARGIN.bottom}" y2="${HEIGHT - MARGIN.bottom}"/>`);
  parts.push(`<text x="${MARGIN.left + plotWidth / 2}" y="${HEIGHT - 2}" text-anchor="middle">${axes.xLabel}</text>`);
  parts.push(`<text transform="translate(10 ${MARGIN.top + plotHeight / 2}) rotate(-90)" text-anchor="middle">${axes.yLabel}</text>`);
  for (const s of series) {
    const points = Array.from(s.values, (value, t) => `${x(t)},${y(value)}`).join(" ");
    parts.push(`<polyline class="cf-curve" stroke="${s.color}" points="${points}"><title>${s.label}</title></polyline>`);
  }
  return `<svg class="cf-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${series.map((s) => s.label).join(" and ")} over the cardiac cycle">${parts.join("")}</svg>`;
}
