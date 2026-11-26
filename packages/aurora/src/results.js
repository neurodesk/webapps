import { createUint8Nifti } from '@neurodesk/webapp-components/file-io/nifti';

// Upstream AURORA 2-region label convention (Buchner et al. 2022/2023, model.py):
//   1 = peritumoral oedema (channel 0 only; `# edema` upstream)
//   2 = metastasis core (enhancing + necrosis, channel 1; overwrites label 1)
export const LABELS = Object.freeze([
  Object.freeze({ value: 1, name: 'Peritumoral oedema' }),
  Object.freeze({ value: 2, name: 'Metastasis (enhancing + necrosis)' }),
]);

export const REGIONS = Object.freeze([
  Object.freeze({ id: 'WL', name: 'Whole lesion (labels 1 + 2)', labels: Object.freeze([1, 2]) }),
  Object.freeze({ id: 'MET', name: 'Metastasis (label 2)', labels: Object.freeze([2]) }),
]);

function fallbackHeader(dims, affine) {
  const buf = new ArrayBuffer(352);
  const dv = new DataView(buf);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, dims[0], true);
  dv.setInt16(44, dims[1], true);
  dv.setInt16(46, dims[2], true);
  dv.setInt16(48, 1, true);
  dv.setInt16(70, 2, true);
  dv.setInt16(72, 8, true);
  dv.setFloat32(76, 1, true);
  for (let axis = 0; axis < 3; axis++) {
    const spacing = Math.hypot(affine[0][axis], affine[1][axis], affine[2][axis]) || 1;
    dv.setFloat32(80 + axis * 4, spacing, true);
  }
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, 1, true);
  dv.setUint8(123, 2); // millimetres
  dv.setInt16(254, 1, true);
  for (let col = 0; col < 4; col++) {
    dv.setFloat32(280 + col * 4, affine[0][col], true);
    dv.setFloat32(296 + col * 4, affine[1][col], true);
    dv.setFloat32(312 + col * 4, affine[2][col], true);
  }
  new Uint8Array(buf).set([0x6e, 0x2b, 0x31, 0x00], 344);
  return buf;
}

function writeLabelNifti(data, dims, affine, headerBytes) {
  const sourceHeader = headerBytes || fallbackHeader(dims, affine);
  return new Uint8Array(createUint8Nifti(data, sourceHeader, dims));
}

// Connected-component lesion definition: 26-connectivity on enhancing metastasis (label 2)
// with a minimum size of 5 voxels (5 mm^3 at 1 mm isotropic) to suppress single-voxel noise specks.
export const LESION_CONNECTIVITY = 26;
export const DEFAULT_MIN_LESION_VOXELS = 5;

export function labelCounts(labels) {
  const counts = [0, 0, 0];
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    if (v >= 0 && v < counts.length) counts[v]++;
  }
  return counts;
}

export function voxelVolumeMl(affine) {
  const [a, b, c] = [0, 1, 2].map((col) => [0, 1, 2].map((row) => affine[row][col]));
  const det = a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det) / 1000;
}

/**
 * Count 26-connected components for voxels where `predicate(value)` holds.
 * Returns components sorted largest-first with voxel count and volume in mL.
 */
