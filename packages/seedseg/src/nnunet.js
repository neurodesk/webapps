// Adapted from astewartau/prostate c9b328a2e0bc1768c0b75640f5532e2853e7ef31.
// Volumes use NIfTI memory order (x fastest), with dimensions in z,y,x order.
import { connectedComponents3D } from "@neurodesk/webapp-components/volume";

// ---------- preprocessing ----------

/** Bounding box [[z0,z1],[y0,y1],[x0,x1]) of nonzero voxels (nnU-Net crop_to_nonzero). */
export function nonzeroBBox(data, dims) {
  const [nz, ny, nx] = dims;
  const lo = [nz, ny, nx],
    hi = [-1, -1, -1];
  let i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (data[i] !== 0) {
          if (z < lo[0]) lo[0] = z;
          if (z > hi[0]) hi[0] = z;
          if (y < lo[1]) lo[1] = y;
          if (y > hi[1]) hi[1] = y;
          if (x < lo[2]) lo[2] = x;
          if (x > hi[2]) hi[2] = x;
        }
      }
    }
  }
  if (hi[0] < 0)
    return [
      [0, nz],
      [0, ny],
      [0, nx],
    ];
  return [
    [lo[0], hi[0] + 1],
    [lo[1], hi[1] + 1],
    [lo[2], hi[2] + 1],
  ];
}

export function cropBox(data, dims, box) {
  const [, ny, nx] = dims;
  const cd = box.map(([a, b]) => b - a);
  const out = new Float32Array(cd[0] * cd[1] * cd[2]);
  let o = 0;
  for (let z = box[0][0]; z < box[0][1]; z++) {
    for (let y = box[1][0]; y < box[1][1]; y++) {
      const s = (z * ny + y) * nx + box[2][0];
      out.set(data.subarray(s, s + cd[2]), o);
      o += cd[2];
    }
  }
  return { data: out, dims: cd };
}

/** Inverse of cropBox: write `src` (dims of the box) into a zero volume of `dims`. */
export function uncropBox(src, dims, box, fill = 0) {
  const [nz, ny, nx] = dims;
  const out = new Float32Array(nz * ny * nx);
  if (fill) out.fill(fill);
  const w = box[2][1] - box[2][0];
  let o = 0;
  for (let z = box[0][0]; z < box[0][1]; z++) {
    for (let y = box[1][0]; y < box[1][1]; y++) {
      out.set(src.subarray(o, o + w), (z * ny + y) * nx + box[2][0]);
      o += w;
    }
  }
  return out;
}

/** Per-image z-score without mask (nnU-Net ZScoreNormalization), in place. */
export function zscoreInPlace(a) {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  const mean = s / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - mean;
    ss += d * d;
  }
  const std = Math.max(Math.sqrt(ss / n), 1e-8);
  for (let i = 0; i < n; i++) a[i] = (a[i] - mean) / std;
  return { mean, std };
}

/** nnU-Net compute_new_shape. */
export function newShape(dims, spacing, target) {
  return dims.map((n, i) => Math.round((spacing[i] / target[i]) * n));
}

/** Linear resampling (align_corners=False, edge clamp). nnU-Net uses cubic splines here; only
 *  used for images whose spacing differs from the plans (off-protocol). */
export function resampleLinear(src, sd, td) {
  const out = new Float32Array(td[0] * td[1] * td[2]);
  const coord = (n, m) => {
    const s = n / m,
      i0 = new Int32Array(m),
      i1 = new Int32Array(m),
      w = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      let c = (i + 0.5) * s - 0.5;
      c = Math.min(Math.max(c, 0), n - 1);
      i0[i] = Math.floor(c);
      i1[i] = Math.min(i0[i] + 1, n - 1);
      w[i] = c - i0[i];
    }
    return { i0, i1, w };
  };
  const cz = coord(sd[0], td[0]),
    cy = coord(sd[1], td[1]),
    cx = coord(sd[2], td[2]);
  const at = (z, y, x) => src[(z * sd[1] + y) * sd[2] + x];
  let o = 0;
  for (let z = 0; z < td[0]; z++) {
    for (let y = 0; y < td[1]; y++) {
      for (let x = 0; x < td[2]; x++, o++) {
        const z0 = cz.i0[z],
          z1 = cz.i1[z],
          wz = cz.w[z];
        const y0 = cy.i0[y],
          y1 = cy.i1[y],
          wy = cy.w[y];
        const x0 = cx.i0[x],
          x1 = cx.i1[x],
          wx = cx.w[x];
        const c00 = at(z0, y0, x0) * (1 - wx) + at(z0, y0, x1) * wx;
        const c01 = at(z0, y1, x0) * (1 - wx) + at(z0, y1, x1) * wx;
        const c10 = at(z1, y0, x0) * (1 - wx) + at(z1, y0, x1) * wx;
        const c11 = at(z1, y1, x0) * (1 - wx) + at(z1, y1, x1) * wx;
        out[o] =
          (c00 * (1 - wy) + c01 * wy) * (1 - wz) +
          (c10 * (1 - wy) + c11 * wy) * wz;
      }
    }
  }
  return out;
}

