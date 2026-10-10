// SynthStrip brain extraction. Ported 1:1 from
// neurodesk/vesselboost-webapp@/web/js/inference-worker.js (stepSynthStrip,
// lines 1562..1880). Behavior preserved, structure normalised: pure helpers
// are isolated and exported for unit testing; runSynthStrip takes its
// dependencies (model bytes, ort namespace, progress callbacks) as
// arguments rather than reaching into a worker-global state object.
//
// Pipeline (RAS-oriented input -> binary brain mask in RAS):
//   1. RAS -> LIA reorientation (model trained on LIA brains)
//   2. Resample to 1mm isotropic ("fast" -> adaptive 1..2mm to keep min
//      resampled axis >= 48 voxels on high-res inputs)
//   3. Crop to bounding box of nonzero voxels
//   4. Center-pad to per-axis multiple of 64 within [192, 320]
//   5. Per-volume P99 normalisation (subtract min, divide by 99th pct of
//      nonzero voxels, clamp to [0,1])
//   6. Fortran-order -> C-order transpose into ONNX tensor
//   7. ONNX inference (WASM execution provider only — WebGPU lacks 3D MaxPool)
//   8. C-order -> Fortran-order transpose back
//   9. If fast-mode resampled the input, reverse center-pad/crop on the
//      signed-distance transform, linearly resample it back to original
//      LIA dims, then threshold. This preserves a sub-voxel boundary and
//      avoids overgrowing the mask by nearest-upsampling a 2mm binary mask.
//      Non-resampled inputs threshold on the conformed grid as before.
//   10. Largest CC + interior fill (FreeSurfer SynthStrip default)
//   11. LIA -> RAS reorientation
//   12. (Optional) 1-voxel 6-conn dilation — vesselboost behaviour, off by
//       default for LNM where we want a tighter mask.

import {
  resampleVolume,
  resampleLabelsNearest,
  keepLargestComponentAndFill
} from './volume-utils.js';

// ---------------- Pure helpers (exported for unit testing) ----------------

export function computeFreeSurferTargetDims(cropDims) {
  return cropDims.map(s => Math.min(320, Math.max(192, Math.ceil(s / 64) * 64)));
}

export function centerPadConform(croppedData, cropDims, targetDims) {
  const [cnx, cny, cnz] = cropDims;
  const [tnx, tny, tnz] = targetDims;
  const offsets = [
    Math.floor((tnx - cnx) / 2),
    Math.floor((tny - cny) / 2),
    Math.floor((tnz - cnz) / 2)
  ];
  const data = new Float32Array(tnx * tny * tnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      for (let x = 0; x < cnx; x++) {
        const dx = x + offsets[0];
        const dy = y + offsets[1];
        const dz = z + offsets[2];
        data[dx + dy * tnx + dz * tnx * tny] =
          croppedData[x + y * cnx + z * cnx * cny];
      }
    }
  }
  return { data, offsets };
}

export function uncenterUnpadMask(paddedMask, targetDims, cropDims, offsets) {
  const [cnx, cny, cnz] = cropDims;
  const [tnx, tny] = targetDims;
  const result = new Uint8Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      for (let x = 0; x < cnx; x++) {
        const sx = x + offsets[0];
        const sy = y + offsets[1];
        const sz = z + offsets[2];
        result[x + y * cnx + z * cnx * cny] =
          paddedMask[sx + sy * tnx + sz * tnx * tny];
      }
    }
  }
  return result;
}

// FreeSurfer P99 normalisation: subtract min, divide by p99 of nonzero,
// clamp to [0,1]. Returns a NEW array — input is not mutated. p99 is
// computed by sorting the nonzero values (matches vesselboost's exact
// floor-index convention).
export function p99Normalize(data) {
  const n = data.length;
  let vMin = Infinity;
  for (let i = 0; i < n; i++) {
    if (data[i] < vMin) vMin = data[i];
  }
  if (!isFinite(vMin)) vMin = 0;

  const shifted = new Float32Array(n);
  for (let i = 0; i < n; i++) shifted[i] = data[i] - vMin;

  let nonZeroCount = 0;
  for (let i = 0; i < n; i++) {
    if (shifted[i] > 0) nonZeroCount++;
  }
  let p99 = 0;
  if (nonZeroCount > 0) {
    const nonZero = new Float32Array(nonZeroCount);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      if (shifted[i] > 0) nonZero[idx++] = shifted[i];
    }
    nonZero.sort();
    p99 = nonZero[Math.floor(nonZeroCount * 0.99)];
  }
  const denom = p99 || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.min(1, Math.max(0, shifted[i] / denom));
  }
  return { data: out, vMin, p99 };
}

