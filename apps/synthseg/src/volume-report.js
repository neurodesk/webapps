// The age-normative volume report as data and SVG markup. Pure: norms, volumes and the subject in,
// numbers, text and SVG strings out, so everything here is Node-tested and the page only places it.
import { assess, centile, footerLines, headerLines, modelKey, percentileText, referenceNote, scaledAge } from '@neurodesk/synthseg/brainquant';
import { VOLUME_COLUMNS } from '@neurodesk/synthseg/results';
import manifest from '@neurodesk/synthseg/manifest' with { type: 'json' };

const WIDTH = 240;
const HEIGHT = 160;
const MARGIN = { top: 8, right: 8, bottom: 28, left: 40 };
const SAMPLES = 61;
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

const ml = (mm3) => mm3 / 1000;
const round = (value) => Number(value.toFixed(1));

/** Raw soft volumes remain useful even when the population assessment rejects a run. */
export function rawVolumeRows(volumes) {
  return VOLUME_COLUMNS.map((title) => ({
    title,
    volumeMl: Number.isFinite(volumes[title]) ? ml(volumes[title]).toFixed(2) : 'n/a',
  }));
}

/** Round step for about `count` ticks across `span`: 1, 2, 5 or 10 times a power of ten. */
export function tickStep(span, count = 4) {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  if (unit >= Math.sqrt(50)) return 10 * power;
  if (unit >= Math.sqrt(10)) return 5 * power;
  if (unit >= Math.sqrt(2)) return 2 * power;
  return power;
}

/**
 * Everything the Volumes view shows for one subject: text lines, one chart per structure and the table.
 * `reference` is the selectReference result the norms were loaded for.
 */
export function volumeReport(norms, volumes, subject, { reference, voxelSizeMm = 1 }) {
  const report = assess(norms, volumes, subject);
  const { ageMin, ageMax } = norms.reference;
  const span = subject.age === null ? [ageMin, ageMax] : [Math.min(ageMin, subject.age), Math.max(ageMax, subject.age)];
  const ages = Array.from({ length: SAMPLES }, (_, index) => span[0] + ((span[1] - span[0]) * index) / (SAMPLES - 1));
  const key = modelKey(subject);
  const charts = report.results.map((result) => {
    const model = norms.structures.find((structure) => structure.id === result.id).models[key];
    const curves = QUANTILES.map((q) => ages.map((age) => ml(centile(model, scaledAge(norms, age), q))));
    return {
      id: result.id,
      caption: `${result.title}: ${percentileText(result.percentile)}`,
      flagged: result.flag !== '',
      svg: chartSvg({
        ages,
        curves,
        domain: [span[0] - 2, span[1] + 2],
        patient: { age: subject.age, adjustedMl: ml(result.adjustedMm3) },
        reference: report.outsideReferenceAge ? [ageMin, ageMax] : null,
        label: `${result.title} adjusted volume against age`,
      }),
    };
  });
  const rows = report.results.map((result) => ({
    id: result.id,
    title: result.title,
    volumeMl: ml(result.volumeMm3).toFixed(2),
    adjustedMl: ml(result.adjustedMm3).toFixed(2),
    z: result.z === null ? 'n/a' : `${result.z >= 0 ? '+' : '−'}${Math.abs(result.z).toFixed(2)}`,
    percentile: percentileText(result.percentile),
    flag: result.flag,
  }));
  return {
    report,
    header: [
      ...headerLines(report, norms),
      `Population data: ${norms.reference.cohort}, version ${manifest.norms[reference.id].version}.`,
      ...(voxelSizeMm > 1 ? [`This run used ${voxelSizeMm} mm voxels. The 1 mm reference norms have not been validated for this grid.`] : []),
    ],
    footer: footerLines(report, norms, [referenceNote(norms, reference.reason)]),
    charts,
    rows,
  };
}

/**
 * One structure's chart: 5th-95th and 25th-75th percentile bands and the median against age, and the
 * subject as a dot, or as a dashed level when the age is unknown.
 * @param {{ ages: number[], curves: number[][], domain: [number, number],
 *   patient: { age: number | null, adjustedMl: number }, reference: [number, number] | null, label: string }} chart
 */
