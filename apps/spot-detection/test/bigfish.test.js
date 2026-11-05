// The port against Big-FISH 0.6.2 itself: validation/reference.json was recorded by
// validation/bigfish_reference.py on synthetic images that src/synthetic.js rebuilds
// byte for byte, so these tests need no data file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { breakingPoint, centeredMovingAverage, detectSpots, exactExp, gaussianKernel, localMaximum, objectRadiusPixel, thresholdSpots } from "../src/bigfish.js";
import { erf, fitSubpixel, gaussianModel } from "../src/subpixel.js";
import { syntheticImage } from "../src/synthetic.js";

const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));
const synthetic = Object.entries(reference.cases).filter(([, c]) => c.generator);

test("the reference was recorded with Big-FISH 0.6.2", () => {
  assert.equal(reference.versions["big-fish"], "0.6.2");
  assert.equal(synthetic.length, 3);
});

for (const [name, expected] of synthetic) {
  test(`${name}: filtered image, elbow, threshold and spots equal Big-FISH's`, () => {
    const { shape, spots, seed } = expected.generator;
    const image = syntheticImage(shape, spots, seed);
    const result = detectSpots(image, { voxelSize: expected.voxelSize, spotRadius: expected.spotRadius });
    assert.deepEqual(result.sigma, expected.sigma);
    const sha = createHash("sha256").update(Buffer.from(result.filtered.data.buffer)).digest("hex");
    assert.equal(sha, expected.logSha256, "LoG image bytes");
    assert.equal(localMaximum(result.filtered, result.sigma).reduce((a, b) => a + b, 0), expected.localMaxima);
    assert.deepEqual(Array.from(result.curve.thresholds), expected.curve.thresholds);
    assert.deepEqual(result.curve.counts, expected.curve.counts);
    assert.equal(result.threshold, expected.threshold);
    assert.deepEqual(result.spots, expected.spots);
    assert.deepEqual(result.spots.map((s) => image.data[s.reduce((o, v, a) => o * image.shape[a] + v, 0)]), expected.intensity);
  });

  test(`${name}: sub-pixel positions agree with Big-FISH within 1e-4 px`, () => {
    const { shape, spots, seed } = expected.generator;
    const image = syntheticImage(shape, spots, seed);
    const subpixel = fitSubpixel(image, expected.spots, { voxelSize: expected.voxelSize, spotRadius: expected.spotRadius });
    subpixel.forEach((position, i) => position.forEach((v, a) => assert.ok(Math.abs(v - expected.subpixel[i][a]) < 1e-4, `spot ${i} axis ${a}: ${v} vs ${expected.subpixel[i][a]}`)));
  });
}

test("a threshold set by hand replaces the elbow", () => {
  const [, expected] = synthetic[0];
  const image = syntheticImage(expected.generator.shape, expected.generator.spots, expected.generator.seed);
  const high = detectSpots(image, { voxelSize: expected.voxelSize, spotRadius: expected.spotRadius, threshold: 200 });
  assert.equal(high.threshold, 200);
  assert.equal(high.automaticThreshold, expected.threshold);
  assert.equal(high.spots.length, 21);
});

test("object radius in pixels is radius over voxel size per axis", () => {
  assert.deepEqual(objectRadiusPixel([300, 103, 103], [350, 150, 150]), [350 / 300, 150 / 103, 150 / 103]);
  assert.throws(() => objectRadiusPixel([300, 103], [350, 150, 150]), /one value per axis/);
});

test("Gaussian kernels sum to one and the second-order kernel is symmetric", () => {
  const k0 = gaussianKernel(1.5, 0, 6);
  assert.ok(Math.abs(k0.reduce((a, b) => a + b, 0) - 1) < 1e-15);
  const k2 = gaussianKernel(1.5, 2, 6);
  for (let i = 0; i < 6; i++) assert.equal(k2[i], k2[12 - i]);
  assert.ok(k2[6] < 0);
});

test("exactExp is correctly rounded where Math.exp can be one ulp off", () => {
  assert.notEqual(Math.exp(-338), exactExp(-338));
  for (const [x, hex] of [[-1, "3fd78b56362cef38"], [-8.5, "3f2aab43fb3940a1"], [0.5, "3ffa61298e1e069c"], [-338, "2174aa16b0ce0f41"]]) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, exactExp(x));
    assert.equal(view.getBigUint64(0).toString(16), hex, `exp(${x})`);
  }
});

test("moving average and breaking point follow Big-FISH", () => {
  assert.deepEqual(centeredMovingAverage([1, 2, 3, 4, 5, 6], 5), [2.2, 2.4, 3, 4, 4.6, 4.8]);
  // A steep fall, then a slow tail: the elbow is the first threshold back above the mean slope.
  const y = [10, 8, 6, 4, 3.5, 3.4, 3.3, 3.2];
  assert.equal(breakingPoint([0, 1, 2, 3, 4, 5, 6, 7], y), 4);
  assert.throws(() => breakingPoint([0, 1, 2], [1, 2, 3]), /no elbow/);
});

test("connected maxima above the threshold collapse to their truncated centroid", () => {
  const shape = [4, 5];
  const data = new Uint16Array(20);
  const mask = new Uint8Array(20);
  for (const i of [6, 7, 13]) {
    data[i] = 9;
    mask[i] = 1;
  }
  data[4] = 2;
  mask[4] = 1;
  assert.deepEqual(thresholdSpots({ data, shape }, mask, 5), [[1, 2]]);
  assert.deepEqual(thresholdSpots({ data, shape }, mask, 1), [[0, 4], [1, 2]]);
});

test("erf matches reference values", () => {
  for (const [x, value] of [[0, 0], [0.5, 0.5204998778130465], [1, 0.8427007929497149], [2, 0.9953222650189527], [-3, -0.9999779095030014]]) {
    assert.ok(Math.abs(erf(x) - value) < 2e-16, `erf(${x})`);
  }
});

test("the Gaussian model's Jacobian matches finite differences", () => {
  const voxel = [300, 103, 103];
  const params = [700, 300, 280, 340, 160, 50000, 120];
  const size = [5, 6, 6];
  const { values, jacobian } = gaussianModel(params, size, voxel);
  params.forEach((p, a) => {
    const h = 1e-6 * Math.max(1, Math.abs(p));
    const up = gaussianModel(params.map((v, b) => (b === a ? v + h : v)), size, voxel).values;
    const down = gaussianModel(params.map((v, b) => (b === a ? v - h : v)), size, voxel).values;
    for (let i = 0; i < values.length; i += 7) {
      const numeric = (up[i] - down[i]) / (2 * h);
      assert.ok(Math.abs(numeric - jacobian[a][i]) <= 1e-5 * Math.max(1, Math.abs(numeric)), `parameter ${a} voxel ${i}`);
    }
  });
});
