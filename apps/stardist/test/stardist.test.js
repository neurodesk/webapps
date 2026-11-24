// The StarDist 2D and 3D ports against Python StarDist 0.9.1, csbdeep 0.8.1, numpy and skimage,
// whose results validation/reference.py recorded in validation/reference.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  axisTiles,
  descendingOrder,
  measureNuclei,
  normalize,
  padImage,
  percentile,
  polygonCoordinates,
  predictCandidates,
  renderLabels,
  suppress,
} from "../src/stardist.js";
import {
  automaticTiles3D,
  measureNuclei3D,
  padVolume,
  predictCandidates3D,
  renderLabels3D,
  segment3D,
  suppress3D,
} from "../src/stardist3d.js";
import { MODEL, resolveModel } from "../src/config.js";

const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));
const N_RAYS = 32;

function decode(base64, Type) {
  const bytes = Buffer.from(base64, "base64");
  return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

function labelHash(labels) {
  return createHash("sha256").update(new Uint8Array(labels.buffer, labels.byteOffset, labels.byteLength)).digest("hex");
}

test("percentiles equal numpy.percentile's linear method", () => {
  const probe = Array.from({ length: 10007 }, (_, i) => (i * 7919) % 65521);
  for (const [p, want] of Object.entries(reference.percentiles)) {
    assert.equal(percentile(probe, Number(p)), want, `percentile ${p}`);
  }
});

test("normalization is csbdeep's float32 (x - lo) / (hi - lo + eps)", () => {
  const values = Uint16Array.from([8, 206, 100, 7, 300, 8, 50]);
  const { data, low, high } = normalize(values, 0, 100);
  assert.equal(low, 7);
  assert.equal(high, 300);
  assert.equal(data[2], Math.fround(Math.fround(100 - 7) / Math.fround(293)));
  assert.equal(data[3], 0);
  assert.equal(data[4], 1);
});

test("the model constants are the converted models'", () => {
  assert.equal(MODEL.nRays, N_RAYS);
  assert.deepEqual(MODEL.grid, [2, 2]);
  assert.deepEqual(MODEL.divBy, [16, 16]);
  assert.deepEqual(MODEL.tileOverlap, [94, 94]);
  assert.equal(MODEL.thresholds.prob, reference.thresholds.prob);
  assert.equal(MODEL.thresholds.nms, reference.thresholds.nms);

  const he = resolveModel("2D_versatile_he");
  assert.equal(he.channels, 3);
  assert.equal(he.thresholds.prob, reference.he.thresholds.prob);
  assert.equal(he.thresholds.nms, reference.he.thresholds.nms);

  const paper = resolveModel("2D_paper_dsb2018");
  assert.deepEqual(paper.grid, [1, 1]);
  assert.deepEqual(paper.divBy, [8, 8]);
  assert.equal(paper.thresholds.prob, reference.paper_dsb2018.thresholds.prob);
  assert.equal(paper.thresholds.nms, reference.paper_dsb2018.thresholds.nms);

  const demo3d = resolveModel("3D_demo");
  assert.equal(demo3d.ndim, 3);
  assert.equal(demo3d.nRays, 96);
  assert.deepEqual(demo3d.grid, [1, 2, 2]);
  assert.deepEqual(demo3d.divBy, [1, 2, 2]);
  assert.equal(demo3d.thresholds.prob, reference.demo_3d.thresholds.prob);
  assert.equal(demo3d.thresholds.nms, reference.demo_3d.thresholds.nms);
});

test("tiles are csbdeep's Tiling.for_n_tiles slices", () => {
  for (const { size, n_tiles: nTiles, block, overlap_blocks: overlap, tiles } of reference.tiling) {
    assert.deepEqual(axisTiles(size, nTiles, block, overlap), tiles, `${size} px in ${nTiles} tiles`);
  }
});

/** NMS and labels on recorded predict_sparse candidates, as segment() runs them. */
function suppressAndDraw({ prob: probText, dist: distText, points: pointsText }, height, width) {
  const prob = decode(probText, Float32Array);
  const dist = decode(distText, Float32Array);
  const points = decode(pointsText, Int32Array);
  const order = descendingOrder(prob);
  const sortedDist = new Float32Array(dist.length);
  const sortedPoints = new Int32Array(points.length);
  order.forEach((from, to) => {
    sortedDist.set(dist.subarray(from * N_RAYS, (from + 1) * N_RAYS), to * N_RAYS);
    sortedPoints.set(points.subarray(2 * from, 2 * from + 2), 2 * to);
  });
  const kept = suppress(sortedDist, sortedPoints, N_RAYS, reference.thresholds.nms).map((i) => order[i]);
  const keptDist = new Float32Array(kept.length * N_RAYS);
  const keptPoints = new Int32Array(kept.length * 2);
  const keptProb = new Float32Array(kept.length);
  kept.forEach((from, to) => {
    keptDist.set(dist.subarray(from * N_RAYS, (from + 1) * N_RAYS), to * N_RAYS);
    keptPoints.set(points.subarray(2 * from, 2 * from + 2), 2 * to);
    keptProb[to] = prob[from];
  });
  const coord = polygonCoordinates(keptDist, keptPoints, N_RAYS);
  return { count: prob.length, kept, labels: renderLabels(coord, keptProb, N_RAYS, height, width) };
}

test("NMS keeps the polygons StarDist's c_non_max_suppression_inds keeps", () => {
  const { nms } = reference;
  const [[r0, r1], [c0, c1]] = nms.crop;
  const { count, kept, labels } = suppressAndDraw(nms, r1 - r0, c1 - c0);
  assert.equal(count, nms.count);
  assert.deepEqual(kept, nms.kept);
  assert.equal(labelHash(labels), nms.labels_sha256);
});

test("padding reflects at the end of each axis as numpy.pad(mode='reflect') does", () => {
  for (const { shape: [height, width], padded_shape: paddedShape, sha256 } of reference.padding) {
    const values = Float32Array.from({ length: height * width }, (_, i) => i);
    const padded = padImage(values, height, width, MODEL.divBy);
    assert.deepEqual([padded.height, padded.width], paddedShape);
    assert.equal(labelHash(Float32Array.from(padded.data)), sha256, `${height} × ${width}`);
  }
});

test("multi-channel RGB padding preserves interleaved channel tuples", () => {
  const rgb = Float32Array.from({ length: 5 * 3 * 3 }, (_, i) => i);
  const padded = padImage(rgb, 5, 3, [8, 8], 3);
  assert.deepEqual([padded.height, padded.width], [8, 8]);
  assert.equal(padded.data.length, 8 * 8 * 3);
  // Row 5 reflects row 3, col 3 reflects col 1: pixel (3, 1) has index (3*3 + 1)*3 = 30.
  assert.deepEqual(Array.from(padded.data.subarray((5 * 8 + 3) * 3, (5 * 8 + 3) * 3 + 3)), [30, 31, 32]);
});

test("on a crop that is not a multiple of 16, NMS and labels equal predict_instances'", () => {
  const crop = reference.padded_crop;
  const [[r0, r1], [c0, c1]] = crop.crop;
  assert.notEqual((r1 - r0) % MODEL.divBy[0], 0);
  assert.notEqual((c1 - c0) % MODEL.divBy[1], 0);
  const { count, kept, labels } = suppressAndDraw(crop, r1 - r0, c1 - c0);
  assert.equal(count, crop.candidates);
  assert.deepEqual(kept, crop.kept);
  assert.equal(labelHash(labels), crop.labels_sha256);
  assert.equal(labels.reduce((max, label) => Math.max(max, label), 0), crop.count);
});

test("labels drawn from the example's polygons equal polygons_to_label's", () => {
  const example = reference.example["1x1"];
  const coord = decode(example.coord, Float32Array);
  const prob = decode(example.prob, Float32Array);
  const [height, width] = reference.shape;
  const labels = renderLabels(coord, prob, N_RAYS, height, width);
  assert.equal(labelHash(labels), example.labels_sha256);
  assert.equal(labels.reduce((max, label) => Math.max(max, label), 0), example.count);
});

test("nucleus measurements equal skimage regionprops", () => {
  const example = reference.example["1x1"];
  const [height, width] = reference.shape;
  const labels = renderLabels(decode(example.coord, Float32Array), decode(example.prob, Float32Array), N_RAYS, height, width);
  // An image whose intensity is a known function of position stands in for the example.
  const image = Float64Array.from(labels, (_, i) => (i % 251) + Math.floor(i / width));
  const rows = measureNuclei(labels, image, width, example.count);
  assert.equal(rows.length, example.nuclei.length);
  for (const [row, [id, x, y, area]] of rows.map((row, i) => [row, example.nuclei[i]])) {
    assert.equal(row.id, id);
    assert.ok(Math.abs(row.x - x) < 1e-9 && Math.abs(row.y - y) < 1e-9, `centroid of ${id}`);
    assert.equal(row.area, area);
  }
});

test("tiled prediction gives the untiled candidates when the receptive field fits the overlap", async () => {
  const height = 300;
  const width = 410;
  const image = Float32Array.from({ length: height * width }, (_, i) => Math.sin(i * 0.37) * 0.5 + 0.5);
  const model = { ...MODEL, tileOverlap: [20, 20] };
  // A stand-in network with a 5-pixel receptive field: probability and distances at each
  // grid pixel depend only on the input near it.
  const run = (tile, h, w) => {
    const gh = h / 2;
    const gw = w / 2;
    const prob = new Float32Array(gh * gw);
    const dist = new Float32Array(gh * gw * N_RAYS);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const yy = Math.min(h - 1, Math.max(0, 2 * y + dy));
            const xx = Math.min(w - 1, Math.max(0, 2 * x + dx));
            sum += tile[yy * w + xx];
          }
        }
        prob[y * gw + x] = sum / 25;
        for (let k = 0; k < N_RAYS; k++) dist[(y * gw + x) * N_RAYS + k] = sum + k;
      }
    }
    return { prob, dist };
  };
  const whole = await predictCandidates(image, height, width, model, { probThresh: 0.5, nTiles: [1, 1], run });
  const tiled = await predictCandidates(image, height, width, model, { probThresh: 0.5, nTiles: [3, 2], run });
  assert.equal(tiled.tiles, 6);
  const key = (result) => {
    const rows = [];
    for (let i = 0; i < result.prob.length; i++) rows.push(`${result.points[2 * i]},${result.points[2 * i + 1]}:${result.prob[i]}:${result.dist[i * N_RAYS]}`);
    return rows.sort();
  };
  assert.ok(whole.prob.length > 1000);
  assert.deepEqual(key(tiled), key(whole));
  for (let i = 0; i < whole.prob.length; i++) {
    const [y, x] = [whole.points[2 * i], whole.points[2 * i + 1]];
    assert.ok(y >= 4 && x >= 4 && y < height && x < width, "candidates keep StarDist's border b = 2 and stay in the image");
  }
});

