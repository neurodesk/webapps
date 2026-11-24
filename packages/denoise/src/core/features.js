// Strictly J-invariant (blind-spot) multiscale feature generator for self-supervised
// Noise2Self / Aydin FGR denoising (Batson & Royer, ICML 2019).
//
// Mathematical blind-spot guarantee (bit-for-bit exact zero dependence on center voxel):
// - Every feature at voxel (z, y, x) is computed strictly from neighbours (z', y', x') != (z, y, x).
// - On singleton axes (ny === 1 or nx === 1), offsets that would map back to the center pixel are
//   skipped rather than reflected onto the center.
// - Multiscale hollow donut rings (r = 2, 4, 8) are computed from disjoint directional row/column
//   prefix and suffix sums (top rows y' < y, bottom rows y' > y, left cols x' < x, right cols x' > x)
//   so the center voxel (y, x) NEVER enters any accumulator subtracted at (y, x) — eliminating
//   floating-point cancellation leakage even across 1e20 dynamic range.
// - Supports row-strip extraction (`yStart..yEnd`) so working memory stays bounded on huge planes.

/**
 * Mirror index excluding the boundary pixel so `idx = -1` maps to `1` (not `0`)
 * and `idx = n` maps to `n - 2` (not `n - 1`). Caller must guard `n > 1` so an offset
 * never maps back to the origin on a singleton axis.
 * @param {number} idx
 * @param {number} n
 * @returns {number}
 */
export function mirrorIndex(idx, n) {
  if (n <= 1) return 0;
  let i = idx;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
  }
  return i;
}

/**
 * Returns the scales `[r, rIn]` included for the chosen `maxScale` (`2`, `4` or `8`).
 * @param {number} maxScale
 * @returns {Array<[number, number]>}
 */
export function ringScalesFor(maxScale) {
  const scales = [[2, 1]];
  if (maxScale >= 4) scales.push([4, 2]);
  if (maxScale >= 8) scales.push([8, 4]);
  return scales;
}

/**
 * Returns the ordered feature names for the chosen `use3d` and `maxScale` configuration.
 * @param {{ use3d: boolean, maxScale: number }} options
 * @returns {string[]}
 */
export function featureNames({ use3d, maxScale }) {
  const names = [
    "h_mean",
    "h_diff",
    "v_mean",
    "v_diff",
    "d1_mean",
    "d1_diff",
    "d2_mean",
    "d2_diff",
    "cross_mean",
    "cross_std",
    "ring1_mean",
    "ring1_median",
    "ring1_min",
    "ring1_max",
  ];
  const rings = ringScalesFor(maxScale);
  for (const [r] of rings) names.push(`ring${r}_mean`);
  for (let i = 0; i < rings.length; i += 1) {
    const prev = i === 0 ? "ring1" : `ring${rings[i - 1][0]}`;
    names.push(`dod_${prev}_ring${rings[i][0]}`);
  }
  if (use3d) {
    names.push("z1_mean", "z1_diff", "z1_min", "z1_max", "z1_3x3_mean", "z2_mean");
  }
  return names;
}

/**
 * Computes exact cancellation-free hollow donut ring means for rows `yStart..yEnd` (exclusive)
 * of a single 2D slice `[ny, nx]`.
 *
 * For each `(y, x)`, the ring `[-r..r] \ [-rIn..rIn]` is partitioned into four regions whose
 * accumulators NEVER read `slice[y, x]`:
 * - Top band (`y' in [max(0, y-r) .. y-rIn-1]`, all `x' in [x-r .. x+r]`): row sums strictly
 *   from rows `y' < y`.
 * - Bottom band (`y' in [y+rIn+1 .. min(ny-1, y+r)]`, all `x' in [x-r .. x+r]`): row sums strictly
 *   from rows `y' > y`.
 * - Left band (`y' in [y-rIn .. y+rIn]`, `x' in [max(0, x-r) .. x-rIn-1]`): strictly `x' < x`,
 *   computed from left-to-right row prefix sums that stop before `x`.
 * - Right band (`y' in [y-rIn .. y+rIn]`, `x' in [x+rIn+1 .. min(nx-1, x+r)]`): strictly `x' > x`,
 *   computed from right-to-left row suffix sums that stop after `x`.
 *
 * Because `slice[y, x]` never enters any intermediate sum touched at `(y, x)`, changing
 * `slice[y, x]` by any finite amount causes literally 0.0 change in the ring mean at `(y, x)`.
 */
