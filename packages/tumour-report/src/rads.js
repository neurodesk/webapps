// Standardized MNI-space RADS anatomical and surgical characterization on the
// 197 x 233 x 189 1 mm ICBM 152 2009a symmetric grid, matching raidionics_rads_lib
// (BSD-2-Clause), plus Greedy WASM MNI normalization helper.
import { gunzip, registerAffineGreedy, registerSvfGreedy, resliceAffineGreedy, resliceGreedy } from '@neurodesk/greedy';
import { readVolume, writeVolume } from '@neurodesk/synthsr';
import { applyAffinePoint, resampleToOutput, voxelSpacingMm } from './preprocess.js';
import mniLobesLabels from './data/mni_lobes.json' with { type: 'json' };
import schaefer7Labels from './data/schaefer7.json' with { type: 'json' };
import schaefer17Labels from './data/schaefer17.json' with { type: 'json' };

export const ICBM2009A_DIMS = Object.freeze([197, 233, 189]);
export const ATLAS_LABELS = Object.freeze({
  mniLobes: Object.freeze(mniLobesLabels),
  schaefer7: Object.freeze(schaefer7Labels),
  schaefer17: Object.freeze(schaefer17Labels),
});

function round2(v) {
  return Math.round(v * 100) / 100;
}

// Reproduces raidionicsrads lateralisation percentages (latMask == 1 -> right, 2 -> left)
// while determining bilateral midline crossing from unrounded hemisphere voxel counts
// (left > 0 && right > 0) and reporting unlabelled coverage explicitly.
export function computeLaterality(mniMask, latMask) {
  if (mniMask.length !== latMask.length) {
    throw new Error('Tumour mask and lateralisation atlas dimensions do not match.');
  }
  let total = 0;
  let right = 0;
  let left = 0;
  for (let i = 0; i < mniMask.length; i++) {
    if (!mniMask[i]) continue;
    total++;
    const side = latMask[i];
    if (side === 1) right++;
    else if (side === 2) left++;
  }
  const unlabelled = total - left - right;
  if (total === 0) {
    return {
      leftPct: 0,
      rightPct: 0,
      unlabelledPct: 0,
      leftVoxels: 0,
      rightVoxels: 0,
      unlabelledVoxels: 0,
      midlineCrossing: false,
    };
  }
  const leftPct = round2((left / total) * 100);
  const rightPct = round2((right / total) * 100);
  const unlabelledPct = round2((unlabelled / total) * 100);
  const midlineCrossing = left > 0 && right > 0;
  return {
    leftPct,
    rightPct,
    unlabelledPct,
    leftVoxels: left,
    rightVoxels: right,
    unlabelledVoxels: unlabelled,
    midlineCrossing,
  };
}

// Reproduces raidionicsrads compute_resectability_index (Kommers et al., Neuro-Oncology 2021).
// Should be displayed for Glioblastoma only.
export function computeResectability(mniMask, leftPct, resectLeft, resectRight) {
  const map = leftPct >= 50 ? resectLeft : resectRight;
  if (mniMask.length !== map.length) {
    throw new Error('Tumour mask and resectability map dimensions do not match.');
  }
  let voxels = 0;
  let sum = 0;
  for (let i = 0; i < mniMask.length; i++) {
    if (!mniMask[i]) continue;
    voxels++;
    const val = map[i];
    if (Number.isFinite(val)) sum += val;
  }
  if (voxels === 0) {
    return {
      hemisphereMap: leftPct >= 50 ? 'left' : 'right',
      expectedResectableMl: 0,
      expectedResidualMl: 0,
      resectabilityIndex: 0,
    };
  }
  const resectableMl = sum * 1e-3;
  const residualMl = voxels * 1e-3 - resectableMl;
  const index = sum / voxels;
  return {
    hemisphereMap: leftPct >= 50 ? 'left' : 'right',
    expectedResectableMl: Number(resectableMl.toFixed(3)),
    expectedResidualMl: Number(residualMl.toFixed(3)),
    resectabilityIndex: Number(index.toFixed(4)),
  };
}