test("3D padding reflects at the end of each axis as numpy.pad(mode='reflect') does", () => {
  for (const { shape: [depth, height, width], div_by: divBy, padded_shape: paddedShape, sha256 } of reference.demo_3d.padding) {
    const values = Float32Array.from({ length: depth * height * width }, (_, i) => i);
    const padded = padVolume(values, depth, height, width, divBy);
    assert.deepEqual([padded.depth, padded.height, padded.width], paddedShape);
    assert.equal(labelHash(Float32Array.from(padded.data)), sha256, `${depth} × ${height} × ${width}`);
  }
});

test("3D NMS and polyhedron rendering match Python StarDist3D voxel for voxel", () => {
  const demo3d = resolveModel("3D_demo");
  const { nms, shape: [depth, height, width], thresholds, example } = reference.demo_3d;
  const prob = decode(nms.prob, Float32Array);
  const dist = decode(nms.dist, Float32Array);
  const points = decode(nms.points, Int32Array);
  assert.equal(prob.length, nms.count);
  const order = descendingOrder(prob);
  const sortedDist = new Float32Array(dist.length);
  const sortedPoints = new Int32Array(points.length);
  order.forEach((from, to) => {
    sortedDist.set(dist.subarray(from * demo3d.nRays, (from + 1) * demo3d.nRays), to * demo3d.nRays);
    sortedPoints.set(points.subarray(3 * from, 3 * from + 3), 3 * to);
  });
  const kept = suppress3D(sortedDist, sortedPoints, demo3d.rays, thresholds.nms).map((i) => order[i]);
  assert.deepEqual(kept, nms.kept);
  const keptDist = new Float32Array(kept.length * demo3d.nRays);
  const keptPoints = new Int32Array(kept.length * 3);
  const keptProb = new Float32Array(kept.length);
  kept.forEach((from, to) => {
    keptDist.set(dist.subarray(from * demo3d.nRays, (from + 1) * demo3d.nRays), to * demo3d.nRays);
    keptPoints.set(points.subarray(3 * from, 3 * from + 3), 3 * to);
    keptProb[to] = prob[from];
  });
  const labels = renderLabels3D(keptDist, keptPoints, keptProb, demo3d.rays, depth, height, width);
  assert.equal(labelHash(labels), nms.labels_sha256);

  // Check 3D regionprops centroids and volumes against Python's reference table.
  const dummyVolume = Float64Array.from(labels, (_, i) => i % 97);
  const rows = measureNuclei3D(labels, dummyVolume, depth, height, width, kept.length);
  const wantRows = example["1x1x1"].nuclei;
  assert.equal(rows.length, wantRows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const [wantId, wantX, wantY, wantZ, wantVol] = wantRows[i];
    assert.equal(row.id, wantId);
    assert.equal(row.volume, wantVol);
    assert.ok(Math.abs(row.x - wantX) < 1e-9 && Math.abs(row.y - wantY) < 1e-9 && Math.abs(row.z - wantZ) < 1e-9, `3D centroid of ${wantId}`);
  }
});

