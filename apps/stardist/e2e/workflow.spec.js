// StarDist on the pinned example, end to end in the production build: the label image must be
// Python StarDist 0.9.1's (validation/reference.json) pixel for pixel, with and without tiling and
// on a crop that needs padding; cancelling a run and the automation contract.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";
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

const labelHash = (labels) => createHash("sha256").update(new Uint8Array(labels.buffer, labels.byteOffset, labels.byteLength)).digest("hex");

async function checkAgainstPython(page, label, key) {
  await expect(page.locator("#statusText")).toHaveText(/^\d+ nuclei segmented$/, { timeout: 120000 });
  const labelsFile = await download(page, "Nucleus labels");
  expect(labelsFile.name).toBe("dsb2018-nuclei-2d_stardist_labels.tif");
  const { width, height, labels } = await readLabelTiff(labelsFile.bytes);
  expect([height, width]).toEqual(reference.shape);
  if (process.env.STARDIST_BROWSER_LABELS) writeFileSync(`${process.env.STARDIST_BROWSER_LABELS}-${label}.tif`, labelsFile.bytes);
  const score = matchLabels(referenceLabels(), labels);
  console.log(`${label}: ${score.nPred} nuclei, Python ${score.nTrue}; F1 ${score.f1.toFixed(4)}, mean matched IoU ${score.meanMatchedIou.toFixed(4)}`);
  // The label image is Python StarDist's predict_instances output byte for byte; the score above
  // only says how far off a failure is.
  expect(labelHash(labels)).toBe(reference.example[key].labels_sha256);

  const table = await download(page, "Nucleus table");
  expect(table.name).toBe("dsb2018-nuclei-2d_stardist_nuclei.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,centroid_x,centroid_y,area_px,mean_intensity,probability");
  expect(rows.length - 1).toBe(score.nPred);
  const area = rows.slice(1).reduce((sum, row) => sum + Number(row.split(",")[3]), 0);
  expect(area).toBe(labels.filter(Boolean).length);
  // The same labels give skimage regionprops' centroids, areas and mean intensities.
  expect(rows.length - 1).toBe(reference.example["1x1"].nuclei.length);
  rows.slice(1).forEach((row, index) => {
    const [id, x, y, pixels, mean] = row.split(",").map(Number);
    const [wantId, wantX, wantY, wantArea, wantMean] = reference.example["1x1"].nuclei[index];
    expect([id, pixels]).toEqual([wantId, wantArea]);
    expect(Math.abs(x - wantX)).toBeLessThan(5e-4);
    expect(Math.abs(y - wantY)).toBeLessThan(5e-4);
    expect(Math.abs(mean - wantMean) / wantMean).toBeLessThan(1e-6);
  });
  return labels;
}

test("the example's nuclei match Python StarDist's", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await checkAgainstPython(page, "untiled", "1x1");
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
  await checkAgainstPython(page, "tiled", "2x2");
});

test("a crop that is not a multiple of 16 is padded as StarDist pads it", async ({ page }) => {
  test.setTimeout(240000);
  const crop = reference.padded_crop;
  const [[r0, r1], [c0, c1]] = crop.crop;
  const [height, width] = [r1 - r0, c1 - c0];
  const response = await fetch(exampleFile.url);
  const { width: fullWidth, labels: full } = await readLabelTiff(Buffer.from(await response.arrayBuffer()));
  const raw = new Uint16Array(height * width);
  for (let y = 0; y < height; y++) raw.set(full.subarray((r0 + y) * fullWidth + c0, (r0 + y) * fullWidth + c1), y * width);
  expect(labelHash(raw)).toBe(crop.raw_sha256);
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "crop.tif", mimeType: "image/tiff", buffer: Buffer.from(writeLabelTiff(raw, width, height)) });
  await expect(page.locator("#fileInfo")).toContainText(`${width} × ${height}`);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(`${crop.count} nuclei segmented`, { timeout: 120000 });
  await expect(page.locator("#technicalLog")).toContainText(`${crop.candidates} candidate polygons above probability`);
  const labelsFile = await download(page, "Nucleus labels");
  const result = await readLabelTiff(labelsFile.bytes);
  expect([result.height, result.width]).toEqual([height, width]);
  expect(labelHash(result.labels)).toBe(crop.labels_sha256);
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
