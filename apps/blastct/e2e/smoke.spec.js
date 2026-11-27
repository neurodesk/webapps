// Browser tests against `vite preview` of the production build: shared shell, cross-origin
// isolation, 3D head CT validation, example loading/failure/cancel/retry, running-job
// cancellation, and full @heavy TBI lesion segmentation parity on BLAST-CT scan_0_head_ct.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { DEFAULT_MODEL_ID, modelById } from "@neurodesk/blastct/models";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const primaryExample = examples[0];
const primaryFile = primaryExample.files[0];
const primaryModel = modelById(DEFAULT_MODEL_ID);
// Upstream biomedia-mira/blast-ct v2.0.0 checkpoint 1 counts on scan_0_head_ct.nii.gz.
const ORACLE_COUNTS = { iph: 48087, eah: 23595, oedema: 62721, ivh: 327 };

function makeSyntheticNifti({ dims = [16, 16, 16], frames = 1, pixdim = [1, 1, 1], name = "synthetic.nii" } = {}) {
  const [nx, ny, nz] = dims;
  const rank = frames > 1 ? 4 : 3;
  const nvox = nx * ny * nz * frames;
  const buf = new Uint8Array(352 + nvox * 2);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, rank, true);
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, frames, true);
  dv.setInt16(70, 4, true);
  dv.setInt16(72, 16, true);
  dv.setFloat32(76, 1, true);
  dv.setFloat32(80, pixdim[0], true);
  dv.setFloat32(84, pixdim[1], true);
  dv.setFloat32(88, pixdim[2], true);
  dv.setFloat32(108, 352, true);
  dv.setInt16(252, 1, true);
  dv.setInt16(254, 1, true);
  dv.setFloat32(280, pixdim[0], true);
  dv.setFloat32(300, pixdim[1], true);
  dv.setFloat32(320, pixdim[2], true);
  buf.set([0x6e, 0x2b, 0x31, 0x00], 344);
  return { name, mimeType: "application/octet-stream", buffer: Buffer.from(buf) };
}

test("app boots in workspace with idle status and disabled run", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("shared app bar opens About, Cite, Privacy and switches theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("dialog[open]")).toContainText("traumatic brain injury");
  await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("Multiclass semantic segmentation and quantification of traumatic brain injury lesions");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("never uploaded");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("non-image, 4D, and oversized volumes are refused before running", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a scan") });
  await expect(page.locator("#statusText")).toContainText("No images produced");
  await expect(page.locator("#runButton")).toBeDisabled();

  await page.locator("#imageInput").setInputFiles(makeSyntheticNifti({ dims: [8, 8, 8], frames: 2, name: "series_4d.nii" }));
  await expect(page.locator("#statusText")).toContainText("requires a single 3D non-contrast head CT volume");
  await expect(page.locator("#runButton")).toBeDisabled();

  // Small payload with huge physical spacing -> exceeds 32M voxels at 1 mm isotropic
  await page.locator("#imageInput").setInputFiles(makeSyntheticNifti({ dims: [16, 16, 16], pixdim: [30, 30, 30], name: "giant_fov.nii" }));
  await expect(page.locator("#statusText")).toContainText("exceeding the browser limit");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("hosted example loads cleanly, handles download failure retry, and reaches ready state", async ({ page }) => {
  test.setTimeout(150000);
  let attempts = 0;
  await page.context().route(primaryFile.url, (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, body: "" });
    return route.fallback();
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();

  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("201 × 201 × 149");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling during example read prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(150000);
  await page.goto("./");
  await page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const blob = this;
      if (blob.size !== 352) return read.call(blob);
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          Blob.prototype.arrayBuffer = read;
          read.call(blob).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a running segmentation terminates the worker and re-enables controls", async ({ page }) => {
  test.setTimeout(150000);
  let releaseModel;
  await page.context().route(primaryModel.url, async (route) => {
    await new Promise((resolve) => { releaseModel = resolve; });
    await route.abort("aborted").catch(() => {});
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText(/Starting BLAST-CT segmentation|Reading head CT volume|Downloading the BLAST-CT model/, { timeout: 30000 });
  await page.locator("#cancelButton").click();
  releaseModel?.();
  await expect(page.locator("#statusText")).toHaveText("Segmentation cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("segments hosted head CT example matching upstream BLAST-CT v2.1.0 checkpoint 1 parity", { tag: "@heavy" }, async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · /, { timeout: 9 * 60 * 1000 });
  await expect(page.locator("#labelLegend")).toBeVisible();
  await expect(page.locator("#labelLegend")).toContainText("IPH");
  await expect(page.locator("#labelLegend")).toContainText("EAH");
  await expect(page.locator("#labelLegend")).toContainText("Oedema");
  await expect(page.locator("#labelLegend")).toContainText("IVH");

  const segEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Lesion labels" }).getByRole("button", { name: "Download" }).click();
  const segDl = await segEvent;
  expect(segDl.suggestedFilename()).toBe("scan_0_head_ct_blastct_segmentation.nii.gz");
  const raw = gunzipSync(readFileSync(await segDl.path()));
  expect([raw.readInt16LE(42), raw.readInt16LE(44), raw.readInt16LE(46)]).toEqual([201, 201, 149]);
  expect(raw.readInt16LE(68)).toBe(1002); // NIFTI_INTENT_LABEL
  expect(raw.readInt16LE(70)).toBe(2); // uint8
  expect(raw.readFloatLE(124)).toBe(4); // cal_max reset for 4-class labels
  expect(raw.readFloatLE(128)).toBe(0); // cal_min reset
  expect(raw.readInt16LE(252)).toBe(1); // qform_code preserved from input
  expect(raw.readInt16LE(254)).toBe(1); // sform_code preserved from input
  const voxels = raw.subarray(352);
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < voxels.length; i++) {
    if (voxels[i] < 5) counts[voxels[i]]++;
  }
  expect(Math.abs(counts[1] - ORACLE_COUNTS.iph)).toBeLessThanOrEqual(50);
  expect(Math.abs(counts[2] - ORACLE_COUNTS.eah)).toBeLessThanOrEqual(50);
  expect(Math.abs(counts[3] - ORACLE_COUNTS.oedema)).toBeLessThanOrEqual(50);
  expect(Math.abs(counts[4] - ORACLE_COUNTS.ivh)).toBeLessThanOrEqual(50);

  const csvEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Volumes (CSV)" }).getByRole("button", { name: "Download" }).click();
  const csvDl = await csvEvent;
  expect(csvDl.suggestedFilename()).toBe("scan_0_head_ct_blastct_volumes.csv");
  const csvText = readFileSync(await csvDl.path(), "utf8");
  expect(csvText).toContain("scan,class_id,class_key,class_label,voxels,volume_ml");
  expect(csvText).toContain("Intraparenchymal haemorrhage");
  expect(csvText).toContain("Extra-axial haemorrhage");
  expect(csvText).toContain("Perilesional oedema");
  expect(csvText).toContain("Intraventricular haemorrhage");
  expect(csvText).toContain("Total lesion burden");
});
