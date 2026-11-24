// DOM-independent unit tests (Node, no browser). Browser behaviour is covered by the
// Playwright tests in e2e/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, DEFAULT_MODEL_ID, MODEL, MODEL_IDS, MODELS, resolveModel } from "../src/config.js";
import { labelColormap, outputName, segmentationSettings } from "../src/settings.js";

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
  assert.ok(Object.isFrozen(MODEL));
  assert.ok(Object.isFrozen(MODELS));
  assert.equal(DEFAULT_MODEL_ID, "2D_versatile_fluo");
  assert.deepEqual(MODEL_IDS, ["2D_versatile_fluo", "2D_versatile_he", "2D_paper_dsb2018", "3D_demo"]);
});

test("every model is pinned to an immutable Hugging Face revision with its checksum", () => {
  for (const id of MODEL_IDS) {
    const model = resolveModel(id);
    assert.ok(Object.isFrozen(model), id);
    assert.match(model.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/stardist\/models\/stardist-[a-z0-9-]+\.onnx$/, id);
    assert.match(model.sha256, /^[0-9a-f]{64}$/, id);
    assert.ok(model.bytes > 1_000_000, id);
  }
  assert.equal(resolveModel("2D_versatile_he").channels, 3);
  assert.equal(resolveModel("3D_demo").ndim, 3);
  assert.equal(resolveModel("3D_demo").rays.vertices.length, 96);
  assert.equal(resolveModel("3D_demo").rays.faces.length, 188);
  assert.throws(() => resolveModel("unknown"), /Unknown StarDist model/);
});

test("settings default to the chosen model's thresholds and refuse values out of range", () => {
  assert.deepEqual(segmentationSettings({}, MODEL), { model: "2D_versatile_fluo", channel: 1, probThresh: MODEL.thresholds.prob, nmsThresh: 0.3, tiles: 0 });
  const he = resolveModel("2D_versatile_he");
  assert.deepEqual(segmentationSettings({}, he), { model: "2D_versatile_he", channel: 1, probThresh: he.thresholds.prob, nmsThresh: 0.3, tiles: 0 });
  const paper = resolveModel("2D_paper_dsb2018");
  assert.deepEqual(segmentationSettings({}, paper), { model: "2D_paper_dsb2018", channel: 1, probThresh: paper.thresholds.prob, nmsThresh: 0.5, tiles: 0 });
  assert.deepEqual(segmentationSettings({ channel: 2, probThresh: 0.6, nmsThresh: 0.4, tiles: 3 }, MODEL), { model: "2D_versatile_fluo", channel: 2, probThresh: 0.6, nmsThresh: 0.4, tiles: 3 });
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
