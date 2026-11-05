import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arCoefficient, autocovariance, constrainedOasisAR1, deconvolve, noiseLevel, oasisAR1, percentile } from "../src/core/oasis.js";

// validation/oasis_reference.py: OASIS (j-friedrich/OASIS@6296247, GPL-3, reference only) on
// three simulated AR(1) traces.
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/oasis-reference.json", import.meta.url), "utf8"));

const maxDifference = (a, b) => a.reduce((worst, value, i) => Math.max(worst, Math.abs(value - b[i])), 0);
const residual = (y, c, b = 0) => y.reduce((sum, value, t) => sum + (value - b - c[t]) ** 2, 0);

for (const reference of cases) {
  const y = Float64Array.from(reference.y);

  test(`${reference.name}: oasisAR1 equals OASIS for λ = 0 and λ = 1`, () => {
    for (const [lambda, expected] of [[0, reference.oasisLambda0], [1, reference.oasisLambda1]]) {
      const { c, s } = oasisAR1(y, reference.g, lambda);
      assert.ok(maxDifference(c, expected.c) < 1e-12, `c, λ ${lambda}`);
      assert.ok(maxDifference(s, expected.s) < 1e-12, `s, λ ${lambda}`);
    }
  });

  test(`${reference.name}: the noise-constrained fit meets σ²T and matches OASIS's`, () => {
    const fit = constrainedOasisAR1(y, reference.g, reference.sn);
    const target = reference.sn ** 2 * y.length;
    assert.ok(Math.abs(residual(y, fit.c) - target) / target < 1e-8);
    // OASIS stops its λ iteration at a looser tolerance (its residual is within 1e-4 of σ²T).
    assert.ok(maxDifference(fit.c, reference.constrained.c) < 2e-4);
    assert.ok(Math.abs(fit.lambda - reference.constrained.lambda) / reference.constrained.lambda < 1e-3);
  });

  test(`${reference.name}: noise and AR(1) estimates equal OASIS's GetSn (logmexp) and estimate_time_constant`, () => {
    assert.ok(Math.abs(noiseLevel(y) - reference.noiseLogmexp) < 1e-12);
    assert.ok(Math.abs(arCoefficient(y, reference.noiseLogmexp) - reference.arCoefficientLags5) < 1e-12);
  });
}

test("spikes are non-negative, sit only at pool starts, and reproduce the calcium", () => {
  const { y, g } = cases[0];
  const { c, s } = oasisAR1(Float64Array.from(y), g, 0.5);
  for (let t = 0; t < c.length; t++) {
    assert.ok(s[t] >= -1e-12, `s[${t}] = ${s[t]}`);
    const predicted = (t ? g * c[t - 1] : 0) + s[t];
    assert.ok(Math.abs(predicted - c[t]) < 1e-12);
  }
});

test("a minimum spike size merges pools whose jump is smaller", () => {
  const { y, g } = cases[1];
  const free = oasisAR1(Float64Array.from(y), g, 0, 0);
  const thresholded = oasisAR1(Float64Array.from(y), g, 0, 0.5);
  const count = (s) => s.filter((value) => value > 1e-9).length;
  assert.ok(count(thresholded.s) < count(free.s));
  for (const value of thresholded.s.slice(1)) assert.ok(value === 0 || value >= 0.5 - 1e-9 || value < 1e-9);
});

test("a flat trace has no activity and the baseline is recovered", () => {
  let state = 9;
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
  const y = Float64Array.from({ length: 500 }, () => 3 + 0.2 * noise());
  const result = deconvolve(y, { g: 0.9 });
  assert.ok(Math.abs(result.baseline - 3) < 0.05, `baseline ${result.baseline}`);
  assert.ok(result.c.reduce((a, b) => a + b, 0) / y.length < 0.02);
});

test("autocovariance and percentile follow their definitions", () => {
  const y = [1, 3, 2, 5, 4];
  const gamma = autocovariance(y, 2);
  assert.ok(Math.abs(gamma[0] - 2) < 1e-12);
  assert.ok(Math.abs(gamma[1] - ((-2 * 0) + (0 * -1) + (-1 * 2) + (2 * 1)) / 5) < 1e-12);
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5);
  assert.equal(percentile([4, 1, 3, 2], 0), 1);
  assert.equal(percentile([4, 1, 3, 2], 100), 4);
});