// Reproduces raidionicsrads compute_cortical_structures_location.
// Returns both full lookup map (matching RADS keys) and sorted non-zero rows.
export function computeCorticalOverlap(mniMask, atlasMask, labelEntries) {
  if (mniMask.length !== atlasMask.length) {
    throw new Error('Tumour mask and cortical atlas dimensions do not match.');
  }
  let tumourTotal = 0;
  const overlapCounts = new Map();
  const regionTotals = new Map();
  for (let i = 0; i < atlasMask.length; i++) {
    const lbl = atlasMask[i];
    if (lbl) {
      regionTotals.set(lbl, (regionTotals.get(lbl) || 0) + 1);
    }
    if (mniMask[i]) {
      tumourTotal++;
      if (lbl) {
        overlapCounts.set(lbl, (overlapCounts.get(lbl) || 0) + 1);
      }
    }
  }

  const byName = {};
  const involved = [];
  for (const entry of labelEntries) {
    const ov = overlapCounts.get(entry.label) || 0;
    const regTotal = regionTotals.get(entry.label) || 0;
    const pctOfTumour = tumourTotal > 0 ? round2((ov / tumourTotal) * 100) : 0;
    const pctOfRegion = regTotal > 0 ? round2((ov / regTotal) * 100) : 0;
    byName[entry.name] = pctOfTumour;
    if (ov > 0) {
      involved.push({
        label: entry.label,
        name: entry.name,
        region: entry.region || entry.name,
        laterality: entry.laterality ?? null,
        overlapVoxels: ov,
        overlapPct: pctOfTumour,
        regionPct: pctOfRegion,
      });
    }
  }
  involved.sort((a, b) => b.overlapPct - a.overlapPct || a.name.localeCompare(b.name));
  return { byName, involved };
}

// 1D exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher 2012) in O(N).
function edt1d(f, n, spacing, out, v, z) {
  const s2 = spacing * spacing;
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q];
    if (fq >= 1e20) continue;
    let s;
    while (true) {
      const r = v[k];
      const fr = f[r];
      if (fr >= 1e20) {
        if (k === 0) {
          v[0] = q;
          break;
        }
        k--;
        continue;
      }
      s = ((fq + s2 * q * q) - (fr + s2 * r * r)) / (2 * s2 * (q - r));
      if (s <= z[k]) {
        k--;
      } else {
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
        break;
      }
    }
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const diff = (q - r) * spacing;
    out[q] = diff * diff + f[r];
  }
}

// Exact 3D squared Euclidean Distance Transform from all non-zero voxels of `mask`.
// Returns Float32Array of squared distances in mm^2 in NIfTI Fortran order.
export function squaredEdt3d(mask, dims, spacing = [1, 1, 1]) {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const INF = 1e20;
  const dist = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    dist[i] = mask[i] ? 0 : INF;
  }

  const maxDim = Math.max(nx, ny, nz);
  const f = new Float64Array(maxDim);
  const out = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  const slice = nx * ny;

  // Pass X
  for (let iz = 0; iz < nz; iz++) {
    const zOff = iz * slice;
    for (let iy = 0; iy < ny; iy++) {
      const row = zOff + iy * nx;
      for (let ix = 0; ix < nx; ix++) f[ix] = dist[row + ix];
      edt1d(f, nx, spacing[0], out, v, z);
      for (let ix = 0; ix < nx; ix++) dist[row + ix] = out[ix];
    }
  }
  // Pass Y
  for (let iz = 0; iz < nz; iz++) {
    const zOff = iz * slice;
    for (let ix = 0; ix < nx; ix++) {
      const col = zOff + ix;
      for (let iy = 0; iy < ny; iy++) f[iy] = dist[col + iy * nx];
      edt1d(f, ny, spacing[1], out, v, z);
      for (let iy = 0; iy < ny; iy++) dist[col + iy * nx] = out[iy];
    }
  }
  // Pass Z
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const base = ix + iy * nx;
      for (let iz = 0; iz < nz; iz++) f[iz] = dist[base + iz * slice];
      edt1d(f, nz, spacing[2], out, v, z);
      for (let iz = 0; iz < nz; iz++) dist[base + iz * slice] = out[iz];
    }
  }
  return dist;
}

// Parse uncompressed bcb_tracts.bin (from scripts/prepare_atlases.py).
export function parseBcbTractsPack(rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const metaText = new TextDecoder().decode(bytes.subarray(4, 4 + metaLen));
  const meta = JSON.parse(metaText);
  if (meta.format !== 'bcb-tracts-bitpack-v1') {
    throw new Error(`Unsupported BCB tract pack format: ${meta.format}`);
  }
  return {
    dims: meta.dims,
    cutoff: meta.cutoff,
    tracts: meta.tracts,
    payload: bytes.subarray(4 + metaLen),
  };
}