// Fortran-order (x + y*nx + z*nx*ny) -> C-order (x*ny*nz + y*nz + z).
// SynthStrip's ONNX wrapper expects C-order with dim layout [nx, ny, nz].
export function fortranToCOrder(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        out[x * ny * nz + y * nz + z] = data[x + y * nx + z * nx * ny];
      }
    }
  }
  return out;
}

export function cOrderToFortran(data, dims) {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        out[x + y * nx + z * nx * ny] = data[x * ny * nz + y * nz + z];
      }
    }
  }
  return out;
}

// 6-connectivity binary dilation by `radius` voxels. Iterative (one
// 6-neighbour expansion per radius step). Used to expand the SynthStrip
// brain mask outward — vesselboost defaults to radius=1 to catch boundary
// vessels. LNM default is radius=0 (off).
export function dilate3D(mask, dims, radius = 1) {
  if (!radius || radius < 1) {
    const copy = new Uint8Array(mask.length);
    copy.set(mask);
    return copy;
  }
  const [nx, ny, nz] = dims;
  let cur = new Uint8Array(mask.length);
  cur.set(mask);
  let next = new Uint8Array(mask.length);
  for (let r = 0; r < radius; r++) {
    next.fill(0);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = x + y * nx + z * nx * ny;
          if (cur[idx]) {
            next[idx] = 1;
            if (x > 0) next[idx - 1] = 1;
            if (x < nx - 1) next[idx + 1] = 1;
            if (y > 0) next[idx - nx] = 1;
            if (y < ny - 1) next[idx + nx] = 1;
            if (z > 0) next[idx - nx * ny] = 1;
            if (z < nz - 1) next[idx + nx * ny] = 1;
          }
        }
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  return cur;
}

// ---------------- Orchestration ----------------

function rasToLia(rasData, rasDims) {
  // perm = [0, 2, 1], flip = [true, true, false]
  // (matches vesselboost stepSynthStrip lines 1591..1610.)
  const liaDims = [rasDims[0], rasDims[2], rasDims[1]];
  const [dx, dy, dz] = liaDims;
  const out = new Float32Array(rasData.length);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        // src axis 0 = flip, axis 1 (perm 2 -> axis 1) = flip, axis 2 (perm 1 -> axis 2) = no flip
        const sx = liaDims[0] - 1 - ox;          // flip[0]=true, perm[0]=0
        const sz = liaDims[1] - 1 - oy;          // flip[1]=true, perm[1]=2 -> RAS axis 2
        const sy = oz;                           // flip[2]=false, perm[2]=1 -> RAS axis 1
        const srcIdx = sx + sy * rasDims[0] + sz * rasDims[0] * rasDims[1];
        out[ox + oy * dx + oz * dx * dy] = rasData[srcIdx];
      }
    }
  }
  return { data: out, dims: liaDims };
}

function liaMaskToRas(liaMask, liaDims, rasDims) {
  // Inverse of rasToLia for a binary mask.
  const [dx, dy, dz] = liaDims;
  const out = new Uint8Array(rasDims[0] * rasDims[1] * rasDims[2]);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        if (!liaMask[ox + oy * dx + oz * dx * dy]) continue;
        const dxRas = liaDims[0] - 1 - ox;       // flip[0]=true, perm[0]=0
        const dzRas = liaDims[1] - 1 - oy;       // flip[1]=true, perm[1]=2
        const dyRas = oz;                        // flip[2]=false, perm[2]=1
        out[dxRas + dyRas * rasDims[0] + dzRas * rasDims[0] * rasDims[1]] = 1;
      }
    }
  }
  return out;
}

function computeBoundingBox(data, dims) {
  const [nx, ny, nz] = dims;
  let minX = nx, minY = ny, minZ = nz;
  let maxX = -1, maxY = -1, maxZ = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[x + y * nx + z * nx * ny] > 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }
  if (maxX < minX) {
    return { min: [0, 0, 0], max: dims, isEmpty: true };
  }
  return { min: [minX, minY, minZ], max: [maxX + 1, maxY + 1, maxZ + 1], isEmpty: false };
}

