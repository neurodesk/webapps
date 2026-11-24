import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { readVolume, writeVolume } from "@neurodesk/synthsr";
import { compareBinaryMasks } from "@neurodesk/tumour-report/results";
import { assetById } from "@neurodesk/tumour-report/models";
import reference from "../../../packages/tumour-report/validation/container-reference.json" with { type: "json" };
import { readContainerReference } from "../../../packages/tumour-report/validation/reference.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const beamster = examples[0];
const upenn = examples[1];
const brainModel = assetById("mri-brain");
const bytesOf = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

function makeSyntheticPair() {
  const dims = [32, 32, 24];
  const affine = [
    [1, 0, 0, -16],
    [0, 1, 0, -16],
    [0, 0, 1, -12],
    [0, 0, 0, 1],
  ];
  const count = dims[0] * dims[1] * dims[2];
  const t1 = new Float32Array(count);
  const mask = new Uint8Array(count);
  const idx = (x, y, z) => x + dims[0] * (y + dims[1] * z);
  for (let z = 4; z < 20; z++) {
    for (let y = 4; y < 28; y++) {
      for (let x = 4; x < 28; x++) {
        t1[idx(x, y, z)] = 100;
      }
    }
  }
  // Lesion 1: 12 x 12 x 6 box (measurable >= 10x10 mm on axial slices)
  for (let z = 9; z < 15; z++) {
    for (let y = 6; y < 18; y++) {
      for (let x = 6; x < 18; x++) {
        mask[idx(x, y, z)] = 1;
        t1[idx(x, y, z)] = 220;
      }
    }
  }
  // Lesion 2: 5 x 5 x 5 box separated by > 5 mm
  for (let z = 10; z < 15; z++) {
    for (let y = 21; y < 26; y++) {
      for (let x = 21; x < 26; x++) {
        mask[idx(x, y, z)] = 1;
        t1[idx(x, y, z)] = 210;
      }
    }
  }
  return {
    t1Buffer: Buffer.from(writeVolume({ data: t1, dims, affine }, "synthetic t1c")),
    maskBuffer: Buffer.from(writeVolume({ data: mask, dims, affine }, "synthetic mask")),
  };
}

function make4dNifti() {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  for (const [k, n] of [4, 8, 8, 8, 2, 1, 1, 1].entries()) header.writeInt16LE(n, 40 + 2 * k);
  header.writeInt16LE(2, 70);
  header.writeInt16LE(8, 72);
  for (let k = 0; k < 5; k++) header.writeFloatLE(1, 76 + 4 * k);
  header.writeFloatLE(352, 108);
  header.write("n+1\0", 344, "latin1");
  return Buffer.concat([header, Buffer.alloc(8 * 8 * 8 * 2)]);
}

async function downloadRow(page, label) {
  if (!await page.locator("#outputSection").evaluate((el) => el.open)) {
    await page.locator("#outputSection summary").click();
  }
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).locator(".nd-download-btn").click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

