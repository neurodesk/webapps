// Richardson-Lucy in the committed module against scikit-image 0.25.2's
// restoration.richardson_lucy (clip=False) on the inputs validation/rl_reference.py recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadDeconvolution } from "../src/node.js";

const reference = JSON.parse(readFileSync(new URL("../validation/rl-reference.json", import.meta.url), "utf8"));
const { Deconvolver, paddedDims } = loadDeconvolution();
const decode = (text) => {
  const bytes = Buffer.from(text, "base64");
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / 8).slice();
};

for (const c of reference.cases) {
  test(`${c.id}: equals skimage richardson_lucy after ${c.iterations} iterations`, () => {
    const image = decode(c.image);
    const expected = decode(c.expected);
    const padded = Array.from(paddedDims(Uint32Array.from(c.dims), Uint32Array.from(c.psfDims)));
    // The padded grid is not a power of two on every axis: the mixed-radix path runs.
    assert.ok(padded.some((n) => (n & (n - 1)) !== 0), `padded ${padded}`);
    const deconvolver = new Deconvolver(image, Uint32Array.from(c.dims), decode(c.psf), Uint32Array.from(c.psfDims), 0);
    deconvolver.iterate(c.iterations);
    assert.equal(deconvolver.iterations(), c.iterations);
    const got = deconvolver.estimate();
    let worst = 0;
    for (let i = 0; i < got.length; i += 1) worst = Math.max(worst, Math.abs(got[i] - expected[i]) / Math.abs(expected[i]));
    deconvolver.free();
    // The brief's criterion is 1e-4; the port agrees to rounding.
    assert.ok(worst < 1e-9, `max relative difference ${worst}`);
  });
}

test("RL-TV with a positive weight lowers the total variation of the estimate", () => {
  const c = reference.cases[0];
  const run = (weight) => {
    const deconvolver = new Deconvolver(decode(c.image), Uint32Array.from(c.dims), decode(c.psf), Uint32Array.from(c.psfDims), weight);
    deconvolver.iterate(20);
    const estimate = deconvolver.estimate();
    deconvolver.free();
    let variation = 0;
    for (let i = 1; i < estimate.length; i += 1) variation += Math.abs(estimate[i] - estimate[i - 1]);
    return variation;
  };
  assert.ok(run(0.01) < run(0));
});

test("negative images and oversized TV weights are refused", () => {
  const psf = Float64Array.of(1);
  assert.throws(() => new Deconvolver(Float64Array.of(-1, 1), Uint32Array.of(1, 1, 2), psf, Uint32Array.of(1, 1, 1), 0), /nonnegative/);
  assert.throws(() => new Deconvolver(Float64Array.of(1, 1), Uint32Array.of(1, 1, 2), psf, Uint32Array.of(1, 1, 1), 0.2), /TV weight/);
});
