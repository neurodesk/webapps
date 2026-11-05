// Global optimisation of tile positions from the pairwise offsets (Preibisch et al. 2009):
// translations that minimise the weighted sum of squared differences between each link's
// measured offset and the offset the positions imply, solved exactly by least squares per
// connected component. A link's weight is its cross-correlation r times the number of pixels
// it was measured on, so a small diagonal overlap cannot pull tiles as hard as a full edge.
// Links below the correlation threshold are left out. After each solve the link with the
// largest residual is removed, and the system solved again, while Fiji's Grid/Collection
// stitching (Stitching 3.1.8) would remove one. As in Fiji, the test is on tiles, not links: a
// tile's error is the mean residual of its used links, and the worst link is removed when the
// largest tile error is above `maxRatio` times the mean tile error and above 0.95 px, or when
// the mean tile error itself is above `maxAbsolute` pixels.
//
// One tile per component is fixed: the lowest-numbered tile of the largest component stays at
// its approximate position. Every other component (a tile whose links were all rejected, or a
// group cut off from the rest) keeps its approximate layout, moved by the mean correction of
// the largest component, so it stays where the layout put it relative to its neighbours.

export const GLOBAL_DEFAULTS = Object.freeze({
  /** Links whose cross-correlation is below this are not used (Fiji's default is 0.3). */
  threshold: 0.3,
  /** The worst link is an outlier when the largest tile error is above maxRatio × the mean tile error (and 0.95 px) … */
  maxRatio: 2.5,
  /** … or when the mean tile error is above this many pixels (Fiji's defaults are 2.5 and 3.5). */
  maxAbsolute: 3.5,
});

/** The largest tile error must also exceed this for the ratio test, as in Fiji. */
export const MIN_OUTLIER_RESIDUAL = 0.95;

/** Fiji's condition for removing the worst link after a solve. */
export function isOutlierStep(worst, average, { maxRatio, maxAbsolute }) {
  return (average * maxRatio < worst && worst > MIN_OUTLIER_RESIDUAL) || average > maxAbsolute;
}

/**
 * Fiji's error statistics: the mean and largest, across tiles with a used link, of each tile's
 * mean residual over its used links (TileConfigurationStitching.computeError).
 * @param {{ i: number, j: number, residual: number }[]} used
 */
export function tileErrors(used) {
  const sums = new Map();
  for (const { i, j, residual } of used) {
    for (const tile of [i, j]) {
      const [sum, count] = sums.get(tile) ?? [0, 0];
      sums.set(tile, [sum + residual, count + 1]);
    }
  }
  const errors = [...sums.values()].map(([sum, count]) => sum / count);
  return {
    average: errors.reduce((a, b) => a + b, 0) / errors.length,
    largest: Math.max(...errors),
  };
}

/** Connected components of the tiles under `links`, largest first. */
export function components(count, links) {
  const parent = Array.from({ length: count }, (_, i) => i);
  // Iterative, with path halving: a chain of thousands of tiles would overflow a recursive find.
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const { i, j } of links) parent[find(i)] = find(j);
  const groups = new Map();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
}

// Solves M p = b for the symmetric positive definite M by Cholesky decomposition.
function solveSpd(matrix, rhs) {
  const n = matrix.length;
  const L = matrix.map((row) => Float64Array.from(row));
  for (let j = 0; j < n; j++) {
    let diagonal = L[j][j];
    for (let k = 0; k < j; k++) diagonal -= L[j][k] * L[j][k];
    if (!(diagonal > 0)) throw new Error('The tile links do not determine the positions.');
    L[j][j] = Math.sqrt(diagonal);
    for (let i = j + 1; i < n; i++) {
      let value = L[i][j];
      for (let k = 0; k < j; k++) value -= L[i][k] * L[j][k];
      L[i][j] = value / L[j][j];
    }
  }
  return rhs.map((b) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let value = b[i];
      for (let k = 0; k < i; k++) value -= L[i][k] * y[k];
      y[i] = value / L[i][i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let value = y[i];
      for (let k = i + 1; k < n; k++) value -= L[k][i] * x[k];
      x[i] = value / L[i][i];
    }
    return x;
  });
}

