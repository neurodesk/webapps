import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPsfSize, memoryPlan, nextFastLength, normaliseSum, opticsSettings, prepareImage, prepareMeasuredPsf, runSettings } from "../src/index.js";
import { loadDeconvolution } from "../src/node.js";

test("the automatic PSF size is odd and capped by the stack", () => {
  const spacingUm = { x: 0.0659, y: 0.0659, z: 0.13 };
  const confocal = autoPsfSize({ modality: "confocal", na: 1.4, ni: 1.518, emissionUm: 0.525, spacingUm, dims: [41, 256, 256] });
  assert.deepEqual(confocal, { xy: 43, z: 27 });
  const widefield = autoPsfSize({ modality: "widefield", na: 1.4, ni: 1.518, emissionUm: 0.525, spacingUm, dims: [41, 256, 256] });
  assert.deepEqual(widefield, { xy: 129, z: 81 });
  const small = autoPsfSize({ modality: "widefield", na: 0.5, ni: 1, emissionUm: 0.6, spacingUm: { x: 0.2, y: 0.2, z: 1 }, dims: [5, 12, 10] });
  assert.ok(small.xy <= 9 && small.xy % 2 === 1 && small.z <= 9 && small.z % 2 === 1, JSON.stringify(small));
  assert.equal(autoPsfSize({ modality: "widefield", na: 0.5, ni: 1, emissionUm: 0.6, spacingUm, dims: [1, 64, 64] }).z, 1);
});

test("the memory plan uses the module's padded grid", () => {
  const { paddedDims } = loadDeconvolution();
  for (const [dims, psf] of [[[41, 256, 256], [27, 43, 43]], [[9, 20, 17], [7, 9, 9]], [[1, 97, 101], [1, 31, 31]]]) {
    const plan = memoryPlan(dims, psf);
    assert.deepEqual(plan.padded, Array.from(paddedDims(Uint32Array.from(dims), Uint32Array.from(psf))));
  }
  assert.equal(nextFastLength(97), 100);
  assert.ok(!memoryPlan([500, 2048, 2048], [129, 129, 129]).fits);
});

test("a measured PSF loses its background and is centred on its peak", () => {
  const dims = [5, 6, 7];
  const values = new Float64Array(5 * 6 * 7).fill(10);
  // Peak at (z 2, y 2, x 4): the largest odd box around it is 5 x 5 x 5.
  values[(2 * 6 + 2) * 7 + 4] = 110;
  values[(2 * 6 + 2) * 7 + 3] = 60;
  const psf = prepareMeasuredPsf(values, dims);
  assert.deepEqual(psf.dims, [5, 5, 5]);
  assert.deepEqual(psf.peak, [2, 2, 4]);
  assert.equal(psf.background, 10);
  const centre = (2 * 5 + 2) * 5 + 2;
  assert.ok(Math.abs(psf.data[centre] - 100 / 150) < 1e-15 && Math.abs(psf.data[centre - 1] - 50 / 150) < 1e-15);
  assert.ok(Math.abs(psf.data.reduce((a, b) => a + b, 0) - 1) < 1e-15);
});

test("negative image values are set to 0 and counted; NaN is refused", () => {
  const { data, negative } = prepareImage(Float32Array.of(-2, 3, 0));
  assert.deepEqual(Array.from(data), [0, 3, 0]);
  assert.equal(negative, 1);
  assert.throws(() => prepareImage(Float32Array.of(Number.NaN)), /non-finite/);
  assert.throws(() => normaliseSum(Float64Array.of(0, 0)), /no positive/);
});

test("settings are validated before a run", () => {
  assert.deepEqual(runSettings({ method: "rl", iterations: 20, tvWeight: 0.5 }), { method: "rl", iterations: 20, tvWeight: 0 });
  assert.deepEqual(runSettings({ method: "rltv", iterations: 5, tvWeight: 0.002 }), { method: "rltv", iterations: 5, tvWeight: 0.002 });
  assert.throws(() => runSettings({ method: "rltv", iterations: 5, tvWeight: 0.2 }), /TV weight/);
  assert.throws(() => runSettings({ iterations: 0 }), /Iterations/);
  assert.throws(() => runSettings({ iterations: 2.5 }), /Iterations/);
  const optics = opticsSettings({ modality: "confocal", na: 1.4, immersionIndex: 1.518, sampleIndex: 1.47, emissionNm: 525, excitationNm: 488 });
  assert.equal(optics.emissionUm, 0.525);
  assert.equal(optics.excitationUm, 0.488);
  assert.equal(opticsSettings({ modality: "widefield", na: 1.4, immersionIndex: 1.518, sampleIndex: 1.47, emissionNm: 525, excitationNm: 488 }).excitationUm, 0);
  assert.throws(() => opticsSettings({ modality: "widefield", na: 1.6, immersionIndex: 1.518, sampleIndex: 1.47, emissionNm: 525 }), /numerical aperture/);
});
