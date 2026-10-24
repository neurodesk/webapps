// Browser tests against `vite preview` of the production build: boot, the shared shell, N4 in a
// worker on a biased DWI, the hosted example and its failure, retry and cancel paths, and the
// automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { biasedSeries, dicomMask, tissueMask, tissueVariation } from "./fixtures.mjs";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";
import { dropFolder, exampleBidsTree } from "../../../test-utils/bids-folder-drop.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const imageUrl = examples[0].files.find((file) => file.role === "image").url;

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return event;
}

/** Loads a series and its tissue mask: the synthetic block is not a head, so MindGrab is not used. */
async function loadWithMask(page, files, grid = {}) {
  await page.locator("#imageInput").setInputFiles(files);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#maskInput").setInputFiles(tissueMask(grid));
  await expect(page.locator("#maskInfo")).toContainText("voxels");
}

async function readDownload(event) {
  return readNiftiFrames(gunzipSync(readFileSync(await (await event).path())));
}

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("a biased DWI is flattened, every volume by the same field", async ({ page }) => {
  test.setTimeout(120000);
  const series = biasedSeries();
  await page.goto("/");
  await loadWithMask(page, series.files);
  await expect(page.locator("#modeNote")).toHaveText("DWI: the field is fitted to the mean of 2 b0 volumes.");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Bias field corrected", { timeout: 90000 });
  const image = download(page, "Corrected image");
  expect((await image).suggestedFilename()).toBe("sub-01_desc-n4_dwi.nii.gz");
  const out = await readDownload(image);
  expect(out.frames).toBe(3);
  const before = tissueVariation(series.data, series.tissue);
  const after = tissueVariation(out.data, series.tissue);
  expect(after).toBeLessThan(before / 2);
  // The b = 1000 volume keeps its ratio to the b0 volumes: one field corrects all of them.
  const centre = series.tissue[Math.floor(series.tissue.length / 2)];
  expect(out.data[series.voxels + centre] / out.data[centre]).toBeCloseTo(0.4, 3);
  const bias = download(page, "Bias field");
  expect((await bias).suggestedFilename()).toBe("sub-01_desc-n4_biasfield.nii.gz");
  const bval = download(page, "b-values");
  expect(readFileSync(await (await bval).path(), "utf8")).toBe("0 1000 0");
});

