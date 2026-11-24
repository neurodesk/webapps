import assert from "node:assert/strict";
import test from "node:test";
import { APP, DEFAULT_MODEL_ID, MODEL, MODEL_IDS, MODELS, resolveModel } from "../src/config.js";
import { labelColormap, outputName, segmentationSettings } from "../src/settings.js";

test("APP exports canonical metadata", () => {
  assert.equal(APP.id, "cellpose");
  assert.equal(APP.title, "Cellpose");
  assert.match(APP.version, /^\d+\.\d+\.\d{8}$/);
});

test("manifest pins cyto3 and nuclei models with immutable Hugging Face URLs and checksums", () => {
  assert.deepEqual(MODEL_IDS, ["cyto3", "nuclei"]);
  assert.equal(DEFAULT_MODEL_ID, "cyto3");
  assert.equal(MODEL, MODELS.cyto3);
  for (const id of MODEL_IDS) {
    const spec = MODELS[id];
    assert.equal(spec.name, id);
    assert.match(spec.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/cellpose\/models\/cellpose-/);
    assert.match(spec.sha256, /^[0-9a-f]{64}$/);
    assert.ok(spec.bytes > 1_000_000);
    assert.equal(spec.channels, 2);
    assert.equal(spec.bsize, 224);
    assert.equal(spec.divBy, 16);
  }
  assert.equal(MODELS.cyto3.diamMean, 30);
  assert.equal(MODELS.cyto3.supportsNuclearChannel, true);
  assert.equal(MODELS.nuclei.diamMean, 17);
  assert.equal(MODELS.nuclei.supportsNuclearChannel, false);
});

test("resolveModel returns defaults and throws on unknown ids", () => {
  assert.equal(resolveModel(), MODELS.cyto3);
  assert.equal(resolveModel("nuclei"), MODELS.nuclei);
  assert.throws(() => resolveModel("does-not-exist"), /Unknown Cellpose model/);
});

test("segmentationSettings validates bounds and respects model defaults", () => {
  const sCyto = segmentationSettings({}, MODELS.cyto3);
  assert.deepEqual(sCyto, {
    model: "cyto3",
    channel: 1,
    nuclearChannel: 0,
    diameter: 30,
    flowThresh: 0.4,
    cellprobThresh: 0,
    minSize: 15,
    do3D: false,
    anisotropy: 1,
  });

  const sNuc = segmentationSettings({ nuclearChannel: 2 }, MODELS.nuclei);
  assert.equal(sNuc.diameter, 17);
  assert.equal(sNuc.nuclearChannel, 0, "nuclei model ignores nuclear guidance channel");

  assert.throws(() => segmentationSettings({ diameter: 2 }, MODELS.cyto3), /diameter/);
  assert.throws(() => segmentationSettings({ flowThresh: 5 }, MODELS.cyto3), /flow error threshold/);
  assert.throws(() => segmentationSettings({ cellprobThresh: 10 }, MODELS.cyto3), /cell probability threshold/);
  assert.throws(() => segmentationSettings({ minSize: 0 }, MODELS.cyto3), /minimum cell size/);
  assert.throws(() => segmentationSettings({ anisotropy: 0 }, MODELS.cyto3), /anisotropy/);
  assert.throws(() => segmentationSettings({ channel: 1.5 }, MODELS.cyto3), /whole number/);
});

test("outputName sanitizes filenames and labelColormap makes 0 transparent", () => {
  assert.equal(outputName("cells 01/test", "labels.tif"), "cells_01_test_cellpose_labels.tif");
  assert.equal(outputName("!!!", "cells.csv"), "image_cellpose_cells.csv");
  const cmap = labelColormap(5);
  assert.equal(cmap.R.length, 6);
  assert.equal(cmap.A[0], 0);
  assert.equal(cmap.A[1], 255);
  assert.equal(cmap.I[5], 5);
});
