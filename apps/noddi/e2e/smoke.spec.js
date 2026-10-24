// Browser tests against `vite preview` of the production build: boot, the shared shell, the real
// tensor and NODDI fits in workers, the hosted example and its failure, retry and cancel paths.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { fitTensor } from "@neurodesk/dwi2trx";
import { parseBvalBvec } from "@neurodesk/dwi2trx/gradients";
import { runNiimath } from "@neurodesk/dwi2trx/runner";
import { MAPS, bidsStem, gradientText, mapName, maskName } from "@neurodesk/noddi/pipeline";
import { oversizedHeaderDwi, syntheticDwi, syntheticMask } from "./fixtures.mjs";
import { dropFolder, exampleBidsTree } from "../../../test-utils/bids-folder-drop.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const slab = examples.find((example) => example.id === "ds005134-slab");
const singleShell = examples.find((example) => example.id === "single-shell");
// The failure, retry and read-cancel tests use the first example, the multi-shell slab.
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
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
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

test("cancelling a niimath dtifit fit stops its worker and permits another fit", async ({ page, context }) => {
  // The first fit's niimath WASM download waits until the fit is cancelled, so the cancel
  // always reaches the dtifit worker while it runs.
  let requests = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // A route on the context also holds requests from the page's workers.
  await context.route(/niimath[^/]*\.wasm$/, async (route) => {
    requests += 1;
    if (requests === 1) await held;
    await route.continue().catch(() => {});
  });
  await page.goto("/");
  await loadWithMask(page, syntheticDwi({ shells: [1000] }));
  await page.locator("#tensorFit").selectOption("niimath-dtifit");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("niimath dtifit");
  await expect.poll(() => requests).toBe(1);
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  release();
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fitted", { timeout: 60000 });
  await expect(page.locator("#technicalLog")).toContainText("niimath dtifit on 32 of 32 volumes");
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

test("the multi-shell slab example fits the tensor and NODDI and downloads every map", async ({ page }) => {
  // MindGrab and the NODDI fit of about 46 000 voxels took 2 minutes on 8 cores.
  test.setTimeout(600000);
  expect(examples[0].id).toBe(slab.id);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(slab.id);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_dir-AP_desc-slab_dwi.nii.gz", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("13×b0, 12×b500, 48×b1000, 64×b2000");
  await expect(page.locator("#fitNoddi")).toBeEnabled();
  await expect(page.locator("#fitNoddi")).toBeChecked();
  await expect(page.locator("#noddiNote")).toBeHidden();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/Fitted \d+ voxels · 11 maps/, { timeout: 540000 });
  await expect(page.locator("#technicalLog")).toContainText(/MindGrab .+ brain mask on (cpu|webgpu|webgl2)/);
  await expect(page.locator("#technicalLog")).toContainText("Fitting tensor and NODDI");
  const rows = page.locator("#resultList .nd-volume-toggle");
  const labels = [...MAPS.tensor, ...MAPS.noddi].map((map) => map.label);
  await expect(rows).toHaveCount(labels.length + 1);
  for (const label of [...labels, "Brain mask"]) {
    await expect(rows.filter({ hasText: new RegExp(`^View${label}Download$`) })).toHaveCount(1);
  }
  const stem = bidsStem(slab.files.find((file) => file.role === "image").name);
  const download = async (label, name) => {
    const event = page.waitForEvent("download");
    await rows.filter({ hasText: new RegExp(`^View${label}Download$`) }).getByRole("button", { name: "Download" }).click();
    const file = await event;
    expect(file.suggestedFilename()).toBe(name);
    return readDownload(file);
  };
  const mask = await download("Brain mask", maskName(stem));
  expect(Array.from(mask.dims).slice(0, 3)).toEqual([67, 92, 10]);
  const inMask = Array.from(mask.data, (value) => value > 0);
  const brain = inMask.filter(Boolean).length;
  // MindGrab kept 45 965 of the slab's 61 640 voxels; the slab is the bounding box of a bet mask.
  expect(brain).toBeGreaterThan(30000);
  expect(brain).toBeLessThan(inMask.length);
  const masked = (map) => Array.from(map.data.subarray(0, inMask.length)).filter((_, i) => inMask[i]);
  const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
  const fa = masked(await download("FA", mapName(stem, "tensor", "fa")));
  expect(median(fa)).toBeGreaterThan(0.1);
  expect(median(fa)).toBeLessThan(0.6);
  // The NODDI fractions and ODI are bounded by the model. The measured medians in the mask are
  // ICVF 0.50 and ODI 0.37; ISOVF is 0 in a third of the mask.
  for (const [label, param, low, high] of [["ICVF", "icvf", 0.3, 0.7], ["ODI", "odi", 0.2, 0.6], ["ISOVF", "isovf", 0, 0.4]]) {
    const values = masked(await download(label, mapName(stem, "noddi", param)));
    expect(values.every((value) => value >= 0 && value <= 1), label).toBe(true);
    expect(median(values), label).toBeGreaterThanOrEqual(low);
    expect(median(values), label).toBeLessThan(high);
  }
  const direction = await download("NODDI direction", mapName(stem, "noddi", "direction"));
  expect(direction.frames).toBe(3);
  const voxels = inMask.length;
  const norms = inMask.flatMap((brainVoxel, i) => (brainVoxel
    ? [Math.hypot(direction.data[i], direction.data[voxels + i], direction.data[2 * voxels + i])]
    : []));
  expect(norms.filter((norm) => Math.abs(norm - 1) < 1e-4).length / norms.length).toBeGreaterThan(0.99);
});

test("the single-shell example fits the tensor, refuses NODDI and downloads FA", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(singleShell.id);
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

test("cancelling default MindGrab extraction permits a complete retry", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  // The single-shell example keeps the retry's fit short; the slab test runs MindGrab to the end.
  await page.locator("select[data-neurodesk-example]").selectOption(singleShell.id);
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
  expect(report.provenance.tensorFit).toBe("wls");
  expect(report.provenance.niimath).toBeNull();
  expect(Object.keys(report.artifacts)).toContain("tensor-fa");
});

test("the automation operation fits with niimath dtifit and NODDI, and names the fit", async ({ page }) => {
  const dwi = syntheticDwi();
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(dwi.files);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles(syntheticMask({ value: 1 }));
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "mask" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { tensorFit: "niimath-dtifit" } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 120000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("dti+noddi-amico");
  expect(report.provenance.tensorFit).toBe("niimath-dtifit");
  expect(report.provenance.niimath).toMatch(/^\d+\.\d+\.\S+$/);
  expect(Object.keys(report.artifacts)).toEqual(expect.arrayContaining(["tensor-fa", "tensor-rd", "tensor-direction", "noddi-icvf"]));
  await expect(page.locator("#technicalLog")).toContainText("niimath dtifit on 32 of 62 volumes");
});

test("example with niimath dtifit downloads FA and MD equal to DWI2TRX's fit of the same gradients and mask", async ({ page, request }) => {
  test.setTimeout(240000);
  const example = singleShell;
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#tensorFit").selectOption("niimath-dtifit");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fitted", { timeout: 180000 });
  await expect(page.locator("#technicalLog")).toContainText("niimath dtifit on 21 of 21 volumes");
  const rows = page.locator("#resultList .nd-volume-toggle");
  await expect(rows).toHaveCount(7);
  const download = async (label) => {
    const event = page.waitForEvent("download");
    await rows.filter({ hasText: new RegExp(`^View${label}Download$`) }).getByRole("button", { name: "Download" }).click();
    const file = await event;
    return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
  };
  const fa = await download("FA");
  const md = await download("MD");
  const mask = await download("Brain mask");
  expect(fa.name).toBe("dwi_model-tensor_param-fa_dwimap.nii.gz");
  expect(md.name).toBe("dwi_model-tensor_param-md_dwimap.nii.gz");
  // DWI2TRX's fit (@neurodesk/dwi2trx in Node) of the example image with the app's brain mask.
  const files = {};
  for (const file of example.files) files[file.role] = await (await request.get(file.url)).body();
  // The app gives niimath unit bvecs and -xflip 0 (see gradientText), so the reference does too.
  const { bvals, bvecs } = parseBvalBvec(files.bval.toString(), files.bvec.toString());
  const text = gradientText(bvals, bvecs, bvals.map((_, i) => i));
  const reference = await fitTensor(runNiimath, { dwi: files.image, bval: Buffer.from(text.bval), bvec: Buffer.from(text.bvec), mask: mask.bytes, xflip: "0" });
  const values = (bytes) => readNiftiFrames(gunzipSync(bytes)).data;
  expect(values(fa.bytes)).toEqual(values(reference.FA));
  expect(values(md.bytes)).toEqual(values(reference.MD));
  expect(values(fa.bytes).filter((value) => value > 0).length).toBeGreaterThan(1000);
});

test("a dropped BIDS folder fits the tensor to the chosen run", async ({ page }) => {
  test.setTimeout(180000);
  const tree = await exampleBidsTree(page.request, singleShell, { runs: 2 });
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.getByRole("combobox", { name: "DWI run" })).toBeHidden();
  await dropFolder(page, tree);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-1_dwi.nii.gz", { timeout: 120000 });
  const runs = page.getByRole("combobox", { name: "DWI run" });
  await expect(runs.locator("option")).toHaveText(["sub-01_run-1_dwi", "sub-01_run-2_dwi"]);
  await runs.selectOption({ label: "sub-01_run-2_dwi" });
  await expect(page.locator("#fileInfo")).toHaveText("sub-01_run-2_dwi.nii.gz · 1×b0, 20×b2500", { timeout: 120000 });
  await expect(page.locator("#fitNoddi")).toBeDisabled();
  // Undo after another drop gives back the folder with the chosen run, not its first run.
  const other = Object.fromEntries(["nii.gz", "bval", "bvec"].map((ext) => [`ds/sub-01/dwi/sub-01_dwi.${ext}`, tree[`ds/sub-01/dwi/sub-01_run-1_dwi.${ext}`]]));
  await dropFolder(page, other);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_dwi.nii.gz", { timeout: 60000 });
  await expect(runs).toBeHidden();
  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-2_dwi.nii.gz", { timeout: 60000 });
  await expect(runs).toHaveValue("1");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fitted", { timeout: 120000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(7);
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: /^ViewFADownload$/ }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe(mapName("sub-01_run-2", "tensor", "fa"));
  const fa = await readDownload(download);
  expect(Array.from(fa.data).filter((value) => value > 0).length).toBeGreaterThan(1000);
});

