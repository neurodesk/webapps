// Browser tests against `vite preview` of the production build: the shared shell, DenoiseImage in
// its module worker on the pinned example against native ANTs, the settings and mask against the
// Node build of the same module, refusals, cancellation, the example's failure and retry paths,
// and the automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loadDenoise } from "@neurodesk/ants-denoise/node";
import { example, exampleBytes, exampleFile, halfMask, inflate, nonzeroMask, phantom, series4d, sha256 } from "./fixtures.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const native = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const DENOISED_NAME = "MSLesSeg_P57_T1_desc-denoised_FLAIR.nii.gz";
const nifti = (name, buffer) => ({ name, mimeType: "application/octet-stream", buffer });

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

async function chooseSettings(page, { noiseModel, patchRadius, searchRadius }) {
  await page.locator("#noiseModel").selectOption(noiseModel);
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#patchRadius").fill(String(patchRadius));
  await page.locator("#searchRadius").fill(String(searchRadius));
}

async function loadImage(page, file) {
  await page.locator("#imageInput").setInputFiles(file);
  await expect(page.locator("#statusText")).toHaveText(`${file.name} loaded`, { timeout: 60000 });
}

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await expect(page.locator("#infoDialog")).toContainText("Manjón");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // The DenoiseImage module is a pthread build: its memory needs cross-origin isolation.
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("the example is the pinned MS FLAIR the native reference was recorded on", () => {
  expect(native.example).toEqual({ name: exampleFile.name, sha256: exampleFile.sha256 });
  expect(native.cases.map((entry) => entry.id)).toEqual(["default", "rician-nonzero-mask"]);
});

test(`example ${example.id} with the defaults gives native ANTs DenoiseImage's voxels and downloads them`, async ({ page }) => {
  test.setTimeout(420000);
  const reference = native.cases.find((entry) => entry.id === "default");
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(`${exampleFile.name} · 240 × 240 × 81 · 1.04 × 1.04 × 2.30 mm`, { timeout: 120000 });
  await expect(page.locator("#noiseModel")).toHaveValue(reference.settings.noiseModel);
  await expect(page.locator("#patchRadius")).toHaveValue(String(reference.settings.patchRadius));
  await expect(page.locator("#searchRadius")).toHaveValue(String(reference.settings.searchRadius));
  const started = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#statusText")).toHaveText("Image denoised", { timeout: 400000 });
  await stopped;
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(2);
  await expect(page.locator("#technicalLog")).toContainText("ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 DenoiseImage -d 3 -i MSLesSeg_P57_T1_FLAIR.nii.gz -n Gaussian -s 1 -p 1 -r 2");
  const denoised = await downloadRow(page, "Denoised image");
  expect(denoised.name).toBe(DENOISED_NAME);
  expect(sha256(inflate(denoised.bytes))).toBe(reference.sha256);
  // The viewer goes back to the image before denoising; its download is the input itself.
  const inputRow = page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Input image" });
  await inputRow.getByRole("button", { name: "View" }).click();
  await expect(page.locator("#technicalLog")).toContainText(`Showing ${exampleFile.name}`);
  const original = await downloadRow(page, "Input image");
  expect(original.name).toBe(exampleFile.name);
  expect(sha256(original.bytes)).toBe(exampleFile.sha256);
});

test("the Rician model inside a mask gives native ANTs DenoiseImage's voxels", async ({ page }) => {
  test.setTimeout(420000);
  const reference = native.cases.find((entry) => entry.id === "rician-nonzero-mask");
  const image = await exampleBytes();
  await page.goto("/");
  await loadImage(page, nifti(exampleFile.name, image));
  await chooseSettings(page, reference.settings);
  await page.locator("#maskInput").setInputFiles(nifti("head_mask.nii.gz", nonzeroMask(image)));
  await expect(page.locator("#statusText")).toHaveText("Only the 1109370 voxels of head_mask.nii.gz will be denoised");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Image denoised", { timeout: 400000 });
  await expect(page.locator("#resultList")).toContainText("Denoised image · Rician, patch 1, search 2");
  const denoised = await downloadRow(page, "Denoised image");
  expect(sha256(inflate(denoised.bytes))).toBe(reference.sha256);
});

