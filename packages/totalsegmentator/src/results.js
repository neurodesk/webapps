// Per-structure statistics (volume + intensity), TSV formatting, NIfTI serialization and Dice evaluation.
import { writeVolume } from '@neurodesk/synthsr';
import { GROUP_LABELS, labelsForTask } from './labels.js';

export function voxelVolumeMl(affine) {
  const [a, b, c] = [0, 1, 2].map((col) => [0, 1, 2].map((row) => affine[row][col]));
  const det = a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det) / 1000;
}

// Computes voxel count, volume (mL), mean and SD intensity for every detected structure.
export function structureStatistics({ labels, imageData, dims, affine, task, includeEmpty = false }) {
  const catalog = labelsForTask(task);
  const maxId = catalog.reduce((m, entry) => Math.max(m, entry.id), 0);
  const counts = new Int32Array(maxId + 1);
  const sums = new Float64Array(maxId + 1);
  const sumsSq = new Float64Array(maxId + 1);

  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (id === 0 || id > maxId) continue;
    counts[id]++;
    if (imageData) {
      const v = imageData[i];
      sums[id] += v;
      sumsSq[id] += v * v;
    }
  }

  const mlPerVoxel = voxelVolumeMl(affine);
  const rows = [];
  for (const entry of catalog) {
    const voxels = counts[entry.id];
    if (!includeEmpty && voxels === 0) continue;
    const mean = imageData && voxels > 0 ? sums[entry.id] / voxels : null;
    const variance = imageData && voxels > 0 ? Math.max(0, sumsSq[entry.id] / voxels - mean * mean) : null;
    rows.push({
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      group: entry.group,
      groupLabel: GROUP_LABELS[entry.group] ?? entry.group,
      voxels,
      ml: voxels * mlPerVoxel,
      mean,
      sd: variance !== null ? Math.sqrt(variance) : null,
    });
  }
  return rows;
}

export function statisticsTable(rows, { modality = 'ct' } = {}) {
  const unit = modality === 'ct' ? 'hu' : 'intensity';
  const lines = [`label\tstructure\tgroup\tvoxels\tvolume_ml\tmean_${unit}\tsd_${unit}`];
  for (const row of rows) {
    lines.push([
      row.id,
      row.slug,
      row.group,
      row.voxels,
      row.ml.toFixed(3),
      row.mean === null ? '' : row.mean.toFixed(2),
      row.sd === null ? '' : row.sd.toFixed(2),
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export function caseStem(fileName) {
  return String(fileName || 'scan')
    .replace(/\.nii(\.gz)?$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'totalsegmentator';
}

export function outputNames(stem, task) {
  return {
    segmentation: `${stem}_totalseg_${task}.nii`,
    table: `${stem}_totalseg_${task}_stats.tsv`,
  };
}

export function segmentationResults({ labels, imageData, dims, affine, task, modality = 'ct' }, fileName) {
  const stem = caseStem(fileName);
  const names = outputNames(stem, task);
  const rows = structureStatistics({ labels, imageData, dims, affine, task });
  const description = `TotalSegmentator ${task} multilabel mask`;
  return {
    segmentation: {
      name: names.segmentation,
      bytes: writeVolume({ data: labels, dims, affine }, description),
    },
    table: {
      name: names.table,
      text: statisticsTable(rows, { modality }),
    },
    rows,
  };
}

// Per-class and mean foreground Dice between two label volumes, for reference validation.
export function compareLabels(labels, reference, task) {
  const catalog = labelsForTask(task);
  const maxId = catalog.reduce((m, entry) => Math.max(m, entry.id), 0);
  const inter = new Int32Array(maxId + 1);
  const predCnt = new Int32Array(maxId + 1);
  const refCnt = new Int32Array(maxId + 1);
  let differing = 0;

  for (let i = 0; i < labels.length; i++) {
    const a = labels[i];
    const b = reference[i];
    if (a !== b) differing++;
    if (a > 0 && a <= maxId) predCnt[a]++;
    if (b > 0 && b <= maxId) refCnt[b]++;
    if (a > 0 && a === b && a <= maxId) inter[a]++;
  }

  const perClass = {};
  let diceSum = 0;
  let present = 0;
  for (const entry of catalog) {
    const total = predCnt[entry.id] + refCnt[entry.id];
    if (total === 0) continue;
    const score = (2 * inter[entry.id]) / total;
    perClass[entry.slug] = Number(score.toFixed(5));
    diceSum += score;
    present++;
  }
  return {
    meanDice: present ? Number((diceSum / present).toFixed(5)) : 1,
    presentClasses: present,
    differingVoxels: differing,
    totalVoxels: labels.length,
    perClass,
  };
}
