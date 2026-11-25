// Interactive workflow e2e tests: ruler calibration on canvas and via keyboard,
// seed placement & seed fallback, photo replacement resetting calibration,
// stale-output invalidation, uniform-image warning, mobile touch targets,
// report view + SVG chart, and verifying decoded PNG/CSV/JSON download contents.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { decode } from "fast-png";
import { parseCsvMetrics, syntheticWoundPng, uniformFieldPng } from "../test/offline.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));

test("interactive 2-point ruler calibration, seed placement, measurement, report, downloads and invalidation", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng());
  await expect(page.locator("#fileInfo")).toContainText("synthetic-wound.png");
  await expect(page.locator("#runButton")).toBeEnabled();

  // In Inspect mode, touch-action must not lock scrolling.
  const inspectTouch = await page.locator("#canvas").evaluate((el) => getComputedStyle(el).touchAction);
  expect(inspectTouch).not.toBe("none");

  // Calibrate ruler by dragging across 80 image pixels with referenceMm = 10 -> ~8 px/mm.
  await page.locator("#rulerTool").click();
  await expect(page.locator("#rulerTool")).toHaveAttribute("aria-pressed", "true");
  const rulerTouch = await page.locator("#canvas").evaluate((el) => getComputedStyle(el).touchAction);
  expect(rulerTouch).toBe("none");

  const box = await page.locator("#canvas").boundingBox();
  const scale = Math.min(box.width, box.height) / 160;
  const at = (x, y) => [
    box.x + (box.width - 160 * scale) / 2 + x * scale,
    box.y + (box.height - 160 * scale) / 2 + y * scale,
  ];
  await page.mouse.move(...at(40, 20));
  await page.mouse.down();
  await page.mouse.move(...at(120, 20), { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("#statusText")).toContainText("Calibrated:");
  const calibratedScale = Number(await page.locator("#pixelsPerMm").inputValue());
  expect(calibratedScale).toBeGreaterThan(7);
  expect(calibratedScale).toBeLessThan(9);

  // Place seed at centre of synthetic wound.
  await page.locator("#seedTool").click();
  const seedTouch = await page.locator("#canvas").evaluate((el) => getComputedStyle(el).touchAction);
  expect(seedTouch).toBe("none");
  await page.mouse.click(...at(80, 80));
  await expect(page.locator("#statusText")).toContainText("Seed placed at");

  // Run measurement.
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Wound measured");
  await expect(page.locator("#statusText")).toContainText("U ");
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  // Switch through views including Report with tables, SVG chart and honest disclaimer.
  await page.getByRole("button", { name: "Boundary", exact: true }).click();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#report")).toContainText("Planimetry Geometry");
  await expect(page.locator("#report")).toContainText("Color-based RYB Tissue Estimates");
  await expect(page.locator("#report")).toContainText("Unclassified");
  await expect(page.locator("#report")).toContainText("px²");
  await expect(page.locator("#report")).toContainText("Research use only");
  await expect(page.locator("#report")).not.toContainText("Epithelializing");
  await expect(page.locator("#report svg.nd-chart")).toBeVisible();

  // Download and verify all 4 outputs (parsed CSV, JSON, and decoded PNG pixels).
  const downloadOutput = async (label) => {
    const downloadPromise = page.waitForEvent("download");
    await page.locator(`#resultList .nd-volume-toggle:has-text("${label}") .nd-download-btn`).click();
    const dl = await downloadPromise;
    return readFileSync(await dl.path());
  };

  const csvMetrics = parseCsvMetrics((await downloadOutput("Planimetry table")).toString("utf8"));
  expect(csvMetrics.get("wound_detected")?.value).toBe("true");
  expect(csvMetrics.get("calibrated")?.value).toBe("true");
  expect(csvMetrics.get("wound_area_px")?.unit).toBe("px²");
  const areaPx = Number(csvMetrics.get("wound_area_px")?.value);
  expect(areaPx).toBeGreaterThan(3400);
  expect(Number(csvMetrics.get("circularity")?.value)).toBeLessThanOrEqual(1);
  expect(Number(csvMetrics.get("ryb_red_granulation_pct")?.value)).toBeGreaterThan(40);
  expect(csvMetrics.has("ryb_unclassified_pct")).toBe(true);

  const provenance = JSON.parse((await downloadOutput("Provenance report")).toString("utf8"));
  expect(provenance.woundDetected).toBe(true);
  expect(provenance.segmentation.seedFallback).toBe(false);
  expect(provenance.planimetry.areaPx).toBe(areaPx);
  expect(provenance.planimetry.circularity).toBeLessThanOrEqual(1);
  expect(provenance.ryb.classes.unclassified.label).toBe("Unclassified");

  const maskPng = decode(await downloadOutput("Wound mask"));
  expect(maskPng.width).toBe(160);
  expect(maskPng.height).toBe(160);
  let whiteCount = 0;
  for (let i = 0; i < maskPng.data.length; i++) {
    if (maskPng.data[i] === 255) whiteCount++;
  }
  expect(whiteCount).toBe(areaPx);

  const overlayPng = decode(await downloadOutput("RYB tissue overlay"));
  expect(overlayPng.width).toBe(160);
  expect(overlayPng.height).toBe(160);

  // Changing a setting immediately invalidates stale outputs.
  await page.locator("#sensitivity").fill("0.1");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#outputSection")).not.toHaveAttribute("open", "");

  // Loading a new photo resets pixelsPerMm to 0 and clears ruler/seed.
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng("second-photo.png"));
  await expect(page.locator("#fileInfo")).toContainText("second-photo.png");
  await expect(page.locator("#pixelsPerMm")).toHaveValue("0");
  await expect(page.locator("#clearAnnotationsButton")).toBeDisabled();
});