// Compute subcortical white-matter tract overlap (%) and minimum Euclidean distance (mm)
// for every tract in the parsed BCB pack using a single 3D EDT of the tumour mask.
export function computeSubcorticalTracts(mniMask, dims, tractsPack, spacing = [1, 1, 1]) {
  if (dims[0] !== tractsPack.dims[0] || dims[1] !== tractsPack.dims[1] || dims[2] !== tractsPack.dims[2]) {
    throw new Error('Tumour mask and BCB tract pack dimensions do not match.');
  }
  let tumourTotal = 0;
  for (let i = 0; i < mniMask.length; i++) {
    if (mniMask[i]) tumourTotal++;
  }
  if (tumourTotal === 0) {
    return { tracts: [], overlapping: [], nearby: [] };
  }

  const distSq = squaredEdt3d(mniMask, dims, spacing);
  const [nx, ny] = dims;
  const slice = nx * ny;
  const payload = tractsPack.payload;
  const results = [];

  for (const tract of tractsPack.tracts) {
    const [x0, y0, z0, x1, y1, z1] = tract.bbox;
    const bx = x1 - x0;
    const by = y1 - y0;
    const bz = z1 - z0;
    const baseOffset = tract.byteOffset;
    let overlapVoxels = 0;
    let minD2 = Infinity;
    let bitIdx = 0;

    for (let lz = 0; lz < bz; lz++) {
      const zOff = (z0 + lz) * slice;
      for (let ly = 0; ly < by; ly++) {
        const yOff = zOff + (y0 + ly) * nx;
        for (let lx = 0; lx < bx; lx++, bitIdx++) {
          const byte = payload[baseOffset + (bitIdx >> 3)];
          if (((byte >> (bitIdx & 7)) & 1) === 0) continue;
          const idx = yOff + (x0 + lx);
          if (mniMask[idx]) {
            overlapVoxels++;
            minD2 = 0;
          } else if (minD2 > 0) {
            const d2 = distSq[idx];
            if (d2 < minD2) minD2 = d2;
          }
        }
      }
    }

    const overlapPct = round2((overlapVoxels / tumourTotal) * 100);
    const minDistanceMm = overlapVoxels > 0 ? 0 : Number(Math.sqrt(minD2).toFixed(2));
    results.push({
      id: tract.id,
      name: tract.name,
      overlapVoxels,
      overlapPct,
      minDistanceMm,
      tractVoxels: tract.voxels,
    });
  }

  results.sort((a, b) => (
    b.overlapPct - a.overlapPct
    || a.minDistanceMm - b.minDistanceMm
    || a.name.localeCompare(b.name)
  ));
  return {
    tracts: results,
    overlapping: results.filter((t) => t.overlapVoxels > 0),
    nearby: results.filter((t) => t.overlapVoxels === 0 && t.minDistanceMm <= 15),
  };
}

// Compute complete MNI-space RADS report from a binary tumour mask already on the
// 197 x 233 x 189 1 mm ICBM 2009a grid and loaded atlas objects.
export function computeMniRads({
  mniMask,
  dims = ICBM2009A_DIMS,
  tumourType = 'glioblastoma',
  atlases,
}) {
  const laterality = computeLaterality(mniMask, atlases.lateralisation);
  const lobes = computeCorticalOverlap(mniMask, atlases.lobes, atlases.lobeLabels ?? ATLAS_LABELS.mniLobes);
  const schaefer7 = atlases.schaefer7
    ? computeCorticalOverlap(mniMask, atlases.schaefer7, atlases.schaefer7Labels ?? ATLAS_LABELS.schaefer7)
    : null;
  const schaefer17 = atlases.schaefer17
    ? computeCorticalOverlap(mniMask, atlases.schaefer17, atlases.schaefer17Labels ?? ATLAS_LABELS.schaefer17)
    : null;
  const subcortical = atlases.bcbTracts
    ? computeSubcorticalTracts(mniMask, dims, atlases.bcbTracts)
    : null;
  const resectability = tumourType === 'glioblastoma' && atlases.resectLeft && atlases.resectRight
    ? computeResectability(mniMask, laterality.leftPct, atlases.resectLeft, atlases.resectRight)
    : null;

  let mniVoxels = 0;
  for (let i = 0; i < mniMask.length; i++) {
    if (mniMask[i]) mniVoxels++;
  }

  return {
    template: 'mni_icbm152_nlin_sym_09a',
    dims: [...dims],
    mniVoxels,
    mniVolumeMl: Number((mniVoxels * 1e-3).toFixed(3)),
    laterality,
    resectability,
    cortical: {
      mniLobes: lobes,
      schaefer7,
      schaefer17,
    },
    subcortical,
  };
}

