// DOM-independent unit tests for DermViT preprocessing, softmax/entropy, occlusion
// sensitivity, upsampling, and output serializers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode as decodePng } from "fast-png";
import { MODEL } from "../src/config.js";
import {
  computeOcclusionSensitivity,
  normalizeInputRgba,
  occludeCell,
  preprocessToTensor,
  resizeRgbaPillowBilinear,
  shadesOfGray,
  softmax,
  summarizePredictions,
  upsampleSaliency,
  validateLogits,
} from "../src/core/vit.js";
import { compositeSaliencyRgba, heatColor, saliencyOverlayRgba } from "../src/display.js";
import {
  CSV_DISCLAIMER,
  encodeSaliencyPng,
  outputStem,
  predictionsCsv,
  probabilityChartSvg,
  provenanceJson,
} from "../src/outputs.js";

test("shadesOfGray balances warm cast and handles uniform black images safely", () => {
  const width = 4;
  const height = 4;
  const warm = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    warm[i * 4] = 200;
    warm[i * 4 + 1] = 100;
    warm[i * 4 + 2] = 100;
    warm[i * 4 + 3] = 255;
  }
  const { rgba, gains } = shadesOfGray(warm, width, height, 6);
  assert.ok(gains.r < 1, "red channel should be attenuated");
  assert.ok(gains.g > 1 && gains.b > 1, "green and blue channels should be boosted");
  assert.equal(rgba[0], rgba[1]);
  assert.equal(rgba[1], rgba[2]);
  assert.equal(rgba[3], 255);

  const black = new Uint8ClampedArray(width * height * 4);
  const blackResult = shadesOfGray(black, width, height, 6);
  assert.deepEqual(blackResult.gains, { r: 1, g: 1, b: 1 });
});

test("preprocessToTensor resizes bilinearly to 224x224 and normalizes NCHW to [-1, 1]", () => {
  const width = 2;
  const height = 2;
  // Constant RGB = (0, 127.5 ~ 128, 255)
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 0;
    rgba[i * 4 + 1] = 128;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }

  const { tensor, colorConstancyGains } = preprocessToTensor(rgba, width, height);
  const plane = 224 * 224;
  assert.equal(tensor.length, 3 * plane);
  assert.equal(colorConstancyGains, null);

  // R=0 -> (0/255 - 0.5)/0.5 = -1
  assert.ok(Math.abs(tensor[0] - -1) < 1e-5);
  assert.ok(Math.abs(tensor[plane - 1] - -1) < 1e-5);
  // G=128 -> (128/255 - 0.5)/0.5 ~= +0.00392
  const expectedG = (128 / 255 - 0.5) / 0.5;
  assert.ok(Math.abs(tensor[plane] - expectedG) < 1e-5);
  // B=255 -> (255/255 - 0.5)/0.5 = +1
  assert.ok(Math.abs(tensor[2 * plane] - 1) < 1e-5);
});

test("preprocessToTensor bilinearly interpolates horizontal gradient cleanly", () => {
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 255, 255, 255, 255,
  ]);
  const { tensor } = preprocessToTensor(rgba, 2, 2, { size: 4 });
  // Leftmost column near -1, rightmost near +1, strictly increasing across x
  assert.ok(tensor[0] < tensor[1]);
  assert.ok(tensor[1] < tensor[2]);
  assert.ok(tensor[2] < tensor[3]);
  assert.ok(tensor[0] < -0.5);
  assert.ok(tensor[3] > 0.5);
});