export function chooseFastTargetSpacing(data, dims, spacing) {
  const bbox = computeBoundingBox(data, dims);
  if (bbox.isEmpty) return [1.0, 1.0, 1.0];

  const cropExtents = [
    (bbox.max[0] - bbox.min[0]) * spacing[0],
    (bbox.max[1] - bbox.min[1]) * spacing[1],
    (bbox.max[2] - bbox.min[2]) * spacing[2]
  ];
  const fullExtents = dims.map((d, i) => d * spacing[i]);
  const minExtent = Math.min(...fullExtents);

  // Keep the conformed ONNX tensor at 192^3 whenever possible. A blanket
  // 2mm downsample still produces a 192^3 tensor for many 1mm clinical
  // heads, but it removes boundary detail and overgrows the final mask.
  const spacingForConform192 = Math.max(...cropExtents.map(e => e / 191));
  const spacingForMinDim48 = minExtent / 48;
  const nativeFloor = Math.min(2.0, Math.max(1.0, Math.min(...spacing)));
  const sp = Math.max(
    nativeFloor,
    Math.min(2.0, spacingForMinDim48, spacingForConform192)
  );
  return [sp, sp, sp];
}

function cropToBBox(data, dims, bbox) {
  const [nx, ny] = dims;
  const [oxMin, oyMin, ozMin] = bbox.min;
  const [oxMax, oyMax, ozMax] = bbox.max;
  const cdims = [oxMax - oxMin, oyMax - oyMin, ozMax - ozMin];
  const cropped = new Float32Array(cdims[0] * cdims[1] * cdims[2]);
  for (let z = 0; z < cdims[2]; z++) {
    for (let y = 0; y < cdims[1]; y++) {
      for (let x = 0; x < cdims[0]; x++) {
        const srcIdx = (oxMin + x) + (oyMin + y) * nx + (ozMin + z) * nx * ny;
        cropped[x + y * cdims[0] + z * cdims[0] * cdims[1]] = data[srcIdx];
      }
    }
  }
  return { data: cropped, dims: cdims };
}

function placeBackInResampledFrame(croppedMask, cropDims, fullDims, bbox) {
  const out = new Uint8Array(fullDims[0] * fullDims[1] * fullDims[2]);
  const [oxMin, oyMin, ozMin] = bbox.min;
  const [fnx, fny] = fullDims;
  const [cnx, cny, cnz] = cropDims;
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      for (let x = 0; x < cnx; x++) {
        const dst = (oxMin + x) + (oyMin + y) * fnx + (ozMin + z) * fnx * fny;
        out[dst] = croppedMask[x + y * cnx + z * cnx * cny];
      }
    }
  }
  return out;
}

function uncenterUnpadFloat(paddedData, targetDims, cropDims, offsets) {
  const [cnx, cny, cnz] = cropDims;
  const [tnx, tny] = targetDims;
  const result = new Float32Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      for (let x = 0; x < cnx; x++) {
        const sx = x + offsets[0];
        const sy = y + offsets[1];
        const sz = z + offsets[2];
        result[x + y * cnx + z * cnx * cny] =
          paddedData[sx + sy * tnx + sz * tnx * tny];
      }
    }
  }
  return result;
}

function placeBackFloat(croppedData, cropDims, fullDims, bbox, fillValue) {
  const out = new Float32Array(fullDims[0] * fullDims[1] * fullDims[2]);
  out.fill(fillValue);
  const [oxMin, oyMin, ozMin] = bbox.min;
  const [fnx, fny] = fullDims;
  const [cnx, cny, cnz] = cropDims;
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      for (let x = 0; x < cnx; x++) {
        const dst = (oxMin + x) + (oyMin + y) * fnx + (ozMin + z) * fnx * fny;
        out[dst] = croppedData[x + y * cnx + z * cnx * cny];
      }
    }
  }
  return out;
}