test("cancelling stops the worker and permits another run", async ({ page }) => {
  test.setTimeout(120000);
  const series = biasedSeries({ nx: 160, ny: 160, nz: 120, frames: 1, bvals: [0] });
  await page.goto("/");
  // A 3 M-voxel image takes some seconds to read and show.
  await loadWithMask(page, series.files, { nx: 160, ny: 160, nz: 120 });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

// Rows: the input image, then the outputs.
const EXAMPLE_RUNS = {
  "ds005134-slab": { image: "sub-01_dir-AP_desc-slab_dwi.nii.gz", rows: 7, volumes: 137, stem: "sub-01_dir-AP", prefix: "sub-01_dir-AP_desc-n4_dwi" },
  "t1-head": { image: "T1_head.nii.gz", rows: 4, volumes: 1, stem: "T1", prefix: "T1_desc-n4_head" },
  dwi: { image: "dwi.nii.gz", rows: 6, volumes: 21, stem: "dwi", prefix: "dwi_desc-n4" },
};

test("the first example is the ds005134 multi-shell slab", () => {
  expect(examples.map((example) => example.id)).toEqual(Object.keys(EXAMPLE_RUNS));
});

for (const example of examples) {
  test(`example ${example.id} corrects the bias field and downloads the image, field and mask`, async ({ page }) => {
    test.setTimeout(240000);
    const run = EXAMPLE_RUNS[example.id];
    await page.goto("/");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("#fileInfo")).toContainText(run.image, { timeout: 120000 });
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText("Bias field corrected", { timeout: 210000 });
    await expect(page.locator("#technicalLog")).toContainText(/MindGrab .+ brain mask on (cpu|webgpu|webgl2)/);
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(run.rows);
    // The viewer can go back to the scan before correction; its download is the input itself.
    const inputRow = page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Input image" });
    await inputRow.getByRole("button", { name: "View" }).click();
    await expect(page.locator("#technicalLog")).toContainText(`Showing ${run.image}`);
    const original = download(page, "Input image");
    expect((await original).suggestedFilename()).toBe(run.image);
    const image = download(page, "Corrected image");
    expect((await image).suggestedFilename()).toBe(`${run.prefix}.nii.gz`);
    const corrected = await readDownload(image);
    expect(corrected.frames).toBe(run.volumes);
    expect(corrected.data.every(Number.isFinite)).toBe(true);
    const mask = download(page, "Brain mask");
    expect((await mask).suggestedFilename()).toBe(`${run.stem}_desc-brain_mask.nii.gz`);
    const inMask = Array.from((await readDownload(mask)).data, (value) => value > 0);
    expect(inMask.filter(Boolean).length).toBeGreaterThan(1000);
    const field = download(page, "Bias field");
    expect((await field).suggestedFilename()).toBe(`${run.stem}_desc-n4_biasfield.nii.gz`);
    const bias = Array.from((await readDownload(field)).data).filter((_, i) => inMask[i]);
    expect(bias.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
    if (example.files.some((file) => file.role === "sidecar")) {
      const sidecar = download(page, "Sidecar");
      expect((await sidecar).suggestedFilename()).toBe(`${run.prefix}.json`);
      const metadata = JSON.parse(readFileSync(await (await sidecar).path(), "utf8"));
      expect(metadata.PhaseEncodingDirection).toBe("j-");
      expect(metadata.Description).toMatch(/N4/);
    }
  });
}

test("cancelling default MindGrab extraction permits a complete retry", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  const started = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#statusText")).toHaveText("Extracting the brain from the mean b0 with MindGrab");
  await page.locator("#cancelButton").click();
  await stopped;
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Bias field corrected", { timeout: 150000 });
  await expect(page.locator("#technicalLog")).toContainText(/MindGrab .+ brain mask on (cpu|webgpu|webgl2)/);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    // The retry downloads the real example, which can take longer than the 30 s default.
    test.setTimeout(150000);
    const example = examples[0];
    let attempts = 0;
    await page.context().route(imageUrl, (route) => {
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
  const example = examples[0];
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
});

test("the automation operation returns the corrected image, field and mask", async ({ page }) => {
  test.setTimeout(120000);
  const series = biasedSeries();
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(series.files);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles({
    name: "upstream_acquisition.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05, SliceTiming: [0, 0.02] })),
  });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "sidecar" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles(tissueMask());
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "mask" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 90000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.procedure).toBe("mrtrix-dwibiascorrect-ants");
  expect(Object.keys(report.artifacts).sort()).toEqual(["bias", "bval", "bvec", "image", "mask", "sidecar"]);
  const event = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "sidecar" }));
  expect(JSON.parse(readFileSync(await (await event).path(), "utf8"))).toMatchObject({
    PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05, SliceTiming: [0, 0.02],
  });
});


test("cancelling while results are compressed does not publish downloads", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await loadWithMask(page, biasedSeries().files);
  await page.evaluate(() => {
    const NativeCompressionStream = CompressionStream;
    const gate = new Promise((resolve) => { window.finishPacking = resolve; });
    window.CompressionStream = class {
      constructor(format) {
        const stream = new NativeCompressionStream(format);
        return {
          writable: stream.writable,
          readable: stream.readable.pipeThrough(new TransformStream({
            async transform(chunk, controller) {
              window.packingStarted = true;
              await gate;
              controller.enqueue(chunk);
            },
          })),
        };
      }
    };
  });
  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.packingStarted === true, null, { timeout: 90000 });
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishPacking());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a cancelled mask import keeps correction from racing the mask read", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(biasedSeries().files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#advancedSettings summary").click();
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "brain_mask.nii.gz") return read.call(this);
      return new Promise((resolve, reject) => {
        window.finishMaskRead = () => read.call(this).then(resolve, reject);
      });
    };
  });
  const mask = { ...biasedSeries({ frames: 1, bvals: [0] }).files[0], name: "brain_mask.nii.gz" };
  await page.locator("#maskInput").setInputFiles(mask);
  await page.waitForFunction(() => typeof window.finishMaskRead === "function");
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishMaskRead());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#maskInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});