test("softmax and summarizePredictions compute stable probabilities, ranking, entropy, and margin", () => {
  // Uniform logits -> equal probabilities, maximum entropy
  const uniform = summarizePredictions([1000, 1000, 1000, 1000, 1000, 1000, 1000], MODEL.classes);
  const sum = uniform.probabilities.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.ok(Math.abs(uniform.normalizedEntropy - 1) < 1e-6);
  assert.ok(Math.abs(uniform.entropyBits - Math.log2(7)) < 1e-6);
  assert.ok(Math.abs(uniform.margin) < 1e-12);

  // Peaked logits at index 4 (NV) with runner-up index 5 (MEL)
  const peaked = summarizePredictions([-2, -3, -4, -5, 5, 2, -6], MODEL.classes);
  assert.equal(peaked.top.code, "NV");
  assert.equal(peaked.top.rank, 1);
  assert.equal(peaked.ranked[1].code, "MEL");
  assert.equal(peaked.ranked[1].rank, 2);
  assert.ok(peaked.top.probability > 0.9);
  assert.ok(peaked.margin > 0.8);
  assert.ok(peaked.normalizedEntropy > 0 && peaked.normalizedEntropy < 0.3);
  assert.equal(softmax([]).length, 0);
});

test("occlusion sensitivity runs 5x5 passes, isolates active patch, and upsamples cleanly", async () => {
  const size = 10;
  const grid = 5;
  const baseTensor = new Float32Array(3 * size * size).fill(1);
  const occluded = occludeCell(baseTensor, size, grid, 2, 2, 0);
  // Center cell [4..6, 4..6] should be zeroed across all 3 channels; corners remain 1
  assert.equal(occluded[0], 1);
  assert.equal(occluded[4 * size + 4], 0);
  assert.equal(occluded[size * size + 5 * size + 5], 0);
  assert.equal(occluded[2 * size * size + 4 * size + 5], 0);

  // Synthetic forward model whose top class (NV = index 4) depends strongly on center cell [4..6, 4..6]
  let calls = 0;
  const runForward = async (tensor) => {
    calls += 1;
    const centerVal = tensor[4 * size + 4]; // 1 normally, 0 when center cell occluded
    const logits = new Float32Array([-1, -1, -1, -1, centerVal > 0.5 ? 4 : -1, 0, -1]);
    return logits;
  };
  const baseSummary = summarizePredictions(await runForward(baseTensor), MODEL.classes);
  calls = 0;

  const progressSteps = [];
  const saliency = await computeOcclusionSensitivity(baseTensor, baseSummary, runForward, {
    size,
    grid,
    onProgress: (done, total) => progressSteps.push([done, total]),
  });

  assert.equal(calls, 25);
  assert.equal(progressSteps.length, 25);
  assert.deepEqual(progressSteps[24], [25, 25]);
  assert.equal(saliency.topClassCode, "NV");
  assert.ok(saliency.maxDrop > 0.5);
  // Center cell (row 2, col 2 => index 12) should be normalized to 1.0, others ~0
  assert.equal(saliency.normalized[12], 1);
  assert.equal(saliency.normalized[0], 0);

  const upsampled = upsampleSaliency(saliency.normalized, grid, 25, 25);
  assert.equal(upsampled.length, 625);
  // Center pixel (12, 12) aligns with grid center (2, 2) -> 1.0; corner pixel is 0
  assert.ok(Math.abs(upsampled[12 * 25 + 12] - 1) < 1e-6);
  assert.ok(upsampled[12 * 25 + 10] > 0.5 && upsampled[12 * 25 + 10] < 1);
  assert.equal(upsampled[0], 0);
});

