import { test } from "node:test";
import assert from "node:assert/strict";
import { niftiFile } from "../src/volumes.js";

test("the NIfTI view of a stack records its voxel size in millimetres", async () => {
  const image = { data: new Uint16Array(4 * 3 * 2), shape: [4, 3, 2] };
  const view = new DataView(await niftiFile(image, [300, 103, 103], "stack.nii").arrayBuffer());
  assert.equal(view.getUint8(123) & 7, 2, "xyzt_units spatial code: millimetres");
  assert.deepEqual([42, 44, 46].map((at) => view.getInt16(at, true)), [2, 3, 4]);
  const f = Math.fround;
  assert.deepEqual([80, 84, 88].map((at) => view.getFloat32(at, true)), [f(103e-6), f(103e-6), f(300e-6)]);
  const row = (at) => [0, 1, 2, 3].map((i) => view.getFloat32(at + 4 * i, true));
  assert.deepEqual(row(280), [f(103e-6), 0, 0, 0]);
  assert.deepEqual(row(296), [0, f(-103e-6), 0, f(2 * 103e-6)]);
  assert.deepEqual(row(312), [0, 0, f(300e-6), 0]);
});