test("a BIDS run without its gradient tables shows as a disabled choice", async ({ page }) => {
  const tree = await exampleBidsTree(page.request, singleShell, { runs: 2 });
  delete tree["ds/sub-01/dwi/sub-01_run-1_dwi.bval"];
  delete tree["ds/sub-01/dwi/sub-01_run-1_dwi.bvec"];
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await dropFolder(page, tree);
  await expect(page.locator("#fileInfo")).toContainText("sub-01_run-2_dwi.nii.gz", { timeout: 120000 });
  const runs = page.getByRole("combobox", { name: "DWI run" });
  await expect(runs.locator("option")).toHaveText(["sub-01_run-1_dwi (no .bval, .bvec)", "sub-01_run-2_dwi"]);
  await expect(runs.locator("option:disabled")).toHaveText(["sub-01_run-1_dwi (no .bval, .bvec)"]);
  await expect(runs).toHaveValue("1");
});


test("the nonlinear dmipy option fits in workers and downloads bounded NODDI fractions", async ({ page }) => {
  test.setTimeout(120000);
  const dwi = syntheticDwi({ size: 4, directions: 12 });
  await page.goto("/");
  await loadWithMask(page, dwi, 4);
  await expect(page.locator("#noddiMethod")).toHaveValue("amico");
  await page.locator("#noddiMethod").selectOption("dmipy");
  await page.locator("#fitNoddi").uncheck();
  await expect(page.locator("#noddiMethod")).toBeDisabled();
  await expect(page.locator("#noddiMethod")).toHaveValue("dmipy");
  await page.locator("#fitNoddi").check();
  await expect(page.locator("#noddiMethod")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("11 maps", { timeout: 90000 });
  await expect(page.locator("#technicalLog")).toContainText(/Nonlinear NODDI: \d+ fitted, \d+ skipped, \d+ nonconverged, \d+ failed/);
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "ICVF" }).getByRole("button", { name: "Download" }).click();
  const volume = await readDownload(await event);
  expect(volume.dims).toEqual([4, 4, 4]);
  expect(Array.from(volume.data).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  expect(Array.from(volume.data).some((value) => value > 0)).toBe(true);
});

test("automation selects nonlinear dmipy and records voxel diagnostics", async ({ page }) => {
  test.setTimeout(120000);
  const dwi = syntheticDwi({ size: 4, directions: 12 });
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(dwi.files);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles(syntheticMask({ size: 4, value: 1 }));
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "mask" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { method: "dmipy" } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 90000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("dti+noddi-dmipy");
  expect(report.provenance.noddiDiagnostics.fitted).toBeGreaterThan(0);
  for (const name of ["skipped", "nonconverged", "failed"]) expect(report.provenance.noddiDiagnostics[name]).toBeGreaterThanOrEqual(0);
  expect(Object.keys(report.artifacts)).toEqual(expect.arrayContaining(["tensor-fa", "noddi-icvf", "noddi-isovf", "noddi-odi"]));
});
