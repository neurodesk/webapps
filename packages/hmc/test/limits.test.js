import assert from "node:assert/strict";
import test from "node:test";
import { estimatorBytes, nifreezeInputProblem } from "../src/limits.js";
import { correctNiFreeze } from "../src/nifreeze.js";
import { loadHmcNode } from "../src/node.js";

// Inputs measured in hmc.wasm for #452 (plan section 6). `passed` is what the estimator did:
// init and one GP prediction. The first group repeats ds005577's slices, frames or mask
// (validation/estimator-limits.mjs); the second is a large grid with few volumes and a mask of
// the first M voxels (validation/init-limits.mjs); the third a 2 × 2 × 2 grid with many DWI
// volumes (validation/gp-quadratic.mjs).
const grid = (nx, ny, nz) => nx * ny * nz;
const measured = [
  { name: "ds005577 reference", voxels: 1080000, frames: 101, dwiVolumes: 90, maskVoxels: 161668, passed: true },
  { name: "94 slices", voxels: 1353600, frames: 101, dwiVolumes: 90, maskVoxels: 202042, passed: true },
  { name: "98 slices", voxels: 1411200, frames: 101, dwiVolumes: 90, maskVoxels: 210209, passed: false },
  { name: "202 frames", voxels: 1080000, frames: 202, dwiVolumes: 180, maskVoxels: 161679, passed: false },
  { name: "reference grid, 373,717-voxel mask", voxels: 1080000, frames: 101, dwiVolumes: 90, maskVoxels: 373717, passed: true },
  { name: "reference grid, 395,137-voxel mask", voxels: 1080000, frames: 101, dwiVolumes: 90, maskVoxels: 395137, passed: false },
  { name: "half grid, 202 frames", voxels: 547200, frames: 202, dwiVolumes: 180, maskVoxels: 200157, passed: true },
  { name: "half grid, 202 frames, wider mask", voxels: 547200, frames: 202, dwiVolumes: 180, maskVoxels: 227289, passed: false },
  { name: "quarter grid, 404 frames", voxels: 273600, frames: 404, dwiVolumes: 360, maskVoxels: 135294, passed: false },
  // Review of #631: the previous estimate accepted this (1.048 GB), and nifreeze_init trapped.
  { name: "250 × 250 × 275, 6 DWI, 2M mask", voxels: grid(250, 250, 275), frames: 7, dwiVolumes: 6, maskVoxels: 2000000, passed: false },
  { name: "250 × 250 × 264, 6 DWI, 2M mask", voxels: grid(250, 250, 264), frames: 7, dwiVolumes: 6, maskVoxels: 2000000, passed: false },
  { name: "250 × 250 × 270, 6 DWI, 10,000-voxel mask", voxels: grid(250, 250, 270), frames: 7, dwiVolumes: 6, maskVoxels: 10000, passed: false },
  { name: "250 × 250 × 231, 6 DWI, 1M mask", voxels: grid(250, 250, 231), frames: 7, dwiVolumes: 6, maskVoxels: 1000000, passed: true },
  { name: "250 × 250 × 255, 6 DWI, 1M mask", voxels: grid(250, 250, 255), frames: 7, dwiVolumes: 6, maskVoxels: 1000000, passed: false },
  { name: "250 × 250 × 173, 6 DWI, 4M mask", voxels: grid(250, 250, 173), frames: 7, dwiVolumes: 6, maskVoxels: 4000000, passed: true },
  { name: "250 × 250 × 230, 6 DWI, 4M mask", voxels: grid(250, 250, 230), frames: 7, dwiVolumes: 6, maskVoxels: 4000000, passed: false },
  { name: "200 × 200 × 148, 20 DWI, 1M mask", voxels: grid(200, 200, 148), frames: 21, dwiVolumes: 20, maskVoxels: 1000000, passed: true },
  { name: "200 × 200 × 153, 20 DWI, 10,000-voxel mask", voxels: grid(200, 200, 153), frames: 21, dwiVolumes: 20, maskVoxels: 10000, passed: false },
  { name: "200 × 200 × 98, 20 DWI, 1.6M mask", voxels: grid(200, 200, 98), frames: 21, dwiVolumes: 20, maskVoxels: 1600000, passed: true },
  { name: "200 × 200 × 125, 20 DWI, 1.6M mask", voxels: grid(200, 200, 125), frames: 21, dwiVolumes: 20, maskVoxels: 1600000, passed: false },
  { name: "160 × 160 × 83, 60 DWI", voxels: grid(160, 160, 83), frames: 61, dwiVolumes: 60, maskVoxels: 500000, passed: true },
  { name: "160 × 160 × 86, 60 DWI", voxels: grid(160, 160, 86), frames: 61, dwiVolumes: 60, maskVoxels: 500000, passed: false },
  { name: "128 × 128 × 66, 120 DWI", voxels: grid(128, 128, 66), frames: 121, dwiVolumes: 120, maskVoxels: 200000, passed: true },
  { name: "128 × 128 × 69, 120 DWI", voxels: grid(128, 128, 69), frames: 121, dwiVolumes: 120, maskVoxels: 200000, passed: false },
  { name: "3,200 DWI volumes", voxels: 8, frames: 3201, dwiVolumes: 3200, maskVoxels: 8, passed: true },
  { name: "3,500 DWI volumes", voxels: 8, frames: 3501, dwiVolumes: 3500, maskVoxels: 8, passed: false },
  // Review of #631: the estimate before the (DWI − 1)² term accepted this (1.28 MB), and the first prediction trapped.
  { name: "8,000 DWI volumes", voxels: 8, frames: 8001, dwiVolumes: 8000, maskVoxels: 8, passed: false },
];

