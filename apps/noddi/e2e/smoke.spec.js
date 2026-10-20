// Browser tests against `vite preview` of the production build: boot, the shared shell, the real
// tensor and NODDI fits in workers, the hosted example and its failure, retry and cancel paths.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { oversizedHeaderDwi, syntheticDwi, syntheticMask } from "./fixtures.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const dwiUrl = examples[0].files.find((file) => file.role === "image").url;

/** Loads the series and a mask of every voxel: the synthetic cube is too small for MindGrab. */
async function loadWithMask(page, dwi, size = 8) {
  await page.locator("#imageInput").setInputFiles(dwi.files);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#maskInput").setInputFiles(syntheticMask({ size, value: 1 }));
  await expect(page.locator("#maskInfo")).toContainText(`${size ** 3} voxels`);
}

async function readDownload(download) {
  return readNiftiFrames(gunzipSync(readFileSync(await download.path())));
}

async function holdCompression(page) {
  await page.evaluate(() => {
    const NativeCompressionStream = window.CompressionStream;
    window.CompressionStream = class {
      constructor(format) {
        const compressor = new NativeCompressionStream(format);
        const held = new Promise((resolve) => {
          window.finishOutputCompression = () => {
            window.CompressionStream = NativeCompressionStream;
            resolve();
          };
        });
        this.writable = compressor.writable;
        this.readable = compressor.readable.pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            await held;
            controller.enqueue(chunk);
          },
        }));
      }
    };
  });
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

test("a header whose decoded image passes the limit is refused before the image is read", async ({ page }) => {
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    window.wholeImageReads = 0;
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      if (this instanceof File && /\.nii(\.gz)?$/.test(this.name)) window.wholeImageReads++;
      return read.call(this);
    };
  });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(oversizedHeaderDwi());
  await expect(page.locator("footer#status #statusText")).toHaveText("Decoded image too large (2.68 GB; browser limit 2.00 GB).");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  expect(await page.evaluate(() => window.wholeImageReads)).toBe(0);
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#fileInfo")).toBeHidden();
});

test("a two-shell DWI gives tensor and NODDI maps with the known fibre direction", async ({ page }) => {
  const dwi = syntheticDwi();
  await page.goto("/");
  await loadWithMask(page, dwi);
  await expect(page.locator("#fileInfo")).toContainText("2×b0, 30×b1000, 30×b2000");
  await expect(page.locator("#fitNoddi")).toBeEnabled();
  await expect(page.locator("#fitNoddi")).toBeChecked();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(`Fitted ${dwi.voxels} voxels`, { timeout: 120000 });
  const rows = page.locator("#resultList .nd-volume-toggle");
  await expect(rows).toHaveCount(11);
  const download = async (label) => {
    const event = page.waitForEvent("download");
    await rows.filter({ hasText: new RegExp(`^View${label}Download$`) }).getByRole("button", { name: "Download" }).click();
    return event;
  };
  const fa = await download("FA");
  expect(fa.suggestedFilename()).toBe("sub-01_model-tensor_param-fa_dwimap.nii.gz");
  const centre = 4 + 8 * (4 + 8 * 4);
  const faMap = await readDownload(fa);
  expect(faMap.data[centre]).toBeCloseTo(0.8, 1);
  expect(faMap.data[0]).toBe(0);
  const direction = await readDownload(await download("NODDI direction"));
  expect(direction.frames).toBe(3);
  expect(Math.abs(direction.data[centre])).toBeCloseTo(1, 4);
  const odi = await readDownload(await download("ODI"));
  expect(odi.data[centre]).toBeLessThan(0.2);
  const icvf = await readDownload(await download("ICVF"));
  expect(icvf.data[centre]).toBeGreaterThan(0);
  expect(icvf.data[centre]).toBeLessThanOrEqual(1);
});