test("normalizeInputRgba rejects fully transparent images and composites partial alpha over white", () => {
  const transparent = new Uint8ClampedArray(4 * 4 * 4);
  assert.throws(
    () => normalizeInputRgba(transparent, 4, 4),
    { message: "Image is fully transparent and has no visible pixels." },
  );
  assert.throws(
    () => preprocessToTensor(transparent, 4, 4),
    { message: "Image is fully transparent and has no visible pixels." },
  );

  // 2x1: pixel 0 is black at 50% alpha (a=128 -> ~127 over white); pixel 1 is transparent (a=0 -> 255 white)
  const partial = new Uint8ClampedArray([
    0, 0, 0, 128,
    10, 20, 30, 0,
  ]);
  const flattened = normalizeInputRgba(partial, 2, 1);
  assert.equal(flattened.hadTransparency, true);
  assert.equal(flattened.rgba[0], 127);
  assert.equal(flattened.rgba[1], 127);
  assert.equal(flattened.rgba[2], 127);
  assert.equal(flattened.rgba[3], 255);
  assert.equal(flattened.rgba[4], 255);
  assert.equal(flattened.rgba[5], 255);
  assert.equal(flattened.rgba[6], 255);
  assert.equal(flattened.rgba[7], 255);

  const opaque = new Uint8ClampedArray([40, 80, 120, 255]);
  const opaqueResult = normalizeInputRgba(opaque, 1, 1);
  assert.equal(opaqueResult.hadTransparency, false);
  assert.deepEqual(Array.from(opaqueResult.rgba), [40, 80, 120, 255]);
});

test("resizeRgbaPillowBilinear performs antialiased downsampling matching Pillow resample=2", () => {
  // 16x16 1-pixel checkerboard (0 and 255 alternating) downsampled 4x to 4x4:
  // Pillow's scale-dependent triangular filter integrates over 2*scale pixels and averages near mid-grey (~127-128),
  // whereas naive 2x2 bilinear sampling aliases severely.
  const inW = 16;
  const inH = 16;
  const checker = new Uint8ClampedArray(inW * inH * 4);
  for (let y = 0; y < inH; y++) {
    for (let x = 0; x < inW; x++) {
      const v = (x + y) % 2 === 0 ? 0 : 255;
      const idx = (y * inW + x) * 4;
      checker[idx] = v;
      checker[idx + 1] = v;
      checker[idx + 2] = v;
      checker[idx + 3] = 255;
    }
  }
  const down = resizeRgbaPillowBilinear(checker, inW, inH, 4, 4);
  for (let i = 0; i < 16; i++) {
    const r = down[i * 4];
    assert.ok(r >= 120 && r <= 135, `Expected antialiased mid-grey near 128, got ${r} at pixel ${i}`);
    assert.equal(down[i * 4 + 3], 255);
  }

  // Thin 1px white vertical stripe at x=5 in a 16x16 black image downsampled to 4x4:
  // antialiased filter preserves the stripe's energy (non-zero in column 1), unlike naive 2x2 sampling.
  const stripe = new Uint8ClampedArray(inW * inH * 4);
  for (let i = 0; i < inW * inH; i++) stripe[i * 4 + 3] = 255;
  for (let y = 0; y < inH; y++) {
    const idx = (y * inW + 5) * 4;
    stripe[idx] = 255;
    stripe[idx + 1] = 255;
    stripe[idx + 2] = 255;
  }
  const downStripe = resizeRgbaPillowBilinear(stripe, inW, inH, 4, 4);
  const col1 = downStripe[1 * 4];
  assert.ok(col1 > 20 && col1 < 120, `Expected antialiased stripe contribution in column 1, got ${col1}`);

  // Vertical-first branch (tall 8x32 -> 4x4) also preserves constant and antialiased checkerboard energy.
  const tall = new Uint8ClampedArray(8 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 8; x++) {
      const v = y % 2 === 0 ? 0 : 255;
      const idx = (y * 8 + x) * 4;
      tall[idx] = v;
      tall[idx + 1] = v;
      tall[idx + 2] = v;
      tall[idx + 3] = 255;
    }
  }
  const downTall = resizeRgbaPillowBilinear(tall, 8, 32, 4, 4);
  for (let i = 0; i < 16; i++) {
    assert.ok(downTall[i * 4] >= 120 && downTall[i * 4] <= 135, `Tall antialiased value ${downTall[i * 4]}`);
  }

  // preprocessToTensor uses 8-bit rounded Pillow output before (v/255 - 0.5)/0.5 normalization.
  const { tensor } = preprocessToTensor(checker, inW, inH, { size: 4 });
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(tensor[i]) < 0.08, `Expected near-zero normalized tensor for checkerboard, got ${tensor[i]}`);
  }
});