for (const { name, passed, ...input } of measured) {
  test(`the limit ${passed ? "accepts" : "refuses"} the measured ${name}`, () => {
    assert.equal(nifreezeInputProblem(input) === null, passed);
  });
}

test("the review's large grid is refused at init, before any mask is known", () => {
  const input = { voxels: grid(250, 250, 275), frames: 7, dwiVolumes: 6 };
  assert.match(nifreezeInputProblem(input), /^Series too large for motion correction \(1\.10 of 1\.06 GB\)/);
  assert.match(nifreezeInputProblem({ ...input, maskVoxels: 2000000 }), /^Series too large for motion correction \(1\.12 of 1\.06 GB\)/);
});

test("init applies before a mask exists and the fit only to GP", () => {
  const reference = { voxels: 1080000, frames: 101, dwiVolumes: 90 };
  assert.equal(estimatorBytes(reference).fit, 0);
  assert.equal(nifreezeInputProblem(reference), null);
  const wide = { ...reference, maskVoxels: 1069861 };
  assert.match(nifreezeInputProblem(wide), /^GP model too large \(2\.35 of 1\.06 GB\)/);
  assert.equal(nifreezeInputProblem({ ...wide, model: "trivial" }), null);
});

test("a mask of 0 voxels is a lower bound for the GP estimate", () => {
  for (const input of measured) {
    const zero = estimatorBytes({ ...input, maskVoxels: 0 });
    const bytes = estimatorBytes(input);
    assert.ok(zero.init <= bytes.init && zero.fit <= bytes.fit, input.name);
  }
  assert.notEqual(nifreezeInputProblem({ voxels: 8, frames: 4001, dwiVolumes: 4000, maskVoxels: 0 }), null);
  assert.equal(nifreezeInputProblem({ voxels: 8, frames: 4001, dwiVolumes: 4000, maskVoxels: 0, model: "trivial" }), null);
});

test("each message fits the 90-character limit on visible help", () => {
  const huge = { voxels: 1e9, frames: 400, dwiVolumes: 360, maskVoxels: 1e9 };
  for (const input of [huge, { ...huge, frames: 101, voxels: 1000, dwiVolumes: 30000 }]) {
    const message = nifreezeInputProblem(input);
    assert.ok(message && message.length <= 90, message);
  }
});

test("correctNiFreeze refuses an oversized series before the estimator allocates it", async () => {
  const hmc = await loadHmcNode();
  const frames = 202;
  const series = { dims: [120, 120, 75], frames, data: new Float32Array(0) };
  const bvals = Array.from({ length: frames }, (_, i) => i % 10 ? 1000 : 0);
  const bvecs = [bvals.map(b => b ? 1 : 0), bvals.map(() => 0), bvals.map(() => 0)];
  await assert.rejects(correctNiFreeze({ series, bvals, bvecs, mask: null, hmc, model: "trivial" }), /^Error: Series too large for motion correction/);
});