test("3D tiled prediction equals untiled candidates when receptive field fits overlap", async () => {
  const depth = 12;
  const height = 28;
  const width = 30;
  const volume = Float32Array.from({ length: depth * height * width }, (_, i) => Math.sin(i * 0.29) * 0.5 + 0.5);
  const model = { ...resolveModel("3D_demo"), tileOverlap: [2, 4, 4] };
  const run = (tile, d, h, w) => {
    const gd = d;
    const gh = h / 2;
    const gw = w / 2;
    const prob = new Float32Array(gd * gh * gw);
    const dist = new Float32Array(gd * gh * gw * model.nRays);
    for (let z = 0; z < gd; z++) {
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          let sum = 0;
          for (let dz = -1; dz <= 1; dz++) {
            const zz = Math.min(d - 1, Math.max(0, z + dz));
            for (let dy = -1; dy <= 1; dy++) {
              const yy = Math.min(h - 1, Math.max(0, 2 * y + dy));
              for (let dx = -1; dx <= 1; dx++) {
                const xx = Math.min(w - 1, Math.max(0, 2 * x + dx));
                sum += tile[(zz * h + yy) * w + xx];
              }
            }
          }
          const at = (z * gh + y) * gw + x;
          prob[at] = sum / 27;
          for (let k = 0; k < model.nRays; k++) dist[at * model.nRays + k] = sum + k * 0.01;
        }
      }
    }
    return { prob, dist };
  };
  const whole = await predictCandidates3D(volume, depth, height, width, model, { probThresh: 0.5, nTiles: [1, 1, 1], run });
  const tiled = await predictCandidates3D(volume, depth, height, width, model, { probThresh: 0.5, nTiles: [2, 2, 2], run });
  assert.equal(tiled.tiles, 8);
  const key = (result) => {
    const rows = [];
    for (let i = 0; i < result.prob.length; i++) {
      rows.push(`${result.points[3 * i]},${result.points[3 * i + 1]},${result.points[3 * i + 2]}:${result.prob[i]}:${result.dist[i * model.nRays]}`);
    }
    return rows.sort();
  };
  assert.ok(whole.prob.length > 50);
  assert.deepEqual(key(tiled), key(whole));
});

