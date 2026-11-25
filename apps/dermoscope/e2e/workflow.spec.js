// End-to-end workflow tests for Dermoscope ABCD against the production build:
// real pinned ISIC example loading, experimental ABCD analysis (with D unscored and explicit D),
// 8-sector report table, all 4 preprocessing toggle combinations through the Web Worker,
// all 4 downloads, and WebMCP / neurodeskAutomation execution.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decode } from "fast-png";
import { syntheticLesionPng } from "../test/offline.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function downloadRow(page, label) {
  const pending = page.waitForEvent("download");
  await page
    .locator("#resultList .nd-volume-toggle")
    .filter({ hasText: label })
    .getByRole("button", { name: "Download", exact: true })
    .click();
  const dl = await pending;
  const path = await dl.path();
  return {
    name: dl.suggestedFilename(),
    bytes: readFileSync(path),
    text: readFileSync(path, "utf8"),
  };
}

test("real ISIC example runs through DullRazor + experimental ABCD analysis, views, and all four downloads", async ({ page }) => {
  test.setTimeout(120000);
  const example = examples[0]; // ISIC_0000022.jpg (melanoma in situ with hairs)
  await page.goto("./");

  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name, { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis complete · A\d+ B/, { timeout: 60000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);

  // Exercise all toolbar views including the structured experimental ABCD report.
  for (const label of ["Preprocessed", "Colors", "Original", "Report"]) {
    await page.locator("nd-viewer-toolbar").getByRole("button", { name: label, exact: true }).click();
  }
  const reportText = await page.locator("#report").innerText();
  expect(reportText).toContain("Experimental automated morphometry");
  expect(reportText).toContain("Not computed (enter D to calculate)");
  expect(reportText).toContain("8-sector border weighted Lab contrast");
  expect(reportText).toContain("S1");
  expect(reportText).toContain("S8");
  expect(reportText).toContain("not a clinical diagnosis");
  expect(reportText).not.toMatch(/benign-range|suspicious-range|high-risk-range|high suspicion/i);

  // Download and validate all four declared artifacts.
  const pre = await downloadRow(page, "Preprocessed image");
  expect(pre.name).toBe("ISIC_0000022_preprocessed.png");
  const prePng = decode(new Uint8Array(pre.bytes));
  expect(Math.max(prePng.width, prePng.height)).toBeLessThanOrEqual(512);
  expect(prePng.channels).toBe(4);

  const mask = await downloadRow(page, "Lesion mask");
  expect(mask.name).toBe("ISIC_0000022_mask.png");
  const maskPng = decode(new Uint8Array(mask.bytes));
  expect(maskPng.width).toBe(prePng.width);
  expect(maskPng.height).toBe(prePng.height);
  expect(maskPng.channels).toBe(1);
  const maskOn = maskPng.data.reduce((sum, v) => sum + (v === 255 ? 1 : 0), 0);
  expect(maskOn).toBeGreaterThan(500);

  const csv = await downloadRow(page, "ABCD metrics");
  expect(csv.name).toBe("ISIC_0000022_abcd_metrics.csv");
  expect(csv.text).toContain("tds_total_dermoscopy_score,,score,not computed (enter D to calculate)");
  expect(csv.text).toContain("weighted_Lab_contrast");
  expect(csv.text).toContain("hair_coverage,");
  expect(csv.text).not.toMatch(/benign-range|suspicious-range|high-risk-range|high suspicion/i);

  const prov = await downloadRow(page, "Provenance report");
  expect(prov.name).toBe("ISIC_0000022_provenance.json");
  const record = JSON.parse(prov.text);
  expect(record.app).toBe("dermoscope");
  expect(record.segmentation.segmented).toBe(true);
  expect(record.preprocessing.hairRemoved).toBe(true);
  expect(record.preprocessing.repairedPixels).toBeGreaterThan(0);
  expect(record.preprocessing.hairCoveragePct).toBeGreaterThan(0);
  expect(record.abcd.geometry.areaPx).toBe(maskOn);
  expect(record.abcd.scores.A).toBeGreaterThanOrEqual(0);
  expect(record.abcd.scores.C).toBeGreaterThanOrEqual(1);
  expect(record.abcd.scores.D).toBeNull();
  expect(record.abcd.scores.tds).toBeNull();
  expect(record.abcd.band).toBeUndefined();
  expect(record.assumptions.colorSpace).toContain("sRGB");

  // Explicitly selecting D = 3 computes composite TDS without clinical risk-band labels.
  await page.locator("#differentialStructures").selectOption("3");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis complete · TDS /, { timeout: 60000 });
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Report", exact: true }).click();
  const reportWithD = await page.locator("#report").innerText();
  expect(reportWithD).toContain("Clinician-entered D=3");
  expect(reportWithD).not.toMatch(/benign-range|suspicious-range|high-risk-range|high suspicion/i);

  // Loading a new photo resets D back to 0 (Not scored) so D never carries over across photos.
  await page.locator("#imageInput").setInputFiles(syntheticLesionPng());
  await expect(page.locator("#differentialStructures")).toHaveValue("0");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis complete · A\d+ B/, { timeout: 60000 });
});

test("all 4 (removeHair, colorConstancy) toggle combinations run cleanly through the Web Worker", async ({ page }) => {
  const sample = syntheticLesionPng();
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(sample);
  await expect(page.locator("#runButton")).toBeEnabled();

  for (const [removeHair, colorConstancy] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    await page.locator("#removeHair").setChecked(removeHair);
    await page.locator("#colorConstancy").setChecked(colorConstancy);
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText(/^Analysis complete · A0 B/, { timeout: 60000 });
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
  }
});

test("neurodeskAutomation runs analyze with custom parameters and downloads verified artifacts", async ({ page }) => {
  const sample = syntheticLesionPng();
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles(sample);

  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      parameters: {
        removeHair: false,
        colorConstancy: false,
        thresholdBias: 0,
        pixelsPerMm: 8,
        differentialStructures: 3,
      },
    });
  });

  await expect
    .poll(
      () => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state),
      { timeout: 60000 },
    )
    .toMatch(/succeeded|failed/);

  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error?.message ?? null).toBeNull();
  const { report } = snapshot;
  expect(Object.keys(report.artifacts).sort()).toEqual([
    "mask",
    "metrics",
    "preprocessed",
    "provenance",
  ]);
  expect(report.provenance.abcd.scores.A).toBe(0);
  expect(report.provenance.abcd.scores.D).toBe(3);
  expect(report.provenance.abcd.scores.tds).toBeGreaterThan(0);
  expect(report.provenance.abcd.band).toBeUndefined();
  expect(report.provenance.abcd.geometry.calibrated).toBe(true);
  expect(report.provenance.abcd.geometry.equivalentDiameterMm).toBeCloseTo(8.0, 0);

  const dlPromise = page.waitForEvent("download");
  await page.evaluate(() =>
    globalThis.neurodeskAutomation.dispatch("download", { artifactId: "metrics" }),
  );
  const dlBytes = readFileSync(await (await dlPromise).path());
  expect(sha256(dlBytes)).toBe(report.artifacts.metrics.sha256);
});
