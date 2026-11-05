// StarDist on the pinned example, end to end in the production build: the labels must match
// Python StarDist 0.9.1's (validation/reference.json) with IoU-matched F1 >= 0.99 and a nucleus
// count within 1 %, with and without tiling; cancelling a run and the automation contract.
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { MODEL } from "../src/config.js";
import { examples, matchLabels, readLabelTiff, reference, referenceLabels } from "./reference.mjs";

const [example] = examples;
const [exampleFile] = example.files;
const expectedCount = reference.example["1x1"].count;

async function loadExample(page) {
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
}

async function download(page, stage) {
  const pending = page.waitForEvent("download");
  await page.locator(`#resultList .nd-volume-toggle:has-text("${stage}") .nd-download-btn`).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

async function checkAgainstPython(page, label) {
  await expect(page.locator("#statusText")).toHaveText(/^\d+ nuclei segmented$/, { timeout: 120000 });
  const labelsFile = await download(page, "Nucleus labels");
  expect(labelsFile.name).toBe("dsb2018-nuclei-2d_stardist_labels.tif");
  const { width, height, labels } = await readLabelTiff(labelsFile.bytes);
  expect([height, width]).toEqual(reference.shape);
  if (process.env.STARDIST_BROWSER_LABELS) writeFileSync(`${process.env.STARDIST_BROWSER_LABELS}-${label}.tif`, labelsFile.bytes);
  const python = referenceLabels();
  const score = matchLabels(python, labels);
  const identical = python.every((value, i) => value === labels[i]);
  console.log(`${label}: ${score.nPred} nuclei, Python ${score.nTrue}; F1 ${score.f1.toFixed(4)}, mean matched IoU ${score.meanMatchedIou.toFixed(4)}; identical: ${identical}`);
  expect(score.f1).toBeGreaterThanOrEqual(0.99);
  expect(Math.abs(score.nPred - expectedCount) / expectedCount).toBeLessThanOrEqual(0.01);

  const table = await download(page, "Nucleus table");
  expect(table.name).toBe("dsb2018-nuclei-2d_stardist_nuclei.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,centroid_x,centroid_y,area_px,mean_intensity,probability");
  expect(rows.length - 1).toBe(score.nPred);
  const area = rows.slice(1).reduce((sum, row) => sum + Number(row.split(",")[3]), 0);
  expect(area).toBe(labels.filter(Boolean).length);
  if (identical) {
    // The same labels give skimage regionprops' centroids, areas and mean intensities.
    rows.slice(1).forEach((row, index) => {
      const [id, x, y, pixels, mean] = row.split(",").map(Number);
      const [wantId, wantX, wantY, wantArea, wantMean] = reference.example["1x1"].nuclei[index];
      expect([id, pixels]).toEqual([wantId, wantArea]);
      expect(Math.abs(x - wantX)).toBeLessThan(5e-4);
      expect(Math.abs(y - wantY)).toBeLessThan(5e-4);
      expect(Math.abs(mean - wantMean) / wantMean).toBeLessThan(1e-6);
    });
  }
  return labels;
}

test("the example's nuclei match Python StarDist's", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await checkAgainstPython(page, "untiled");
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  // The views switch between filled labels, outlines and the image alone.
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Outlines", exact: true }).click();
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.locator("#statusText")).toHaveText(/nuclei segmented$/);
});

test("tiled prediction gives the same nuclei", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#tiles").selectOption("2");
  await page.locator("#runButton").click();
  await expect(page.locator("#technicalLog")).toContainText("2 × 2 tiles");
  await checkAgainstPython(page, "tiled");
});

test("cancelling a run stops its worker, leaves no output and permits a retry", async ({ page }) => {
  test.setTimeout(240000);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route(MODEL.url, async (route) => {
    attempts++;
    if (attempts === 1) await held;
    return route.fulfill({ response: await route.fetch() }).catch(() => {});
  });
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Downloading the StarDist model");
  await page.locator("#cancelButton").click();
  release();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^\d+ nuclei segmented$/, { timeout: 120000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(2);
});

test("the automation operation returns the labels and the table", async ({ page }) => {
  test.setTimeout(240000);
  const response = await fetch(exampleFile.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: exampleFile.name, mimeType: "image/tiff", buffer: bytes });
  const snapshot = await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { operation: "segment", parameters: {} });
    for (;;) {
      const value = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (!["queued", "running"].includes(value.state)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
  expect(snapshot.state).toBe("succeeded");
  expect(Object.keys(snapshot.report.artifacts).sort()).toEqual(["labels", "table"]);
  expect(snapshot.report.provenance.model).toBe("2D_versatile_fluo");
  expect(Math.abs(snapshot.report.provenance.nuclei - expectedCount)).toBeLessThanOrEqual(1);
});

test("the desktop offline check passes on its synthetic nuclei", async ({ page }) => {
  test.setTimeout(240000);
  const { verifyOffline } = await import("../test/offline.mjs");
  await page.goto("./");
  const download = async (selector) => {
    const pending = page.waitForEvent("download");
    await page.locator(selector).click();
    const file = await pending;
    return { filename: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
  };
  const result = await verifyOffline(page, { download });
  expect(result.nuclei).toBe(9);
});
