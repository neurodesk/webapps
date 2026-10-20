import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadDwidenoise } from "../src/wasm.js";

const p2s = await loadDwidenoise(readFileSync(new URL("../src/dwidenoise.wasm", import.meta.url)));

// The Rust crate's fixture: spec.py, which equals DIPY 1.12.1 Patch2Self version 1 (OLS, patch
// radius 0) to < 5e-15 of the signal range.
const fixture = JSON.parse(
  readFileSync(new URL("../../../exes/dwi/denoise/tests/data/fixture.json", import.meta.url), "utf8"),
);

function nvoxOf(c) {
  return c.dims[0] * c.dims[1] * c.dims[2];
}

/** One f32 ulp of |value| rounded to f32. */
function ulp(value) {
  const f = new Float32Array([Math.abs(value)]);
  const bits = new Uint32Array(f.buffer);
  bits[0] += 1;
  return f[0] - Math.fround(Math.abs(value));
}

test("the fixture is within one f32 ulp of the float64 reference", () => {
  for (const c of fixture.cases) {
    const out = p2s.denoiseArray(Float32Array.from(c.input), nvoxOf(c), c.bvals);
    c.expected.forEach((want, i) => {
      const diff = Math.abs(out[i] - Math.fround(want));
      assert.ok(diff <= ulp(want), `${c.name} index ${i}: ${out[i]} vs ${want}`);
    });
  }
});

test("a single b0 is copied unchanged", () => {
  const c = fixture.cases.find((x) => x.name === "one_b0");
  const nvox = nvoxOf(c);
  const b0 = c.bvals.findIndex((b) => b < 50);
  const out = p2s.denoiseArray(Float32Array.from(c.input), nvox, c.bvals);
  assert.deepEqual(out.subarray(b0 * nvox, (b0 + 1) * nvox), Float32Array.from(c.input.slice(b0 * nvox, (b0 + 1) * nvox)));
});

test("the b0 rule is the shared one: b below 50 is b0", () => {
  assert.equal(p2s.B0_THRESHOLD, 50);
  assert.deepEqual(p2s.groups([0, 49.9, 50, 1000]), { b0: [0, 1], dwi: [2, 3] });
  assert.deepEqual(p2s.fittedGroups([0, 1000, 2000]), [[1, 2]]);
});

test("fewer than 2 diffusion-weighted volumes are refused", () => {
  assert.throws(() => p2s.groups([0, 0, 1000]), /at least 2 diffusion-weighted volumes.*has 1/);
  assert.throws(() => p2s.groups([0, 5]), /has 0/);
  assert.throws(() => p2s.groups([0, NaN, 1000, 1000]), /not a number/);
  assert.throws(() => p2s.denoiseArray(new Float32Array(10), 5, [0, 1000, 1000]), /Expected 15 values/);
});

test("linearly dependent volumes are refused with the volume named", () => {
  const nvox = 64;
  const data = new Float32Array(nvox * 4);
  for (let v = 0; v < nvox; v++) {
    data[v] = 100 + Math.sin(v * 0.37);
    data[nvox + v] = data[2 * nvox + v] = 50 + Math.cos(v * 1.3) * 7 + v;
    data[3 * nvox + v] = 20 + Math.sin(v * 0.11) * 3 + 0.5 * v;
  }
  assert.throws(() => p2s.denoiseArray(data, nvox, [0, 1000, 1000, 1000]), /Volume 2 \(counting from 0\) is a linear combination/);
});

test("values that are not finite are refused", () => {
  const c = fixture.cases[0];
  const data = Float32Array.from(c.input);
  data[nvoxOf(c) + 3] = NaN;
  assert.throws(() => p2s.denoiseArray(data, nvoxOf(c), c.bvals), /not finite numbers/);
});

test("a single unchanged b0 must also contain only finite values", () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const data = Float32Array.from([invalid, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.throws(() => p2s.denoiseArray(data, 4, [0, 1000, 1000]), /not finite numbers/);
  }
});

test("partial Gram sums of voxel ranges add up to one pass, and chunked runs equal one run", () => {
  const c = fixture.cases.find((x) => x.name === "two_b0");
  const nvox = nvoxOf(c);
  const buffer = p2s.allocate(c.input.length);
  try {
    buffer.view().set(c.input);
    for (const group of p2s.fittedGroups(c.bvals)) {
      const one = p2s.accumulate(buffer, nvox, group, new Float64Array(p2s.gramLength(group.length)));
      const sum = new Float64Array(one.length);
      for (const [first, count] of [[0, 7], [7, 50], [57, nvox - 57]]) {
        const part = p2s.accumulate(buffer, nvox, group, new Float64Array(one.length), first, count);
        part.forEach((v, i) => (sum[i] += v));
      }
      one.forEach((v, i) => assert.ok(Math.abs(sum[i] - v) <= 1e-12 * Math.max(1, Math.abs(v)), `gram ${i}`));
    }
  } finally {
    buffer.free();
  }
  const whole = p2s.denoiseArray(Float32Array.from(c.input), nvox, c.bvals);
  const chunked = p2s.denoiseArray(Float32Array.from(c.input), nvox, c.bvals, { chunk: 17 });
  whole.forEach((v, i) => assert.ok(Math.abs(chunked[i] - v) <= ulp(v), `index ${i}`));
});

test("denoise works in place on module memory and reports progress", () => {
  const c = fixture.cases.find((x) => x.name === "two_b0");
  const nvox = nvoxOf(c);
  const buffer = p2s.allocate(c.input.length);
  const seen = [];
  try {
    buffer.view().set(c.input);
    p2s.denoise(buffer, nvox, c.bvals, { chunk: 50, onProgress: (done, total) => seen.push([done, total]) });
    const expected = p2s.denoiseArray(Float32Array.from(c.input), nvox, c.bvals);
    assert.deepEqual(buffer.view(), expected);
  } finally {
    buffer.free();
  }
  assert.deepEqual(seen.at(-1), [4 * nvox, 4 * nvox]);
  assert.throws(() => buffer.view(), /freed/);
});
