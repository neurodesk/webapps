import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, AXES, MODEL, WINDOW_PRESETS } from "../src/config.js";

test("app id is lowercase kebab-case and frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.equal(Object.isFrozen(APP), true);
  assert.equal(Object.isFrozen(MODEL), true);
  assert.deepEqual(AXES, ["axial", "coronal", "sagittal"]);
  assert.ok(WINDOW_PRESETS.some((p) => p.id === "auto"));
  assert.ok(WINDOW_PRESETS.some((p) => p.id === "ct-soft"));
});

test("all four MedSAM2 ONNX assets come from commit-pinned Hugging Face URLs", () => {
  const pinned = /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/medsam2\/models\/medsam2-.*\.onnx$/;
  for (const key of ["imageEncoder", "maskDecoder", "memoryEncoder", "memoryAttention"]) {
    assert.match(MODEL[key].url, pinned, key);
    assert.ok(MODEL[key].bytes > 0, key);
    assert.match(MODEL[key].sha256, /^[0-9a-f]{64}$/, key);
  }
});