test("app boots, is cross-origin isolated, and shared app bar owns About, Privacy and theme", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);

  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Raidionics");
  await dialog.getByRole("button", { name: "Close" }).click();

  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("a 4D volume is refused clearly", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({
    name: "dynamic_4d.nii",
    mimeType: "application/octet-stream",
    buffer: make4dNifti(),
  });
  await expect(page.locator("#statusText")).toHaveText("dynamic_4d.nii must be a single 3D volume.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("supplied-mask mode computes native morphometry, renders clickable Results tab and downloads outputs", async ({ page }) => {
  const { t1Buffer, maskBuffer } = makeSyntheticPair();
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "synth_t1c.nii", mimeType: "application/octet-stream", buffer: t1Buffer });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#maskInput").setInputFiles({ name: "synth_mask.nii", mimeType: "application/octet-stream", buffer: maskBuffer });
  await expect(page.locator("#runButton")).toHaveText("Characterize mask");

  await page.locator("#computeMniReport").uncheck();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Report ready · 2 lesions · [\d.]+ mL$/, { timeout: 60000 });

  await expect(page.locator("#resultsTab")).toBeEnabled();
  await page.locator("#resultsTab").click();
  await expect(page.locator("#resultsReport")).toBeVisible();
  await expect(page.locator("#resultsReport")).toContainText("Per-lesion native morphometry");
  await expect(page.locator("#resultsReport")).toContainText("Multifocal");

  // Clicking a lesion jumps back to the 3-plane viewer at its centroid.
  await page.locator('#resultsReport [role="button"]').first().click();
  await expect(page.locator("#resultsReport")).toBeHidden();
  await expect(page.locator("#statusText")).toContainText("Focused lesion #1");

  const reportFile = await downloadRow(page, "Report (JSON)");
  expect(reportFile.name).toBe("synth_t1c_report.json");
  const report = JSON.parse(reportFile.bytes.toString("utf8"));
  expect(report.morphometry.lesionCount).toBe(2);
  expect(report.morphometry.multifocal).toBe(true);
  expect(report.morphometry.lesions[0].axialBidimensional.measurable10x10mm).toBe(true);

  const lesionsTsv = await downloadRow(page, "Lesions table (TSV)");
  expect(lesionsTsv.bytes.toString("utf8").trim().split("\n")).toHaveLength(3);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed example ${failure} can retry the same example`, async ({ page }) => {
    const [first] = beamster.files;
    let attempts = 0;
    await page.route(first.url, async (route) => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
      return route.continue();
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(beamster.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(beamster.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling an example download leaves nothing loaded and permits a retry", async ({ page }) => {
  const [first] = beamster.files;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route(first.url, async (route) => {
    attempts++;
    if (attempts === 1) await held;
    return route.continue();
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(beamster.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "loading");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  release();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(beamster.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
});

test("a failed model download is reported and the run can be retried", async ({ page }) => {
  let attempts = 0;
  await page.context().route(brainModel.url, (route) => {
    attempts++;
    return route.fulfill({ status: 503, body: "" });
  });
  await page.goto("./");
  const { t1Buffer } = makeSyntheticPair();
  await page.locator("#imageInput").setInputFiles({ name: "retry_t1c.nii", mimeType: "application/octet-stream", buffer: t1Buffer });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\)/, { timeout: 60000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\)/, { timeout: 60000 });
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("cancelling a running analysis via footer × stops it and keeps inputs ready", async ({ page }) => {
  await page.context().route(brainModel.url, () => {});
  await page.goto("./");
  const { t1Buffer } = makeSyntheticPair();
  await page.locator("#imageInput").setInputFiles({ name: "cancel_t1c.nii", mimeType: "application/octet-stream", buffer: t1Buffer });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible({ timeout: 30000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#statusText")).toHaveText("Analysis cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#fileInfo")).toContainText("cancel_t1c.nii");
});

test("BEAMSTER native T1c example matches the pinned Raidionics container and computes MNI RADS", async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  await page.goto("./");
  await page.getByLabel("Input", { exact: true }).selectOption(beamster.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#tumourType")).toHaveValue("metastasis");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#advancedSettings summary").click();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();

  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText(/^Report ready · 3 lesions · [\d.]+ mL$/, { timeout: 14 * 60 * 1000 });

  const tumourDownload = await downloadRow(page, "Tumour mask (native)");
  expect(tumourDownload.name).toBe("BEAMSTER_A_038_T1c_tumour_mask.nii.gz");
  const predicted = readVolume(bytesOf(gunzipSync(tumourDownload.bytes)));
  const containerRef = readVolume(bytesOf(gunzipSync(await readContainerReference("BEAMSTER_A_038_tumour.nii.gz"))));
  const comparison = compareBinaryMasks(Uint8Array.from(predicted.data), Uint8Array.from(containerRef.data));
  console.log(`Browser BEAMSTER vs container: ${JSON.stringify(comparison)}`);
  expect(comparison.dice).toBeGreaterThanOrEqual(reference.gates.nativeTumourMinDice);

  const reportDownload = await downloadRow(page, "Report (JSON)");
  const report = JSON.parse(reportDownload.bytes.toString("utf8"));
  expect(report.morphometry.lesionCount).toBe(3);
  expect(report.rads.laterality.leftPct).toBeGreaterThan(95);
  expect(report.rads.resectability).toBeNull();
  expect(report.rads.cortical.mniLobes.involved.some((r) => r.name === "frontal_left")).toBe(true);
  expect(report.rads.subcortical.overlapping.length).toBeGreaterThan(0);

  await page.locator("#resultsTab").click();
  await expect(page.locator("#resultsReport")).toBeVisible();
  await expect(page.locator("#resultsReport")).toContainText("MNI cortical lobes");
  await expect(page.locator("#resultsReport")).toContainText("Subcortical white-matter tracts");
});

test("UPENN-GBM skull-stripped example computes glioblastoma resectability", { tag: "@heavy" }, async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);
  await page.goto("./");
  await page.getByLabel("Input", { exact: true }).selectOption(upenn.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#tumourType")).toHaveValue("glioblastoma");
  await page.locator("#advancedSettings summary").click();
  await expect(page.locator("#skullStripped")).toBeChecked();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Report ready · \d+ lesions? · [\d.]+ mL$/, { timeout: 14 * 60 * 1000 });
  await page.locator("#resultsTab").click();
  await expect(page.locator("#resultsReport")).toContainText("Glioblastoma resectability");
});