// Crop a volume tightly around a binary mask (+margin) and resample to 1 mm canonical RAS.
function cropMaskBbox(mask, dims, margin) {
  const [nx, ny, nz] = dims;
  let minX = nx;
  let minY = ny;
  let minZ = nz;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = nx * (y + ny * z);
      for (let x = 0; x < nx; x++) {
        if (!mask[row + x]) continue;
        if (x < minX) minX = x;
        if (x + 1 > maxX) maxX = x + 1;
        if (y < minY) minY = y;
        if (y + 1 > maxY) maxY = y + 1;
        if (z < minZ) minZ = z;
        if (z + 1 > maxZ) maxZ = z + 1;
      }
    }
  }
  if (maxX < 0) return null;
  return [
    Math.max(0, minX - margin),
    Math.max(0, minY - margin),
    Math.max(0, minZ - margin),
    Math.min(nx, maxX + margin),
    Math.min(ny, maxY + margin),
    Math.min(nz, maxZ + margin),
  ];
}

function hasAffineShear(affine, tol = 1e-5) {
  const cols = [0, 1, 2].map((c) => [affine[0][c], affine[1][c], affine[2][c]]);
  const norms = cols.map((v) => Math.hypot(v[0], v[1], v[2]));
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (norms[i] <= 0 || norms[j] <= 0) return true;
      const cos = Math.abs(cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2]) / (norms[i] * norms[j]);
      if (cos > tol) return true;
    }
  }
  return false;
}

// Crop brain-masked T1c tightly around brainMask and resample to 1 mm RAS for Greedy
// registration, while cropping the moving tumour mask around its own full bounding box.
// For orthogonal affines the mask stays at native resolution (no intermediate resampling);
// for sheared affines (which Greedy rejects), it is resampled to an orthogonal RAS grid
// at the scan's own finest voxel spacing so sub-millimetre foci are preserved.
export function prepareRegistrationInputsRas(volume, brainMask, tumourMask, margin = 4) {
  const [nx, ny] = volume.dims;
  const brainBox = cropMaskBbox(brainMask, volume.dims, margin);
  if (!brainBox) {
    throw new Error('Brain mask is empty; cannot register to MNI space.');
  }
  const [bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ] = brainBox;
  const bd = [bMaxX - bMinX, bMaxY - bMinY, bMaxZ - bMinZ];
  const cropT1 = new Float32Array(bd[0] * bd[1] * bd[2]);
  for (let z = 0; z < bd[2]; z++) {
    for (let y = 0; y < bd[1]; y++) {
      const dstRow = bd[0] * (y + bd[1] * z);
      const srcRow = bMinX + nx * (bMinY + y + ny * (bMinZ + z));
      for (let x = 0; x < bd[0]; x++) {
        const si = srcRow + x;
        if (brainMask[si]) cropT1[dstRow + x] = volume.data[si];
      }
    }
  }
  const bOrigin = applyAffinePoint(volume.affine, bMinX, bMinY, bMinZ);
  const bAffine = volume.affine.map((r, i) => (i < 3 ? [r[0], r[1], r[2], bOrigin[i]] : [...r]));
  const rasT1 = resampleToOutput({ data: cropT1, dims: bd, affine: bAffine }, [1, 1, 1], 1);

  const maskBox = cropMaskBbox(tumourMask, volume.dims, 2) ?? brainBox;
  const [mMinX, mMinY, mMinZ, mMaxX, mMaxY, mMaxZ] = maskBox;
  const md = [mMaxX - mMinX, mMaxY - mMinY, mMaxZ - mMinZ];
  const cropMask = new Uint8Array(md[0] * md[1] * md[2]);
  for (let z = 0; z < md[2]; z++) {
    for (let y = 0; y < md[1]; y++) {
      const dstRow = md[0] * (y + md[1] * z);
      const srcRow = mMinX + nx * (mMinY + y + ny * (mMinZ + z));
      for (let x = 0; x < md[0]; x++) {
        if (tumourMask[srcRow + x]) cropMask[dstRow + x] = 1;
      }
    }
  }
  const mOrigin = applyAffinePoint(volume.affine, mMinX, mMinY, mMinZ);
  const mAffine = volume.affine.map((r, i) => (i < 3 ? [r[0], r[1], r[2], mOrigin[i]] : [...r]));
  if (hasAffineShear(mAffine)) {
    const finest = Math.min(...voxelSpacingMm(mAffine));
    const resampled = resampleToOutput(
      { data: Float32Array.from(cropMask), dims: md, affine: mAffine },
      [finest, finest, finest],
      0,
    );
    const orthoMask = new Uint8Array(resampled.data.length);
    for (let i = 0; i < orthoMask.length; i++) {
      if (resampled.data[i] >= 0.5) orthoMask[i] = 1;
    }
    return {
      t1: rasT1,
      mask: { data: orthoMask, dims: resampled.dims, affine: resampled.affine },
    };
  }
  return {
    t1: rasT1,
    mask: { data: cropMask, dims: md, affine: mAffine },
  };
}

