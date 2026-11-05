// PSF numerics against analytic ground truth (point-sampled Gaussian beads of known σ) and
// against ImageJ and MetroloJ_QC run in Fiji (test/fixtures/metroloj-reference.json, recorded
// by validation/reference.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FWHM_PER_SIGMA, fitGaussian, fitGoodness } from "../src/core/fit.js";
import { analyseBeads, maxProjection, prominentMaxima, summariseBeads } from "../src/core/psf.js";
import { beadStack, random, smallBeads } from "./synthetic.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/metroloj-reference.json", import.meta.url), "utf8"));

test("a noise-free Gaussian profile returns its σ, centre and baseline", () => {
  const x = Array.from({ length: 31 }, (_, i) => i * 0.05);
  const y = x.map((v) => 12 + 300 * Math.exp(-((v - 0.731) ** 2) / (2 * 0.0917 ** 2)));
  const fit = fitGaussian(x, y);
  assert.ok(Math.abs(fit.sigma - 0.0917) < 1e-9, `σ ${fit.sigma}`);
  assert.ok(Math.abs(fit.centre - 0.731) < 1e-9);
  assert.ok(Math.abs(fit.baseline - 12) < 1e-6);
  assert.ok(Math.abs(fit.fwhm - 0.0917 * FWHM_PER_SIGMA) < 1e-9);
  assert.ok(fit.r2 > 0.999999);
});

test("σ from a noisy, quantised profile is within 1 % over 200 draws on average", () => {
  const next = random(11);
  const errors = [];
  for (let k = 0; k < 200; k++) {
    const sigma = 0.15 + 0.1 * next();
    const centre = 0.9 + 0.2 * next();
    const x = Array.from({ length: 41 }, (_, i) => i * 0.05);
    const y = x.map((v) => Math.round(100 + 2000 * Math.exp(-((v - centre) ** 2) / (2 * sigma ** 2)) + (next() - 0.5) * 20));
    errors.push((fitGaussian(x, y).sigma - sigma) / sigma);
  }
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  assert.ok(Math.abs(mean) < 0.002, `mean relative error ${mean}`);
  assert.ok(Math.max(...errors.map(Math.abs)) < 0.01, `worst relative error ${Math.max(...errors.map(Math.abs))}`);
});

test("goodness of fit is ImageJ's adjusted R²", () => {
  const y = [1, 2, 4, 2, 1, 0];
  const mean = 10 / 6;
  const total = y.reduce((a, v) => a + (v - mean) ** 2, 0);
  assert.equal(fitGoodness(y, 0.5), 1 - (0.5 / total) * (6 / 2));
});

test("synthetic Gaussian beads of known σ give FWHM within 1 % on every axis", () => {
  const spacing = { x: 0.065, y: 0.065, z: 0.15 };
  const sigma = { x: 0.09, y: 0.1, z: 0.32 };
  const beads = [
    { x: 20.3, y: 21.7, z: 15.2, amplitude: 3000 },
    { x: 60.6, y: 24.1, z: 14.7, amplitude: 2500 },
    { x: 23.9, y: 61.4, z: 16.4, amplitude: 4000 },
    { x: 62.2, y: 63.8, z: 15.9, amplitude: 3500 },
  ];
  const data = beadStack({ nx: 84, ny: 84, nz: 31, spacing, beads, sigma, background: 120, noise: 8, seed: 3 });
  const { beads: found } = analyseBeads(data, { nx: 84, ny: 84, nz: 31, spacing }, { halfBox: 9, prominence: 200, minR2: 0.95, saturation: 65535 });
  assert.equal(found.length, 4);
  for (const bead of found) {
    assert.equal(bead.rejection, null);
    assert.ok(bead.goodFit);
    for (const axis of ["x", "y", "z"]) {
      const truth = sigma[axis] * FWHM_PER_SIGMA;
      const error = Math.abs(bead.fwhm[axis] - truth) / truth;
      assert.ok(error < 0.01, `bead ${bead.id} ${axis}: ${bead.fwhm[axis]} vs ${truth} (${(error * 100).toFixed(2)} %)`);
    }
  }
  const summary = summariseBeads(found, { lateral: 0.2, axial: 0.75 });
  assert.equal(summary.used, 4);
  assert.ok(Math.abs(summary.z.ratio - summary.z.mean / 0.75) < 1e-12);
});

