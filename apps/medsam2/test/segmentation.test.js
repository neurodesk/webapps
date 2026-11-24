import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boxFromCorners,
  clickPixel,
  commitObject3D,
  decoderInputs,
  maskIou,
  measureObjects3D,
  objectsTsv,
  parsePrompts,
  reconcileObjectsFromLabels,
  selectMaskAndPtr,
  stabilityScore,
  thresholdMask,
  uncommitObject,
  useMultimaskForPrompt,
} from "../src/segmentation.js";
import { LOW_RES_SIZE } from "../src/volume.js";
import { labelColour, overlayRgba } from "../src/display.js";

test("boxFromCorners and clickPixel clamp and validate coordinates", () => {
  assert.deepEqual(boxFromCorners([30.2, 40.6], [10.4, 5.1], 100, 80), [10, 5, 30, 41]);
  assert.equal(boxFromCorners([10, 10], [10, 20], 100, 80), null);
  assert.deepEqual(clickPixel(4.9, 1.1, 10, 10), [4, 1]);
  assert.equal(clickPixel(10, 0, 10, 10), null);
});

test("decoderInputs scales coordinates to 512×512 with box corners first", () => {
  const inputs = decoderInputs({ box: [50, 25, 100, 75], points: [[25, 50, 1]] }, 200, 100);
  assert.deepEqual([...inputs.labels], [2, 3, 1]);
  assert.deepEqual([...inputs.coords], [128, 128, 256, 384, 64, 256]);
  assert.equal(useMultimaskForPrompt({ box: null, points: [[10, 10, 1]] }), true);
  assert.equal(useMultimaskForPrompt({ box: [0, 0, 10, 10], points: [] }), false);
  assert.equal(useMultimaskForPrompt({ box: null, points: [[1, 1, 1], [2, 2, 0]] }), false);
});

test("selectMaskAndPtr implements SAM 2 dynamic_multimask_via_stability and ptr rules", () => {
  const plane = LOW_RES_SIZE * LOW_RES_SIZE;
  const lowMasks = new Float32Array(4 * plane);
  // Token 0 unstable: half in (-0.05, +0.05], half > +0.05 -> stability = 0.5 < 0.98
  lowMasks.fill(0.01, 0, plane / 2);
  lowMasks.fill(1.0, plane / 2, plane);
  lowMasks.fill(2.0, 2 * plane, 3 * plane);
  assert.ok(Math.abs(stabilityScore(lowMasks, 0, plane) - 0.5) < 1e-6);

  const ious = Float32Array.of(0.95, 0.4, 0.9, 0.6);
  const objPtrs = Float32Array.from({ length: 4 * 256 }, (_, i) => Math.floor(i / 256) + 1);
  // Single-mask mode (multimaskOutput=false) with unstable token 0 falls back to token 2 mask,
  // while keeping token 0 object pointer (SAM 2 MaskDecoder.forward rule).
  const fallback = selectMaskAndPtr(lowMasks, ious, objPtrs, false);
  assert.equal(fallback.token, 2);
  assert.equal(fallback.objPtr[0], 1);

  // Multimask mode picks token 2 for both mask and object pointer.
  const multi = selectMaskAndPtr(lowMasks, ious, objPtrs, true);
  assert.equal(multi.token, 2);
  assert.equal(multi.objPtr[0], 3);
});

test("3D commit, undo, measurement and TSV output work across slices", () => {
  const dims = [4, 4, 3];
  const labels = new Uint8Array(4 * 4 * 3);
  const m0 = new Uint8Array(16);
  m0[0] = 1;
  m0[1] = 1;
  const m1 = new Uint8Array(16);
  m1[0] = 1;
  const claimed = commitObject3D(labels, new Map([[0, m0], [1, m1]]), dims, "axial", 1);
  assert.equal(claimed.length, 3);
  const rows = measureObjects3D(labels, dims, [1, 2, 3], [{ id: 1, slices: 2, axis: "axial", prompt: { box: [0, 0, 2, 1], points: [] } }]);
  assert.equal(rows[0].voxels, 3);
  assert.equal(rows[0].slices, 2);
  assert.equal(rows[0].volumeMm3, 18);
  assert.match(objectsTsv(rows), /^label\tvoxels\tvolume_mm3\tvolume_ml\tslices\tcentroid_x_vx\t.*\n1\t3\t18\.00\t0\.0180\t2\t/);
  uncommitObject(labels, claimed, 1);
  assert.equal(labels.some(Boolean), false);
});