test("3D NMS matches StarDist 0.9.1 kernel and convex-hull intersection decisions", () => {
  const demo3d = resolveModel("3D_demo");
  const nRays = demo3d.nRays;
  // Convex-hull upper bound keeps both small candidates at threshold 0.3.
  const dSmall = new Float32Array(2 * nRays).fill(2);
  assert.deepEqual(suppress3D(dSmall, new Int32Array([8, 8, 8, 10, 8, 8]), demo3d.rays, 0.3), [0, 1]);
  // Kernel lower bound suppresses the second candidate at threshold 0.3.
  const dMed = new Float32Array(2 * nRays).fill(3);
  assert.deepEqual(suppress3D(dMed, new Int32Array([8, 8, 8, 8, 10, 10]), demo3d.rays, 0.3), [0]);
});

test("automaticTiles3D bounds actual overlapped 3D tile output memory and predictCandidates3D caps dense candidates", async () => {
  const demo3d = resolveModel("3D_demo");
  const tiles = automaticTiles3D(128, 512, 512, demo3d);
  assert.ok(tiles[0] * tiles[1] * tiles[2] > 8, `expected finer 3D tiling than 2x2x2, got ${tiles}`);
  const depth = 12;
  const height = 16;
  const width = 16;
  const volume = new Float32Array(depth * height * width);
  await assert.rejects(
    predictCandidates3D(volume, depth, height, width, demo3d, {
      probThresh: 0.1,
      nTiles: [1, 1, 1],
      maxCandidates: 5,
      run: (_tile, d, h, w) => ({
        prob: new Float32Array((d / demo3d.grid[0]) * (h / demo3d.grid[1]) * (w / demo3d.grid[2])).fill(0.9),
        dist: new Float32Array((d / demo3d.grid[0]) * (h / demo3d.grid[1]) * (w / demo3d.grid[2]) * demo3d.nRays).fill(2),
      }),
    }),
    /More than 5 3D candidate polyhedra/,
  );
});