test("b-values are preserved when gradient directions are absent", async ({ page }) => {
  await page.goto("/");
  const files = biasedSeries().files.filter((file) => !file.name.endsWith(".bvec"));
  await loadWithMask(page, files);
  await expect(page.locator("#modeNote")).toHaveText("DWI: the field is fitted to the mean of 2 b0 volumes.");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Bias field corrected", { timeout: 90000 });
  const bval = await download(page, "b-values");
  expect(readFileSync(await bval.path(), "utf8")).toBe("0 1000 0");
  await expect(page.locator("#resultList .nd-volume-toggle").filter({ hasText: "b-vectors" })).toHaveCount(0);
});


test("DICOM correction downloads an anonymized sidecar", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dicomSeries({ slices: 16, patient: { birthDate: "19800102" } }));
  await expect(page.locator("#fileInfo")).toContainText(".nii", { timeout: 60000 });
  // The DICOM fixture is an intensity ramp, so use its known mask rather than skull stripping it.
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#maskInput").setInputFiles(dicomMask());
  await expect(page.locator("#maskInfo")).toContainText("4096 voxels");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Bias field corrected", { timeout: 60000 });
  const event = await download(page, "Sidecar");
  const sidecar = JSON.parse(readFileSync(await event.path(), "utf8"));
  expect(sidecar.EchoTime).toBe(0.02);
  expect(sidecar).not.toHaveProperty("PatientName");
  expect(sidecar).not.toHaveProperty("PatientBirthDate");
});

test("a dropped BIDS folder corrects the chosen run and keeps its sidecar", async ({ page }) => {
  test.setTimeout(240000);
  const tree = await exampleBidsTree(page.request, examples[0], { runs: 2 });
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.getByRole("combobox", { name: "DWI run" })).toBeHidden();
  await dropFolder(page, tree);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-1_dwi.nii.gz", { timeout: 120000 });
  const runs = page.getByRole("combobox", { name: "DWI run" });
  await expect(runs.locator("option")).toHaveText(["sub-01_run-1_dwi", "sub-01_run-2_dwi"]);
  await runs.selectOption({ label: "sub-01_run-2_dwi" });
  await expect(page.locator("#fileInfo")).toHaveText("sub-01_run-2_dwi.nii.gz · 67×92×10×137 · bval, bvec", { timeout: 120000 });
  await expect(page.locator("#modeNote")).toHaveText("DWI: the field is fitted to the mean of 13 b0 volumes.");
  // Undo after another drop gives back the folder with the chosen run, not its first run.
  const other = Object.fromEntries(["nii.gz", "bval", "bvec"].map((ext) => [`ds/sub-01/dwi/sub-01_dwi.${ext}`, tree[`ds/sub-01/dwi/sub-01_run-1_dwi.${ext}`]]));
  await dropFolder(page, other);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_dwi.nii.gz", { timeout: 60000 });
  await expect(runs).toBeHidden();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-2_dwi.nii.gz", { timeout: 60000 });
  await expect(runs).toHaveValue("1");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Bias field corrected", { timeout: 210000 });
  const image = download(page, "Corrected image");
  expect((await image).suggestedFilename()).toBe("sub-01_run-2_desc-n4_dwi.nii.gz");
  expect((await readDownload(image)).frames).toBe(137);
  const bval = await download(page, "b-values");
  expect(bval.suggestedFilename()).toBe("sub-01_run-2_desc-n4_dwi.bval");
  expect(readFileSync(await bval.path())).toEqual(tree["ds/sub-01/dwi/sub-01_run-2_dwi.bval"]);
  const sidecar = await download(page, "Sidecar");
  expect(sidecar.suggestedFilename()).toBe("sub-01_run-2_desc-n4_dwi.json");
  // The run's own sidecar (the example's) and the dataset's dwi.json both reach the output.
  expect(JSON.parse(readFileSync(await sidecar.path(), "utf8"))).toMatchObject({ PhaseEncodingDirection: "j-", InheritedField: "ds/dwi.json", RunSidecar: 2 });
});
