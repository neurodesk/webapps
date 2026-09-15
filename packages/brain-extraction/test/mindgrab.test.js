import test from "node:test";
import assert from "node:assert/strict";
import { writeVolume } from "@neurodesk/synthsr";
import { runMindgrab } from "../src/mindgrab.js";

const volume = {
  dims: [2, 2, 2],
  affine: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ],
  data: Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
};

test("MindGrab adapter requests the mask and records the selected backend", async () => {
  let options;
  const mask = { ...volume, data: Uint8Array.from([0, 1, 1, 1, 1, 1, 1, 0]) };
  const result = await runMindgrab({
    volume,
    assetPath: "https://example.test/syncro/mindgrab/",
    segmenter: async (input, received) => {
      options = received;
      assert.ok(input.byteLength > 352);
      return {
        image: writeVolume(volume),
        mask: writeVolume(mask),
        elapsedMs: 123,
        backend: "webgl2",
        ranInWorker: false,
      };
    },
  });
  const { onLog, ...comparable } = options;
  assert.equal(typeof onLog, "function");
  assert.deepEqual(comparable, {
    model: "mindgrab",
    mask: true,
    gzipOutput: false,
    backend: "auto",
    worker: false,
    assetPath: "https://example.test/syncro/mindgrab/",
  });
  assert.deepEqual([...result.mask.data], [0, 1, 1, 1, 1, 1, 1, 0]);
  assert.equal(result.provenance.backend, "webgl2");
  assert.equal(result.provenance.package, "@brainchop/mindgrab");
});