/** Least-squares positions of one component, with `fixed` held at `anchor`. */
function solveComponent(tiles, links, fixed, anchor, dims) {
  const free = tiles.filter((t) => t !== fixed);
  if (!free.length) return new Map([[fixed, [...anchor]]]);
  const index = new Map(free.map((t, k) => [t, k]));
  const n = free.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  const rhs = Array.from({ length: dims }, () => new Float64Array(n));
  for (const { i, j, offset, weight } of links) {
    const a = index.get(i);
    const b = index.get(j);
    // weight · (p_j − p_i − offset)²
    for (let d = 0; d < dims; d++) {
      if (b !== undefined) rhs[d][b] += weight * (offset[d] + (a === undefined ? anchor[d] : 0));
      if (a !== undefined) rhs[d][a] -= weight * (offset[d] - (b === undefined ? anchor[d] : 0));
    }
    if (a !== undefined) matrix[a][a] += weight;
    if (b !== undefined) matrix[b][b] += weight;
    if (a !== undefined && b !== undefined) {
      matrix[a][b] -= weight;
      matrix[b][a] -= weight;
    }
  }
  const solution = solveSpd(matrix, rhs);
  const positions = new Map([[fixed, [...anchor]]]);
  for (const [tile, k] of index) positions.set(tile, solution.map((axis) => axis[k]));
  return positions;
}

function residual(link, positions) {
  const pi = positions[link.i];
  const pj = positions[link.j];
  return Math.hypot(...link.offset.map((o, d) => pj[d] - pi[d] - o));
}

/**
 * @param {number[][]} approximate approximate tile positions (pixels)
 * @param {{ i: number, j: number, offset: number[], r: number, pixels?: number }[]} measured pairwise offsets of j relative to i
 * @returns {{ positions: number[][], links: object[], components: number[][] }}
 *   links carry `status` ('used', 'low correlation' or 'outlier') and `residual` (pixels).
 */
export function optimisePositions(approximate, measured, options = {}) {
  const { threshold, maxRatio, maxAbsolute } = { ...GLOBAL_DEFAULTS, ...options };
  const count = approximate.length;
  const dims = approximate[0]?.length ?? 2;
  const largest = Math.max(1, ...measured.map((link) => link.pixels ?? 1));
  const links = measured.map((link) => ({
    ...link,
    weight: Math.max(link.r, 1e-6) * Math.max(link.pixels ?? 1, 1) / largest,
    status: link.r >= threshold ? 'used' : 'low correlation',
  }));
  let positions;
  let groups;
  for (;;) {
    const used = links.filter((link) => link.status === 'used');
    groups = components(count, used);
    positions = new Array(count);
    const [main] = groups;
    const mainFixed = main[0];
    const solved = solveComponent(main, used.filter((l) => main.includes(l.i)), mainFixed, approximate[mainFixed], dims);
    for (const [tile, p] of solved) positions[tile] = p;
    const correction = new Array(dims).fill(0);
    for (const tile of main) for (let d = 0; d < dims; d++) correction[d] += (positions[tile][d] - approximate[tile][d]) / main.length;
    for (const group of groups.slice(1)) {
      const fixed = group[0];
      const anchor = approximate[fixed].map((v, d) => v + correction[d]);
      const local = solveComponent(group, used.filter((l) => group.includes(l.i)), fixed, anchor, dims);
      // Keep the group's mean correction equal to the main component's.
      const drift = new Array(dims).fill(0);
      for (const tile of group) for (let d = 0; d < dims; d++) drift[d] += (local.get(tile)[d] - approximate[tile][d] - correction[d]) / group.length;
      for (const [tile, p] of local) positions[tile] = p.map((v, d) => v - drift[d]);
    }
    for (const link of links) link.residual = residual(link, positions);
    if (!used.length) break;
    const { average, largest } = tileErrors(used);
    if (isOutlierStep(largest, average, { maxRatio, maxAbsolute })) {
      used.reduce((a, b) => (b.residual > a.residual ? b : a)).status = 'outlier';
    }
    else break;
  }
  return {
    positions,
    links: links.map(({ weight: _weight, ...link }) => link),
    components: groups,
  };
}