test("the settings and the mask reach DenoiseImage as in the Node build of the module", async ({ page }) => {
  test.setTimeout(120000);
  const settings = { noiseModel: "Rician", patchRadius: 2, searchRadius: 3 };
  const image = phantom();
  const mask = halfMask();
  const denoiser = await loadDenoise();
  const expected = {
    defaults: sha256(await denoiser.denoise({ image })),
    chosen: sha256(await denoiser.denoise({ image, mask, ...settings })),
  };
  expect(expected.chosen).not.toBe(expected.defaults);
  await page.goto("/");
  await loadImage(page, nifti("sub-01_T2w.nii", image));
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Image denoised", { timeout: 60000 });
  expect(sha256(inflate((await downloadRow(page, "Denoised image")).bytes))).toBe(expected.defaults);
  await chooseSettings(page, settings);
  await page.locator("#maskInput").setInputFiles(nifti("sub-01_mask.nii.gz", mask));
  await expect(page.locator("#statusText")).toHaveText("Only the 6912 voxels of sub-01_mask.nii.gz will be denoised");
  // A new mask withdraws the result of the run without it.
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Image denoised", { timeout: 60000 });
  const denoised = await downloadRow(page, "Denoised image");
  expect(denoised.name).toBe("sub-01_desc-denoised_T2w.nii.gz");
  expect(sha256(inflate(denoised.bytes))).toBe(expected.chosen);
  await page.locator("#clearMask").click();
  await expect(page.locator("#statusText")).toHaveText("The whole image will be denoised");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("a radius outside the offered range is refused at its field", async ({ page }) => {
  await page.goto("/");
  await loadImage(page, nifti("phantom.nii", phantom(12)));
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#searchRadius").fill("4");
  await page.locator("#advancedSettings").evaluate((section) => { section.open = false; });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Search radius must be a whole number from 1 to 3.");
  await expect(page.locator("#advancedSettings")).toHaveAttribute("open", "");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a 4D series and a mask on another grid are refused, and a valid image loads after them", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(nifti("sub-01_dwi.nii.gz", series4d()));
  await expect(page.locator("#statusText")).toHaveText("This image has 3 volumes. Choose one 3D volume; for a diffusion series use dwidenoise.");
  await expect(page.locator("#runButton")).toBeDisabled();
  await loadImage(page, nifti("phantom.nii", phantom()));
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#maskInput").setInputFiles(nifti("small_mask.nii.gz", halfMask(12)));
  await expect(page.locator("#statusText")).toHaveText("small_mask.nii.gz is not on the image grid.");
  await expect(page.locator("#clearMask")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a run stops its worker, leaves no output and permits a complete retry", async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/");
  await loadImage(page, nifti(exampleFile.name, await exampleBytes()));
  const started = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#statusText")).toHaveText(`Denoising ${exampleFile.name}…`);
  await page.locator("#cancelButton").click();
  await stopped;
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  // A new image after a finished run withdraws its result.
  await loadImage(page, nifti("phantom.nii", phantom(12)));
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Image denoised", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(2);
  await loadImage(page, nifti("phantom2.nii", phantom(16)));
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("the automation operation denoises with its parameters and downloads the reported artifact", async ({ page }) => {
  test.setTimeout(120000);
  const image = phantom();
  const parameters = { noiseModel: "Rician", patchRadius: 1, searchRadius: 3 };
  const expected = sha256(await (await loadDenoise()).denoise({ image, ...parameters }));
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(nifti("sub-02_T1w.nii", image));
  const report = await page.evaluate(async (parameters) => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters });
    for (;;) {
      const snapshot = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (!["queued", "running"].includes(snapshot.state)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, parameters);
  expect(report.state).toBe("succeeded");
  expect(report.report.provenance.settings).toEqual({ ...parameters, shrinkFactor: 1 });
  expect(report.report.provenance.nativeCommand).toBe("ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 DenoiseImage -d 3 -i sub-02_T1w.nii -n Rician -s 1 -p 1 -r 3 -o sub-02_desc-denoised_T1w.nii.gz -v 0");
  await expect(page.locator("#noiseModel")).toHaveValue("Rician");
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "image" }));
  const bytes = readFileSync(await (await download).path());
  expect(sha256(bytes)).toBe(report.report.artifacts.image.sha256);
  expect(sha256(inflate(bytes))).toBe(expected);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(150000);
    let attempts = 0;
    await page.context().route(exampleFile.url, (route) => {
      attempts++;
      if (attempts > 1) return route.fallback();
      return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(150000);
  await page.goto("/");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});
