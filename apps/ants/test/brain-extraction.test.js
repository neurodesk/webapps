import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBrain, strippedName } from "../src/brain-extraction.js";

test("brain-extracted names preserve NIfTI suffixes", () => {
  assert.equal(strippedName("T1_head.nii.gz"), "T1_head_brain.nii.gz");
  assert.equal(strippedName("scan.nii"), "scan_brain.nii");
});

test("the extracted image is returned as a file named after its source", async () => {
  const result = await extractBrain({
    file: new File([Uint8Array.of(1, 2)], "T1_head.nii.gz"),
    assetPath: "/brainchop/",
    segmenter: async () => ({ image: Uint8Array.of(3, 4), backend: "webgpu", elapsedMs: 25 }),
  });
  assert.equal(result.file.name, "T1_head_brain.nii.gz");
  assert.equal(result.backend, "webgpu");
});

test("a missing input or an empty MindGrab result is an error, not an empty file", async () => {
  await assert.rejects(extractBrain({ file: null, assetPath: "/brainchop/" }), /Choose an image/);
  await assert.rejects(extractBrain({
    file: new File([Uint8Array.of(1, 2)], "T1_head.nii.gz"),
    assetPath: "/brainchop/",
    segmenter: async () => ({ backend: "webgpu" }),
  }), /did not return a brain-extracted image/);
});