test("reconcileObjectsFromLabels preserves label integrity across edits and undo", () => {
  const dims = [4, 4, 3];
  const labels = new Uint8Array(4 * 4 * 3);
  const m1 = new Uint8Array(16);
  m1[0] = 1;
  m1[1] = 1;
  const m2 = new Uint8Array(16);
  m2[2] = 1;
  m2[3] = 1;
  const c1 = commitObject3D(labels, new Map([[0, m1]]), dims, "axial", 1);
  const c2 = commitObject3D(labels, new Map([[0, m2]]), dims, "axial", 2);
  const objects = [
    { id: 1, claimed: c1, axis: "axial", slices: 1, voxels: c1.length, prompt: { box: null, points: [[0, 0, 1]] } },
    { id: 2, claimed: c2, axis: "axial", slices: 1, voxels: c2.length, prompt: { box: null, points: [[2, 0, 1]] } },
  ];

  // Simulate manual mask edit: paint label 1 over one of label 2's voxels and extend label 2 onto slice 1 and 2.
  const overwritten = c2[0];
  labels[overwritten] = 1;
  const extraSlice1 = 1 * 16 + 5;
  const extraSlice2 = 2 * 16 + 5;
  labels[extraSlice1] = 2;
  labels[extraSlice2] = 2;

  const { objects: reconciled, nextId } = reconcileObjectsFromLabels(labels, dims, objects);
  assert.equal(nextId, 3);
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[0].voxels, 3);
  assert.equal(reconciled[0].slices, 1);
  assert.equal(reconciled[1].voxels, 3);
  assert.equal(reconciled[1].slices, 3);

  const rows = measureObjects3D(labels, dims, 2.5, reconciled);
  assert.equal(rows[1].slices, 3);
  assert.equal(rows[1].volumeMm3, 7.5);

  // Undoing label 2 removes all of label 2 (including newly painted slices) and leaves label 1 intact.
  const popped = reconciled.pop();
  uncommitObject(labels, popped.claimed, popped.id);
  assert.equal(labels[overwritten], 1);
  assert.equal(labels[extraSlice1], 0);
  assert.equal(labels[extraSlice2], 0);
  assert.equal(labels.filter((v) => v === 1).length, 3);
  assert.equal(labels.filter((v) => v === 2).length, 0);
});

test("parsePrompts validates axes, slice bounds, points, boxes and ranges", () => {
  const parsed = parsePrompts('[{"axis":"axial","slice":5,"box":[1,2,8,9],"range":[3,7]}]', [10, 12, 10]);
  assert.deepEqual(parsed[0], { axis: "axial", slice: 5, points: [], box: [1, 2, 8, 9], propagate: true, range: [3, 7] });
  assert.throws(() => parsePrompts('[{"axis":"oblique"}]', [10, 10, 10]), /axis must be/);
  assert.throws(() => parsePrompts('[{"slice":10,"points":[[1,1,1]]}]', [10, 10, 10]), /outside 0\.\.9/);
  assert.throws(() => parsePrompts('[{"slice":5,"points":[[1,1,1]],"range":[6,8]}]', [10, 10, 10]), /must include slice 5/);
  assert.equal(maskIou(thresholdMask(Float32Array.of(1, -1)), Uint8Array.of(1, 0)), 1);
  assert.equal(labelColour(1).length, 3);
  assert.equal(overlayRgba({ labels: Uint8Array.of(0, 1), width: 2, height: 1, opacity: 0.5 }).length, 8);
});
