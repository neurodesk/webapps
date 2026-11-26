import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { encode as encodePng, hasPngSignature } from "fast-png";

const SIZE = 128;

// Synthetic dermoscopy image: dark corners (vignette), light perilesional skin,
// and a central erythematous vascular lesion disk.
export function syntheticDermoscopyPng() {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const apertureR = SIZE * 0.46;
  const lesionR = SIZE * 0.2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (y * SIZE + x) << 2;
      const d = Math.hypot(x - cx, y - cy);
      let r = 224;
      let g = 186;
      let b = 160;
      if (d > apertureR) {
        r = 5;
        g = 5;
        b = 5;
      } else if (d <= lesionR) {
        r = 188;
        g = 48;
        b = 56;
      }
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  const png = encodePng({ width: SIZE, height: SIZE, data, channels: 4, depth: 8 });
  return {
    name: "synthetic-vascular.png",
    mimeType: "image/png",
    buffer: Buffer.from(png),
  };
}

export async function verifyOffline(page, { download }) {
  await page.locator("#imageInput").setInputFiles(syntheticDermoscopyPng());
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 30000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/, { timeout: 60000 });

  const row = (label) => `#resultList .nd-volume-toggle:has-text("${label}") .nd-download-btn`;
  const csvDownload = await download(row("Colorimetry metrics"));
  assert.equal(csvDownload.filename, "synthetic-vascular_colorimetry.csv");
  const lines = csvDownload.bytes.toString("utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^target,/);
  assert.match(lines[2], /^reference,/);
  const diffCols = lines[3].split(",");
  const deltaE2000 = Number(diffCols[diffCols.length - 1]);
  assert.ok(Number.isFinite(deltaE2000) && deltaE2000 > 15, `expected ΔE2000 > 15, got ${deltaE2000}`);

  const hbDownload = await download(row("Hemoglobin map"));
  assert.equal(hbDownload.filename, "synthetic-vascular_hemoglobin.png");
  assert.ok(hasPngSignature(hbDownload.bytes), "hemoglobin output must be a valid PNG");

  return { filename: csvDownload.filename, deltaE2000 };
}
