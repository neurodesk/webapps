// Pure-JS BLAST-CT DeepMedic preprocessing, dynamic 80+15k patch planning,
// edge-padded patch extraction, and end-to-end 3D head CT segmentation pipeline.
import {
  niftiRasToSitkLps,
  prepareVolume1mm,
  resampleLabelsNearest,
} from './geometry.js';

export const HU_LOWER = -15.0;
export const HU_UPPER = 100.0;
export const RECEPTIVE_FIELD_MARGIN = 80; // input_size - output_size for 3-pathway (5, 3, 1) DeepMedic
export const STRIDE_LCM = 15; // lcm(5, 3, 1)
export const WEBGPU_OUTPUT_PATCH = 45; // 125^3 input -> 91 MiB max tensor (< 128 MiB WebGPU buffer limit)
export const CPU_OUTPUT_PATCH = 75; // 155^3 input -> 18 patches on 201x201x149 CT (~2x faster on WASM)

export const CLASSES = Object.freeze([
  Object.freeze({ id: 1, key: 'iph', shortLabel: 'IPH', label: 'Intraparenchymal haemorrhage', color: [230, 57, 70] }),
  Object.freeze({ id: 2, key: 'eah', shortLabel: 'EAH', label: 'Extra-axial haemorrhage', color: [244, 162, 97] }),
  Object.freeze({ id: 3, key: 'oedema', shortLabel: 'Oedema', label: 'Perilesional oedema', color: [42, 157, 143] }),
  Object.freeze({ id: 4, key: 'ivh', shortLabel: 'IVH', label: 'Intraventricular haemorrhage', color: [69, 123, 157] }),
]);

/**
 * Exact port of `blast_ct.nifti.transformation.IntensityWindowNormalization(-15.0, 100.0)`:
 * clamps HU to [-15, 100] and linearly maps to [-1, 1].
 */
export function intensityWindowNormalize(data, lower = HU_LOWER, upper = HU_UPPER) {
  const out = new Float32Array(data.length);
  const invSpan = 1 / (upper - lower);
  const sum = lower + upper;
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (v <= lower) v = lower;
    else if (v >= upper) v = upper;
    out[i] = (2 * v - sum) * invSpan;
  }
  return out;
}

/**
 * Plan non-overlapping output patches covering `shapeZYX = [nz, ny, nx]` where every
 * output dimension is a multiple of 15 (`<= maxOutputPatch`) and every patch start
 * is a multiple of 15. Edge patches shrink to the smallest multiple of 15 covering
 * the remaining voxels, matching upstream 110^3 DeepMedic logits identically.
 */
export function planPatches(shapeZYX, maxOutputPatch = CPU_OUTPUT_PATCH) {
  const stepMax = Math.max(STRIDE_LCM, Math.floor(maxOutputPatch / STRIDE_LCM) * STRIDE_LCM);
  const axisPlans = shapeZYX.map((size) => {
    const segs = [];
    for (let start = 0; start < size; start += stepMax) {
      const rem = size - start;
      const outSize = Math.min(stepMax, Math.max(STRIDE_LCM, Math.ceil(rem / STRIDE_LCM) * STRIDE_LCM));
      segs.push({ start, outSize, inSize: outSize + RECEPTIVE_FIELD_MARGIN });
    }
    return segs;
  });

  const patches = [];
  for (const z of axisPlans[0]) {
    for (const y of axisPlans[1]) {
      for (const x of axisPlans[2]) {
        patches.push({
          outStart: [z.start, y.start, x.start],
          outSize: [z.outSize, y.outSize, x.outSize],
          inSize: [z.inSize, y.inSize, x.inSize],
        });
      }
    }
  }
  return patches;
}

/**
 * Extract an edge-padded input patch centered on `[outStart, outStart + outSize)`
 * with margin `RECEPTIVE_FIELD_MARGIN / 2 = 40` voxels on each side (exact match to
 * `PatchSampler.get_image_patch` with `np.pad(..., mode='edge')`).
 */
