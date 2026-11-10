// DOM-independent unit tests (Node, no browser). Browser behaviour is covered by the
// Playwright tests in e2e/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, MODEL } from "../src/config.js";
import { labelColormap, outputName, segmentationSettings } from "../src/settings.js";

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
  assert.ok(Object.isFrozen(MODEL));
});

test("the model is pinned to an immutable Hugging Face revision with its checksum", () => {
  assert.match(MODEL.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/stardist\/models\/stardist-2d-versatile-fluo\.onnx$/);
  assert.match(MODEL.sha256, /^[0-9a-f]{64}$/);
});

test("settings default to the model's thresholds and refuse values out of range", () => {
  assert.deepEqual(segmentationSettings({}, MODEL), { channel: 1, probThresh: MODEL.thresholds.prob, nmsThresh: 0.3, tiles: 0 });
  assert.deepEqual(segmentationSettings({ channel: 2, probThresh: 0.6, nmsThresh: 0.4, tiles: 3 }, MODEL), { channel: 2, probThresh: 0.6, nmsThresh: 0.4, tiles: 3 });
  assert.throws(() => segmentationSettings({ probThresh: 1.5 }, MODEL), /probability threshold must be between/);
  assert.throws(() => segmentationSettings({ nmsThresh: 0 }, MODEL), /overlap threshold must be between/);
  assert.throws(() => segmentationSettings({ tiles: 2.5 }, MODEL), /whole number/);
  assert.throws(() => segmentationSettings({ channel: 0 }, MODEL), /channel must be between/);
});

test("output names keep the input name and drop unsafe characters", () => {
  assert.equal(outputName("dsb2018-nuclei-2d", "labels.tif"), "dsb2018-nuclei-2d_stardist_labels.tif");
  assert.equal(outputName("my image (1)", "nuclei.csv"), "my_image_1_stardist_nuclei.csv");
});

test("the label colormap gives every nucleus an opaque colour and leaves background clear", () => {
  const cmap = labelColormap(3);
  assert.deepEqual(cmap.I, [0, 1, 2, 3]);
  assert.deepEqual(cmap.A, [0, 255, 255, 255]);
  assert.notDeepEqual([cmap.R[1], cmap.G[1], cmap.B[1]], [cmap.R[2], cmap.G[2], cmap.B[2]]);
});