test("bead fits equal MetroloJ_QC's CurveFitterPlus on the example's profiles", () => {
  let compared = 0;
  for (const bead of reference.example.beads) {
    for (const axis of ["x", "y", "z"]) {
      if (bead.r2[axis] < 0.8) continue;
      const values = bead.profiles[axis];
      const step = axis === "z" ? 0.1328337499999975 : 0.1261517431295761;
      const fit = fitGaussian(values.map((_, i) => i * step), values);
      assert.ok(Math.abs(fit.fwhm - bead.fwhm[axis]) / bead.fwhm[axis] < 2e-6, `bead ${bead.id} ${axis}: ${fit.fwhm} vs MetroloJ_QC ${bead.fwhm[axis]}`);
      assert.ok(Math.abs(fit.r2 - bead.r2[axis]) < 1e-6);
      compared++;
    }
  }
  assert.ok(compared >= 120, `${compared} profiles compared`);
});

test("maxima and bead centres equal ImageJ's MaximumFinder and MetroloJ_QC's centring", () => {
  const small = smallBeads();
  const projection = maxProjection(Float32Array.from(small.data), small.nx, small.ny, small.nz);
  const maxima = prominentMaxima(projection, small.nx, small.ny, reference.small.prominence).map((m) => [m.x, m.y]);
  assert.deepEqual(maxima.map(String).sort(), reference.small.maxima.map(String).sort());
  const { beads } = analyseBeads(Float32Array.from(small.data), small, { halfBox: reference.small.halfBox, prominence: reference.small.prominence, minR2: 0.95, saturation: 65535 });
  const fitted = beads.filter((b) => b.fits);
  assert.equal(fitted.length, reference.small.beads.length);
  for (const ref of reference.small.beads) {
    const bead = fitted.find((b) => b.id === ref.id);
    assert.deepEqual([bead.x, bead.y, bead.z], [ref.x, ref.y, ref.z]);
    for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(bead.fwhm[axis] - ref.fwhm[axis]) / ref.fwhm[axis] < 2e-6, `${ref.id} ${axis}`);
  }
});

test("beads too close together, at the edge or saturated are rejected with a reason", () => {
  const small = smallBeads();
  const { beads } = analyseBeads(Float32Array.from(small.data), small, { halfBox: 6, prominence: 100, minR2: 0.95, saturation: 65535 });
  const near = beads.filter((b) => (b.peakX === 47 || b.peakX === 52) && b.peakY > 40);
  assert.equal(near.length, 2);
  assert.ok(near.every((b) => b.rejection === "neighbour"));
  const edge = analyseBeads(Float32Array.from(small.data), small, { halfBox: 15, prominence: 100, minR2: 0.95, saturation: 65535 }).beads;
  assert.ok(edge.find((b) => b.peakX === 14).rejection === "edge");
  const saturated = analyseBeads(Float32Array.from(small.data), small, { halfBox: 6, prominence: 100, minR2: 0.95, saturation: 1300 }).beads;
  assert.equal(saturated.find((b) => b.peakX === 21).rejection, "saturated");
});

test("the automatic prominence is 10 background SDs of the projection", () => {
  const small = smallBeads();
  const result = analyseBeads(Float32Array.from(small.data), small, { halfBox: 6, minR2: 0.95, saturation: null });
  assert.ok(Math.abs(result.prominence - 10 * result.background.sd) < 1e-12);
  assert.throws(() => analyseBeads(new Float32Array(64 * 64), { nx: 64, ny: 64, nz: 1, spacing: { x: 1, y: 1, z: 1 } }, { halfBox: 4, minR2: 0.9, saturation: null }), /z-stack/);
});

test("progress reaches the end even when the last maxima are rejected", () => {
  const small = smallBeads();
  const calls = [];
  const { beads, maximaCount } = analyseBeads(Float32Array.from(small.data), small, { halfBox: 15, prominence: 100, minR2: 0.95, saturation: 65535 }, (done, total) => calls.push([done, total]));
  assert.ok(beads.at(-1).rejection, "the last maximum is rejected in this case");
  assert.deepEqual(calls.at(-1), [maximaCount, maximaCount]);
});