export function extractPaddedPatch(vol, shapeZYX, outStart, outSize) {
  const [nz, ny, nx] = shapeZYX;
  const [oz, oy, ox] = outStart;
  const [dz, dy, dx] = outSize;
  const halfMargin = RECEPTIVE_FIELD_MARGIN / 2; // 40
  const izSize = dz + RECEPTIVE_FIELD_MARGIN;
  const iySize = dy + RECEPTIVE_FIELD_MARGIN;
  const ixSize = dx + RECEPTIVE_FIELD_MARGIN;
  const z0 = oz - halfMargin;
  const y0 = oy - halfMargin;
  const x0 = ox - halfMargin;

  const patch = new Float32Array(izSize * iySize * ixSize);
  const plane = ny * nx;
  const maxZ = nz - 1;
  const maxY = ny - 1;
  const maxX = nx - 1;

  const xMap = new Int32Array(ixSize);
  for (let ix = 0; ix < ixSize; ix++) {
    const sx = x0 + ix;
    xMap[ix] = sx < 0 ? 0 : sx > maxX ? maxX : sx;
  }

  let dst = 0;
  for (let iz = 0; iz < izSize; iz++) {
    const sz = z0 + iz;
    const cz = sz < 0 ? 0 : sz > maxZ ? maxZ : sz;
    const zOff = cz * plane;
    for (let iy = 0; iy < iySize; iy++) {
      const sy = y0 + iy;
      const cy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
      const rowOff = zOff + cy * nx;
      for (let ix = 0; ix < ixSize; ix++) {
        patch[dst++] = vol[rowOff + xMap[ix]];
      }
    }
  }
  return patch;
}

/** Write patch argmax class labels (0..4) into the reconstructed 1 mm volume. */
export function writePatchArgmax(logits, outSize, outStart, dstLabels, shapeZYX) {
  const [nz, ny, nx] = shapeZYX;
  const [oz, oy, ox] = outStart;
  const [dz, dy, dx] = outSize;
  const patchVox = dz * dy * dx;
  const dstPlane = ny * nx;

  const limZ = Math.min(dz, nz - oz);
  const limY = Math.min(dy, ny - oy);
  const limX = Math.min(dx, nx - ox);

  for (let z = 0; z < limZ; z++) {
    const dstZ = (oz + z) * dstPlane;
    const pZ = z * dy * dx;
    for (let y = 0; y < limY; y++) {
      const dstRow = dstZ + (oy + y) * nx + ox;
      const pRow = pZ + y * dx;
      for (let x = 0; x < limX; x++) {
        const p = pRow + x;
        let bestC = 0;
        let bestV = logits[p];
        for (let c = 1; c < 5; c++) {
          const v = logits[c * patchVox + p];
          if (v > bestV) {
            bestV = v;
            bestC = c;
          }
        }
        dstLabels[dstRow + x] = bestC;
      }
    }
  }
}

/**
 * End-to-end BLAST-CT head CT lesion segmentation over an injected ONNX DeepMedic runner.
 * `runModel(patchFloat32, [1, 1, iz, iy, ix])` -> Promise<Float32Array> `[1, 5, oz, oy, ox]`.
 */
export async function segmentHeadCt({
  data,
  dimsXYZ,
  rasAffine,
  maxOutputPatch = CPU_OUTPUT_PATCH,
  runModel,
  onPatch = () => {},
  signal,
}) {
  if (!dimsXYZ || dimsXYZ.length !== 3 || dimsXYZ.some((d) => d < 8)) {
    throw new Error('Expected a 3D head CT volume with at least 8 voxels along each axis.');
  }
  const expectedVox = dimsXYZ[0] * dimsXYZ[1] * dimsXYZ[2];
  if (data.length !== expectedVox) {
    throw new Error(`Volume buffer length (${data.length}) does not match dimensions ${dimsXYZ.join(' × ')}.`);
  }

  signal?.throwIfAborted();
  const nativeGeom = niftiRasToSitkLps(dimsXYZ, rasAffine);
  const { data: isoData, isoGeom } = prepareVolume1mm(data, nativeGeom);
  signal?.throwIfAborted();

  const norm = intensityWindowNormalize(isoData, HU_LOWER, HU_UPPER);
  const shapeZYX = [isoGeom.size[2], isoGeom.size[1], isoGeom.size[0]];
  const patches = planPatches(shapeZYX, maxOutputPatch);
  const isoLabels = new Uint8Array(isoData.length);

  for (let idx = 0; idx < patches.length; idx++) {
    signal?.throwIfAborted();
    const { outStart, outSize, inSize } = patches[idx];
    const patch = extractPaddedPatch(norm, shapeZYX, outStart, outSize);
    const logits = await runModel(patch, [1, 1, inSize[0], inSize[1], inSize[2]]);
    signal?.throwIfAborted();
    writePatchArgmax(logits, outSize, outStart, isoLabels, shapeZYX);
    onPatch(idx + 1, patches.length);
  }

  const nativeLabels = resampleLabelsNearest(isoLabels, isoGeom, nativeGeom);
  return {
    labels: nativeLabels,
    isoLabels,
    nativeGeom,
    isoGeom,
    patches: patches.length,
  };
}