// Normalize a native-space brain-masked T1c + full tumour mask onto ICBM 152 2009a
// using @neurodesk/greedy (affine NMI default, optional deformable SVF with NMI).
export async function normalizeToMniWithGreedy({
  volume,
  brainMask,
  tumourMask,
  mniTemplateBytes,
  greedyApi,
  deformable = false,
  onProgress = () => {},
}) {
  if (!greedyApi) throw new Error('Greedy WebAssembly API is required for MNI normalization.');
  const fixedBytes = await gunzip(mniTemplateBytes);
  const prepared = prepareRegistrationInputsRas(volume, brainMask, tumourMask);
  const movingT1Bytes = new Uint8Array(writeVolume(prepared.t1, 'Brain-masked 1mm RAS T1c'));
  const movingMaskBytes = new Uint8Array(writeVolume(prepared.mask, 'Tumour mask 1mm RAS'));

  onProgress({ stage: 'register', message: 'Registering brain to MNI ICBM152 (affine)' });
  const matrix = registerAffineGreedy({
    api: greedyApi,
    fixed: fixedBytes,
    moving: movingT1Bytes,
    iterations: '100x50x10',
  });

  let warpedT1Bytes;
  let warpedMaskBytes;
  if (deformable) {
    onProgress({ stage: 'register', message: 'Refining MNI alignment (deformable Greedy NMI)' });
    const affineMaskBytes = resliceAffineGreedy({
      api: greedyApi,
      fixed: fixedBytes,
      moving: movingMaskBytes,
      matrix,
      interpolation: 'nearest',
      fill: 0,
    });
    const affineMaskVol = readVolume(affineMaskBytes.slice().buffer);
    const fixedVol = readVolume(fixedBytes.slice().buffer);
    const metricMask = new Uint8Array(fixedVol.data.length);
    for (let i = 0; i < metricMask.length; i++) {
      metricMask[i] = fixedVol.data[i] > 0 && affineMaskVol.data[i] < 0.5 ? 1 : 0;
    }
    const metricMaskBytes = new Uint8Array(
      writeVolume({ data: metricMask, dims: fixedVol.dims, affine: fixedVol.affine }, 'Lesion-excluded MNI mask'),
    );
    const warp = registerSvfGreedy({
      api: greedyApi,
      fixed: fixedBytes,
      moving: movingT1Bytes,
      matrix,
      mask: metricMaskBytes,
      metric: 'NMI',
      iterations: '100x50x0',
    });
    const registration = { matrix, warp };
    warpedT1Bytes = resliceGreedy({
      api: greedyApi,
      fixed: fixedBytes,
      moving: movingT1Bytes,
      registration,
      interpolation: 'linear',
      fill: 0,
    });
    warpedMaskBytes = resliceGreedy({
      api: greedyApi,
      fixed: fixedBytes,
      moving: movingMaskBytes,
      registration,
      interpolation: 'nearest',
      fill: 0,
    });
  } else {
    warpedT1Bytes = resliceAffineGreedy({
      api: greedyApi,
      fixed: fixedBytes,
      moving: movingT1Bytes,
      matrix,
      interpolation: 'linear',
      fill: 0,
    });
    warpedMaskBytes = resliceAffineGreedy({
      api: greedyApi,
      fixed: fixedBytes,
      moving: movingMaskBytes,
      matrix,
      interpolation: 'nearest',
      fill: 0,
    });
  }

  const mniVol = readVolume(warpedMaskBytes.slice().buffer);
  const mniMask = new Uint8Array(mniVol.data.length);
  let mniVoxels = 0;
  for (let i = 0; i < mniMask.length; i++) {
    if (mniVol.data[i] >= 0.5) {
      mniMask[i] = 1;
      mniVoxels++;
    }
  }
  return {
    mniMask,
    mniVoxels,
    dims: mniVol.dims,
    affine: mniVol.affine,
    warpedT1Bytes,
    warpedMaskBytes,
    matrix,
    mode: deformable ? 'greedy-deformable' : 'greedy-affine',
  };
}