test("keyboard coordinates, seed fallback warning, and uniform image no-wound warning", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng());
  await expect(page.locator("#runButton")).toBeEnabled();

  // Apply ruler and out-of-wound seed purely via keyboard coordinate inputs.
  await page.locator("#annotationCoordinates summary").click();
  await page.locator("#rulerX1").fill("10");
  await page.locator("#rulerY1").fill("10");
  await page.locator("#rulerX2").fill("110");
  await page.locator("#rulerY2").fill("10");
  await page.locator("#applyRulerButton").click();
  await expect(page.locator("#pixelsPerMm")).toHaveValue("10");

  // Invalidating or clearing the ruler reference length clears pixelsPerMm so Measure does not reuse stale or assumed scale.
  await page.locator("#referenceMm").fill("25");
  await page.locator("#referenceMm").blur();
  await expect(page.locator("#pixelsPerMm")).toHaveValue("4");
  await page.locator("#referenceMm").fill("");
  await expect(page.locator("#pixelsPerMm")).toHaveValue("0");
  await page.locator("#referenceMm").blur();
  await expect(page.locator("#statusText")).toContainText("Ruler reference (mm) must be");
  await page.locator("#referenceMm").fill("0");
  await expect(page.locator("#pixelsPerMm")).toHaveValue("0");
  await page.locator("#referenceMm").blur();
  await expect(page.locator("#statusText")).toContainText("Ruler reference (mm) must be");
  // Calibrated scale exceeding 1000 px/mm (100 px / 0.1 mm = 1000 is allowed, >1000 is rejected)
  await page.locator("#rulerX2").fill("120");
  await page.locator("#referenceMm").fill("0.1");
  await page.locator("#applyRulerButton").click();
  await expect(page.locator("#statusText")).toContainText("must be between 0 and 1000 px/mm");
  await page.locator("#rulerX2").fill("110");
  await page.locator("#referenceMm").fill("10");
  await page.locator("#applyRulerButton").click();
  await expect(page.locator("#pixelsPerMm")).toHaveValue("10");

  await page.locator("#seedX").fill("4");
  await page.locator("#seedY").fill("4");
  await page.locator("#applySeedButton").click();
  await expect(page.locator("#statusText")).toContainText("Seed placed at (4, 4)");

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Wound measured");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report")).toContainText("fell back to the nearest component");

  const provPromise = page.waitForEvent("download");
  await page.locator('#resultList .nd-volume-toggle:has-text("Provenance report") .nd-download-btn').click();
  const prov = JSON.parse(readFileSync(await (await provPromise).path(), "utf8"));
  expect(prov.segmentation.seedFallback).toBe(true);

  // Uniform image must report "No wound bed detected" and "—" for tissue fractions.
  await page.locator("#imageInput").setInputFiles(uniformFieldPng());
  await expect(page.locator("#pixelsPerMm")).toHaveValue("0");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("No wound bed detected");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report")).toContainText("No wound bed detected");
  await expect(page.locator("#report")).toContainText("Red —");
});

test("phone viewport meets 44px touch targets for canvas tool buttons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  for (const id of ["#inspectTool", "#rulerTool", "#seedTool"]) {
    const box = await page.locator(id).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

test("bundled example loads, runs through planimetry and downloads parsed CSV", async ({ page }) => {
  test.setTimeout(120000);
  const example = examples[0];
  await page.goto("./");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name, { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Wound measured", { timeout: 60000 });
  const downloadPromise = page.waitForEvent("download");
  await page.locator('#resultList .nd-volume-toggle:has-text("Planimetry table") .nd-download-btn').click();
  const download = await downloadPromise;
  const metrics = parseCsvMetrics(readFileSync(await download.path(), "utf8"));
  expect(metrics.get("wound_detected")?.value).toBe("true");
  expect(Number(metrics.get("wound_area_px")?.value)).toBeGreaterThan(100);
  expect(Number(metrics.get("circularity")?.value)).toBeLessThanOrEqual(1);
  expect(metrics.has("ryb_unclassified_pct")).toBe(true);
});
