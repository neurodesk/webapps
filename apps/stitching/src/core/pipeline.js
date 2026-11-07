// The stitching pipeline without the browser: which tile pairs to register, the pairwise
// registrations, the global optimisation and the summary numbers. The app runs the pairwise
// step across workers with the same functions; the validation scripts run `stitch` directly.
import { registerPair } from './pairwise.js';
import { optimisePositions } from './global.js';
import { checkSolverMemory } from './memory.js';
import { overlappingPairs } from './tile-layout.js';

/** Every pair that overlaps under the approximate layout, with B's approximate offset from A. */
export function planPairs(shapes, approximate) {
  return overlappingPairs(shapes, approximate).map(([i, j]) => ({
    i,
    j,
    approximateOffset: approximate[j].map((v, d) => v - approximate[i][d]),
  }));
}

/** Pairwise registration of `pairs`; a pair that cannot be scored becomes an r = 0 link. */
export function registerPairs(tiles, pairs, options = {}, { onProgress, signal } = {}) {
  return pairs.map((pair, k) => {
    signal?.throwIfAborted();
    const result = registerPair(tiles[pair.i], tiles[pair.j], pair.approximateOffset, options);
    onProgress?.(k + 1, pairs.length);
    return result
      ? { i: pair.i, j: pair.j, approximateOffset: pair.approximateOffset, offset: result.offset, r: result.r, pixels: result.pixels }
      : { i: pair.i, j: pair.j, approximateOffset: pair.approximateOffset, offset: pair.approximateOffset, r: 0, pixels: 0 };
  });
}

/**
 * Pairwise registration and global optimisation, in one thread.
 * @param {{ shape: number[], data: ArrayLike<number> }[]} tiles
 * @param {number[][]} approximate
 */
export function stitch(tiles, approximate, options = {}) {
  if (tiles.length < 2) throw new Error('Stitching needs at least two tiles.');
  const pairs = planPairs(tiles.map((tile) => tile.shape), approximate);
  if (!pairs.length) throw new Error('No tiles overlap under this layout; check the grid size, order and overlap.');
  checkSolverMemory({ shapes: tiles.map((tile) => tile.shape), dtype: tiles[0].dtype ?? 'float64', pairs });
  const links = registerPairs(tiles, pairs, options.pairwise);
  return optimisePositions(approximate, links, options.global);
}

/** Positions relative to the first tile, so results from different origins compare directly. */
export function relativeToFirst(positions) {
  return positions.map((p) => p.map((v, d) => v - positions[0][d]));
}

/** The largest Euclidean distance between two sets of positions, both taken relative to tile 0. */
export function maxPositionDifference(a, b) {
  const ra = relativeToFirst(a);
  const rb = relativeToFirst(b);
  return Math.max(...ra.map((p, k) => Math.hypot(...p.map((v, d) => v - rb[k][d]))));
}
