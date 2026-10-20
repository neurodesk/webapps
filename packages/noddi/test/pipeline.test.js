import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAPS,
  bidsStem,
  chunks,
  emptyMaps,
  gatherChunk,
  mapName,
  maskIndices,
  maskName,
  meanVolumes,
  scatterChunk,
  stackFrames,
} from "../src/pipeline.js";

test("names follow BIDS BEP016 dwimap", () => {
  const stem = bidsStem("sub-01_ses-1_dwi.nii.gz");
  assert.equal(stem, "sub-01_ses-1");
  assert.equal(mapName(stem, "noddi", "icvf"), "sub-01_ses-1_model-noddi_param-icvf_dwimap.nii.gz");
  assert.equal(maskName(stem), "sub-01_ses-1_desc-brain_mask.nii.gz");
  assert.equal(bidsStem("data.nii"), "data");
});

test("every map has a unique parameter label within its model", () => {
  for (const maps of Object.values(MAPS)) {
    assert.equal(new Set(maps.map((m) => m.param)).size, maps.length);
  }
});

test("the mean b0 averages the given volumes voxel by voxel", () => {
  // Two volumes of four voxels: background 0-2, tissue 100.
  const data = Float32Array.from([0, 2, 100, 100, 2, 0, 100, 102]);
  const mean = meanVolumes(data, 4, [0, 1]);
  assert.deepEqual(Array.from(mean), [1, 1, 100, 101]);
});

test("gather and scatter round-trip a chunk of masked voxels", () => {
  const voxels = 5;
  const volumes = 2;
  const data = Float32Array.from([10, 11, 12, 13, 14, 20, 21, 22, 23, 24]);
  const indices = maskIndices(Uint8Array.from([0, 1, 0, 1, 1]));
  const [first, second] = chunks(indices, 2);
  assert.deepEqual(Array.from(first), [1, 3]);
  assert.deepEqual(Array.from(gatherChunk(data, voxels, volumes, first)), [11, 13, 21, 23]);
  const maps = emptyMaps("noddi", voxels);
  scatterChunk(maps, { ICVF: Float32Array.from([0.5]), unknown: Float32Array.from([9]) }, second);
  assert.deepEqual(Array.from(maps.ICVF), [0, 0, 0, 0, 0.5]);
  assert.equal(maps.unknown, undefined);
});

test("direction frames stack x, y and z volumes", () => {
  const maps = { a: Float32Array.from([1, 2]), b: Float32Array.from([3, 4]), c: Float32Array.from([5, 6]) };
  assert.deepEqual(Array.from(stackFrames(maps, ["a", "b", "c"])), [1, 2, 3, 4, 5, 6]);
});