function computeStripRingMeans(slice, ny, nx, yStart, yEnd, rings) {
  const maxR = rings[rings.length - 1][0];
  const padY0 = Math.max(0, yStart - maxR);
  const padY1 = Math.min(ny, yEnd + maxR);
  const padH = padY1 - padY0;
  const stripH = yEnd - yStart;
  const numRings = rings.length;
  const results = new Array(numRings);

  // Precompute per-row left-to-right prefix and right-to-left suffix sums on [padY0..padY1).
  // Each row's prefix/suffix is strictly within that row.
  const stride = nx + 1;
  const rowPref = new Float64Array(padH * stride);
  const rowSuff = new Float64Array(padH * stride);
  for (let ry = 0; ry < padH; ry += 1) {
    const srcRow = (padY0 + ry) * nx;
    const pRow = ry * stride;
    rowPref[pRow] = 0;
    for (let x = 0; x < nx; x += 1) {
      rowPref[pRow + x + 1] = rowPref[pRow + x] + slice[srcRow + x];
    }
    rowSuff[pRow + nx] = 0;
    for (let x = nx - 1; x >= 0; x -= 1) {
      rowSuff[pRow + x] = rowSuff[pRow + x + 1] + slice[srcRow + x];
    }
  }

  // Reusable per-row horizontal window sums for one ring scale.
  const fullWin = new Float64Array(padH * nx);
  const fullCnt = new Int32Array(nx);
  const leftWin = new Float64Array(padH * nx);
  const leftCnt = new Int32Array(nx);
  const rightWin = new Float64Array(padH * nx);
  const rightCnt = new Int32Array(nx);

  for (let ri = 0; ri < numRings; ri += 1) {
    const [r, rIn] = rings[ri];
    const out = new Float32Array(stripH * nx);

    for (let x = 0; x < nx; x += 1) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= nx ? nx - 1 : x + r;
      fullCnt[x] = x1 >= x0 ? x1 - x0 + 1 : 0;

      const lx0 = x0;
      const lx1 = x - rIn - 1;
      leftCnt[x] = lx1 >= lx0 ? lx1 - lx0 + 1 : 0;

      const rx0 = x + rIn + 1;
      const rx1 = x1;
      rightCnt[x] = rx1 >= rx0 ? rx1 - rx0 + 1 : 0;
    }

    for (let ry = 0; ry < padH; ry += 1) {
      const pRow = ry * stride;
      const dst = ry * nx;
      for (let x = 0; x < nx; x += 1) {
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r >= nx ? nx - 1 : x + r;
        fullWin[dst + x] = rowPref[pRow + x1 + 1] - rowPref[pRow + x0];

        const lx1 = x - rIn - 1;
        if (lx1 >= x0) {
          // Left prefix ends at lx1 + 1 <= x - rIn <= x - 1, so column x is never included.
          leftWin[dst + x] = rowPref[pRow + lx1 + 1] - rowPref[pRow + x0];
        } else {
          leftWin[dst + x] = 0;
        }

        const rx0 = x + rIn + 1;
        if (x1 >= rx0) {
          // Right suffix starts at rx0 >= x + rIn + 1 >= x + 2, so column x is never included.
          rightWin[dst + x] = rowSuff[pRow + rx0] - rowSuff[pRow + x1 + 1];
        } else {
          rightWin[dst + x] = 0;
        }
      }
    }

    for (let y = yStart; y < yEnd; y += 1) {
      const outRow = (y - yStart) * nx;
      const ty0 = Math.max(0, y - r) - padY0;
      const ty1 = Math.min(ny - 1, y - rIn - 1) - padY0;
      const by0 = Math.max(0, y + rIn + 1) - padY0;
      const by1 = Math.min(ny - 1, y + r) - padY0;
      const my0 = Math.max(0, y - rIn) - padY0;
      const my1 = Math.min(ny - 1, y + rIn) - padY0;
      const topRows = ty1 >= ty0 ? ty1 - ty0 + 1 : 0;
      const botRows = by1 >= by0 ? by1 - by0 + 1 : 0;
      const midRows = my1 >= my0 ? my1 - my0 + 1 : 0;

      for (let x = 0; x < nx; x += 1) {
        let sum = 0;
        for (let ry = ty0; ry <= ty1; ry += 1) sum += fullWin[ry * nx + x];
        for (let ry = by0; ry <= by1; ry += 1) sum += fullWin[ry * nx + x];
        for (let ry = my0; ry <= my1; ry += 1) {
          sum += leftWin[ry * nx + x] + rightWin[ry * nx + x];
        }
        const count = (topRows + botRows) * fullCnt[x] + midRows * (leftCnt[x] + rightCnt[x]);
        out[outRow + x] = count > 0 ? sum / count : 0;
      }
    }
    results[ri] = out;
  }
  return results;
}

