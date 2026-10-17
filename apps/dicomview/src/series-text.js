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

// A series' images and sidecars as downloads. dcm2niix names its outputs after the input
// folder, often the patient's name, and the study date and time; these carry only the
// series number and description, an image and its sidecar under one stem.
export function downloadFiles(series, outputs) {
  const label = (series.description || series.protocolName || '').replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^[_.]+|_+$/g, '').slice(0, 64);
  const stem = [`series${series.number ?? ''}`, label].filter(Boolean).join('_');
  return outputs.map(({ image, sidecar }, index) => {
    const name = outputs.length > 1 ? `${stem}_${index + 1}` : stem;
    const extension = image.name.match(/\.nii(\.gz)?$/i)?.[0] ?? '.nii';
    return {
      image: new File([image], `${name}${extension}`, { type: image.type }),
      sidecar: sidecar ? new File([`${JSON.stringify(sidecar, null, 2)}\n`], `${name}.json`, { type: 'application/json' }) : null,
    };
  });
}