export function chartSvg({ ages, curves, domain, patient, reference, label }) {
  const [p05, p25, p50, p75, p95] = curves;
  const values = [...p05, ...p95, patient.adjustedMl];
  const step = tickStep(Math.max(...values) - Math.min(...values) || 1);
  const low = Math.floor(Math.min(...values) / step) * step;
  const high = Math.ceil(Math.max(...values) / step) * step;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (age) => round(MARGIN.left + ((age - domain[0]) / (domain[1] - domain[0])) * plotWidth);
  const y = (value) => round(MARGIN.top + (1 - (value - low) / (high - low)) * plotHeight);
  const points = (curve) => curve.map((value, index) => `${x(ages[index])},${y(value)}`);
  const line = (curve) => points(curve).join(' ');
  const band = (lower, upper) => [...points(upper), ...points(lower).reverse()].join(' ');
  const bottom = HEIGHT - MARGIN.bottom;
  const right = WIDTH - MARGIN.right;
  const parts = [];
  for (let value = low; value <= high + step / 2; value += step) {
    const text = Number(value.toPrecision(6));
    parts.push(`<line class="nd-chart-gridline" x1="${MARGIN.left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/>`);
    parts.push(`<text x="${MARGIN.left - 4}" y="${y(value) + 3}" text-anchor="end">${text}</text>`);
  }
  const ageStep = tickStep(domain[1] - domain[0], 4);
  for (let age = Math.ceil(domain[0] / ageStep) * ageStep; age <= domain[1]; age += ageStep) {
    parts.push(`<text x="${x(age)}" y="${bottom + 12}" text-anchor="middle">${age}</text>`);
  }
  parts.push(`<polygon class="nd-chart-band-outer" points="${band(p05, p95)}"/>`);
  parts.push(`<polygon class="nd-chart-band-inner" points="${band(p25, p75)}"/>`);
  parts.push(`<polyline class="nd-chart-median" points="${line(p50)}"/>`);
  if (reference) {
    parts.push(`<rect class="nd-chart-range" x="${x(reference[0])}" y="${MARGIN.top}" width="${round(x(reference[1]) - x(reference[0]))}" height="${plotHeight}"/>`);
    parts.push(`<text class="nd-chart-note" x="${right - 2}" y="${bottom - 4}" text-anchor="end">outside reference age range</text>`);
  }
  parts.push(`<line class="nd-chart-axis" x1="${MARGIN.left}" x2="${MARGIN.left}" y1="${MARGIN.top}" y2="${bottom}"/>`);
  parts.push(`<line class="nd-chart-axis" x1="${MARGIN.left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`);
  parts.push(`<text x="${MARGIN.left + plotWidth / 2}" y="${HEIGHT - 2}" text-anchor="middle">age (years)</text>`);
  parts.push(`<text transform="translate(9 ${MARGIN.top + plotHeight / 2}) rotate(-90)" text-anchor="middle">adjusted volume (mL)</text>`);
  const value = `${patient.adjustedMl.toFixed(2)} mL`;
  if (patient.age === null) {
    parts.push(`<line class="nd-chart-level" x1="${MARGIN.left}" x2="${right}" y1="${y(patient.adjustedMl)}" y2="${y(patient.adjustedMl)}"><title>${value}, age unknown</title></line>`);
  } else {
    parts.push(`<circle class="nd-chart-marker" cx="${x(patient.age)}" cy="${y(patient.adjustedMl)}" r="4.5"><title>${value} at ${patient.age} y</title></circle>`);
  }
  return `<svg class="nd-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${label}">${parts.join('')}</svg>`;
}

/** Legend swatches, as SVG markup per entry. */
export function legendEntries(ageKnown) {
  return [
    {
      label: ageKnown ? 'patient (adjusted volume)' : 'patient (age unknown)',
      svg: ageKnown
        ? '<svg class="nd-chart" viewBox="0 0 18 10" aria-hidden="true"><circle class="nd-chart-marker" cx="9" cy="5" r="4"/></svg>'
        : '<svg class="nd-chart" viewBox="0 0 18 10" aria-hidden="true"><line class="nd-chart-level" x1="0" x2="18" y1="5" y2="5"/></svg>',
    },
    { label: 'median', svg: '<svg class="nd-chart" viewBox="0 0 18 10" aria-hidden="true"><line class="nd-chart-median" x1="0" x2="18" y1="5" y2="5"/></svg>' },
    { label: '25th–75th percentile', svg: '<svg class="nd-chart" viewBox="0 0 18 10" aria-hidden="true"><rect class="nd-chart-band-inner" width="18" height="10"/></svg>' },
    { label: '5th–95th percentile', svg: '<svg class="nd-chart" viewBox="0 0 18 10" aria-hidden="true"><rect class="nd-chart-band-outer" width="18" height="10"/></svg>' },
  ];
}