/** Zero-pad to at least `patch`, centred as nnU-Net pad_nd_image. */
export function padToPatch(data, dims, patch) {
  const pd = dims.map((d, i) => Math.max(d, patch[i]));
  const lo = pd.map((p, i) => Math.floor((p - dims[i]) / 2));
  if (pd.every((p, i) => p === dims[i])) return { data, dims, lo };
  const out = new Float32Array(pd[0] * pd[1] * pd[2]);
  for (let z = 0; z < dims[0]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      const s = (z * dims[1] + y) * dims[2];
      out.set(
        data.subarray(s, s + dims[2]),
        ((z + lo[0]) * pd[1] + y + lo[1]) * pd[2] + lo[2],
      );
    }
  }
  return { data: out, dims: pd, lo };
}

export function unpad(data, pdims, dims, lo) {
  if (pdims.every((p, i) => p === dims[i])) return data;
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  let o = 0;
  for (let z = 0; z < dims[0]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      const s = ((z + lo[0]) * pdims[1] + y + lo[1]) * pdims[2] + lo[2];
      out.set(data.subarray(s, s + dims[2]), o);
      o += dims[2];
    }
  }
  return out;
}

// ---------- sliding window ----------

/** scipy.ndimage.gaussian_filter of a centred delta (truncate 4), separable. */
export function gaussian1d(n, sigma) {
  const r = Math.floor(4 * sigma + 0.5),
    c = Math.floor(n / 2);
  let sum = 0;
  for (let k = -r; k <= r; k++)
    sum += Math.exp((-0.5 * k * k) / (sigma * sigma));
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = i - c;
    g[i] =
      Math.abs(k) <= r ? Math.exp((-0.5 * k * k) / (sigma * sigma)) / sum : 0;
  }
  return g;
}

/** nnU-Net compute_gaussian(patch, sigma_scale, value_scaling_factor). */
export function gaussianMap(patch, sigmaScale = 1 / 8, valueScale = 10) {
  const [gz, gy, gx] = patch.map((p) => gaussian1d(p, p * sigmaScale));
  const n = patch[0] * patch[1] * patch[2];
  const g = new Float64Array(n);
  let mx = 0,
    o = 0;
  for (let z = 0; z < patch[0]; z++) {
    for (let y = 0; y < patch[1]; y++) {
      for (let x = 0; x < patch[2]; x++, o++) {
        g[o] = gz[z] * gy[y] * gx[x];
        if (g[o] > mx) mx = g[o];
      }
    }
  }
  const out = new Float32Array(n);
  let mn = Infinity;
  for (let i = 0; i < n; i++) {
    out[i] = g[i] / (mx / valueScale);
    if (out[i] > 0 && out[i] < mn) mn = out[i];
  }
  for (let i = 0; i < n; i++) if (out[i] === 0) out[i] = mn;
  return out;
}

/** nnU-Net compute_steps_for_sliding_window. */
export function windowSteps(size, patch, step = 0.5) {
  return size.map((s, d) => {
    const k = patch[d];
    const n = Math.ceil((s - k) / (k * step)) + 1;
    const st = n > 1 ? (s - k) / (n - 1) : 0;
    const out = [];
    for (let j = 0; j < n; j++) out.push(Math.round(st * j));
    return out;
  });
}

/** Mirroring axis sets (identity first), as nnU-Net _internal_maybe_mirror_and_predict. */
export function mirrorSets(axes) {
  const out = [[]];
  const comb = (start, k, acc) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < axes.length; i++) {
      acc.push(axes[i]);
      comb(i + 1, k, acc);
      acc.pop();
    }
  };
  for (let k = 1; k <= axes.length; k++) comb(0, k, []);
  return out;
}

