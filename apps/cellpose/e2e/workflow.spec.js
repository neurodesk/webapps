// Cellpose on the pinned 2D and 3D Allen Institute examples, end to end in the production
// build: browser labels and measurements must match Python Cellpose 3.1.1.1
// (validation/reference.json) across cyto3 2D, nuclei 2D and cyto3 3D ortho-plane modes,
// plus cancellation and the WebMCP automation contract.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { MODELS } from "../src/config.js";
import { decodeReferenceLabels, examples, matchLabels, readLabelTiff, reference } from "./reference.mjs";

const cells2dExample = examples.find((item) => item.id === "allen-cells-2d");
const cells3dExample = examples.find((item) => item.id === "allen-cells-3d");

async function loadExample(page, example) {
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

test("cyto3 2D dual-channel segmentation matches Python Cellpose 3.1.1.1", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, cells2dExample);
  await expect(page.locator("#model")).toHaveValue("cyto3");
  await expect(page.locator("#diameter")).toHaveValue("60");
  await expect(page.locator("#channel")).toHaveValue("0");
  await expect(page.locator("#nuclearChannel")).toHaveValue("2");

  await page.locator("#runButton").click();
  const want = reference.cases.cyto3_2d;
  await expect(page.locator("#statusText")).toHaveText(`${want.count} cells segmented`, { timeout: 180000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const labelsFile = await download(page, "Instance labels");
  expect(labelsFile.name).toBe("allen-cells-2d_cellpose_labels.tif");
  const { width, height, labels } = await readLabelTiff(labelsFile.bytes);
  expect([height, width]).toEqual(want.shape);
  const score = matchLabels(decodeReferenceLabels("cyto3_2d"), labels, 0.9);
  expect(score.nPred).toBe(want.count);
  expect(score.f1).toBe(1);
  expect(score.meanMatchedIou).toBeGreaterThan(0.99);

  const table = await download(page, "Object table");
  expect(table.name).toBe("allen-cells-2d_cellpose_cells.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,centroid_x,centroid_y,area_px,mean_intensity");
  expect(rows.length - 1).toBe(want.count);

  // Viewer toolbar toggles cleanly between filled, outlines and image-only views.
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Outlines", exact: true }).click();
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.locator("#statusText")).toHaveText(`${want.count} cells segmented`);
});

test("nuclei 2D segmentation on channel 2 matches Python Cellpose 3.1.1.1", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, cells2dExample);
  await page.locator("#model").selectOption("nuclei");
  await page.locator("#channel").selectOption("1");
  await page.locator("#diameter").fill("40");
  await expect(page.locator("#nuclearChannelField")).toBeHidden();

  await page.locator("#runButton").click();
  const want = reference.cases.nuclei_2d;
  await expect(page.locator("#statusText")).toHaveText(`${want.count} nuclei segmented`, { timeout: 180000 });

  const labelsFile = await download(page, "Instance labels");
  const { width, height, labels } = await readLabelTiff(labelsFile.bytes);
  expect([height, width]).toEqual(want.shape);
  const score = matchLabels(decodeReferenceLabels("nuclei_2d"), labels, 0.9);
  expect(score.nPred).toBe(want.count);
  expect(score.f1).toBe(1);
  expect(score.meanMatchedIou).toBeGreaterThan(0.99);
});

test("cyto3 3D ortho-plane segmentation matches Python Cellpose 3.1.1.1", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page, cells3dExample);
  await expect(page.locator("#fileInfo")).toContainText("64 × 64 × 10");
  await page.locator("#advancedSettings > summary").click();
  await expect(page.locator("#do3D")).toBeChecked();
  await expect(page.locator("#anisotropyField")).toBeVisible();

  await page.locator("#runButton").click();
  const want = reference.cases.cyto3_3d;
  await expect(page.locator("#statusText")).toHaveText(`${want.count} cells segmented`, { timeout: 180000 });

  const labelsFile = await download(page, "Instance labels");
  expect(labelsFile.name).toBe("allen-cells-3d_cellpose_labels.tif");
  const { width, height, depth, labels } = await readLabelTiff(labelsFile.bytes);
  expect([depth, height, width]).toEqual(want.shape);
  const score = matchLabels(decodeReferenceLabels("cyto3_3d"), labels, 0.9);
  expect(score.nPred).toBe(want.count);
  expect(score.f1).toBe(1);
  expect(score.meanMatchedIou).toBeGreaterThan(0.99);

  const table = await download(page, "Object table");
  expect(table.name).toBe("allen-cells-3d_cellpose_cells.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity");
  expect(rows.length - 1).toBe(want.count);
});

test("cancelling a run terminates the worker and leaves the app ready to run again", async ({ page }) => {
  test.setTimeout(240000);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route(MODELS.cyto3.url, async (route) => {
    attempts++;
    if (attempts === 1) {
      await held;
      return route.abort().catch(() => {});
    }
    return route.continue().catch(() => {});
  });
  await loadExample(page, cells2dExample);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  release();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("automation contract runs cyto3 2D end to end and returns labels and CSV", async ({ page }) => {
  test.setTimeout(240000);
  const want = reference.cases.cyto3_2d;
  const response = await fetch(cells2dExample.files[0].url);
  const bytes = Buffer.from(await response.arrayBuffer());
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles({
    name: cells2dExample.files[0].name,
    mimeType: "image/tiff",
    buffer: bytes,
  });
  const snapshot = await page.evaluate(async (params) => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { operation: "segment", parameters: params });
    for (;;) {
      const value = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (!["queued", "running"].includes(value.state)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, cells2dExample.parameters);
  expect(snapshot.state).toBe("succeeded");
  expect(Object.keys(snapshot.report.artifacts).sort()).toEqual(["labels", "table"]);
  expect(snapshot.report.provenance.model).toBe("cyto3");
  expect(snapshot.report.provenance.count).toBe(want.count);
});

test("the desktop offline check passes on its synthetic cells", async ({ page }) => {
  test.setTimeout(240000);
  const { verifyOffline } = await import("../test/offline.mjs");
  await page.goto("./");
  const downloadFile = async (selector) => {
    const pending = page.waitForEvent("download");
    await page.locator(selector).click();
    const file = await pending;
    return { filename: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
  };
  const result = await verifyOffline(page, { download: downloadFile });
  expect(result.cells).toBe(9);
});
