// File helpers for Node. Importing this module loads the WebAssembly synchronously.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RunAccumulator,
  initSync,
  readAnatomy,
  readApertures,
  readFreeSurferLabel,
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
