import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { encode as encodePng } from "fast-png";

const SIZE = 96;

/**
 * Generates a synthetic dermoscopic pigmented lesion PNG: warm light skin surround
 * with a central rounded brown pigmented lesion and subtle pigment network texture.
 */
export function syntheticLesion() {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const rx = SIZE * 0.24;
  const ry = SIZE * 0.2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const dist = Math.hypot(dx, dy);
      const lesion = 1 / (1 + Math.exp((dist - 1) * 5.5));
      const grain = ((x * 11 + y * 17) % 9) - 4;
      const r = Math.max(0, Math.min(255, Math.round(218 * (1 - lesion) + 86 * lesion + grain)));
      const g = Math.max(0, Math.min(255, Math.round(176 * (1 - lesion) + 52 * lesion + grain * 0.7)));
      const b = Math.max(0, Math.min(255, Math.round(152 * (1 - lesion) + 38 * lesion + grain * 0.5)));
      const idx = (y * SIZE + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  const buffer = Buffer.from(encodePng({ width: SIZE, height: SIZE, data, channels: 4, depth: 8 }));
  return { name: "synthetic-lesion.png", mimeType: "image/png", buffer };
}

/**
 * Verifies DermViT offline in the packaged desktop bundle: loads a synthetic dermoscopic
 * lesion PNG, runs real ViT ONNX inference using the bundled model weights, checks the
 * 7-class predictions CSV and provenance JSON downloads.
 */
export async function verifyOffline(page, { download }) {
  await page.locator("#imageInput").setInputFiles(syntheticLesion());
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 30000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Classified: (BKL|BCC|AKIEC|VASC|NV|MEL|DF) /, {
    timeout: 300000,
  });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const row = (label) => `#resultList .nd-volume-toggle:has-text("${label}") .nd-download-btn`;
  const csv = await download(row("Predictions"));
  assert.equal(csv.filename, "synthetic-lesion_dermvit-predictions.csv");
  const lines = csv.bytes.toString("utf8").trim().split("\n");
  assert.match(lines[0], /^# Research & educational use only/);
  assert.equal(lines[1], "rank,class_index,code,label,softmax_score,softmax_percent,logit");
  assert.equal(lines.length, 9);
  const scores = lines.slice(2).map((line) => Number(line.split(",")[4]));
  const scoreSum = scores.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(scoreSum - 1) < 1e-3, `Expected softmax scores summing to 1, got ${scoreSum}`);
  assert.ok(scores[0] >= scores[1], "Rows must be ranked descending by softmax score");

  const prov = await download(row("Provenance"));
  assert.equal(prov.filename, "synthetic-lesion_dermvit-provenance.json");
  const parsed = JSON.parse(prov.bytes.toString("utf8"));
  assert.equal(parsed.app, "dermvit");
  assert.equal(parsed.researchOnly, true);
  assert.equal(parsed.prediction.scoreType, "uncalibrated-softmax");
  assert.equal(parsed.prediction.classes.length, 7);

  return {
    filename: csv.filename,
    topClass: parsed.prediction.topClass,
    topSoftmaxScore: parsed.prediction.topSoftmaxScore,
  };
}
