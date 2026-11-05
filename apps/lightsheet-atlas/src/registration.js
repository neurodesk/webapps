// Atlas registration with Greedy (affine NMI, then a stationary-velocity warp) and the maps it
// yields on the sample's downsampled grid: the atlas labels (as brainreg's registered_atlas) and,
// for every sample voxel, its atlas voxel coordinate (as brainreg's deformation_field_*).
//
// The sample is Greedy's fixed image and the atlas template its moving image, so one transform
// both carries labels into the sample and maps sample points (cells) into the atlas.
// `api` is the Greedy WebAssembly module (@neurodesk/greedy, wasm-single build).

import { createNiftiFromData, createNiftiHeaderFromVolume, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';

export const REGISTRATION = Object.freeze({
  affineIterations: '100x50x10',
  deformableMetric: 'NCC 2x2x2',
  deformableIterations: '100x50x0',
});

const bytes = (buffer) => new Uint8Array(buffer);

/** NIfTI bytes of `data` on an atlas-orientation grid of `shape`, with the atlas header's affine. */
export function gridNifti(data, shape, atlasHeader) {
  return bytes(createNiftiFromData(data, atlasHeader, { dims: shape, range: 'auto' }));
}

/**
 * A NIfTI header for an asr grid of `shape` with `spacingUm` per axis: x = -r, y = -a, z = -s
 * (mm), the orientation the atlas files use, so NIfTI viewers show anatomical directions.
 */
export function gridHeader(shape, spacingUm) {
  const [sa, ss, sr] = spacingUm.map((v) => v / 1000);
  return createNiftiHeaderFromVolume({
    hdr: { dims: [...shape], pixDims: [1, sa, ss, sr], affine: [[0, 0, -sr, 0], [-sa, 0, 0, 0], [0, -ss, 0, 0]] },
  });
}

function coordinateImage(shape, axis) {
  const [A, S, R] = shape;
  const data = new Float32Array(A * S * R);
  let i = 0;
  for (let r = 0; r < R; r++) for (let s = 0; s < S; s++) for (let a = 0; a < A; a++) data[i++] = axis === 0 ? a : axis === 1 ? s : r;
  return data;
}

/**
 * Register the sample (Float32Array on its asr grid of `shape`) to the atlas.
 * `atlas` = { template: raw .nii bytes, annotation: raw .nii bytes (uint16 indices), shape }.
 * Returns { matrix, labels: Uint16Array, coordinates: [Float32Array x3] (atlas voxel indices,
 * -1 outside the atlas), sampleNifti }.
 */
export function registerToAtlas({ api, sample, shape, atlas, onStage = () => {}, settings = REGISTRATION }) {
  const sampleNifti = gridNifti(sample, shape, atlas.template);
  const moving = bytes(atlas.template);
  onStage('affine');
  const matrix = api.register_affine_masked_wasm(sampleNifti, moving, null, 'NMI', settings.affineIterations, true, null);
  onStage('deformable');
  const warp = api.register_svf_masked_wasm(sampleNifti, moving, null, matrix, settings.deformableMetric, settings.deformableIterations);
  onStage('labels');
  const resample = (image, nearest, fill) => readNiftiImageData(
    api.reslice_warp_affine_options(sampleNifti, image, warp, matrix, null, nearest, fill),
  ).data;
  const labelValues = resample(bytes(atlas.annotation), true, 0);
  const labels = Uint16Array.from(labelValues, (v) => Math.round(v));
  onStage('coordinates');
  const coordinates = [0, 1, 2].map((axis) => resample(gridNifti(coordinateImage(atlas.shape, axis), atlas.shape, atlas.template), false, -1));
  return { matrix, warp, labels, coordinates, sampleNifti };
}

/** Trilinear sample of a grid volume (axis 0 fastest) at a continuous index; null outside. */
export function sampleTrilinear(volume, shape, point) {
  const [A, S, R] = shape;
  const [a, s, r] = point;
  if (!(a >= 0 && s >= 0 && r >= 0 && a <= A - 1 && s <= S - 1 && r <= R - 1)) return null;
  const a0 = Math.min(Math.floor(a), A - 2 < 0 ? 0 : A - 2);
  const s0 = Math.min(Math.floor(s), S - 2 < 0 ? 0 : S - 2);
  const r0 = Math.min(Math.floor(r), R - 2 < 0 ? 0 : R - 2);
  const fa = A > 1 ? a - a0 : 0;
  const fs = S > 1 ? s - s0 : 0;
  const fr = R > 1 ? r - r0 : 0;
  let value = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? fa : 1 - fa) * (j ? fs : 1 - fs) * (k ? fr : 1 - fr);
        if (w === 0) continue;
        const v = volume[Math.min(a0 + i, A - 1) + A * (Math.min(s0 + j, S - 1) + S * Math.min(r0 + k, R - 1))];
        if (v < 0) return null;
        value += w * v;
      }
    }
  }
  return value;
}
