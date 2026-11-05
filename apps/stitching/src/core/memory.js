// Working-memory preflight: what each step of a run allocates, from the tile shapes and the
// layout alone, so a job that would not fit is refused before anything is allocated and the
// number of registration workers is bounded by the budget.
//
// Registering a pair holds the two overlap regions as float64 (16 bytes per region pixel) and
// four float64 arrays the size of the padded power-of-two FFT frame (the real and imaginary
// FFT input and the phase correlation's real and imaginary parts, 32 bytes per frame pixel).
// Fusing holds a sum and a weight per fused pixel (float32 for 8- and 16-bit tiles, float64
// otherwise) and four copies of the result in the tiles' sample type: the worker's output, the
// TIFF, the display NIfTI and the OME-Zarr archive.
//
// The global optimisation solves each connected component of linked tiles as a dense system:
// an n × n float64 matrix for its n − 1 free tiles and a copy for the Cholesky factor, one
// component at a time. Rejected links only split components, so the planned pairs' components
// bound it before any pair is registered.
//
// With cross-origin isolation the tiles are decoded into SharedArrayBuffers and every worker
// reads the same bytes; without it each worker receives a structured-clone copy, counted here
// as a copy of every tile per worker.
import { formatBytes } from '@neurodesk/webapp-components/file-io/input-limits';
import { accumulatesInFloat64Type } from './fusion.js';
import { components } from './global.js';
import { frameShape, overlapRegion } from './pairwise.js';

/** Bytes the tiles, pair registrations and fusion of one run may hold at once. */
export const MEMORY_BUDGET = 4e9;

const SAMPLE_BYTES = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 };

export class MemoryBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryBudgetError';
  }
}

function product(values) {
  return values.reduce((a, b) => a * b, 1);
}

/** Bytes the decoded tiles take, all in one sample type. */
export function tileBytes(shapes, dtype) {
  return shapes.reduce((sum, shape) => sum + product(shape), 0) * SAMPLE_BYTES[dtype];
}

/** Bytes registering B to A at the layout's offset allocates, and the region it registers. */
export function pairBytes(shapeA, shapeB, approximateOffset) {
  const region = overlapRegion(shapeA, shapeB, approximateOffset.map((v) => Math.round(v)));
  if (!region) return { bytes: 0, size: null };
  return { bytes: 16 * product(region.size) + 32 * product(frameShape(region.size)), size: region.size };
}

/** Bytes fusing into an image of `shape` allocates, for tiles of `dtype`. */
export function fusionBytes(shape, dtype) {
  const pixels = product(shape);
  return pixels * (2 * (accumulatesInFloat64Type(dtype) ? 8 : 4) + 4 * SAMPLE_BYTES[dtype]);
}

/** Bytes the global optimisation's largest component allocates, and that component's tile count. */
export function solverBytes(count, pairs) {
  const [largest] = components(count, pairs);
  const free = largest.length - 1;
  return { bytes: 2 * 8 * free * free, tiles: largest.length };
}

/** Throws MemoryBudgetError when the tiles and the global optimisation do not fit the budget. */
export function checkSolverMemory({ shapes, dtype, pairs, budget = MEMORY_BUDGET }) {
  const tiles = tileBytes(shapes, dtype);
  const solver = solverBytes(shapes.length, pairs);
  if (tiles + solver.bytes > budget) {
    throw new MemoryBudgetError(
      `Solving the positions of ${solver.tiles} linked tiles needs ${formatBytes(solver.bytes)} for the least-squares system; `
      + `with the tiles (${formatBytes(tiles)}) that is more than this app's ${formatBytes(budget)} working memory. `
      + 'Stitch the mosaic in smaller parts.',
    );
  }
}

/**
 * The number of registration workers (at most `wanted`) whose tiles and largest pair fit the
 * budget together. Throws MemoryBudgetError when even one does not.
 * @param {{ shapes: number[][], dtype: string, pairs: { i: number, j: number, approximateOffset: number[] }[], names?: string[], shared: boolean, wanted: number, budget?: number }} job
 */
export function registrationWorkers({ shapes, dtype, pairs, names, shared, wanted, budget = MEMORY_BUDGET }) {
  const tiles = tileBytes(shapes, dtype);
  let largest = { bytes: 0, size: null, pair: null };
  for (const pair of pairs) {
    const need = pairBytes(shapes[pair.i], shapes[pair.j], pair.approximateOffset);
    if (need.bytes > largest.bytes) largest = { ...need, pair };
  }
  const perWorker = largest.bytes + (shared ? 0 : tiles);
  const fit = Math.floor((budget - tiles) / perWorker);
  if (!(fit >= 1)) {
    const { i, j } = largest.pair;
    const label = (k) => names?.[k] ?? `tile ${k + 1}`;
    throw new MemoryBudgetError(
      `Registering ${label(i)} and ${label(j)} needs ${formatBytes(largest.bytes)} for their ${largest.size.join(' × ')} pixel overlap and its FFT buffers; `
      + `with the tiles (${formatBytes(tiles)}${shared ? '' : ', copied to the worker'}) that is more than this app's ${formatBytes(budget)} working memory. `
      + 'Check the layout\'s overlap, or stitch smaller tiles.',
    );
  }
  return Math.max(1, Math.min(wanted, fit));
}

/** Throws MemoryBudgetError when the tiles and fusing into `shape` do not fit the budget. */
export function checkFusionMemory({ shapes, dtype, shape, shared, budget = MEMORY_BUDGET }) {
  const tiles = tileBytes(shapes, dtype) * (shared ? 1 : 2);
  const fusion = fusionBytes(shape, dtype);
  if (tiles + fusion > budget) {
    throw new MemoryBudgetError(
      `Fusing into ${shape.join(' × ')} pixels needs ${formatBytes(fusion)}; with the tiles (${formatBytes(tiles)}) that is more than this app's ${formatBytes(budget)} working memory. Check the layout.`,
    );
  }
}
