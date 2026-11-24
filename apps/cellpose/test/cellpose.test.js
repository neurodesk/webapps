import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import test from "node:test";
import {
  clusterMasks,
  fillHolesAndRemoveSmallMasks,
  followFlows2D,
  followFlows3D,
  getPadYX,
  measureCells2D,
  measureCells3D,
  normalize99,
  removeBadFlowMasks2D,
  resizePlane2D,
  segment2D,
  segment3D,
  taperMask,
  tileStarts,
} from "../src/cellpose.js";
import { MODELS } from "../src/config.js";

const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));

function decodeF32(b64) {
  const raw = inflateSync(Buffer.from(b64, "base64"));
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function decodeU32(b64) {
  const raw = inflateSync(Buffer.from(b64, "base64"));
  return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

test("taperMask matches Cellpose transforms._taper_mask exactly", () => {
  const spec = reference.helpers.taper_mask_16;
  const got = taperMask(spec.ly, spec.lx, spec.sig);
  const expected = decodeF32(spec.values_f32_zlib_b64);
  assert.equal(got.length, expected.length);
  let maxDiff = 0;
  for (let i = 0; i < got.length; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i] - expected[i]));
  assert.ok(maxDiff < 1e-6, `taperMask max diff ${maxDiff}`);
});

test("getPadYX matches Cellpose transforms.get_pad_yx on all reference shapes", () => {
  for (const item of reference.helpers.pad_yx) {
    const got = getPadYX(item.ly, item.lx, 16, 1);
    assert.deepEqual([got.ypad1, got.ypad2, got.xpad1, got.xpad2], item.pad);
  }
});

test("normalize99 handles constant images and percentile clipping", () => {
  const flat = normalize99(new Float32Array([5, 5, 5, 5]), 1, 99);
  assert.deepEqual(Array.from(flat.data), [0, 0, 0, 0]);
  const ramp = new Float32Array(101);
  for (let i = 0; i <= 100; i++) ramp[i] = i;
  const norm = normalize99(ramp, 1, 99);
  assert.ok(Math.abs(norm.low - 1) < 1e-5);
  assert.ok(Math.abs(norm.high - 99) < 1e-5);
  assert.ok(Math.abs(norm.data[50] - 0.5) < 1e-5);
});

test("tileStarts covers full axis with overlap", () => {
  assert.deepEqual(tileStarts(100, 224, 0.1), { size: 100, starts: [0] });
  const { size, starts } = tileStarts(500, 224, 0.1);
  assert.equal(size, 224);
  assert.equal(starts[0], 0);
  assert.equal(starts[starts.length - 1] + size, 500);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] < starts[i - 1] + size);
  }
});

test("resizePlane2D preserves constant planes and linear ramps", () => {
  const src = new Float32Array(4 * 4).fill(7.5);
  const dst = resizePlane2D(src, 4, 4, 8, 6);
  assert.equal(dst.length, 48);
  for (let i = 0; i < dst.length; i++) assert.ok(Math.abs(dst[i] - 7.5) < 1e-5);
});

test("2D flow tracking, clustering, flow-error QC and hole filling match Python Cellpose 3.1.1.1", () => {
  const crop = reference.helpers.compute_masks_crop;
  const [height, width] = crop.shape;
  const dP = decodeF32(crop.dP_f32_zlib_b64);
  const dY = dP.subarray(0, height * width);
  const dX = dP.subarray(height * width, 2 * height * width);
  const cellprob = decodeF32(crop.cellprob_f32_zlib_b64);
  const expected = decodeU32(crop.labels_u32_zlib_b64);

  const { inds, pts } = followFlows2D(dY, dX, cellprob, height, width, 0.0, crop.niter);
  let labels = clusterMasks(pts, inds, [height, width], { maxSizeFraction: 0.4 });
  labels = removeBadFlowMasks2D(labels, dY, dX, height, width, 0.4);
  labels = fillHolesAndRemoveSmallMasks(labels, [height, width], 15);

  let maxLabel = 0;
  let fgBoth = 0;
  let fgEither = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > maxLabel) maxLabel = labels[i];
    if (labels[i] > 0 && expected[i] > 0) fgBoth++;
    if (labels[i] > 0 || expected[i] > 0) fgEither++;
  }
  assert.equal(maxLabel, crop.count, `expected ${crop.count} masks, got ${maxLabel}`);
  assert.ok(fgBoth / fgEither > 0.995, `foreground IoU ${(fgBoth / fgEither).toFixed(4)}`);
});

