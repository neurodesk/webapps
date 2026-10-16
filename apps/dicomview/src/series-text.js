// How a series reads in the sidebar and the status bar.

const KINDS = {
  t1: 'T1',
  t2: 'T2',
  flair: 'FLAIR',
  dwi: 'Diffusion',
  fmri: 'EPI time series',
  color: 'Colour',
  localizer: 'Localizer',
};

export function describeSeries(series) {
  const name = series.description || series.protocolName || 'Unnamed series';
  return series.number === null ? name : `Series ${series.number}: ${name}`;
}

// One line in the series list: number, name, modality and image count.
export function seriesLabel(series) {
  const name = series.description || series.protocolName || 'Unnamed';
  const images = `${series.files.length} image${series.files.length === 1 ? '' : 's'}`;
  return [series.number ?? '–', name, series.modality, images].filter(Boolean).join(' · ');
}

const MEASURES = [
  ['repetitionTime', 'TR', ' ms'],
  ['echoTime', 'TE', ' ms'],
  ['inversionTime', 'TI', ' ms'],
  ['flipAngle', 'FA', '°'],
  ['sliceThickness', 'slice', ' mm'],
];

// The selected series in one line: its kind, matrix and main acquisition parameters.
export function seriesSummary(series) {
  const parts = [];
  if (KINDS[series.kind]) parts.push(KINDS[series.kind]);
  if (series.rows && series.cols) parts.push(`${series.cols} × ${series.rows}`);
  for (const [key, label, unit] of MEASURES) {
    const value = series.summary[key];
    if (value === null) continue;
    parts.push(typeof value === 'number' ? `${label} ${value}${unit}` : `${label} ${value}`);
  }
  const varying = series.varyingTags.size;
  if (varying) parts.push(`${varying} field${varying === 1 ? ' varies' : 's vary'}`);
  return parts.join(' · ');
}
