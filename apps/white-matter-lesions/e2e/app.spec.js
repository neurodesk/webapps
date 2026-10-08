import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readVolume } from "@neurodesk/synthsr";
import { dice, maskVoxels } from "../../../test-utils/dice.mjs";
import { compareWithBrowser, measure } from "../validation/browser-reference.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../../../models/white-matter-lesions.manifest.json", import.meta.url), "utf8"));
const modelUrl = manifest.base_url + manifest.assets[0].filename;
const bytesOf = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
// Reference: validation/reference.py (nnU-Net's own resampling, native ONNX Runtime, fold 0) on the
// example inside the app's SynthStrip mask; validation/fixtures/README.md has the commands. It is
// independent of src/pipeline.js and ONNX Runtime Web, not of the SynthStrip port or the ONNX export.
const reference = {
  url: new URL("../validation/fixtures/MSLesSeg_P57_T1_FLAIR_reference-fold0_lesions.nii.gz", import.meta.url),
  sha256: "e8305ef1bb0fa4260cc9a434fec1bf65e171e6c929e67b6c446c1a3935fea905",
  lesionVoxels: 12631,
};
// Measured 2026-10-03 (WebAssembly): Dice 0.9989, 12 623 app voxels against 12 631, 90 lesions,
// 31.5 ml. validation/README.md reports 0.998 for the same port check on another scan. The gate
// leaves 0.009 for floating-point differences between runtimes.
const MIN_REFERENCE_DICE = 0.99;

async function download(page, index) {
  if (!await page.locator("#outputSection").evaluate((element) => element.open)) {
    await page.locator("#outputSection summary").click();
  }
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-download-btn").nth(index).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

// Holds each run to validation/browser-reference.json and attaches its measurements, which a
// re-recording copies into that file. The ensemble's browser needs more than 4 GB of memory.
for (const folds of [1, 5]) {
  test(`automation segments the MS example with ${folds} fold(s) on the input grid, falling back from a failed WebGPU`, async ({ page }, testInfo) => {
    test.setTimeout(folds * 20 * 60 * 1000);
    // The page sees an adapter, so Automatic picks WebGPU; the worker has none, so its session fails.
    await page.addInitScript(() => {
      if (navigator.gpu) navigator.gpu.requestAdapter = async () => ({});
    });
    await page.goto("./");
    await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#fileInfo")).toContainText("240 × 240 × 81 voxels");
    await expect(page.locator("#runButton")).toBeEnabled();
    const inputFile = await download(page, 0);
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: inputFile.name, mimeType: "application/gzip", buffer: inputFile.bytes });
    await page.evaluate(async (parameters) => {
      await window.neurodeskAutomation.dispatch("adopt", { role: "image" });
      await window.neurodeskAutomation.dispatch("start", { operation: "segment", parameters });
    }, { folds });
    await expect(page.locator("#cancelButton")).toBeVisible();
    await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · \d+ lesions · [\d.]+ ml$/, { timeout: folds * 18 * 60 * 1000 });
    await expect(page.locator("#cancelButton")).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot").then((value) => value.state))).toBe("succeeded");
    const report = await page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot").then((value) => value.report));
    expect(Object.keys(report.artifacts).sort()).toEqual(["mask", "probability", "table"]);
    expect(report.provenance.backend).toBe("wasm");
    expect(report.provenance.models).toHaveLength(folds);
    for (const artifact of Object.values(report.artifacts)) expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    const [, count, ml] = (await page.locator("#statusText").textContent()).match(/(\d+) lesions · ([\d.]+) ml/);
    expect(report.measurements.count).toBe(Number(count));
    expect(report.measurements.totalMl.toFixed(2)).toBe(ml);
    await expect(page.locator("#technicalLog")).toContainText("continuing on the CPU");
    await expect(page.locator("#technicalLog")).toContainText(folds === 1 ? "FLAMeS, fold 0, on WebAssembly" : "FLAMeS, 5 folds, on WebAssembly");
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
    await expect(page.locator("#resultList .nd-view-btn").nth(3)).toBeDisabled();
    const flair = await download(page, 0);
    const mask = await download(page, 1);
    const probability = await download(page, 2);
    const table = await download(page, 3);
    expect(mask.name).toBe("MSLesSeg_P57_T1_FLAIR_lesions.nii");
    expect(probability.name).toBe("MSLesSeg_P57_T1_FLAIR_lesion_probability.nii");
    const input = readVolume(bytesOf(flair.bytes));
    const lesions = readVolume(bytesOf(mask.bytes));
    expect(lesions.dims).toEqual(input.dims);
    expect(lesions.affine).toEqual(input.affine);
    if (folds === 1) {
      // Fold 0 against the nnU-Net-resampling reference (validation/reference.py), not a browser recording.
      const referenceBytes = await readFile(reference.url);
      expect(createHash("sha256").update(referenceBytes).digest("hex")).toBe(reference.sha256);
      const expected = readVolume(bytesOf(referenceBytes));
      expect(expected.dims).toEqual(lesions.dims);
      expect(maskVoxels(expected.data)).toBe(reference.lesionVoxels);
      expect(dice(lesions.data, expected.data)).toBeGreaterThanOrEqual(MIN_REFERENCE_DICE);
    }
    const measured = measure({
      mask: lesions,
      probability: readVolume(bytesOf(probability.bytes)),
      lesions: report.measurements.count,
      totalMl: report.measurements.totalMl,
    });
    await testInfo.attach(`browser-reference-${folds}`, { body: JSON.stringify(measured), contentType: "application/json" });
    console.log(`Browser reference, ${folds} fold(s): ${JSON.stringify(measured)}`);
    for (const [passed, line] of compareWithBrowser(measured, folds)) expect(passed, line).toBe(true);
    const rows = table.bytes.toString().trim().split("\n");
    expect(rows[0]).toBe("lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm");
    expect(rows.length - 1).toBe(Number(count));
    expect(rows.slice(1).reduce((sum, row) => sum + Number(row.split("\t")[1]), 0)).toBe(measured.maskVoxels);
  });
}

