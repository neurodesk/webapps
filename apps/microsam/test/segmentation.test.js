// Prompt handling, mask choice and outputs against micro-sam's rules and the recorded reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  boxFromCorners,
  chooseToken,
  clickPixel,
  commitObject,
  decoderInputs,
  maskFromLogits,
  maskFromRuns,
  maskIou,
  maskRuns,
  measureObjects,
  objectsCsv,
  parsePrompts,
  roundHalfEven,
  uncommitObject,
} from "../src/segmentation.js";
import { embeddingSummary } from "../src/summary.js";
import { labelColour, overlayRgba } from "../src/display.js";
import { MODEL } from "../src/config.js";

const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../../models/microsam.manifest.json", import.meta.url), "utf8"));

test("numpy.round rounds halves to even", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.49, -0.5, -1.5, 7].map(roundHalfEven), [0, 2, 2, 3, 0, -2, 7]);
});

test("a dragged box is ordered, clamped to the image and rounded as _process_box does", () => {
  assert.deepEqual(boxFromCorners([30.5, 40.2], [10.5, 5.7], 100, 80), [10, 6, 30, 40]);
  assert.deepEqual(boxFromCorners([-5, -2], [120, 90], 100, 80), [0, 0, 100, 80]);
  assert.equal(boxFromCorners([10.2, 10], [10.4, 20], 100, 80), null);
});

test("a click lands on the pixel under it", () => {
  assert.deepEqual(clickPixel(3.99, 0.01, 10, 10), [3, 0]);
  assert.equal(clickPixel(-0.01, 2, 10, 10), null);
  assert.equal(clickPixel(10, 2, 10, 10), null);
});

test("points get SAM's padding point; a box becomes two corner points", () => {
  const points = decoderInputs({ points: [[180, 90, 1], [10, 20, 0]], box: null }, 360, 360);
  assert.deepEqual([...points.labels], [1, 0, -1]);
  assert.deepEqual([...points.coords], [512, 256, 10 * 1024 / 360, 20 * 1024 / 360, 0, 0].map(Math.fround));
  const box = decoderInputs({ points: [[5, 6, 1]], box: [0, 0, 360, 180] }, 360, 360);
  assert.deepEqual([...box.labels], [1, 2, 3]);
  assert.deepEqual([...box.coords].slice(2), [0, 0, 1024, 512]);
  assert.equal(box.count, 3);
});

test("only one positive click without a box takes the best of the three multimask outputs", () => {
  const scores = [0.99, 0.2, 0.8, 0.5];
  assert.equal(chooseToken({ points: [[1, 1, 1]], box: null }, scores), 2);
  assert.equal(chooseToken({ points: [[1, 1, 0]], box: null }, scores), 0);
  assert.equal(chooseToken({ points: [[1, 1, 1], [2, 2, 1]], box: null }, scores), 0);
  assert.equal(chooseToken({ points: [], box: [0, 0, 4, 4] }, scores), 0);
  assert.equal(chooseToken({ points: [[1, 1, 1]], box: [0, 0, 4, 4] }, scores), 0);
});

test("the recorded reference uses the same mask tokens", () => {
  for (const item of reference.cases) {
    const best = !item.prompt.box && item.prompt.points.length === 1 && item.prompt.points[0][2] === 1;
    assert.equal(item.token > 0, best, item.id);
  }
  assert.equal(reference.cases.length, 24);
  assert.ok(reference.cases.every((item) => item.iou_onnx_python === 1), "the ONNX export gives PyTorch's masks in Python");
});

test("a mask is its token's logits above zero", () => {
  const logits = Float32Array.from([1, -1, 0, 2, /* token 1 */ -3, 0.5, 0.1, -0.1]);
  assert.deepEqual([...maskFromLogits(logits, 0, 2, 2)], [1, 0, 0, 1]);
  assert.deepEqual([...maskFromLogits(logits, 1, 2, 2)], [0, 1, 1, 0]);
});

test("accepted objects keep their pixels and undo frees exactly the claimed ones", () => {
  const labels = new Uint32Array(6);
  const first = commitObject(labels, Uint8Array.of(1, 1, 0, 0, 0, 0), 1);
  const second = commitObject(labels, Uint8Array.of(0, 1, 1, 1, 0, 0), 2);
  assert.deepEqual([...labels], [1, 1, 2, 2, 0, 0]);
  assert.deepEqual([...first], [0, 1]);
  assert.deepEqual([...second], [2, 3]);
  uncommitObject(labels, second);
  assert.deepEqual([...labels], [1, 1, 0, 0, 0, 0]);
});