/** Copy a patch out of a (z,y,x) volume. */
export function extractTile(data, dims, start, patch) {
  const out = new Float32Array(patch[0] * patch[1] * patch[2]);
  let o = 0;
  for (let z = 0; z < patch[0]; z++) {
    for (let y = 0; y < patch[1]; y++) {
      const s = ((start[0] + z) * dims[1] + start[1] + y) * dims[2] + start[2];
      out.set(data.subarray(s, s + patch[2]), o);
      o += patch[2];
    }
  }
  return out;
}

/** Flip a stack of `nch` (z,y,x) blocks over the given spatial axes (0=z,1=y,2=x).
 *  If `acc` is given, adds the flipped values into it instead of returning a copy. */
export function flipBlocks(src, nch, patch, axes, acc) {
  const [pz, py, px] = patch,
    fz = axes.includes(0),
    fy = axes.includes(1),
    fx = axes.includes(2);
  const bs = pz * py * px;
  const out = acc || new Float32Array(src.length);
  for (let c = 0; c < nch; c++) {
    const base = c * bs;
    for (let z = 0; z < pz; z++) {
      const zs = fz ? pz - 1 - z : z;
      for (let y = 0; y < py; y++) {
        const ys = fy ? py - 1 - y : y;
        const so = base + (zs * py + ys) * px,
          d = base + (z * py + y) * px;
        if (fx && acc) {
          for (let x = 0; x < px; x++) out[d + x] += src[so + px - 1 - x];
        } else if (fx) {
          for (let x = 0; x < px; x++) out[d + x] = src[so + px - 1 - x];
        } else if (acc) {
          for (let x = 0; x < px; x++) out[d + x] += src[so + x];
        } else out.set(src.subarray(so, so + px), d);
      }
    }
  }
  return out;
}

/**
 * Sliding-window logits of one network.
 * runNet(Float32Array tile(s), nBatch) -> Promise<Float32Array logits (nBatch*C*P)>.
 * Returns { logits: Float32Array(C * N), C }.
 */
export async function slidingWindowLogits(
  data,
  dims,
  patch,
  runNet,
  opts = {},
) {
  const {
    mirrorAxes = [],
    gaussian = gaussianMap(patch),
    step = 0.5,
    onTile = null,
  } = opts;
  const P = patch[0] * patch[1] * patch[2];
  const N = dims[0] * dims[1] * dims[2];
  const flips = mirrorSets(mirrorAxes);
  const steps = windowSteps(dims, patch, step);
  const nTiles = steps[0].length * steps[1].length * steps[2].length;
  let acc = null,
    C = 0,
    t = 0;
  const norm = new Float32Array(N);
  for (const sz of steps[0])
    for (const sy of steps[1])
      for (const sx of steps[2]) {
        const tile = extractTile(data, dims, [sz, sy, sx], patch);
        let sum = null;
        for (const ax of flips) {
          const x = ax.length ? flipBlocks(tile, 1, patch, ax) : tile;
          const y = await runNet(x, 1);
          if (!sum) {
            C = y.length / P;
            sum = new Float32Array(C * P);
          }
          if (ax.length) flipBlocks(y, C, patch, ax, sum);
          else for (let i = 0; i < sum.length; i++) sum[i] += y[i];
          if (onTile) onTile(++t, nTiles * flips.length);
        }
        if (!acc) acc = new Float32Array(C * N);
        const inv = 1 / flips.length;
        for (let c = 0; c < C; c++) {
          let o = 0;
          for (let z = 0; z < patch[0]; z++) {
            for (let y = 0; y < patch[1]; y++) {
              const d = ((sz + z) * dims[1] + sy + y) * dims[2] + sx;
              const cb = c * N;
              for (let x = 0; x < patch[2]; x++, o++) {
                acc[cb + d + x] += sum[c * P + o] * inv * gaussian[o];
                if (c === 0) norm[d + x] += gaussian[o];
              }
            }
          }
        }
      }
  for (let c = 0; c < C; c++)
    for (let i = 0; i < N; i++) acc[c * N + i] /= norm[i];
  return { logits: acc, C };
}

/** Softmax over channels; returns the probability of class `cls` (Float32Array N). */
export function softmaxClass(logits, C, N, cls) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = -Infinity;
    for (let c = 0; c < C; c++) m = Math.max(m, logits[c * N + i]);
    let s = 0;
    for (let c = 0; c < C; c++) s += Math.exp(logits[c * N + i] - m);
    out[i] = Math.exp(logits[cls * N + i] - m) / s;
  }
  return out;
}

