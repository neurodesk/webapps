// The FSC curve of a PostProcess job as an SVG in the shared chart vocabulary
// (.nd-chart in imaging-workspace.css): token colours only. Pure string output.

const WIDTH = 320;
const HEIGHT = 200;
const MARGIN = { left: 34, right: 10, top: 10, bottom: 30 };
export const GOLD_STANDARD = 0.143;

const format = value => (Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(1));

/** Where the curve first falls below `threshold`, interpolated in 1/Å. */
export function crossing(shells, threshold = GOLD_STANDARD) {
  for (let index = 1; index < shells.length; index += 1) {
    const before = shells[index - 1];
    const after = shells[index];
    if (before.fsc >= threshold && after.fsc < threshold) {
      const t = (before.fsc - threshold) / (before.fsc - after.fsc);
      return before.resolution + t * (after.resolution - before.resolution);
    }
  }
  return null;
}

/**
 * SVG text: the corrected FSC against spatial frequency, the phase-randomised
 * FSC dotted, the 0.143 threshold dashed and a marker where the curve crosses it.
 */
export function fscChartSvg({ shells, finalResolution }) {
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxFrequency = Math.max(...shells.map(shell => shell.resolution)) || 1;
  const x = frequency => MARGIN.left + (frequency / maxFrequency) * plotWidth;
  const y = value => MARGIN.top + (1 - Math.max(-0.05, Math.min(1.05, value))) * plotHeight;
  const path = values => values.map((value, index) => `${index ? 'L' : 'M'}${x(shells[index].resolution).toFixed(1)},${y(value).toFixed(1)}`).join('');
  const parts = [];
  for (const level of [0, 0.5, 1]) {
    parts.push(`<line class="nd-chart-gridline" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y(level)}" y2="${y(level)}"/>`);
    parts.push(`<text x="${MARGIN.left - 4}" y="${y(level) + 3}" text-anchor="end">${level}</text>`);
  }
  for (let tick = 1; tick <= 4; tick += 1) {
    const frequency = (maxFrequency * tick) / 4;
    parts.push(`<text x="${x(frequency)}" y="${HEIGHT - MARGIN.bottom + 12}" text-anchor="middle">${format(1 / frequency)}</text>`);
  }
  parts.push(`<text x="${MARGIN.left + plotWidth / 2}" y="${HEIGHT - 4}" text-anchor="middle">Resolution (Å)</text>`);
  parts.push(`<line class="nd-chart-axis" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y(0)}" y2="${y(0)}"/>`);
  parts.push(`<line class="nd-chart-axis" x1="${MARGIN.left}" x2="${MARGIN.left}" y1="${MARGIN.top}" y2="${HEIGHT - MARGIN.bottom}"/>`);
  parts.push(`<line class="nd-chart-level" x1="${MARGIN.left}" x2="${WIDTH - MARGIN.right}" y1="${y(GOLD_STANDARD)}" y2="${y(GOLD_STANDARD)}"/>`);
  if (shells.every(shell => Number.isFinite(shell.randomised))) {
    parts.push(`<path class="nd-chart-range" d="${path(shells.map(shell => shell.randomised))}"/>`);
  }
  parts.push(`<path class="nd-chart-median" d="${path(shells.map(shell => shell.fsc))}"/>`);
  const at = crossing(shells);
  if (at !== null) {
    parts.push(`<circle class="nd-chart-marker" cx="${x(at).toFixed(1)}" cy="${y(GOLD_STANDARD).toFixed(1)}" r="4"/>`);
    parts.push(`<text class="nd-chart-note" x="${x(at).toFixed(1)}" y="${(y(GOLD_STANDARD) - 8).toFixed(1)}" text-anchor="middle">${finalResolution.toFixed(2)} Å</text>`);
  }
  return `<svg class="nd-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Fourier shell correlation; ${finalResolution.toFixed(2)} Å at FSC 0.143">${parts.join('')}</svg>`;
}
