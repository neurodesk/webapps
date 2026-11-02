// File helpers for Node. Importing this module loads the WebAssembly synchronously.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RunAccumulator,
  initSync,
  readAnatomy,
  readApertures,
  readBensonTemplate,
  readFreeSurferCurv,
  readFreeSurferLabel,
  readFreeSurferSurface,
  readGiftiRun,
} from './index.js';

initSync({ module: readFileSync(new URL('../wasm/samsrf_wasm_bg.wasm', import.meta.url)) });

export * from './index.js';

function fromFile(path, read) {
  const bytes = readFileSync(path);
  try {
    return read(bytes);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

export function readRunFile(path) {
  return fromFile(path, readGiftiRun);
}

const APERTURE_FORMATS = [
  ['.nii.gz', 'nii'],
  ['.nii', 'nii'],
  ['.mat', 'mat'],
  ['.gif', 'gif'],
];

export function readAperturesFile(path) {
  const lower = path.toLowerCase();
  const match = APERTURE_FORMATS.find(([extension]) => lower.endsWith(extension));
  if (!match) {
    throw new Error(`${path}: apertures must be a .mat, .nii, .nii.gz or .gif file`);
  }
  return fromFile(path, (bytes) => readApertures(bytes, match[1]));
}

export function readLabelFile(path) {
  return fromFile(path, readFreeSurferLabel);
}

export function readAnatomyFolder(dir, hemisphere) {
  if (hemisphere !== 'lh' && hemisphere !== 'rh') {
    throw new Error(`hemisphere must be 'lh' or 'rh', not ${JSON.stringify(hemisphere)}`);
  }
  const read = (name) => readFileSync(join(dir, `${hemisphere}.${name}`));
  const thickness = join(dir, `${hemisphere}.thickness`);
  return readAnatomy({
    white: read('white'),
    pial: read('pial'),
    inflated: read('inflated'),
    sphere: read('sphere'),
    curv: read('curv'),
    area: read('area'),
    thickness: existsSync(thickness) ? readFileSync(thickness) : null,
  });
}

export function preprocessRuns(paths, { keep = null, ...options } = {}) {
  if (paths.length === 0) {
    throw new Error('preprocessRuns needs at least one run');
  }
  let accumulator;
  try {
    for (const path of paths) {
      const run = readRunFile(path);
      try {
        accumulator ??= new RunAccumulator(run.vertices, keep, options);
        accumulator.pushRun(run);
      } finally {
        run.free();
      }
    }
    return accumulator.finish();
  } finally {
    accumulator?.free();
  }
}

/**
 * Reads an analysis's files into the parts of a `createJob` spec, as the web app does: the runs are
 * preprocessed keeping the ROI and seed vertices (every vertex without an ROI), with the noise ceiling
 * and global signal. Every path but `runs` is optional; `hemisphere` flips a template's x0 for 'rh'.
 */
export function readAnalysisInputs({
  runs,
  roi = null,
  seed = null,
  apertures = null,
  template = null,
  white = null,
  area = null,
  hemisphere = 'lh',
  normalise = 'zscore',
  combine = 'average',
}) {
  const roiVertices = roi === null ? null : readLabelFile(roi).vertices;
  const seedVertices = seed === null ? null : readLabelFile(seed).vertices;
  const keep = roiVertices === null ? null : Uint32Array.from(new Set([...roiVertices, ...(seedVertices ?? [])])).sort();
  const data = preprocessRuns(runs, { keep, normalise, combine, noiseCeiling: true, globalSignal: true });
  const kept = data.kept ?? Uint32Array.from({ length: data.totalVertices }, (_, index) => index);
  let serialised = null;
  if (apertures !== null) {
    const read = readAperturesFile(apertures);
    serialised = read.serialize();
    read.free();
  }
  const surface = white === null ? null : fromFile(white, readFreeSurferSurface);
  return {
    roi: roiVertices,
    seed: seedVertices,
    kept,
    data: { volumes: data.volumes, vertices: kept, courses: data.data },
    noiseCeiling: data.noiseCeiling,
    globalSignal: data.globalSignal,
    apertures: serialised,
    template: template === null ? null : fromFile(template, (bytes) => readBensonTemplate(bytes, hemisphere === 'rh' ? 'rh' : 'lh')),
    area: area === null ? null : fromFile(area, readFreeSurferCurv),
    surface: surface && { vertices: surface.vertices, faces: surface.faces },
    totalVertices: data.totalVertices,
  };
}

/** The `createJob` spec for `kind` on `readAnalysisInputs` output; `roi` overrides the ROI label. */
export function analysisSpec(inputs, kind, model, { roi = inputs.roi } = {}) {
  return {
    kind,
    model: typeof model === 'string' ? model : JSON.stringify(model),
    apertures: inputs.apertures ?? undefined,
    data: inputs.data,
    roi,
    noiseCeiling: inputs.noiseCeiling,
    globalSignal: inputs.globalSignal,
    seed: inputs.seed && inputs.template ? { vertices: inputs.seed, template: inputs.template } : null,
    surface: inputs.surface,
    area: inputs.area,
    totalVertices: inputs.totalVertices,
  };
}

/** The `[start, end)` ranges that split `total` positions into `shards` pieces. */
export function shardRanges(total, shards = 1) {
  return Array.from({ length: shards }, (_, index) => [Math.floor((index * total) / shards), Math.floor(((index + 1) * total) / shards)]);
}

/** Runs a job over `[0, vertexCount)` in `shards` pieces in this thread and merges, as the app does. */
export function runJob(job, shards = 1, onProgress) {
  const total = job.vertexCount;
  const partials = shardRanges(total, shards).map(([start, end]) => job.run(start, end, onProgress ? (done) => onProgress(start + done, total) : undefined));
  return job.merge(partials.reverse());
}
