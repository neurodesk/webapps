import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadDwidenoise } from "@neurodesk/dwidenoise";
import {
  derivativeSidecar,
  gatherChunk,
  outputNames,
  parseBvals,
  scatterChunk,
  splitName,
  voxelRanges,
} from "../src/pipeline.js";

test("derivative names keep the BIDS suffix and add desc-denoised", () => {
  assert.deepEqual(splitName("sub-01_dir-AP_dwi.nii.gz"), ["sub-01_dir-AP", "dwi"]);
  assert.deepEqual(outputNames("sub-01_dir-AP_dwi.nii.gz"), {
    image: "sub-01_dir-AP_desc-denoised_dwi.nii.gz",
    bval: "sub-01_dir-AP_desc-denoised_dwi.bval",
    bvec: "sub-01_dir-AP_desc-denoised_dwi.bvec",
    sidecar: "sub-01_dir-AP_desc-denoised_dwi.json",
  });
  assert.equal(outputNames("dwi.nii.gz").image, "dwi_desc-denoised.nii.gz");
  assert.equal(outputNames("sub-01_desc-raw_dwi.nii.gz").image, "sub-01_desc-denoised_dwi.nii.gz");
});

test("the derivative sidecar keeps the input's fields and names the method", () => {
  const out = derivativeSidecar({ PhaseEncodingDirection: "j-" });
  assert.equal(out.PhaseEncodingDirection, "j-");
  assert.match(out.Description, /Patch2Self/);
  assert.match(derivativeSidecar(null).Description, /DIPY 1\.12\.1/);
});

test("b-values must be numbers, one per volume", () => {
  assert.deepEqual(parseBvals("0 1000\t1000\n2000\n", 4), [0, 1000, 1000, 2000]);
  assert.throws(() => parseBvals("  ", 1), /empty/);
  assert.throws(() => parseBvals("0 abc", 2), /not a b-value/);
  assert.throws(() => parseBvals("0 -5", 2), /not a b-value/);
  assert.throws(() => parseBvals("0 1000", 3), /3 volumes but the bval file lists 2/);
});

test("voxel ranges cover every voxel once", () => {
  assert.deepEqual(voxelRanges(10, 4), [[0, 4], [4, 4], [8, 2]]);
  assert.deepEqual(voxelRanges(3, 16), [[0, 3]]);
});

test("a chunk gathered from every volume scatters back to the same place", () => {
  const nvox = 7;
  const frames = 3;
  const data = Float32Array.from({ length: nvox * frames }, (_, i) => i);
  const out = new Float32Array(data.length);
  for (const [first, count] of voxelRanges(nvox, 3)) {
    const chunk = gatherChunk(data, nvox, frames, first, count);
    assert.equal(chunk.length, count * frames);
    assert.equal(chunk[count], data[nvox + first]);
    scatterChunk(out, chunk, nvox, frames, first, count);
  }
  assert.deepEqual(out, data);
});

test("chunked Gram sums with one solve equal the package's one-pass denoise", async () => {
  // The pool's arithmetic without workers: Gram per chunk, sums in chunk order, apply per chunk.
  const p2s = await loadDwidenoise(readFileSync(new URL("../../../packages/dwidenoise/src/dwidenoise.wasm", import.meta.url)));
  const nvox = 300;
  const bvals = [0, 1000, 1000, 1000, 5, 1000];
  const frames = bvals.length;
  const data = new Float32Array(nvox * frames);
  for (let t = 0; t < frames; t++) {
    for (let v = 0; v < nvox; v++) data[t * nvox + v] = 100 + 20 * Math.sin(v * (0.1 + 0.07 * t)) + ((v * 7919 + t * 104729) % 13);
  }
  const groups = p2s.fittedGroups(bvals);
  const ranges = voxelRanges(nvox, 64);
  const grams = groups.map((group) => new Float64Array(p2s.gramLength(group.length)));
  for (const [first, count] of ranges) {
    const buffer = p2s.allocate(count * frames);
    buffer.view().set(gatherChunk(data, nvox, frames, first, count));
    groups.forEach((group, g) => {
      const part = p2s.accumulate(buffer, count, group, new Float64Array(grams[g].length));
      part.forEach((value, i) => (grams[g][i] += value));
    });
    buffer.free();
  }
  const coefficients = groups.map((group, g) => p2s.solve(grams[g], group));
  const out = new Float32Array(data.length);
  for (const [first, count] of ranges) {
    const buffer = p2s.allocate(count * frames);
    buffer.view().set(gatherChunk(data, nvox, frames, first, count));
    groups.forEach((group, g) => p2s.apply(buffer, count, group, coefficients[g]));
    scatterChunk(out, buffer.view(), nvox, frames, first, count);
    buffer.free();
  }
  const whole = p2s.denoiseArray(data, nvox, bvals);
  const range = Math.max(...whole) - Math.min(...whole);
  whole.forEach((value, i) => assert.ok(Math.abs(out[i] - value) <= 1e-5 * range, `index ${i}`));
});