test("3D flow tracking and clustering recover synthetic 3D spheres", () => {
  const D = 16;
  const H = 24;
  const W = 24;
  const n = D * H * W;
  const dZ = new Float32Array(n);
  const dY = new Float32Array(n);
  const dX = new Float32Array(n);
  const cp = new Float32Array(n).fill(-5);
  const spheres = [
    { z: 6, y: 7, x: 7, r: 4.5 },
    { z: 10, y: 16, x: 16, r: 4.5 },
  ];
  for (let z = 0; z < D; z++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (z * H + y) * W + x;
        for (const s of spheres) {
          const dz = s.z - z;
          const dy = s.y - y;
          const dx = s.x - x;
          const dist = Math.hypot(dz, dy, dx);
          if (dist <= s.r) {
            cp[at] = 5;
            if (dist > 1e-4) {
              dZ[at] = dz / dist;
              dY[at] = dy / dist;
              dX[at] = dx / dist;
            }
          }
        }
      }
    }
  }
  const { inds, pts } = followFlows3D(dZ, dY, dX, cp, D, H, W, 0, 80);
  let labels = clusterMasks(pts, inds, [D, H, W], { maxSizeFraction: 0.4 });
  labels = fillHolesAndRemoveSmallMasks(labels, [D, H, W], 15);
  const cells = measureCells3D(labels, new Float32Array(n).fill(100), D, H, W);
  assert.equal(cells.length, 2);
  for (const c of cells) {
    assert.ok(c.volume > 250 && c.volume < 450, `unexpected sphere volume ${c.volume}`);
    assert.ok(Math.abs(c.mean - 100) < 1e-4);
  }
});

test("fillHolesAndRemoveSmallMasks fills interior holes and removes tiny regions", () => {
  const H = 10;
  const W = 10;
  const labels = new Int32Array(H * W);
  // 5x5 ring with a 1-pixel hole in the centre (label 1)
  for (let y = 1; y <= 5; y++) {
    for (let x = 1; x <= 5; x++) {
      if (y === 3 && x === 3) continue;
      labels[y * W + x] = 1;
    }
  }
  // 2-pixel speck (label 2)
  labels[8 * W + 8] = 2;
  labels[8 * W + 9] = 2;

  const cleaned = fillHolesAndRemoveSmallMasks(labels, [H, W], 10);
  assert.equal(cleaned[3 * W + 3], 1, "hole in label 1 should be filled");
  assert.equal(cleaned[8 * W + 8], 0, "tiny label 2 should be removed");
  const rows = measureCells2D(cleaned, new Float32Array(H * W).fill(42), W);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].area, 25);
  assert.equal(rows[0].x, 3);
  assert.equal(rows[0].y, 3);
});

test("removeBadFlowMasks2D uses synchronous Jacobi diffusion matching Cellpose 3.1.1.1", () => {
  // 21-pixel C-shaped / asymmetric mask where in-place Gauss-Seidel diverges from Jacobi.
  const H = 12;
  const W = 12;
  const labels = new Int32Array(H * W);
  const coords = [
    [2, 2], [2, 3], [2, 4], [2, 5], [2, 6],
    [3, 2], [3, 6],
    [4, 2], [4, 6],
    [5, 2], [5, 3], [5, 4], [5, 5], [5, 6],
    [6, 4], [7, 4], [8, 4], [8, 5], [8, 6], [8, 7], [8, 8],
  ];
  for (const [y, x] of coords) labels[y * W + x] = 1;
  // Compute exact synchronous Jacobi reference flows in double precision.
  const r0 = 2;
  const c0 = 2;
  const ly = 8 - 2 + 3;
  const lx = 8 - 2 + 3;
  const ys = coords.map(([y]) => y - r0 + 1);
  const xs = coords.map(([, x]) => x - c0 + 1);
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  let medIdx = 0;
  let best = Infinity;
  for (let i = 0; i < ys.length; i++) {
    const d2 = (ys[i] - meanY) ** 2 + (xs[i] - meanX) ** 2;
    if (d2 < best) { best = d2; medIdx = i; }
  }
  const medOff = ys[medIdx] * lx + xs[medIdx];
  let T = new Float64Array(ly * lx);
  let Tnext = new Float64Array(ly * lx);
  const offs = ys.map((y, i) => y * lx + xs[i]);
  for (let t = 0; t < 2 * (ly + lx); t++) {
    T[medOff] += 1;
    for (const off of offs) {
      Tnext[off] = (T[off] + T[off - lx] + T[off + lx] + T[off - 1] + T[off + 1] + T[off - lx - 1] + T[off - lx + 1] + T[off + lx - 1] + T[off + lx + 1]) / 9;
    }
    [T, Tnext] = [Tnext, T];
  }
  const dY = new Float32Array(H * W);
  const dX = new Float32Array(H * W);
  for (let i = 0; i < coords.length; i++) {
    const off = offs[i];
    const gy = T[off + lx] - T[off - lx];
    const gx = T[off + 1] - T[off - 1];
    const n = 1e-60 + Math.hypot(gy, gx);
    const idx = coords[i][0] * W + coords[i][1];
    dY[idx] = (gy / n) * 5;
    dX[idx] = (gx / n) * 5;
  }
  const kept = removeBadFlowMasks2D(labels, dY, dX, H, W, 0.01);
  assert.equal(kept[coords[0][0] * W + coords[0][1]], 1, "exact Jacobi flows must have ~0 error");
});

