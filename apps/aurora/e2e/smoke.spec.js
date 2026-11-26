// Browser tests against `vite preview` of the production build: shared shell, cross-origin
// isolation, prepared BraTS/SRI24 grid validation, example loading/failure/cancel/retry,
// running-job cancellation, and full @heavy metastasis segmentation parity on BraTS-MET.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { DEFAULT_MODEL_ID, modelById } from "@neurodesk/aurora/models";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const primaryExample = examples[0];
const primaryFile = primaryExample.files[0];
const primaryModel = modelById(DEFAULT_MODEL_ID);
// Upstream BrainLesion/AURORA v0.2.7 AuroraInferer(tta=False) counts on BraTS-MET-00110-000-t1c.nii.gz.
const ORACLE_COUNTS = { oedema: 47078, metastasis: 51796 };

function makeOffGridNifti(dims = [32, 32, 32], pixdim = [1, 1, 1]) {
  const [nx, ny, nz] = dims;
  const nvox = nx * ny * nz;
  const buf = new Uint8Array(352 + nvox * 2);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, 1, true);
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
  return { name: "offgrid_t1c.nii", mimeType: "application/octet-stream", buffer: Buffer.from(buf) };
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
  await expect(page.locator("dialog[open]")).toContainText("240 × 240 × 155");
  await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("Identifying core MRI sequences for reliable automatic brain metastasis segmentation");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("never uploaded");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("off-grid and non-NIfTI files are refused before running", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(page.locator("#statusText")).toContainText("not a NIfTI image");
  await expect(page.locator("#runButton")).toBeDisabled();

  await page.locator("#imageInput").setInputFiles(makeOffGridNifti([32, 32, 32]));
  await expect(page.locator("#statusText")).toContainText("AURORA needs the 240 × 240 × 155, 1 mm BraTS/SRI24 grid");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("hosted example loads cleanly, handles download failure retry, and cancels cleanly", async ({ page }) => {
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
  await expect(page.locator("#fileInfo")).toContainText("240 × 240 × 155");
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
  await expect(page.locator("#statusText")).toContainText(/Starting AURORA segmentation|Reading T1c image|Downloading the AURORA model/, { timeout: 30000 });
  await page.locator("#cancelButton").click();
  releaseModel?.();
  await expect(page.locator("#statusText")).toHaveText("Segmentation cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("segments hosted BraTS-MET T1c example matching upstream AuroraInferer(tta=False) parity", { tag: '@heavy' }, async ({ page }) => {
  test.setTimeout(25 * 60 * 1000);
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · /, { timeout: 24 * 60 * 1000 });
  await expect(page.locator("#labelLegend")).toBeVisible();
  await expect(page.locator("#labelLegend")).toContainText("Peritumoral oedema");
  await expect(page.locator("#labelLegend")).toContainText("Metastasis (enhancing + necrosis)");

  const segEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Metastasis labels" }).getByRole("button", { name: "Download" }).click();
  const segDl = await segEvent;
  expect(segDl.suggestedFilename()).toBe("BraTS-MET-00110-000-t1c_aurora_seg.nii.gz");
  const raw = gunzipSync(readFileSync(await segDl.path()));
  expect(raw.readInt16LE(252)).toBe(1); // qform_code preserved from input
  expect(raw.readInt16LE(254)).toBe(1); // sform_code preserved from input
  const voxels = raw.subarray(352);
  let oedema = 0;
  let metastasis = 0;
  for (let i = 0; i < voxels.length; i++) {
    if (voxels[i] === 1) oedema++;
    else if (voxels[i] === 2) metastasis++;
  }
  expect(Math.abs(oedema - ORACLE_COUNTS.oedema)).toBeLessThanOrEqual(50);
  expect(Math.abs(metastasis - ORACLE_COUNTS.metastasis)).toBeLessThanOrEqual(50);

  const tsvEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Volumes (TSV)" }).getByRole("button", { name: "Download" }).click();
  const tsvDl = await tsvEvent;
  const tsvText = readFileSync(await tsvDl.path(), "utf8");
  expect(tsvText).toContain("Peritumoral oedema");
  expect(tsvText).toContain("Metastasis (enhancing + necrosis)");
  expect(tsvText).toContain("lesions_26conn_ge5");
  expect(tsvText).toMatch(/^MET\tMetastasis \(label 2\)\t\d+\t[\d.]+\t1$/m);
});