test("validateLogits, softmax, summarizePredictions, and occlusion reject NaN, Infinity, and wrong length", async () => {
  assert.throws(() => validateLogits([1, 2, 3], 7), /Expected 7 class logits, received 3/);
  assert.throws(() => summarizePredictions([1, 2, 3, 4, 5, 6], MODEL.classes), /Expected 7 class logits/);
  assert.throws(() => summarizePredictions([1, 2, Number.NaN, 4, 5, 6, 7], MODEL.classes), /non-finite logit/i);
  assert.throws(() => summarizePredictions([1, 2, Number.POSITIVE_INFINITY, 4, 5, 6, 7], MODEL.classes), /non-finite logit/i);
  assert.throws(() => softmax([0, Number.NaN, 1]), /non-finite logit/i);
  assert.throws(() => softmax([0, Number.NEGATIVE_INFINITY, 1]), /non-finite logit/i);

  const size = 10;
  const baseTensor = new Float32Array(3 * size * size).fill(0.5);
  const baseSummary = summarizePredictions([0, 0, 0, 0, 3, 1, 0], MODEL.classes);

  let pass = 0;
  await assert.rejects(
    () =>
      computeOcclusionSensitivity(
        baseTensor,
        baseSummary,
        async () => {
          pass += 1;
          if (pass === 7) return new Float32Array([0, 0, Number.NaN, 0, 1, 0, 0]);
          return new Float32Array([0, 0, 0, 0, 2, 1, 0]);
        },
        { size, grid: 5 },
      ),
    /non-finite logit/i,
  );

  await assert.rejects(
    () =>
      computeOcclusionSensitivity(
        baseTensor,
        baseSummary,
        async () => new Float32Array([0, 1, 2]),
        { size, grid: 5 },
      ),
    /Expected 7 class logits, received 3/,
  );
});

test("CSV, provenance JSON, saliency PNG, and SVG chart serializers produce valid artifacts", () => {
  const summary = summarizePredictions([-2, -3, -4, -5, 4.5, 1.5, -3.5], MODEL.classes);
  assert.equal(outputStem("ISIC_0000000.jpg"), "ISIC_0000000");
  assert.equal(outputStem("lesion.PNG"), "lesion");

  const csv = predictionsCsv(summary);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], CSV_DISCLAIMER);
  assert.equal(lines[1], "rank,class_index,code,label,softmax_score,softmax_percent,logit");
  assert.ok(lines[2].startsWith("1,4,NV,Melanocytic nevi,"));

  const json = provenanceJson({ app: "dermvit", top: "NV" });
  assert.deepEqual(JSON.parse(json), { app: "dermvit", top: "NV" });

  // Saliency overlay & PNG encoding round-trip
  const [r, g, b] = heatColor(1);
  assert.ok(r > 200 && g > 200 && b > 100);
  const base = new Uint8ClampedArray(16 * 4).fill(180);
  const map = new Float32Array(16).fill(0.8);
  const overlay = saliencyOverlayRgba(map, 4, 4, 0.5);
  assert.equal(overlay.length, 64);
  assert.ok(overlay[3] > 0);
  const comp = compositeSaliencyRgba(base, map, 4, 4, 0.6);
  assert.equal(comp[3], 255);
  const pngBytes = encodeSaliencyPng(base, map, 4, 4, 0.6);
  assert.equal(pngBytes.byteOffset, 0);
  assert.equal(pngBytes.byteLength, pngBytes.buffer.byteLength);
  const decoded = decodePng(pngBytes);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);

  // SVG chart uses no hardcoded color literals and lists all 7 class codes
  const svg = probabilityChartSvg(summary);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(svg));
  assert.match(svg, /uncalibrated softmax scores/i);
  for (const cls of MODEL.classes) {
    assert.ok(svg.includes(`>${cls.code}<`), `SVG missing class ${cls.code}`);
  }
});
