// StarDist on the pinned 2D and 3D examples, end to end in the production build: the label
// images must match Python StarDist 0.9.1 (validation/reference.json) pixel/voxel for
// pixel/voxel across all four models (2D_versatile_fluo, 2D_versatile_he, 2D_paper_dsb2018,
// 3D_demo), with tiling, padding, cancellation and the automation contract.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";
import { MODEL } from "../src/config.js";
import { examples, matchLabels, readLabelTiff, reference, referenceLabels } from "./reference.mjs";

const fluoExample = examples.find((item) => item.id === "dsb2018-nuclei");
const heExample = examples.find((item) => item.id === "tcia-he-nuclei");
const demo3dExample = examples.find((item) => item.id === "stardist-3d-demo");
const [exampleFile] = fluoExample.files;
const expectedCount = reference.example["1x1"].count;

async function loadExample(page, example = fluoExample) {
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

test("the 2D fluorescence example's nuclei match Python StarDist's", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, fluoExample);
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
  await loadExample(page, fluoExample);
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#tiles").selectOption("2");
  await page.locator("#runButton").click();
  await expect(page.locator("#technicalLog")).toContainText("2 × 2 tiles");
  await checkAgainstPython(page, "tiled", "2x2");
});

test("2D_versatile_he segments the RGB H&E example identically to Python StarDist", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, heExample);
  await expect(page.locator("#model")).toHaveValue("2D_versatile_he");
  await expect(page.locator("#fileInfo")).toContainText("RGB");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(`${reference.he.count} nuclei segmented`, { timeout: 120000 });
  const labelsFile = await download(page, "Nucleus labels");
  expect(labelsFile.name).toBe("tcia-he-nuclei-2d_stardist_labels.tif");
  const { width, height, labels } = await readLabelTiff(labelsFile.bytes);
  expect([height, width]).toEqual(reference.he.shape.slice(0, 2));
  expect(labelHash(labels)).toBe(reference.he.labels_sha256);
  const table = await download(page, "Nucleus table");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,centroid_x,centroid_y,area_px,mean_intensity,probability");
  expect(rows.length - 1).toBe(reference.he.nuclei.length);
});

test("2D_paper_dsb2018 segments the fluorescence example identically to Python StarDist", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, fluoExample);
  await page.locator("#model").selectOption("2D_paper_dsb2018");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(`${reference.paper_dsb2018.count} nuclei segmented`, { timeout: 120000 });
  const labelsFile = await download(page, "Nucleus labels");
  const { labels } = await readLabelTiff(labelsFile.bytes);
  expect(labelHash(labels)).toBe(reference.paper_dsb2018.labels_sha256);
});

test("3D_demo segments the 3D example identically to Python StarDist3D", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, demo3dExample);
  await expect(page.locator("#model")).toHaveValue("3D_demo");
  await expect(page.locator("#fileInfo")).toContainText("57 × 61 × 31");
  await page.locator("#runButton").click();
  const want = reference.demo_3d.example["1x1x1"];
  await expect(page.locator("#statusText")).toHaveText(`${want.count} nuclei segmented`, { timeout: 180000 });
  const labelsFile = await download(page, "Nucleus labels");
  expect(labelsFile.name).toBe("stardist-demo-nuclei-3d_stardist_labels.tif");
  const { width, height, depth, labels } = await readLabelTiff(labelsFile.bytes);
  expect([depth, height, width]).toEqual(reference.demo_3d.shape);
  expect(labelHash(labels)).toBe(want.labels_sha256);
  const table = await download(page, "Nucleus table");
  expect(table.name).toBe("stardist-demo-nuclei-3d_stardist_nuclei.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity,probability");
  expect(rows.length - 1).toBe(want.nuclei.length);
  rows.slice(1).forEach((row, index) => {
    const [id, x, y, z, vol, mean] = row.split(",").map(Number);
    const [wantId, wantX, wantY, wantZ, wantVol, wantMean] = want.nuclei[index];
    expect([id, vol]).toEqual([wantId, wantVol]);
    expect(Math.abs(x - wantX)).toBeLessThan(5e-4);
    expect(Math.abs(y - wantY)).toBeLessThan(5e-4);
    expect(Math.abs(z - wantZ)).toBeLessThan(5e-4);
    expect(Math.abs(mean - wantMean) / wantMean).toBeLessThan(1e-6);
  });
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
  await loadExample(page, fluoExample);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Downloading StarDist");
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