// ---------- candidates ----------

/** Shared components use xyz dimensions; this module uses zyx dimensions. */
export function label26(mask, dims) {
  const { labels, numComponents } = connectedComponents3D(
    mask,
    [...dims].reverse(),
  );
  return { labels, n: numComponents };
}

/**
 * Candidates: components of p > threshold, sorted by mean probability (desc).
 * Centroid = probability-weighted, in NIfTI voxel coordinates [i, j, k] = [x, y, z].
 */
export function candidates(p, dims, threshold = 0.1, voxelVolume = 1) {
  const N = p.length;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = p[i] > threshold ? 1 : 0;
  const { labels, n } = label26(mask, dims);
  const [, ny, nx] = dims;
  const S = new Float64Array(n + 1),
    M = new Float64Array(n + 1),
    cnt = new Int32Array(n + 1);
  const cx = new Float64Array(n + 1),
    cy = new Float64Array(n + 1),
    cz = new Float64Array(n + 1);
  for (let i = 0; i < N; i++) {
    const l = labels[i];
    if (!l) continue;
    const v = p[i],
      x = i % nx,
      y = Math.floor(i / nx) % ny,
      z = Math.floor(i / (nx * ny));
    S[l] += v;
    cnt[l]++;
    if (v > M[l]) M[l] = v;
    cx[l] += v * x;
    cy[l] += v * y;
    cz[l] += v * z;
  }
  const out = [];
  for (let l = 1; l <= n; l++) {
    out.push({
      label: l,
      meanProb: S[l] / cnt[l],
      maxProb: M[l],
      nVoxels: cnt[l],
      volumeMm3: cnt[l] * voxelVolume,
      centroidVox: [cx[l] / S[l], cy[l] / S[l], cz[l] / S[l]],
    });
  }
  out.sort((a, b) => b.meanProb - a.meanProb);
  out.forEach((c, r) => {
    c.rank = r + 1;
  });
  return { list: out, labels };
}

/** Top-K detections + count flag, and a label map with value r on the r-th marker. */
export function detect(p, dims, k = 3, threshold = 0.1, voxelVolume = 1) {
  const { list, labels } = candidates(p, dims, threshold, voxelVolume);
  const markers = list.slice(0, k);
  const rankOf = new Map(markers.map((c, r) => [c.label, r + 1]));
  const markerMap = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++)
    if (labels[i]) markerMap[i] = rankOf.get(labels[i]) || 0;
  return {
    k,
    threshold,
    nCandidates: list.length,
    countFlag: list.length < k,
    markers,
    others: list.slice(k, k + 5),
    markerMap,
  };
}

/** Recomputes a ranked mask's marker list after editing, preserving rank identities.
 * Centroids use probability weights, or a geometric centroid for a zero-probability rank.
 */
export function summarizeMarkers(
  markerMap,
  probability,
  dims,
  { k, voxelVolume = 1, affine },
) {
  const [, ny, nx] = dims;
  const ranks = new Map();
  for (let i = 0; i < markerMap.length; i++) {
    const rank = markerMap[i];
    if (!(rank > 0)) continue;
    let entry = ranks.get(rank);
    if (!entry) {
      entry = {
        voxels: 0,
        sum: 0,
        max: 0,
        weighted: [0, 0, 0],
        geometric: [0, 0, 0],
      };
      ranks.set(rank, entry);
    }
    const p = probability[i];
    const voxel = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
    entry.voxels++;
    entry.sum += p;
    entry.max = Math.max(entry.max, p);
    for (let axis = 0; axis < 3; axis++) {
      entry.weighted[axis] += p * voxel[axis];
      entry.geometric[axis] += voxel[axis];
    }
  }
  const world = (c) =>
    affine
      .slice(0, 3)
      .map((row) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2] + row[3]);
  const markers = [...ranks]
    .sort(([a], [b]) => a - b)
    .map(([rank, entry]) => {
      const centroidVox =
        entry.sum > 0
          ? entry.weighted.map((value) => value / entry.sum)
          : entry.geometric.map((value) => value / entry.voxels);
      return {
        rank,
        meanProb: entry.sum / entry.voxels,
        maxProb: entry.max,
        nVoxels: entry.voxels,
        volumeMm3: entry.voxels * voxelVolume,
        centroidVox,
        centroidWorldMm: world(centroidVox),
      };
    });
  return { k, markers, countFlag: markers.length < k };
}