test("fillHolesAndRemoveSmallMasks preserves enclosed surviving instances with contiguous IDs", () => {
  const H = 12;
  const W = 12;
  const labels = new Int32Array(H * W);
  // Outer ring: label 2 (from 1..9 x 1..9 minus interior 3..7 x 3..7)
  for (let y = 1; y <= 9; y++) {
    for (let x = 1; x <= 9; x++) {
      if (y >= 3 && y <= 7 && x >= 3 && x <= 7) continue;
      labels[y * W + x] = 2;
    }
  }
  // Enclosed surviving instance: label 1 (4..6 x 4..6 = 9 pixels)
  for (let y = 4; y <= 6; y++) {
    for (let x = 4; x <= 6; x++) labels[y * W + x] = 1;
  }
  const cleaned = fillHolesAndRemoveSmallMasks(labels, [H, W], 5);
  assert.equal(cleaned[5 * W + 5], 1, "enclosed label 1 must survive");
  assert.equal(cleaned[1 * W + 1], 2, "surrounding label 2 must survive");
  const rows = measureCells2D(cleaned, new Float32Array(H * W).fill(1), W);
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
});

test("segment2D and segment3D reject non-finite inputs, non-finite outputs, and oversized rescaled budgets", async () => {
  const bad = new Float32Array(16 * 16).fill(1);
  bad[7] = Number.NaN;
  await assert.rejects(
    segment2D(bad, null, 16, 16, MODELS.cyto3, { runBatch: async () => new Float32Array(0) }),
    /non-finite values/,
  );

  const ok = new Float32Array(16 * 16).fill(10);
  await assert.rejects(
    segment2D(ok, null, 16, 16, MODELS.cyto3, {
      diameter: 30,
      runBatch: async (_inp, b, h, w) => new Float32Array(b * 3 * h * w).fill(Number.NaN),
    }),
    /Cellpose model output contains non-finite/,
  );

  // Oversized 2D rescale budget: 768x768 at diameter=5 (6x rescale -> ~652 MiB live buffers) must fail before inference.
  let invoked = false;
  await assert.rejects(
    segment2D(new Float32Array(768 * 768).fill(1), null, 768, 768, MODELS.cyto3, {
      diameter: 5,
      runBatch: async () => {
        invoked = true;
        return new Float32Array(0);
      },
    }),
    /limit 512 MiB/,
  );
  assert.equal(invoked, false);

  // Oversized 3D rescale budget: 1024x1024x32 at diameter=5 (6x rescale -> >7B voxels) must fail before allocating.
  const dummyVol = new Float32Array(1);
  await assert.rejects(
    segment3D(dummyVol, null, 32, 1024, 1024, MODELS.cyto3, {
      diameter: 5,
      anisotropy: 1,
      runBatch: async () => new Float32Array(0),
    }),
    /limit 512 MiB/,
  );
});

test("segment3D scales flow iteration count with diameter and handles anisotropy", async () => {
  const D = 8;
  const H = 16;
  const W = 16;
  const vol = new Float32Array(D * H * W).fill(10);
  const stages = [];
  await segment3D(vol, null, D, H, W, MODELS.cyto3, {
    diameter: 60,
    anisotropy: 2,
    runBatch: async (_inp, b, h, w) => new Float32Array(b * 3 * h * w).fill(-5),
    onStage: (stage, count) => stages.push([stage, count]),
  });
  const dyn = stages.find(([s]) => s === "dynamics");
  assert.deepEqual(dyn, ["dynamics", 400], "diameter=60 on cyto3 (diamMean=30) must run 400 3D flow steps");
});
