// Pure preprocessing and detection tests with tiny volumes and injected networks.
// Clinical validation against nnUNetv2_predict still needs a suitable reference.
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/nnunet.js";

test("sliding-window steps match nnU-Net for the SeedSeg grid", () => {
  assert.deepEqual(P.windowSteps([40, 320, 320], [32, 256, 224]), [
    [0, 8],
    [0, 64],
    [0, 96],
  ]);
  assert.deepEqual(P.windowSteps([32, 256, 224], [32, 256, 224]), [
    [0],
    [0],
    [0],
  ]);
});

test("mirroring uses all 8 axis combinations, identity first", () => {
  const m = P.mirrorSets([0, 1, 2]);
  assert.equal(m.length, 8);
  assert.deepEqual(m[0], []);
  assert.deepEqual(m[7], [0, 1, 2]);
  assert.equal(P.mirrorSets([]).length, 1);
});

test("flipping twice is the identity and accumulation adds", () => {
  const patch = [2, 3, 4],
    n = 24,
    a = Float32Array.from({ length: 2 * n }, (_, i) => i);
  const once = P.flipBlocks(a, 2, patch, [0, 2]);
  assert.notDeepEqual(Array.from(once), Array.from(a));
  assert.deepEqual(
    Array.from(P.flipBlocks(once, 2, patch, [0, 2])),
    Array.from(a),
  );
  const acc = new Float32Array(2 * n).fill(1);
  P.flipBlocks(once, 2, patch, [0, 2], acc);
  assert.deepEqual(
    Array.from(acc),
    Array.from(a, (v) => v + 1),
  );
});

test("crop to nonzero and back, z-score", () => {
  const dims = [3, 4, 5],
    v = new Float32Array(60);
  v[1 * 20 + 2 * 5 + 3] = 2;
  v[2 * 20 + 1 * 5 + 1] = 4;
  const box = P.nonzeroBBox(v, dims);
  assert.deepEqual(box, [
    [1, 3],
    [1, 3],
    [1, 4],
  ]);
  const c = P.cropBox(v, dims, box);
  assert.deepEqual(Array.from(P.uncropBox(c.data, dims, box)), Array.from(v));
  const { mean } = P.zscoreInPlace(c.data);
  assert.ok(Math.abs(mean - 0.5) < 1e-6);
});

test("mirrored sliding window of an identity network returns the input", async () => {
  const patch = [4, 6, 6],
    dims = [6, 9, 7];
  const data = Float32Array.from({ length: 6 * 9 * 7 }, (_, i) => Math.sin(i));
  const { logits, C } = await P.slidingWindowLogits(
    data,
    dims,
    patch,
    async (x) => x,
    {
      mirrorAxes: [0, 1, 2],
    },
  );
  assert.equal(C, 1);
  for (let i = 0; i < data.length; i++)
    assert.ok(Math.abs(logits[i] - data[i]) < 1e-5);
});

test("candidates are ranked by mean probability; count flag when fewer than K", () => {
  const dims = [5, 10, 10],
    p = new Float32Array(500);
  const put = (z, y, x, v) => {
    p[(z * 10 + y) * 10 + x] = v;
  };
  put(1, 1, 1, 0.5);
  put(1, 1, 2, 0.7); // mean 0.6
  put(3, 7, 7, 0.9); // mean 0.9
  const d = P.detect(p, dims, 3, 0.1, 2);
  assert.equal(d.nCandidates, 2);
  assert.equal(d.countFlag, true);
  assert.ok(Math.abs(d.markers[0].meanProb - 0.9) < 1e-6);
  assert.deepEqual(d.markers[0].centroidVox, [7, 7, 3]);
  assert.equal(d.markers[1].volumeMm3, 4);
  assert.equal(d.markerMap[(3 * 10 + 7) * 10 + 7], 1);
  assert.equal(d.markerMap[(1 * 10 + 1) * 10 + 2], 2);
  assert.equal(P.detect(p, dims, 1).countFlag, false);
});

test("Gaussian importance map peaks at 10 in the patch centre", () => {
  const g = P.gaussianMap([4, 8, 8]);
  assert.ok(Math.abs(g[(2 * 8 + 4) * 8 + 4] - 10) < 1e-5);
  assert.ok(g.every((v) => v > 0));
});

test("an edited marker map is summarised per rank: volume, mean probability, weighted centroid", () => {
  const dims = [2, 4, 4],
    map = new Float32Array(32),
    p = new Float32Array(32);
  const at = (z, y, x) => (z * 4 + y) * 4 + x;
  map[at(0, 0, 0)] = 2;
  p[at(0, 0, 0)] = 0.5;
  map[at(1, 3, 3)] = 1;
  p[at(1, 3, 3)] = 0.75;
  map[at(1, 3, 1)] = 1;
  p[at(1, 3, 1)] = 0.25;
  const affine = [
    [-2, 0, 0, 10],
    [0, 1, 0, 0],
    [0, 0, 3, 0],
    [0, 0, 0, 1],
  ];
  const s = P.summarizeMarkers(map, p, dims, { k: 3, voxelVolume: 6, affine });
  assert.equal(s.countFlag, true);
  assert.deepEqual(
    s.markers.map((m) => [m.rank, m.nVoxels, m.volumeMm3, m.meanProb]),
    [
      [1, 2, 12, 0.5],
      [2, 1, 6, 0.5],
    ],
  );
  assert.deepEqual(s.markers[0].centroidVox, [2.5, 3, 1]);
  assert.deepEqual(s.markers[0].centroidWorldMm, [5, 3, 3]);
});

test("a marker painted outside the probability support keeps a finite geometric centroid", () => {
  const markerMap = Float32Array.of(1, 0, 0, 1);
  const probability = new Float32Array(4);
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const { markers } = P.summarizeMarkers(markerMap, probability, [1, 2, 2], {
    k: 1,
    affine,
  });
  assert.deepEqual(markers[0].centroidVox, [0.5, 0.5, 0]);
  assert.equal(markers[0].meanProb, 0);
});