export function connectedLesions(labels, dims, affine, {
  targetLabel = 2,
  minVoxels = DEFAULT_MIN_LESION_VOXELS,
} = {}) {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  let targetCount = 0;
  for (let i = 0; i < total; i++) {
    if (labels[i] === targetLabel) targetCount++;
  }
  if (targetCount < minVoxels) return [];
  const visited = new Uint8Array(total);
  const queue = new Int32Array(targetCount);
  const mlPerVoxel = voxelVolumeMl(affine);
  const components = [];
  const strideZ = nx * ny;

  for (let start = 0; start < total; start++) {
    if (visited[start] || labels[start] !== targetLabel) continue;
    let head = 0;
    let tail = 0;
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % nx;
      const y = Math.floor(idx / nx) % ny;
      const z = Math.floor(idx / strideZ);
      for (let dz = -1; dz <= 1; dz++) {
        const nzCoord = z + dz;
        if (nzCoord < 0 || nzCoord >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const nyCoord = y + dy;
          if (nyCoord < 0 || nyCoord >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const nxCoord = x + dx;
            if (nxCoord < 0 || nxCoord >= nx) continue;
            const nIdx = nxCoord + nyCoord * nx + nzCoord * strideZ;
            if (!visited[nIdx] && labels[nIdx] === targetLabel) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }
    }
    if (tail >= minVoxels) {
      components.push({ voxels: tail, ml: tail * mlPerVoxel });
    }
  }
  components.sort((a, b) => b.voxels - a.voxels);
  return components;
}

export function volumeRows(labels, affine) {
  const counts = labelCounts(labels);
  const ml = voxelVolumeMl(affine);
  const rows = LABELS.map(({ value, name }) => ({ id: String(value), name, voxels: counts[value] }));
  for (const region of REGIONS) {
    rows.push({
      id: region.id,
      name: region.name,
      voxels: region.labels.reduce((sum, value) => sum + counts[value], 0),
    });
  }
  return rows.map((row) => ({ ...row, ml: row.voxels * ml }));
}

export function volumeTable(rows, lesions = null) {
  const header = lesions
    ? `region\tstructure\tvoxels\tvolume_ml\tlesions_26conn_ge${DEFAULT_MIN_LESION_VOXELS}`
    : 'region\tstructure\tvoxels\tvolume_ml';
  const lines = [header];
  for (const row of rows) {
    const cols = [row.id, row.name, row.voxels, row.ml.toFixed(3)];
    if (lesions) {
      cols.push(row.id === '2' || row.id === 'MET' ? String(lesions.length) : '-');
    }
    lines.push(cols.join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export function stemName(fileName) {
  return String(fileName || 'aurora').replace(/\.nii(\.gz)?$/i, '');
}

export function outputNames(caseLabel) {
  return {
    segmentation: `${caseLabel}_aurora_seg.nii`,
    wholeMask: `${caseLabel}_aurora_whole_mask.nii`,
    enhancingMask: `${caseLabel}_aurora_metastasis_mask.nii`,
    table: `${caseLabel}_aurora_volumes.tsv`,
  };
}

export function segmentationResults({ labels, wholeMask, enhancingMask, dims, affine, headerBytes }, caseLabel) {
  const rows = volumeRows(labels, affine);
  const lesions = connectedLesions(labels, dims, affine);
  const names = outputNames(caseLabel);
  return {
    segmentation: {
      name: names.segmentation,
      bytes: writeLabelNifti(labels, dims, affine, headerBytes),
    },
    wholeMask: wholeMask
      ? { name: names.wholeMask, bytes: writeLabelNifti(wholeMask, dims, affine, headerBytes) }
      : null,
    enhancingMask: enhancingMask
      ? { name: names.enhancingMask, bytes: writeLabelNifti(enhancingMask, dims, affine, headerBytes) }
      : null,
    table: { name: names.table, text: volumeTable(rows, lesions) },
    rows,
    lesions,
  };
}

function diceFor(a, b, targetLabels) {
  let both = 0;
  let sizes = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = targetLabels.includes(a[i]) ? 1 : 0;
    const inB = targetLabels.includes(b[i]) ? 1 : 0;
    if (inA && inB) both++;
    sizes += inA + inB;
  }
  return sizes ? (2 * both) / sizes : 1;
}

export function compareLabels(labels, reference) {
  let differing = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] !== reference[i]) differing++;
  return {
    counts: labelCounts(labels),
    referenceCounts: labelCounts(reference),
    dice: Object.fromEntries(REGIONS.map((region) => [region.id, Number(diceFor(labels, reference, region.labels).toFixed(6))])),
    differing,
  };
}
