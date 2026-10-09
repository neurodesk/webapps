import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readVolume } from "@neurodesk/synthsr";
import { dice, maskVoxels } from "../../../test-utils/dice.mjs";

const MIN_REFERENCE_DICE = 0.99;
const fixture = new URL("../validation/fixtures/MSLesSeg_P57_T1_FLAIR_reference-fold0_lesions.nii.gz", import.meta.url);
const load = async () => {
  const bytes = await readFile(fixture);
  return { bytes, volume: readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
};

test("the example's reference lesion mask is the pinned file on the example grid", async () => {
  const { bytes, volume } = await load();
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "e8305ef1bb0fa4260cc9a434fec1bf65e171e6c929e67b6c446c1a3935fea905");
  assert.deepEqual(volume.dims, [240, 240, 81]);
  assert.equal(maskVoxels(volume.data), 12631);
});

test("the browser test's Dice gate rejects an empty, a full and a displaced lesion mask", async () => {
  const { volume } = await load();
  const empty = new Uint8Array(volume.data.length);
  const full = new Uint8Array(volume.data.length).fill(1);
  // The reference itself moved one voxel (1.04 mm) along x.
  const shifted = new Uint8Array(volume.data.length);
  volume.data.forEach((value, index) => {
    if (value && index + 1 < shifted.length) shifted[index + 1] = 1;
  });
  for (const wrong of [empty, full, shifted]) {
    assert.ok(dice(wrong, volume.data) < MIN_REFERENCE_DICE, `Dice ${dice(wrong, volume.data)}`);
  }
});
