// Offline desktop verification for Dermoscope ABCD: feeds a synthetic PNG lesion
// through the UI, runs the Web Worker pipeline, and validates downloaded outputs.
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { decode, encode } from "fast-png";

const SIZE = 160;

export function syntheticLesionPng() {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4;
      const dist = Math.hypot(x - 80, y - 80);
      if (dist <= 32) {
        rgba[o] = 98;
        rgba[o + 1] = 52;
        rgba[o + 2] = 28;
      } else {
        rgba[o] = 216;
        rgba[o + 1] = 178;
        rgba[o + 2] = 156;
      }
      rgba[o + 3] = 255;
    }
  }
  const buffer = Buffer.from(encode({ width: SIZE, height: SIZE, data: rgba, channels: 4, depth: 8 }));
  return { name: "synthetic-nevus.png", mimeType: "image/png", buffer };
}

export async function verifyOffline(page, { download }) {
  await page.locator("#imageInput").setInputFiles(syntheticLesionPng());
  await expect(page.locator("#fileInfo")).toContainText("synthetic-nevus.png", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis complete · A\d+ B/, { timeout: 60000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const row = (label) => `#resultList .nd-volume-toggle:has-text("${label}") .nd-download-btn`;
  const metrics = await download(row("ABCD metrics"));
  assert.equal(metrics.filename, "synthetic-nevus_abcd_metrics.csv");
  const csvText = metrics.bytes.toString("utf8");
  assert.match(csvText, /tds_total_dermoscopy_score,,score,not computed/);
  assert.match(csvText, /score_A_asymmetry,0,/);

  const mask = await download(row("Lesion mask"));
  assert.equal(mask.filename, "synthetic-nevus_mask.png");
  const decodedMask = decode(new Uint8Array(mask.bytes));
  assert.equal(decodedMask.width, SIZE);
  assert.equal(decodedMask.height, SIZE);

  const provenance = await download(row("Provenance report"));
  assert.equal(provenance.filename, "synthetic-nevus_provenance.json");
  const report = JSON.parse(provenance.bytes.toString("utf8"));
  assert.equal(report.app, "dermoscope");
  assert.equal(report.abcd.scores.A, 0);
  assert.equal(report.abcd.scores.D, null);
  assert.equal(report.abcd.scores.tds, null);

  return { filename: metrics.filename, scores: report.abcd.scores };
}
