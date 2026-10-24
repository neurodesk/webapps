// BISON from raw images to the downloads, shared by the browser worker and the command line.
// A T1 alone runs BISON (8 classes); a T1 with a FLAIR runs BISON-WMH (9 classes, with WMH).
//
// Pure: the tools and the assets are injected.
//   drivers: createRegistration, createDenoiser, niimath (see preprocess.js), ort (ONNX Runtime),
//            sessionOptions (optional, for ort.InferenceSession.create)
//   assets:  Map of manifest filename to verified bytes (assets.js)
//   hooks:   onProgress(message), onLog(line), checkpoint(name, bytes), onClassify(fraction), signal
import { decodeNiftiBuffer, parseNiftiHeader, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { MODE_ASSETS, assetsFor } from './assets.js';
import { classifyVoxels, createClassifier } from './classify.js';
import { histogramTable, maskVoxels, modeSpec } from './features.js';
import { CLASS_SLUGS, outputFiles } from './outputs.js';
import { preprocess } from './preprocess.js';

export { CLASS_SLUGS, outputNames } from './outputs.js';
export { MODES } from './features.js';

// BISON was trained on 1 mm images; coarser T1 voxels lose the cortex.
export const MAX_T1_VOXEL_MM = 2;

export function modeFor({ t1, flair }) {
  if (!t1 && flair) throw new Error('BISON needs a T1 image; a FLAIR alone cannot be segmented.');
  if (!t1) throw new Error('BISON needs a T1 image.');
  return flair ? 't1-flair' : 't1';
}

function voxelSize(affine) {
  return [0, 1, 2].map((c) => Math.hypot(affine[0][c], affine[1][c], affine[2][c]));
}

function voxelVolumeMm3(affine) {
  const [a, b, c] = affine;
  return Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
}

/** Refuses an image that is not one 3D volume, has non-finite or constant voxels, or (T1) voxels over 2 mm. */
export async function checkInput(bytes, name, { maxVoxelMm = Infinity } = {}) {
  const { data, header } = readNiftiImageData(await decodeNiftiBuffer(bytes));
  let frames = 1;
  for (let d = 4; d <= header.dims[0]; d++) frames *= Math.max(1, header.dims[d]);
  if (header.dims[0] < 3 || header.nz < 2 || frames !== 1) throw new Error(`The ${name} must be a single 3D volume.`);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (!Number.isFinite(value)) throw new Error(`The ${name} has NaN or infinite voxels.`);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!(max > min)) throw new Error(`The ${name} is constant.`);
  const size = voxelSize(header.affine);
  const volume = voxelVolumeMm3(header.affine);
  if (header.affine.some((row) => row.some((value) => !Number.isFinite(value)))
    || size.some((mm) => !Number.isFinite(mm) || mm <= 0)
    || !Number.isFinite(volume) || volume <= 0) {
    throw new Error(`The ${name} geometry must have finite coordinates and an invertible voxel grid.`);
  }
  if (size.some((mm) => mm > maxVoxelMm)) {
    throw new Error(`The ${name} voxels are ${size.map((mm) => mm.toFixed(2)).join(' x ')} mm; BISON needs ${maxVoxelMm} mm or finer.`);
  }
  return { dims: [header.nx, header.ny, header.nz], voxelSize: size };
}

function checkAssets(assets, mode) {
  for (const { filename } of assetsFor([mode])) {
    if (!assets.has(filename)) throw new Error(`The BISON asset ${filename} is missing.`);
  }
}

function histogram(assets, filename, classes) {
  return histogramTable(JSON.parse(new TextDecoder().decode(assets.get(filename))), classes);
}

/** Voxels and millilitres of every class inside the mask; label 0 is the forest's background class. */
export function classVolumes(labels, mode, header) {
  const { classes } = modeSpec(mode);
  const voxelMl = voxelVolumeMm3(header.affine) / 1000;
  const counts = new Float64Array(classes + 1);
  for (let i = 0; i < labels.length; i++) counts[labels[i]]++;
  return CLASS_SLUGS.slice(0, classes).map((slug, k) => ({ label: k + 1, slug, voxels: counts[k + 1], ml: counts[k + 1] * voxelMl }));
}

/**
 * Runs BISON on raw NIfTI bytes and returns the downloads on the T1 grid:
 * { mode, files: [{ name, bytes }], volumes, volumePol, timings, memory } (memory: peak heap bytes per stage).
 */
export async function runBison({ t1, flair = null, t1Name = 't1.nii.gz' }, drivers, assets, hooks = {}) {
  const { signal, onClassify, ...preprocessHooks } = hooks;
  const mode = modeFor({ t1, flair });
  const spec = modeSpec(mode);
  const files = MODE_ASSETS[mode];
  checkAssets(assets, mode);
  if (!drivers.ort) throw new Error('BISON needs an ONNX Runtime driver.');
  await checkInput(t1, 'T1', { maxVoxelMm: MAX_T1_VOXEL_MM });
  if (flair) await checkInput(flair, 'FLAIR');
  signal?.throwIfAborted();

  const onProgress = (message) => {
    hooks.onProgress?.(message);
    signal?.throwIfAborted();
  };
  const pre = await preprocess({ t1, flair, modes: [mode], assets, drivers, ...preprocessHooks, onProgress });
  const { timings } = pre;

  onProgress('Classifying tissues');
  const started = performance.now();
  const images = {
    mode,
    t1: pre.t1,
    avT1: pre.avT1,
    priors: pre.priors[mode],
    t1Histogram: histogram(assets, files.t1Histogram, spec.classes),
  };
  if (spec.flair) {
    images.flair = pre.flair;
    images.avFlair = pre.avFlair;
    images.flairHistogram = histogram(assets, files.flairHistogram, spec.classes);
  }
  const voxels = maskVoxels(pre.mask);
  if (voxels.length === 0) throw new Error('The brain mask is empty; the T1 could not be registered to the template.');
  const classifier = await createClassifier(drivers.ort, assets.get(files.classifier), drivers.sessionOptions);
  let result;
  try {
    result = await classifyVoxels(classifier, images, voxels, { signal, onProgress: onClassify });
  } finally {
    await classifier.session.release?.();
  }
  timings.classify = (performance.now() - started) / 1000;

  onProgress('Writing results');
  const written = performance.now();
  const outputs = [];
  for (const file of outputFiles({ t1Name, t1Header: pre.header, mode, voxels, labels: result.labels, probabilities: result.probabilities })) {
    signal?.throwIfAborted();
    outputs.push(file);
  }
  timings.write = (performance.now() - written) / 1000;
  return { mode, files: outputs, volumes: classVolumes(result.labels, mode, parseNiftiHeader(pre.header)), volumePol: pre.volumePol, timings, memory: pre.memory };
}