test("segment3D compacts empty survivors so count, CSV rows and label IDs stay aligned", async () => {
  const demo3d = resolveModel("3D_demo");
  const depth = 12;
  const height = 16;
  const width = 16;
  const volume = new Float32Array(depth * height * width).fill(10);
  const res = await segment3D(volume, depth, height, width, demo3d, {
    probThresh: 0.5,
    nmsThresh: 0.99,
    nTiles: [1, 1, 1],
    run: (_tile, d, h, w) => {
      const gh = h / demo3d.grid[1];
      const gw = w / demo3d.grid[2];
      const prob = new Float32Array(d * gh * gw);
      const dist = new Float32Array(d * gh * gw * demo3d.nRays);
      const i1 = (6 * gh + 4) * gw + 4;
      const i2 = (6 * gh + 4) * gw + 5;
      prob[i1] = 0.95;
      prob[i2] = 0.8;
      for (let k = 0; k < demo3d.nRays; k++) {
        dist[i1 * demo3d.nRays + k] = 4;
        dist[i2 * demo3d.nRays + k] = 0.2;
      }
      return { prob, dist };
    },
  });
  assert.equal(res.count, res.nuclei.length);
  assert.equal(res.count, 1);
  assert.equal(res.nuclei[0].id, 1);
});

test("automaticTiles3D budgets elongated 3D stacks below the 64 MiB per-tile cap", () => {
  const demo3d = resolveModel("3D_demo");
  const tiles = automaticTiles3D(128, 256, 8192, demo3d);
  const [bd, bh, bw] = demo3d.divBy;
  const [od, oh, ow] = demo3d.tileOverlap;
  const [gd, gh, gw] = demo3d.grid;
  const maxSpan = (size, block, overlap, nTiles) => {
    const padded = size + ((block - (size % block)) % block);
    const plan = axisTiles(padded, nTiles, block, Math.ceil(overlap / block));
    return Math.max(...plan.map((t) => t.read[1] - t.read[0]));
  };
  const td = maxSpan(128, bd, od, tiles[0]);
  const th = maxSpan(256, bh, oh, tiles[1]);
  const tw = maxSpan(8192, bw, ow, tiles[2]);
  const bytes = (td / gd) * (th / gh) * (tw / gw) * (demo3d.nRays + 1) * 4;
  assert.ok(bytes <= 64 * 1024 * 1024, `expected tile bytes <= 64 MiB, got ${(bytes / 1048576).toFixed(1)} MiB (${tiles.join("x")})`);
});