test("an empty mask is refused instead of writing empty maps", async ({ page }) => {
  const dwi = syntheticDwi();
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dwi.files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#maskInput").setInputFiles(syntheticMask());
  await expect(page.locator("#maskInfo")).toContainText("mask.nii.gz · 0 voxels");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/The brain mask has no voxels/);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("cancelling a fit stops the workers and permits another fit", async ({ page }) => {
  const dwi = syntheticDwi({ size: 24 });
  await page.goto("/");
  await loadWithMask(page, dwi, 24);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("cancelling while output maps are compressed publishes no maps and permits retry", async ({ page }) => {
  const dwi = syntheticDwi({ shells: [1000] });
  await page.goto("/");
  await loadWithMask(page, dwi);
  await holdCompression(page);
  await page.locator("#runButton").click();
  await page.waitForFunction(() => typeof window.finishOutputCompression === "function");
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishOutputCompression());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fitted");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(7);
});

test("model choices survive replacement imports, including a single-shell DWI", async ({ page }) => {
  const multi = syntheticDwi();
  const single = syntheticDwi({ shells: [1000] });
  const upload = async (files) => {
    await page.locator("#imageInput").setInputFiles(files);
    await expect(page.locator("#runButton")).toBeEnabled();
  };
  await page.goto("/");
  await upload(multi.files);
  const noddi = page.locator("#fitNoddi");
  await expect(noddi).toBeEnabled();
  await noddi.uncheck();
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#tensorFit").selectOption("ols");
  await upload(single.files);
  await expect(noddi).toBeDisabled();
  await upload(multi.files);
  await expect(noddi).toBeEnabled();
  await expect(noddi).not.toBeChecked();
  await expect(page.locator("#tensorFit")).toHaveValue("ols");
  await noddi.check();
  await upload(single.files);
  await expect(noddi).toBeDisabled();
  await upload(multi.files);
  await expect(noddi).toBeEnabled();
  await expect(noddi).toBeChecked();
});

test("cancelling input preview preparation prevents a late input commit", async ({ page }) => {
  await page.goto("/");
  await holdCompression(page);
  await page.locator("#imageInput").setInputFiles(syntheticDwi().files);
  await page.waitForFunction(() => typeof window.finishOutputCompression === "function");
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishOutputCompression());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("mask reading blocks fitting, cancels without a late mask and permits retry", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(syntheticDwi().files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "mask.nii.gz") return read.call(this);
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishMaskRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const mask = syntheticMask({ value: 1 });
  await page.locator("#maskInput").setInputFiles(mask);
  await page.waitForFunction(() => typeof window.finishMaskRead === "function");
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishMaskRead());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#maskInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#maskInput").setInputFiles(mask);
  await expect(page.locator("#maskInfo")).toContainText("512 voxels");
});

for (const example of examples) {
  test(`example ${example.id} fits the tensor, refuses NODDI and downloads FA`, async ({ page }) => {
    test.setTimeout(180000);
    await page.goto("/");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("#fileInfo")).toContainText("dwi.nii.gz", { timeout: 120000 });
    await expect(page.locator("#fileInfo")).toContainText("20×b2500");
    await expect(page.locator("#fitNoddi")).toBeDisabled();
    await expect(page.locator("#noddiNote")).toBeVisible();
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Fitted", { timeout: 120000 });
    await expect(page.locator("#technicalLog")).toContainText(/MindGrab .+ brain mask on (cpu|webgpu|webgl2)/);
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(7);
    const event = page.waitForEvent("download");
    await page.locator("#resultList .nd-volume-toggle").first().getByRole("button", { name: "Download" }).click();
    const download = await event;
    expect(download.suggestedFilename()).toBe("dwi_model-tensor_param-fa_dwimap.nii.gz");
    const fa = await readDownload(download);
    const inMask = Array.from(fa.data).filter((value) => value > 0);
    expect(inMask.length).toBeGreaterThan(1000);
    // As FSL dtifit, FA is not clipped: a voxel with a negative eigenvalue (at the mask edge) can
    // exceed 1. A brain's FA is mostly between 0.1 and 0.6.
    const sorted = inMask.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    expect(median).toBeGreaterThan(0.1);
    expect(median).toBeLessThan(0.6);
    expect(sorted.filter((value) => value > 1).length / sorted.length).toBeLessThan(0.01);
  });
}

test("cancelling default MindGrab extraction permits a complete retry", async ({ page }) => {
  test.setTimeout(180000);
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
  await expect(page.locator("#statusText")).toContainText("Fitted", { timeout: 120000 });
  await expect(page.locator("#technicalLog")).toContainText(/MindGrab .+ brain mask on (cpu|webgpu|webgl2)/);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(7);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    // The retry downloads the real example, which can take longer than the 30 s default.
    test.setTimeout(150000);
    const example = examples[0];
    let attempts = 0;
    await page.context().route(dwiUrl, (route) => {
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

test("the automation operation fits the tensor and returns its maps", async ({ page }) => {
  const dwi = syntheticDwi({ shells: [1000] });
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(dwi.files);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles(syntheticMask({ value: 1 }));
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "mask" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("dti");
  expect(Object.keys(report.artifacts)).toContain("tensor-fa");
});
