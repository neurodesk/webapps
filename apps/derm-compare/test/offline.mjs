import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { decode as decodePng, encode as encodePng } from "fast-png";

const SIZE = 160;

function syntheticDermPng({ name, dx = 0, dy = 0, angleDeg = 0, radiusX = 30, radiusY = 20, lesionRgb = [104, 64, 48] }) {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const cx = (SIZE - 1) * 0.5;
  const cy = (SIZE - 1) * 0.5;
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const rx = x - cx - dx;
      const ry = y - cy - dy;
      const lx = cos * rx - sin * ry;
      const ly = sin * rx + cos * ry;
      const tex = 4 * Math.sin((lx + cx) * 0.2) * Math.cos((ly + cy) * 0.2);
      const eDist = Math.hypot(lx / radiusX, ly / radiusY);
      const lobeDist = Math.hypot((lx - radiusX * 0.45) / (radiusX * 0.4), (ly + radiusY * 0.35) / (radiusY * 0.4));
      const w = 1 / (1 + Math.exp((Math.min(eDist, lobeDist) - 1) * 14));
      const p = (y * SIZE + x) * 4;
      data[p] = Math.max(0, Math.min(255, Math.round((222 + tex) * (1 - w) + lesionRgb[0] * w)));
      data[p + 1] = Math.max(0, Math.min(255, Math.round((182 + tex) * (1 - w) + lesionRgb[1] * w)));
      data[p + 2] = Math.max(0, Math.min(255, Math.round((156 + tex) * (1 - w) + lesionRgb[2] * w)));
      data[p + 3] = 255;
    }
  }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encodePng({ width: SIZE, height: SIZE, data, channels: 4, depth: 8 })),
  };
}

// Offline verification: upload two synthetic PNG captures to #baselineInput and #followupInput,
// run rigid alignment and CIEDE2000 analysis, and verify outputs and downloads.
export async function verifyOffline(page, { download }) {
  const basePng = syntheticDermPng({ name: "baseline.png", dx: 0, dy: 0, angleDeg: 0, radiusX: 28, radiusY: 20, lesionRgb: [115, 74, 56] });
  const follPng = syntheticDermPng({ name: "followup.png", dx: 7, dy: -5, angleDeg: 9, radiusX: 33, radiusY: 23, lesionRgb: [72, 40, 32] });

  await page.locator("#baselineInput").setInputFiles(basePng);
  await expect(page.locator("#baselineInfo")).toContainText("baseline.png");
  await page.locator("#followupInput").setInputFiles(follPng);
  await expect(page.locator("#followupInfo")).toContainText("followup.png");

  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 60000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const row = (label) => `#resultList .nd-volume-toggle:has-text("${label}") .nd-download-btn`;
  const aligned = await download(row("Aligned follow-up"));
  assert.equal(aligned.filename, "baseline_vs_followup_aligned.png");
  const alignedImg = decodePng(aligned.bytes);
  assert.equal(alignedImg.width, SIZE);
  assert.equal(alignedImg.height, SIZE);

  const changeMap = await download(row("ΔE2000 change map"));
  assert.equal(changeMap.filename, "baseline_vs_followup_deltaE2000.png");
  const changeImg = decodePng(changeMap.bytes);
  assert.equal(changeImg.width, SIZE);
  assert.equal(changeImg.height, SIZE);

  const metrics = await download(row("Comparison metrics"));
  assert.equal(metrics.filename, "baseline_vs_followup_metrics.csv");
  const rows = Object.fromEntries(
    metrics.bytes.toString("utf8").trim().split("\n").slice(1).map((line) => {
      const [key, val] = line.split(",");
      return [key, Number(val)];
    }),
  );
  assert.ok(rows.aligned_ncc > rows.initial_ncc, `expected aligned_ncc (${rows.aligned_ncc}) > initial_ncc (${rows.initial_ncc})`);
  assert.ok(rows.area_change_pct > 15, `expected area growth > 15%, got ${rows.area_change_pct}`);
  assert.ok(rows.lesion_mean_delta_e2000 > 5, `expected lesion ΔE2000 > 5, got ${rows.lesion_mean_delta_e2000}`);

  const prov = await download(row("Provenance report"));
  assert.equal(prov.filename, "baseline_vs_followup_provenance.json");
  const parsedProv = JSON.parse(prov.bytes.toString("utf8"));
  assert.equal(parsedProv.app, "derm-compare");

  return { filename: metrics.filename, alignedNcc: rows.aligned_ncc, areaChangePct: rows.area_change_pct };
}
