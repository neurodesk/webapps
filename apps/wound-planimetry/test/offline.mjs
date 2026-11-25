import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { decode, encode } from "fast-png";

const WIDTH = 160;
const HEIGHT = 160;

/** Parse 3-column metric,value,unit CSV into a Map of metric -> { value, unit }. */
export function parseCsvMetrics(csvText) {
  const lines = csvText.trim().split("\n");
  assert.equal(lines[0], "metric,value,unit");
  const map = new Map();
  for (const line of lines.slice(1)) {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === "\"" && line[i + 1] === "\"") {
          cur += "\"";
          i++;
        } else if (ch === "\"") {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === "\"") {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    map.set(cells[0], { value: cells[1], unit: cells[2] });
  }
  return map;
}

/** Synthetic wound photograph (PNG): elliptical wound with red granulation, yellow slough and black eschar on intact skin. */
export function syntheticWoundPng(name = "synthetic-wound.png") {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const idx = (y * WIDTH + x) * 4;
      const dx = (x - cx) / 40;
      const dy = (y - cy) / 30;
      let r = 216;
      let g = 178;
      let b = 150;
      if (dx * dx + dy * dy <= 1) {
        if (x < cx) {
          r = 188;
          g = 42;
          b = 46;
        } else if (y < cy) {
          r = 224;
          g = 198;
          b = 64;
        } else {
          r = 28;
          g = 26;
          b = 26;
        }
      }
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encode({ width: WIDTH, height: HEIGHT, data, channels: 4, depth: 8 })),
  };
}

/** Uniform single-colour PNG with zero contrast (should report no wound bed detected). */
export function uniformFieldPng(name = "uniform-skin.png", rgb = [216, 178, 150]) {
  const data = new Uint8Array(80 * 80 * 4);
  for (let i = 0; i < 80 * 80; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encode({ width: 80, height: 80, data, channels: 4, depth: 8 })),
  };
}

export async function verifyOffline(page, { download }) {
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng());
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 30000 });
  await page.locator("#pixelsPerMm").fill("10");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Wound measured", { timeout: 60000 });

  const row = (name) => `#resultList .nd-volume-toggle:has-text("${name}") .nd-download-btn`;
  const csv = await download(row("Planimetry table"));
  assert.equal(csv.filename, "synthetic-wound_wound-planimetry.csv");
  const metrics = parseCsvMetrics(csv.bytes.toString("utf8"));
  assert.equal(metrics.get("wound_detected")?.value, "true");
  assert.equal(metrics.get("calibrated")?.value, "true");
  assert.equal(metrics.get("wound_area_px")?.unit, "px²");
  const areaPx = Number(metrics.get("wound_area_px")?.value);
  assert.ok(areaPx > 3400 && areaPx < 4100, `unexpected areaPx=${areaPx}`);
  assert.ok(Number(metrics.get("wound_area_cm2")?.value) > 0.34);
  const circularity = Number(metrics.get("circularity")?.value);
  assert.ok(circularity > 0.6 && circularity <= 1, `unexpected circularity=${circularity}`);
  assert.ok(Number(metrics.get("ryb_red_granulation_pct")?.value) > 40);
  assert.ok(Number(metrics.get("ryb_yellow_slough_pct")?.value) > 18);
  assert.ok(Number(metrics.get("ryb_black_eschar_pct")?.value) > 18);
  assert.ok(metrics.has("ryb_unclassified_pct"));

  const mask = await download(row("Wound mask"));
  assert.equal(mask.filename, "synthetic-wound_wound-mask.png");
  const decodedMask = decode(mask.bytes);
  assert.equal(decodedMask.width, WIDTH);
  assert.equal(decodedMask.height, HEIGHT);
  let foregroundPx = 0;
  for (let i = 0; i < decodedMask.data.length; i++) {
    assert.ok(decodedMask.data[i] === 0 || decodedMask.data[i] === 255);
    if (decodedMask.data[i] === 255) foregroundPx++;
  }
  assert.equal(foregroundPx, areaPx);

  return { filename: csv.filename, bytes: csv.bytes.length };
}