/**
 * Computes all strictly J-invariant features for rows `[yStart, yEnd)` of slice `z` of a
 * `[nz, ny, nx]` Float32 volume. Returns a row-major `Float32Array` of shape
 * `[(yEnd - yStart) * nx, numFeatures]`.
 *
 * @param {Float32Array} volume
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 * @param {number} z
 * @param {{ use3d: boolean, maxScale: number, yStart?: number, yEnd?: number }} options
 * @param {{ out?: Float32Array }} [scratch]
 * @returns {Float32Array}
 */
export function extractSliceFeatures(volume, dims, z, { use3d, maxScale, yStart = 0, yEnd = dims[1] }, scratch = {}) {
  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  const slice = volume.subarray(z * plane, (z + 1) * plane);
  const rings = ringScalesFor(maxScale);
  const numRings = rings.length;
  const effective3d = Boolean(use3d && nz > 1);
  const numFeatures = 14 + 2 * numRings + (effective3d ? 6 : 0);
  const stripH = yEnd - yStart;
  const stripPixels = stripH * nx;
  const out = scratch.out && scratch.out.length === stripPixels * numFeatures
    ? scratch.out
    : new Float32Array(stripPixels * numFeatures);

  const ringBuffers = computeStripRingMeans(slice, ny, nx, yStart, yEnd, rings);

  // Adjacent slices strictly different from z for 3D / 2D+T mode.
  let sliceZm1 = null;
  let sliceZp1 = null;
  let sliceZm2 = null;
  let sliceZp2 = null;
  if (effective3d) {
    const zPrev = z > 0 ? z - 1 : 1;
    const zNext = z + 1 < nz ? z + 1 : nz - 2;
    const zm2 = nz > 2 ? mirrorIndex(z - 2, nz) : zPrev;
    const zp2 = nz > 2 ? mirrorIndex(z + 2, nz) : zNext;
    const zPrev2 = zm2 === z ? zPrev : zm2;
    const zNext2 = zp2 === z ? zNext : zp2;
    sliceZm1 = volume.subarray(zPrev * plane, (zPrev + 1) * plane);
    sliceZp1 = volume.subarray(zNext * plane, (zNext + 1) * plane);
    sliceZm2 = volume.subarray(zPrev2 * plane, (zPrev2 + 1) * plane);
    sliceZp2 = volume.subarray(zNext2 * plane, (zNext2 + 1) * plane);
  }

  const hasX = nx > 1;
  const hasY = ny > 1;
  const nb = new Float64Array(8);
  const cross = new Float64Array(4);
  const ringVals = new Float64Array(numRings);

  for (let y = yStart; y < yEnd; y += 1) {
    const ym1 = hasY ? mirrorIndex(y - 1, ny) : -1;
    const yp1 = hasY ? mirrorIndex(y + 1, ny) : -1;
    const rowY = y * nx;
    const rowYm1 = ym1 >= 0 ? ym1 * nx : -1;
    const rowYp1 = yp1 >= 0 ? yp1 * nx : -1;
    const localRow = (y - yStart) * nx;

    for (let x = 0; x < nx; x += 1) {
      const xm1 = hasX ? mirrorIndex(x - 1, nx) : -1;
      const xp1 = hasX ? mirrorIndex(x + 1, nx) : -1;

      let hMean = 0;
      let hDiff = 0;
      let vMean = 0;
      let vDiff = 0;
      let d1Mean = 0;
      let d1Diff = 0;
      let d2Mean = 0;
      let d2Diff = 0;
      let crossCount = 0;
      let nbCount = 0;

      if (hasX) {
        const nL = slice[rowY + xm1];
        const nR = slice[rowY + xp1];
        hMean = 0.5 * (nL + nR);
        hDiff = Math.abs(nL - nR);
        cross[crossCount] = nL;
        cross[crossCount + 1] = nR;
        crossCount += 2;
        nb[nbCount] = nL;
        nb[nbCount + 1] = nR;
        nbCount += 2;
      }

      if (hasY) {
        const nU = slice[rowYm1 + x];
        const nD = slice[rowYp1 + x];
        vMean = 0.5 * (nU + nD);
        vDiff = Math.abs(nU - nD);
        cross[crossCount] = nU;
        cross[crossCount + 1] = nD;
        crossCount += 2;
        nb[nbCount] = nU;
        nb[nbCount + 1] = nD;
        nbCount += 2;
      }

      if (hasX && hasY) {
        const nUL = slice[rowYm1 + xm1];
        const nUR = slice[rowYm1 + xp1];
        const nDL = slice[rowYp1 + xm1];
        const nDR = slice[rowYp1 + xp1];
        d1Mean = 0.5 * (nUL + nDR);
        d1Diff = Math.abs(nUL - nDR);
        d2Mean = 0.5 * (nUR + nDL);
        d2Diff = Math.abs(nUR - nDL);
        nb[nbCount] = nUL;
        nb[nbCount + 1] = nUR;
        nb[nbCount + 2] = nDL;
        nb[nbCount + 3] = nDR;
        nbCount += 4;
      }

      let crossMean = 0;
      let crossStd = 0;
      if (crossCount > 0) {
        for (let i = 0; i < crossCount; i += 1) crossMean += cross[i];
        crossMean /= crossCount;
        let sq = 0;
        for (let i = 0; i < crossCount; i += 1) {
          const d = cross[i] - crossMean;
          sq += d * d;
        }
        crossStd = Math.sqrt(sq / crossCount);
      }

      let ring1Mean = 0;
      let ring1Median = 0;
      let ring1Min = 0;
      let ring1Max = 0;
      if (nbCount > 0) {
        for (let i = 0; i < nbCount; i += 1) ring1Mean += nb[i];
        ring1Mean /= nbCount;
        for (let i = 1; i < nbCount; i += 1) {
          const key = nb[i];
          let j = i - 1;
          while (j >= 0 && nb[j] > key) {
            nb[j + 1] = nb[j];
            j -= 1;
          }
          nb[j + 1] = key;
        }
        const mid = nbCount >>> 1;
        ring1Median = nbCount % 2 === 1 ? nb[mid] : 0.5 * (nb[mid - 1] + nb[mid]);
        ring1Min = nb[0];
        ring1Max = nb[nbCount - 1];
      }

      const localIdx = localRow + x;
      let offset = localIdx * numFeatures;
      out[offset] = hMean;
      out[offset + 1] = hDiff;
      out[offset + 2] = vMean;
      out[offset + 3] = vDiff;
      out[offset + 4] = d1Mean;
      out[offset + 5] = d1Diff;
      out[offset + 6] = d2Mean;
      out[offset + 7] = d2Diff;
      out[offset + 8] = crossMean;
      out[offset + 9] = crossStd;
      out[offset + 10] = ring1Mean;
      out[offset + 11] = ring1Median;
      out[offset + 12] = ring1Min;
      out[offset + 13] = ring1Max;
      offset += 14;

      for (let rIdx = 0; rIdx < numRings; rIdx += 1) {
        const val = ringBuffers[rIdx][localIdx];
        ringVals[rIdx] = val;
        out[offset + rIdx] = val;
      }
      offset += numRings;

      for (let rIdx = 0; rIdx < numRings; rIdx += 1) {
        const prev = rIdx === 0 ? ring1Mean : ringVals[rIdx - 1];
        out[offset + rIdx] = prev - ringVals[rIdx];
      }
      offset += numRings;

      if (effective3d) {
        const p = rowY + x;
        const zm = sliceZm1[p];
        const zp = sliceZp1[p];
        const z1Mean = 0.5 * (zm + zp);
        const z1Diff = Math.abs(zm - zp);
        const z1Min = zm < zp ? zm : zp;
        const z1Max = zm > zp ? zm : zp;

        let zSum = zm + zp;
        let zCnt = 2;
        if (hasX) {
          zSum += sliceZm1[rowY + xm1] + sliceZm1[rowY + xp1] + sliceZp1[rowY + xm1] + sliceZp1[rowY + xp1];
          zCnt += 4;
        }
        if (hasY) {
          zSum += sliceZm1[rowYm1 + x] + sliceZm1[rowYp1 + x] + sliceZp1[rowYm1 + x] + sliceZp1[rowYp1 + x];
          zCnt += 4;
        }
        if (hasX && hasY) {
          zSum += sliceZm1[rowYm1 + xm1] + sliceZm1[rowYm1 + xp1] + sliceZm1[rowYp1 + xm1] + sliceZm1[rowYp1 + xp1]
            + sliceZp1[rowYm1 + xm1] + sliceZp1[rowYm1 + xp1] + sliceZp1[rowYp1 + xm1] + sliceZp1[rowYp1 + xp1];
          zCnt += 8;
        }
        const z3x3 = zSum / zCnt;
        const z2Mean = 0.5 * (sliceZm2[p] + sliceZp2[p]);
        out[offset] = z1Mean;
        out[offset + 1] = z1Diff;
        out[offset + 2] = z1Min;
        out[offset + 3] = z1Max;
        out[offset + 4] = z3x3;
        out[offset + 5] = z2Mean;
      }
    }
  }
  return out;
}