test("the table measures each object on the label image", () => {
  // 4 × 3 image: object 1 the left column pair, object 2 one pixel.
  const labels = Uint32Array.of(1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 0, 0);
  const plane = { label: "Intensity", kind: "sample 1", data: Uint16Array.from({ length: 12 }, (_, i) => i * 10) };
  const objects = [{ id: 1, score: 0.91234, prompt: { points: [[0, 0, 1], [3, 2, 0]], box: null } }, { id: 2, score: 0.5, prompt: { points: [], box: [3, 1, 4, 2] } }];
  const rows = measureObjects(labels, 4, [plane], objects);
  assert.deepEqual(rows.map((row) => [row.area, row.x, row.y, row.box, row.means]), [
    [4, 0.5, 0.5, [0, 0, 2, 2], [(0 + 10 + 40 + 50) / 4]],
    [1, 3, 1, [3, 1, 4, 2], [70]],
  ]);
  assert.equal(objectsCsv(rows, [plane]), [
    "id,area_px,centroid_x,centroid_y,bbox_x0,bbox_y0,bbox_x1,bbox_y1,mean_intensity,predicted_iou,prompt",
    "1,4,0.500,0.500,0,0,2,2,25.00000,0.9123,1+ 1-",
    "2,1,3.000,1.000,3,1,4,2,70.00000,0.5000,box",
    "",
  ].join("\n"));
  const rgb = ["red", "green", "blue"].map((kind) => ({ ...plane, kind }));
  assert.match(objectsCsv(measureObjects(labels, 4, rgb, objects), rgb), /^id,.*,mean_red,mean_green,mean_blue,predicted_iou,prompt\n/);
});

test("run lengths round-trip and match the reference's areas", () => {
  const mask = Uint8Array.of(1, 1, 0, 1, 0, 0);
  assert.deepEqual(maskRuns(mask), [0, 2, 1, 1, 2]);
  assert.deepEqual([...maskFromRuns(maskRuns(mask), 6)], [...mask]);
  const size = reference.image.width * reference.image.height;
  for (const item of reference.cases) {
    const decoded = maskFromRuns(item.runs, size);
    assert.equal(decoded.reduce((sum, value) => sum + value, 0), item.area, item.id);
    assert.deepEqual(maskRuns(decoded), item.runs, item.id);
    assert.equal(maskIou(decoded, decoded), 1);
  }
});

test("automation prompts are checked at the boundary", () => {
  assert.deepEqual(parsePrompts('[{"points":[[1,2,1]]},{"box":[9,9,2.5,3]}]', 10, 10), [
    { points: [[1, 2, 1]], box: null },
    { points: [], box: [2, 3, 9, 9] },
  ]);
  assert.throws(() => parsePrompts("not json", 10, 10), /JSON array/);
  assert.throws(() => parsePrompts("[]", 10, 10), /at least one object/);
  assert.throws(() => parsePrompts('[{"points":[[10,2,1]]}]', 10, 10), /outside the 10 × 10 image/);
  assert.throws(() => parsePrompts('[{"points":[[1,2,2]]}]', 10, 10), /label is 1/);
  assert.throws(() => parsePrompts('[{"box":[1,1,1,5]}]', 10, 10), /no area/);
  assert.throws(() => parsePrompts('[{"points":[]}]', 10, 10), /at least one point or a box/);
});

test("the embedding summary samples the reference's positions", () => {
  const embedding = Float32Array.from({ length: 256 * 64 * 64 }, (_, i) => (i % 7) - 3);
  const summary = embeddingSummary(embedding);
  assert.equal(summary.stride, reference.embedding.stride);
  assert.equal(summary.samples.length, reference.embedding.samples.length);
  assert.equal(summary.samples[3], embedding[3 * summary.stride]);
});

test("label colours are distinct and the overlay leaves background clear", () => {
  const colours = new Set(Array.from({ length: 50 }, (_, i) => labelColour(i + 1).join(",")));
  assert.equal(colours.size, 50);
  const labels = Uint32Array.of(0, 1, 1, 0);
  const filled = overlayRgba({ labels, width: 2, height: 2, mode: "filled", opacity: 0.5 });
  assert.deepEqual([filled[3], filled[7]], [0, 128]);
  assert.equal(overlayRgba({ labels, width: 2, height: 2, mode: "image", opacity: 0.5 }).some(Boolean), false);
  const preview = overlayRgba({ labels, width: 2, height: 2, mode: "filled", opacity: 0.2, preview: Uint8Array.of(1, 1, 0, 0), previewId: 2 });
  assert.deepEqual([...preview.slice(0, 3)], labelColour(2));
  assert.equal(preview[3], 128);
});

test("the model URLs come from the pinned manifest", () => {
  assert.match(MODEL.encoder.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/microsam\/models\/microsam-vit-t-lm-encoder\.onnx$/);
  assert.equal(MODEL.decoder.sha256, manifest.assets.find((asset) => asset.role === "decoder").sha256);
  assert.equal(manifest.license, "CC-BY-4.0");
});