function resampleFloatToDims(data, dims, targetDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = targetDims;
  const result = new Float32Array(tnx * tny * tnz);
  const scaleX = (nx - 1) / Math.max(tnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(tny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(tnz - 1, 1);

  for (let z = 0; z < tnz; z++) {
    const sz = z * scaleZ;
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sz - z0;
    for (let y = 0; y < tny; y++) {
      const sy = y * scaleY;
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sy - y0;
      for (let x = 0; x < tnx; x++) {
        const sx = x * scaleX;
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sx - x0;

        const c000 = data[x0 + y0 * nx + z0 * nx * ny];
        const c100 = data[x1 + y0 * nx + z0 * nx * ny];
        const c010 = data[x0 + y1 * nx + z0 * nx * ny];
        const c110 = data[x1 + y1 * nx + z0 * nx * ny];
        const c001 = data[x0 + y0 * nx + z1 * nx * ny];
        const c101 = data[x1 + y0 * nx + z1 * nx * ny];
        const c011 = data[x0 + y1 * nx + z1 * nx * ny];
        const c111 = data[x1 + y1 * nx + z1 * nx * ny];

        const c00 = c000 * (1 - wx) + c100 * wx;
        const c01 = c001 * (1 - wx) + c101 * wx;
        const c10 = c010 * (1 - wx) + c110 * wx;
        const c11 = c011 * (1 - wx) + c111 * wx;
        const c0 = c00 * (1 - wy) + c10 * wy;
        const c1 = c01 * (1 - wy) + c11 * wy;

        result[x + y * tnx + z * tnx * tny] = c0 * (1 - wz) + c1 * wz;
      }
    }
  }

  return result;
}

function thresholdSdt(data, border) {
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (data[i] < border) mask[i] = 1;
  }
  return mask;
}

// Public entry point. Caller hands in already-decoded, RAS-oriented voxel
// data + the SynthStrip ONNX model bytes + an `ort` namespace (the bundled
// onnxruntime-web). Returns { mask: Uint8Array (RAS, same dims as input),
// voxelCount, coveragePct, vMin, p99 }.
export async function runSynthStrip({
  rasData,
  rasDims,
  rasSpacing,
  modelArrayBuffer,
  ort,
  fast = false,
  dilate = false,
  // Execution providers passed straight through to ort.InferenceSession.create.
  // Defaults to ['wasm'] for browser module workers (WebGPU lacks 3D MaxPool).
  // Node-side parity tests pass ['cpu'] to use onnxruntime-node.
  executionProviders = ['wasm'],
  onProgress = () => {},
  onLog = () => {}
}) {
  if (!rasData || !rasDims || !rasSpacing || !modelArrayBuffer || !ort) {
    throw new Error('runSynthStrip: missing required argument');
  }

  const modeLabel = fast ? 'SynthStrip Fast' : 'SynthStrip';
  onProgress(0.02, `${modeLabel}: reorienting RAS->LIA...`);

  // 1. RAS -> LIA
  const lia = rasToLia(rasData, rasDims);
  const liaSpacing = [rasSpacing[0], rasSpacing[2], rasSpacing[1]];
  const targetSpacing = fast
    ? chooseFastTargetSpacing(lia.data, lia.dims, liaSpacing)
    : [1.0, 1.0, 1.0];
  onLog(`Reoriented RAS->LIA: ${rasDims.join('x')} -> ${lia.dims.join('x')}`);

  // 2. Resample to target spacing
  const needsResample =
    liaSpacing[0] !== targetSpacing[0] ||
    liaSpacing[1] !== targetSpacing[1] ||
    liaSpacing[2] !== targetSpacing[2];
  let workData, workDims;
  if (needsResample) {
    onProgress(0.04, `${modeLabel}: resampling to ${targetSpacing[0].toFixed(2)}mm...`);
    const r = resampleVolume(lia.data, lia.dims, liaSpacing, targetSpacing);
    workData = r.data; workDims = r.dims;
    onLog(`Resampled: ${lia.dims.join('x')} -> ${workDims.join('x')} (${targetSpacing[0]}mm)`);
  } else {
    workData = lia.data; workDims = [...lia.dims];
  }
  const resampledDims = [...workDims];

  // 3. Crop to bbox of nonzero
  onProgress(0.05, `${modeLabel}: cropping to brain bbox...`);
  const bbox = computeBoundingBox(workData, workDims);
  if (bbox.isEmpty) {
    onLog('Empty volume; returning empty mask.');
    return {
      mask: new Uint8Array(rasData.length),
      voxelCount: 0,
      coveragePct: 0,
      vMin: 0,
      p99: 0
    };
  }
  const cropped = cropToBBox(workData, workDims, bbox);
  onLog(`Cropped to bbox: ${workDims.join('x')} -> ${cropped.dims.join('x')}`);

  // 4. Center-pad to FreeSurfer target shape
  const targetDims = computeFreeSurferTargetDims(cropped.dims);
  const { data: conformedData, offsets: centerOffsets } =
    centerPadConform(cropped.data, cropped.dims, targetDims);
  onLog(`Conformed: ${cropped.dims.join('x')} -> ${targetDims.join('x')} (offsets: ${centerOffsets.join(',')})`);

  // 5. Normalise to [0, 1]
  onProgress(0.07, `${modeLabel}: normalising...`);
  const { data: normalized, vMin, p99 } = p99Normalize(conformedData);
  onLog(`Normalized: vMin=${vMin.toFixed(2)}, p99=${p99.toFixed(2)}`);

  // 6. Create ONNX session (WASM only — WebGPU lacks 3D MaxPool)
  onProgress(0.10, `${modeLabel}: loading model...`);
  const session = await ort.InferenceSession.create(modelArrayBuffer, {
    executionProviders,
    graphOptimizationLevel: 'all'
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  onLog(`ONNX session ready. Input=${inputName} Output=${outputName}`);

  // 7. F-order -> C-order, infer, C-order -> F-order
  onProgress(0.30, `${modeLabel}: inference on ${targetDims.join('x')}...`);
  const cInput = fortranToCOrder(normalized, targetDims);
  const inputTensor = new ort.Tensor('float32', cInput, [1, 1, ...targetDims]);
  let sdtData;
  try {
    const results = await session.run({ [inputName]: inputTensor });
    sdtData = cOrderToFortran(results[outputName].data, targetDims);
  } finally {
    if (typeof inputTensor.dispose === 'function') inputTensor.dispose();
    if (typeof session.release === 'function') session.release();
  }

  // 8. SDT < 1 -> binary mask
  onProgress(0.85, `${modeLabel}: thresholding SDT...`);
  const SDT_BORDER = 1;
  const effectiveSdtBorder = needsResample
    ? SDT_BORDER / Math.max(targetSpacing[0], targetSpacing[1], targetSpacing[2])
    : SDT_BORDER;
  const totalConformed = targetDims[0] * targetDims[1] * targetDims[2];
  let sdtMin = Infinity, sdtMax = -Infinity;
  for (let i = 0; i < totalConformed; i++) {
    const v = sdtData[i];
    if (v < sdtMin) sdtMin = v;
    if (v > sdtMax) sdtMax = v;
  }
  onLog(
    `SDT range [${sdtMin.toFixed(2)}, ${sdtMax.toFixed(2)}]; ` +
    `threshold < ${effectiveSdtBorder.toFixed(2)}`
  );

  let liaMask;
  if (needsResample) {
    onProgress(0.88, `${modeLabel}: resampling SDT boundary...`);
    const croppedSdt =
      uncenterUnpadFloat(sdtData, targetDims, cropped.dims, centerOffsets);
    const resampledSdt = placeBackFloat(
      croppedSdt,
      cropped.dims,
      resampledDims,
      bbox,
      effectiveSdtBorder + 1
    );
    const liaSdt = resampleFloatToDims(resampledSdt, resampledDims, lia.dims);
    liaMask = thresholdSdt(liaSdt, effectiveSdtBorder);
  } else {
    const conformedMask = thresholdSdt(sdtData, effectiveSdtBorder);
    const croppedMask =
      uncenterUnpadMask(conformedMask, targetDims, cropped.dims, centerOffsets);
    liaMask = placeBackInResampledFrame(
      croppedMask, cropped.dims, resampledDims, bbox
    );
  }

  // 9. Largest CC + interior fill (FreeSurfer SynthStrip default)
  onProgress(0.90, `${modeLabel}: cleaning mask...`);
  liaMask = keepLargestComponentAndFill(liaMask, lia.dims);

  // 10. LIA -> RAS
  let finalMask = liaMaskToRas(liaMask, lia.dims, rasDims);

  // 11. Optional dilation (off for LNM by default)
  if (dilate) {
    onProgress(0.95, `${modeLabel}: dilating mask by 1 voxel...`);
    finalMask = dilate3D(finalMask, rasDims, 1);
  }

  let voxelCount = 0;
  for (let i = 0; i < finalMask.length; i++) {
    if (finalMask[i]) voxelCount++;
  }
  const coveragePct = (100 * voxelCount) / Math.max(1, finalMask.length);
  onLog(`${modeLabel} complete: ${voxelCount} brain voxels (${coveragePct.toFixed(1)}% coverage).`);
  onProgress(1.0, `${modeLabel} complete`);

  return { mask: finalMask, voxelCount, coveragePct, vMin, p99 };
}
