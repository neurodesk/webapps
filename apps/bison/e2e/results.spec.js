// The results of a run and its cancellation, with a stand-in for the BISON worker (fixtures.mjs):
// Output rows, legend, viewer overlays, downloads and the footer ×, without the model files.
import { test, expect } from "@playwright/test";
import { unzipSync } from "fflate";
import { FLAIR, T1, downloaded, fakeResult, useFakeWorker } from "./fixtures.mjs";

const reportMemory = (page, gigabytes) => page.addInitScript((value) => {
  Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => value });
}, gigabytes);

async function loadInputs(page, { flair = false } = {}) {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(T1);
  await expect(page.locator("#fileInfo")).toContainText(T1.name);
  if (flair) {
    await page.locator("#flairInput").setInputFiles(FLAIR);
    await expect(page.locator("#flairInfo")).toContainText(FLAIR.name);
  }
  await expect(page.locator("#runButton")).toBeEnabled();
}

test("a BISON-WMH run fills Output with the labels, 9 probability maps, the mask and the legend", async ({ page }) => {
  await reportMemory(page, 8);
  await useFakeWorker(page, fakeResult(T1.name, "t1-flair"));
  await loadInputs(page, { flair: true });
  await expect(page.locator("#modeHint")).toHaveText(/^BISON-WMH/);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Segmentation complete · 9 classes with WMH");
  const sent = await page.evaluate(() => window.bisonWorkers[0].messages[0]);
  expect(sent).toEqual({ type: "run", t1Name: T1.name, flair: true, heldBaseUrl: null });
  await expect(page.locator("#outputSection")).toHaveJSProperty("open", true);
  const rows = page.locator("#resultList .nd-stage-label");
  await expect(rows).toHaveCount(2 + 1 + 9 + 1);
  await expect(rows.nth(0)).toHaveText("T1");
  await expect(rows.nth(1)).toHaveText("FLAIR");
  await expect(rows.nth(2)).toHaveText("Tissue labels");
  await expect(rows.nth(11)).toHaveText("WMH probability");
  await expect(rows.nth(12)).toHaveText("Classification mask");
  const legend = page.locator("#classLegend .nd-legend-item");
  await expect(legend).toHaveCount(9);
  await expect(legend.nth(0)).toContainText("Ventricles");
  await expect(legend.nth(8)).toContainText("WMH");
  await expect(legend.nth(8)).toContainText("0.09 ml");
  // The labels are shown over the T1 at first; a probability map replaces them as a heat map.
  await expect(page.locator("#resultList .nd-view-btn").nth(2)).toHaveClass(/active/);
  await page.locator("#resultList .nd-view-btn").nth(10).click();
  await expect(page.locator("#resultList .nd-view-btn").nth(10)).toHaveClass(/active/);
  await expect(page.locator("#resultList .nd-view-btn").nth(2)).not.toHaveClass(/active/);
  await page.locator("#resultList .nd-view-btn").nth(1).click();
  await expect(page.locator("#resultList .nd-view-btn").nth(1)).toHaveClass(/active/);
  await expect(page.locator("#viewerNotice")).toBeHidden();
  await page.locator("#technicalLog").getByRole("tab", { name: "Analysis" }).click();
  await expect(page.locator("#technicalLog")).toContainText("WMH: 0.09 mL");

  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-download-btn").nth(2).click();
  const labels = await downloaded(await pending);
  expect(labels.name).toBe("sub-01_T1w_bison-labels.nii.gz");
  expect(labels.bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

  const zipped = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all (zip)" }).click();
  const zip = await downloaded(await zipped);
  expect(zip.name).toBe("sub-01_T1w_bison.zip");
  const names = Object.keys(unzipSync(new Uint8Array(zip.bytes))).sort();
  expect(names).toHaveLength(11);
  expect(names).toContain("sub-01_T1w_bison-prob-wmh.nii.gz");
  expect(names.some((name) => name === T1.name || name === FLAIR.name)).toBe(false);
});

test("a BISON run with a T1 alone has 8 classes and no WMH", async ({ page }) => {
  await reportMemory(page, 8);
  await useFakeWorker(page, fakeResult(T1.name, "t1"));
  await loadInputs(page);
  await expect(page.locator("#modeHint")).toHaveText(/^BISON: 8 tissue classes/);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Segmentation complete · 8 classes");
  await expect(page.locator("#resultList .nd-stage-label")).toHaveCount(1 + 1 + 8 + 1);
  await expect(page.locator("#classLegend .nd-legend-item")).toHaveCount(8);
});

test("the footer × ends the worker, and a new run starts a new one", async ({ page }) => {
  await reportMemory(page, 8);
  await useFakeWorker(page);
  await loadInputs(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Registering T1 to the template (affine)");
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#imageInput")).toBeDisabled();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Segmentation cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  expect(await page.evaluate(() => window.bisonWorkers.map(({ terminated }) => terminated))).toEqual([true]);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.bisonWorkers.map(({ terminated }) => terminated))).toEqual([true, false]);
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Segmentation cancelled");
});

test("a new T1 replaces the old session's FLAIR and its results", async ({ page }) => {
  await reportMemory(page, 8);
  await useFakeWorker(page, fakeResult(T1.name, "t1-flair"));
  await loadInputs(page, { flair: true });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Segmentation complete · 9 classes with WMH");
  await page.locator("#imageInput").setInputFiles({ ...T1, name: "sub-02_T1w.nii.gz" });
  await expect(page.locator("#fileInfo")).toContainText("sub-02_T1w.nii.gz");
  await expect(page.locator("#flairInfo")).toBeHidden();
  await expect(page.locator("#modeHint")).toHaveText(/^BISON: 8 tissue classes/);
  await expect(page.locator("#resultList .nd-stage-label")).toHaveCount(1);
  await expect(page.locator("#classLegend")).toBeHidden();
});

test("automation returns the labels, one probability map per class and the mask", async ({ page }) => {
  await reportMemory(page, 8);
  await useFakeWorker(page, fakeResult(T1.name, "t1"));
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles(T1);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "t1" });
    await globalThis.neurodeskAutomation.dispatch("start", { operation: "segment" });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state)).toBe("succeeded");
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(Object.keys(report.artifacts).sort()).toEqual(["labels", "mask", ...Array.from({ length: 8 }, (_, k) => `probabilities-${k + 1}`)].sort());
  expect(report.measurements.volumes).toHaveLength(8);
  expect(report.provenance.method).toBe("BISON");
});