test("automation reports a failed model download and leaves the run available", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.route(modelUrl, (route) => route.fulfill({ status: 503, body: "" }));
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#skullStripped").check();
  const input = await download(page, 0);
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: input.name, mimeType: "application/gzip", buffer: input.bytes });
  await page.evaluate(async () => {
    await window.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await window.neurodeskAutomation.dispatch("start", { parameters: { skullStripped: true } });
  });
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\)/, { timeout: 120000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect.poll(() => page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot").then((value) => value.state))).toBe("failed");
  const snapshot = await page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error.message).toMatch(/Model download failed/);
  expect(snapshot.report).toBeUndefined();
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(1);
});

test("the ensemble downloads each fold in turn", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  const secondFold = manifest.base_url + manifest.assets[1].filename;
  await page.route(secondFold, (route) => route.fulfill({ status: 503, body: "" }));
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#skullStripped").check();
  await page.locator("#folds").selectOption("5");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\): .*flames-fold1\.onnx/, { timeout: 180000 });
  await expect(page.locator("#technicalLog")).toContainText("Downloading FLAMeS model 1 of 5…");
  await expect(page.locator("#technicalLog")).toContainText("Downloading FLAMeS model 2 of 5…");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a run stops it and keeps the input ready", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.route(modelUrl, () => {});
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#skullStripped").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Downloading FLAMeS model…", { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#fileInfo")).toContainText("MSLesSeg_P57_T1_FLAIR.nii.gz");
});

test("automation cancellation stops the worker and permits a new run", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.route(modelUrl, () => {});
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#skullStripped").check();
  const input = await download(page, 0);
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: input.name, mimeType: "application/gzip", buffer: input.bytes });
  await page.evaluate(async () => {
    await window.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await window.neurodeskAutomation.dispatch("start", { parameters: { skullStripped: true } });
  });
  await expect(page.locator("#statusText")).toHaveText("Downloading FLAMeS model…", { timeout: 60000 });
  await page.evaluate(() => window.neurodeskAutomation.dispatch("cancel"));
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  const snapshot = await page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.state).toBe("cancelled");
  expect(snapshot.report).toBeUndefined();
  await page.unroute(modelUrl);
  await page.route(modelUrl, (route) => route.fulfill({ status: 503, body: "" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: input.name, mimeType: "application/gzip", buffer: input.bytes });
  await page.evaluate(async () => {
    await window.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await window.neurodeskAutomation.dispatch("start", { parameters: { skullStripped: true } });
  });
  await expect.poll(() => page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot").then((value) => value.state)), { timeout: 120000 }).toBe("failed");
  await expect(page.locator("#statusText")).toHaveText(/Model download failed/);
});

test("advanced settings start open and keep their values when the section closes", async ({ page }) => {
  await page.goto("./");
  const summary = page.locator("#advancedSettings summary");
  await expect(page.locator("#advancedSettings")).toHaveAttribute("open", "");
  await expect(page.locator("#folds")).toBeVisible();
  await page.locator("#skullStripped").check();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#folds").selectOption("5");
  await summary.click();
  await summary.click();
  await expect(page.locator("#skullStripped")).toBeChecked();
  await expect(page.locator("#folds")).toHaveValue("5");
  await expect(page.locator("#backend")).toHaveValue("wasm");
});

for (const failure of ["download", "empty image"]) {
  test(`a failed example ${failure} can be retried`, async ({ page }) => {
    const example = examples[0];
    let attempts = 0;
    await page.route(example.files[0].url, (route) => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
      return route.continue();
    });
    await page.goto("./");
    const picker = page.getByLabel("Example", { exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("the shared app bar owns About, Cite and the theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("FLAMeS");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("10.1101/2025.05.19.25327707");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});
