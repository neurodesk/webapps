// The StarDist port against Python StarDist 0.9.1, csbdeep 0.8.1, numpy and skimage, whose
// results validation/reference.py recorded in validation/reference.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  axisTiles,
  descendingOrder,
  measureNuclei,
  normalize,
  percentile,
  polygonCoordinates,
  predictCandidates,
  renderLabels,
  suppress,
} from "../src/stardist.js";
import { MODEL } from "../src/config.js";

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

test("the model constants are the converted model's", () => {
  assert.equal(MODEL.nRays, N_RAYS);
  assert.equal(MODEL.grid, 2);
  assert.equal(MODEL.divBy, 16);
  assert.deepEqual(MODEL.tileOverlap, [94, 94]);
  assert.equal(MODEL.thresholds.prob, reference.thresholds.prob);
  assert.equal(MODEL.thresholds.nms, reference.thresholds.nms);
});

test("tiles are csbdeep's Tiling.for_n_tiles slices", () => {
  for (const { size, n_tiles: nTiles, block, overlap_blocks: overlap, tiles } of reference.tiling) {
    assert.deepEqual(axisTiles(size, nTiles, block, overlap), tiles, `${size} px in ${nTiles} tiles`);
  }
});

test("NMS keeps the polygons StarDist's c_non_max_suppression_inds keeps", () => {
  const { nms } = reference;
  const prob = decode(nms.prob, Float32Array);
  const dist = decode(nms.dist, Float32Array);
  const points = decode(nms.points, Int32Array);
  assert.equal(prob.length, nms.count);
  const order = descendingOrder(prob);
  const sortedDist = new Float32Array(dist.length);
  const sortedPoints = new Int32Array(points.length);
  order.forEach((from, to) => {
    sortedDist.set(dist.subarray(from * N_RAYS, (from + 1) * N_RAYS), to * N_RAYS);
    sortedPoints.set(points.subarray(2 * from, 2 * from + 2), 2 * to);
  });
  const kept = suppress(sortedDist, sortedPoints, N_RAYS, reference.thresholds.nms).map((i) => order[i]);
  assert.deepEqual(kept, nms.kept);

  const keptDist = new Float32Array(kept.length * N_RAYS);
  const keptPoints = new Int32Array(kept.length * 2);
  const keptProb = new Float32Array(kept.length);
  kept.forEach((from, to) => {
    keptDist.set(dist.subarray(from * N_RAYS, (from + 1) * N_RAYS), to * N_RAYS);
    keptPoints.set(points.subarray(2 * from, 2 * from + 2), 2 * to);
    keptProb[to] = prob[from];
  });
  const [[r0, r1], [c0, c1]] = nms.crop;
  const coord = polygonCoordinates(keptDist, keptPoints, N_RAYS);
  const labels = renderLabels(coord, keptProb, N_RAYS, r1 - r0, c1 - c0);
  assert.equal(labelHash(labels), nms.labels_sha256);
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
