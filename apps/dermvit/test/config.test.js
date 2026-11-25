// DOM-independent unit tests for DermViT configuration, manifest pinning, and examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APP,
  MODEL,
  OCCLUSION_GRID,
  SALIENCY_EXPORT_MAX_SIDE,
  SALIENCY_EXPORT_OPACITY,
  buildProvenance,
  computeBoundedDimensions,
  readSettings,
} from "../src/config.js";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));

test("app config is frozen and matches automation contract", () => {
  assert.ok(Object.isFrozen(APP));
  assert.equal(APP.id, "dermvit");
  assert.equal(APP.title, "DermViT");
  assert.equal(automation.app, APP.id);
  assert.equal(automation.title, APP.title);
  assert.equal(automation.defaultOperation, "classify");
  assert.match(APP.version, /^\d+\.\d+\.\d{8}$/);
});

test("model config pins exact Hugging Face commit, size, sha256, and 7 HAM10000 classes", () => {
  assert.ok(Object.isFrozen(MODEL));
  assert.equal(
    MODEL.url,
    "https://huggingface.co/sazio/skin-mole-vit-onnx/resolve/25be9e61a71125de9502648c1f6adceb7a882637/onnx/model_quantized.onnx",
  );
  assert.equal(MODEL.bytes, 86993703);
  assert.equal(MODEL.sha256, "85c5c07ec67e94d7b34c83624c36f6a729ef3c47747cf1465212c911db5badfa");
  assert.equal(MODEL.input, "pixel_values");
  assert.equal(MODEL.output, "logits");
  assert.equal(MODEL.imageSize, 224);
  assert.deepEqual(MODEL.mean, [0.5, 0.5, 0.5]);
  assert.deepEqual(MODEL.std, [0.5, 0.5, 0.5]);
  assert.deepEqual(
    MODEL.classes.map((c) => c.code),
    ["BKL", "BCC", "AKIEC", "VASC", "NV", "MEL", "DF"],
  );
  assert.equal(OCCLUSION_GRID, 5);
});

test("examples are pinned with immutable URLs, sha256, and byte lengths", () => {
  assert.equal(examples.length, 3);
  assert.deepEqual(
    examples.map((ex) => ex.id),
    ["isic-nevus", "isic-melanoma", "isic-hemangioma"],
  );
  for (const example of examples) {
    assert.equal(example.files.length, 1);
    const [file] = example.files;
    assert.equal(file.role, "image");
    assert.match(file.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\//);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
  }
});

test("readSettings validates backend and normalizes boolean flags", () => {
  assert.deepEqual(readSettings(), {
    backend: "auto",
    colorConstancy: false,
    computeSaliency: false,
  });
  assert.deepEqual(
    readSettings({ backend: "wasm", colorConstancy: true, computeSaliency: true }),
    { backend: "wasm", colorConstancy: true, computeSaliency: true },
  );
  assert.equal(readSettings({ backend: "invalid" }).backend, "auto");
});

test("computeBoundedDimensions preserves small sizes and bounds large images to 512px", () => {
  assert.equal(SALIENCY_EXPORT_MAX_SIDE, 512);
  assert.equal(SALIENCY_EXPORT_OPACITY, 0.6);
  assert.deepEqual(computeBoundedDimensions(300, 200), { width: 300, height: 200 });
  assert.deepEqual(computeBoundedDimensions(1022, 767), { width: 512, height: 384 });
  assert.deepEqual(computeBoundedDimensions(600, 1200), { width: 256, height: 512 });
  assert.throws(() => computeBoundedDimensions(0, 100), /positive/i);
});

test("buildProvenance records research-only disclaimer, model hash, and runtime metadata", () => {
  const record = buildProvenance({
    file: { name: "ISIC_0000000.jpg", size: 54143 },
    width: 1022,
    height: 767,
    format: "jpeg",
    alphaComposited: true,
    settings: readSettings({ backend: "wasm", colorConstancy: false, computeSaliency: false }),
    seconds: 1.25,
    result: {
      backend: "wasm",
      threads: 4,
      ortVersion: "1.29.0",
      inferenceSeconds: 1.1,
      colorConstancyGains: null,
      saliency: null,
      summary: {
        top: { rank: 1, index: 4, code: "NV", label: "Melanocytic nevi", probability: 0.92, logit: 4.1 },
        ranked: [
          { rank: 1, index: 4, code: "NV", label: "Melanocytic nevi", probability: 0.92, logit: 4.1 },
          { rank: 2, index: 5, code: "MEL", label: "Melanoma", probability: 0.08, logit: 1.6 },
        ],
        margin: 0.84,
        entropyBits: 0.402,
        normalizedEntropy: 0.143,
      },
    },
  });

  assert.equal(record.app, "dermvit");
  assert.equal(record.researchOnly, true);
  assert.match(record.disclaimer, /uncalibrated softmax scores/i);
  assert.equal(record.model.sha256, MODEL.sha256);
  assert.equal(record.runtime.backend, "wasm");
  assert.equal(record.runtime.threads, 4);
  assert.equal(record.preprocessing.colorSpace, "srgb");
  assert.equal(record.preprocessing.alphaComposited, true);
  assert.match(record.preprocessing.resize, /Pillow antialiased bilinear/i);
  assert.equal(record.prediction.scoreType, "uncalibrated-softmax");
  assert.equal(record.prediction.topClass, "NV");
  assert.equal(record.prediction.topSoftmaxScore, 0.92);
  assert.equal(record.prediction.classes[0].softmaxScore, 0.92);
  assert.equal(record.saliency, null);
});
