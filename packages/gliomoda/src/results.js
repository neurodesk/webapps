import { writeVolume } from '@neurodesk/synthsr';

// BraTS 2023 labels and the three evaluation regions built from them.
export const LABELS = Object.freeze([
  Object.freeze({ value: 1, name: 'Necrotic tumour core' }),
  Object.freeze({ value: 2, name: 'Oedema (non-enhancing FLAIR hyperintensity)' }),
  Object.freeze({ value: 3, name: 'Enhancing tumour' }),
]);

export const REGIONS = Object.freeze([
  Object.freeze({ id: 'WT', name: 'Whole tumour', labels: Object.freeze([1, 2, 3]) }),
  Object.freeze({ id: 'TC', name: 'Tumour core', labels: Object.freeze([1, 3]) }),
  Object.freeze({ id: 'ET', name: 'Enhancing tumour', labels: Object.freeze([3]) }),
]);

export function labelCounts(labels) {
  const counts = [0, 0, 0, 0];
  for (const value of labels) counts[value]++;
  return counts;
}

export function voxelVolumeMl(affine) {
  const [a, b, c] = [0, 1, 2].map((col) => [0, 1, 2].map((row) => affine[row][col]));
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det) / 1000;
}

// Volume of each label and region, in the order the table and the TSV list them.
export function volumeRows(labels, affine) {
  const counts = labelCounts(labels);
  const ml = voxelVolumeMl(affine);
  const rows = LABELS.map(({ value, name }) => ({ id: String(value), name, voxels: counts[value] }));
  for (const region of REGIONS) {
    rows.push({ id: region.id, name: region.name, voxels: region.labels.reduce((sum, value) => sum + counts[value], 0) });
  }
  return rows.map((row) => ({ ...row, ml: row.voxels * ml }));
}

export function volumeTable(rows) {
  const lines = ['label\tstructure\tvoxels\tvolume_ml'];
  for (const row of rows) lines.push([row.id, row.name, row.voxels, row.ml.toFixed(3)].join('\t'));
  return `${lines.join('\n')}\n`;
}

export function outputNames(caseName) {
  return { segmentation: `${caseName}_gliomoda_seg.nii`, table: `${caseName}_gliomoda_volumes.tsv` };
}

// The case name shared by the inputs: the longest common prefix of their stems, trimmed of
// separators, so BraTS-GLI-00001-000-t1c.nii.gz and its siblings give BraTS-GLI-00001-000.
const SEPARATOR = /[-_.\s]/;

export function caseName(fileNames) {
  const stems = fileNames.map((name) => name.replace(/\.nii(\.gz)?$/i, ''));
  let prefix = stems[0] ?? '';
  for (const stem of stems.slice(1)) {
    let n = 0;
    while (n < prefix.length && prefix[n] === stem[n]) n++;
    prefix = prefix.slice(0, n);
  }
  // A prefix that ends inside a word (the t of t1c and t2f) is cut back to the last separator.
  if (stems.some((stem) => stem.length > prefix.length && !SEPARATOR.test(stem[prefix.length]))) {
    prefix = prefix.slice(0, Math.max(...[...prefix].map((c, i) => (SEPARATOR.test(c) ? i : 0))));
  }
  prefix = prefix.replace(/[-_.\s]+$/, '');
  return prefix || 'gliomoda';
}

export function segmentationResults({ labels, dims, affine }, caseLabel) {
  const rows = volumeRows(labels, affine);
  const names = outputNames(caseLabel);
  return {
    segmentation: { name: names.segmentation, bytes: writeVolume({ data: labels, dims, affine }, 'GlioMODA BraTS labels 1 NCR 2 ED 3 ET') },
    table: { name: names.table, text: volumeTable(rows) },
    rows,
  };
}

function dice(a, b, labels) {
  let both = 0;
  let sizes = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = labels.includes(a[i]);
    const inB = labels.includes(b[i]);
    if (inA && inB) both++;
    sizes += inA + inB;
  }
  return sizes ? (2 * both) / sizes : 1;
}

// Agreement of two label volumes: counts per label, Dice per region and differing voxels.
export function compareLabels(labels, reference) {
  let differing = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] !== reference[i]) differing++;
  return {
    counts: labelCounts(labels),
    referenceCounts: labelCounts(reference),
    dice: Object.fromEntries(REGIONS.map((region) => [region.id, Number(dice(labels, reference, region.labels).toFixed(5))])),
    differing,
  };
}
