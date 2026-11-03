// Lesion overlap with a label atlas, per label and hemisphere, in the columns
// of the Python reporting job's atlas overlap tables (calmar.atlas_overlap.
// calculate_overlap). Those tables feed the knowledge-base atlas mapping, so
// the webapp produces the same rows: the lesion share and the destroyed share
// of every label, and the voxels and label size on each side of the MNI
// midline (world x < 0 is left), because HarvardOxford labels cover both
// hemispheres and the side has to come from the voxels.
//
// Inputs are typed arrays on one grid:
//   lesion  nonzero = in lesion
//   atlas   integer labels, 0 = background
//   dims    [nx, ny, nz]
//   affine  voxel -> world: nested rows ([[a,b,c,d], ...], as nifti-reader-js
//           and resample.js use) or flat row-major (16 or 12 numbers)
//   labels  { [id]: name } (missing ids are named Region_<id>, as in Python)

const MIDLINE = 1e-5;

function row0(affine) {
  if (Array.isArray(affine) && Array.isArray(affine[0]) && affine[0].length >= 4) {
    return affine[0].slice(0, 4).map(Number);
  }
  if (affine && (affine.length === 16 || affine.length === 12)) {
    return [affine[0], affine[1], affine[2], affine[3]].map(Number);
  }
  throw new Error('labelOverlap: affine must be 4 nested rows or 12/16 flat entries');
}

export function labelOverlap({ lesion, atlas, dims, affine, labels = {} }) {
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error('labelOverlap: dims must be [nx, ny, nz]');
  }
  const [nx, ny, nz] = dims;
  const expected = nx * ny * nz;
  if (lesion.length !== expected || atlas.length !== expected) {
    throw new Error(`labelOverlap: lesion (${lesion.length}) and atlas (${atlas.length}) must match dims (${expected})`);
  }
  const [a0, a1, a2, a3] = row0(affine);
  const size = new Map();
  const leftSize = new Map();
  const rightSize = new Map();
  const overlap = new Map();
  const leftOverlap = new Map();
  const rightOverlap = new Map();
  const midOverlap = new Map();
  let total = 0;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  let i = 0;
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      // x depends on i linearly; computed per voxel to keep oblique affines exact.
      const base = a1 * j + a2 * k + a3;
      for (let ii = 0; ii < nx; ii += 1, i += 1) {
        const label = atlas[i] | 0;
        const x = a0 * ii + base;
        if (label !== 0) {
          bump(size, label);
          if (x < -MIDLINE) bump(leftSize, label);
          else if (x > MIDLINE) bump(rightSize, label);
        }
        if (lesion[i]) {
          total += 1;
          if (label !== 0) {
            bump(overlap, label);
            if (x < -MIDLINE) bump(leftOverlap, label);
            else if (x > MIDLINE) bump(rightOverlap, label);
            else bump(midOverlap, label);
          }
        }
      }
    }
  }
  const rows = [];
  for (const [label, n] of [...overlap.entries()].sort((a, b) => a[0] - b[0])) {
    const regionSize = size.get(label) || 0;
    rows.push({
      region: String(labels[label] ?? `Region_${label}`),
      region_id: label,
      overlap_voxels: n,
      total_region_voxels: regionSize,
      total_lesion_voxels: total,
      lesion_in_roi_percent: total ? (100 * n) / total : 0,
      roi_coverage_percent: regionSize ? (100 * n) / regionSize : 0,
      left_overlap_voxels: leftOverlap.get(label) || 0,
      right_overlap_voxels: rightOverlap.get(label) || 0,
      midline_overlap_voxels: midOverlap.get(label) || 0,
      left_region_voxels: leftSize.get(label) || 0,
      right_region_voxels: rightSize.get(label) || 0,
    });
  }
  return { rows, totalLesionVoxels: total };
}
