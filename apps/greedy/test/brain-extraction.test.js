import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBrain, strippedName } from "../src/brain-extraction.js";

test("brain-extracted names preserve NIfTI suffixes", () => {
  assert.equal(strippedName("T1_head.nii.gz"), "T1_head_brain.nii.gz");
  assert.equal(strippedName("scan.nii"), "scan_brain.nii");
});

test("the MindGrab adapter requests worker-backed automatic extraction", async () => {
  const calls = [];
  const input = new File([Uint8Array.of(1, 2)], "T1_head.nii.gz");
  const result = await extractBrain({
    file: input,
    assetPath: "/brainchop/",
    segmenter: async (bytes, options) => {
      calls.push({ bytes: new Uint8Array(bytes), options });
      return { image: Uint8Array.of(3, 4), backend: "webgpu", elapsedMs: 25 };
    },
  });
  assert.deepEqual(calls[0].bytes, Uint8Array.of(1, 2));
  const { onLog, ...options } = calls[0].options;
  assert.equal(typeof onLog, "function");
  assert.deepEqual(options, {
    model: "mindgrab",
    worker: true,
    backend: "auto",
    assetPath: "/brainchop/",
    timeoutMs: 300_000,
  });
  assert.equal(result.file.name, "T1_head_brain.nii.gz");
  assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()), Uint8Array.of(3, 4));
});
