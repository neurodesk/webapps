// Browser e2e tests against the built Denoise app (vite preview).
// Verifies workspace boot, real pinned example denoising byte-for-byte against Node,
// cancellation during fetch and run, failed download recovery, Undo after rejected files,
// inactive field isolation, all denoising methods, and WebMCP automation.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readTiffStack as readTiff } from "@neurodesk/webapp-components/file-io/tiff";
import { stackNifti, stackTiff } from "../src/config.js";
import { denoiseVolume } from "../src/core/denoise.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import { readVolume } from "../src/input.js";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const [firstExample] = examples;
const [firstFile] = firstExample.files;

const status = (page) => page.locator("#statusText");
const row = (page, text) => page.locator("#resultList .nd-volume-toggle", { hasText: text });

function sha256(typedArray) {
  return createHash("sha256")
    .update(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength))
    .digest("hex");
}

async function readTiffStack(bytes) {
  const stack = await readTiff(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return {
    dims: [stack.pages, stack.height, stack.width],
    dtype: stack.dtype,
    data: stack.data,
    spacingUm: stack.metadata.pixelSize,
  };
}

async function download(page, text) {
  const pending = page.waitForEvent("download");
  await row(page, text).locator(".nd-download-btn").click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

function syntheticNoisy2d(ny = 48, nx = 48, seed = 91, spacingUm = { x: 0.15, y: 0.25, z: 0.3 }) {
  const randn = createNormalRng(createRng(seed));
  const clean = new Float32Array(ny * nx);
  const noisy = new Float32Array(ny * nx);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const s = 30 + 210 * Math.exp(-((y - ny / 2) ** 2 + (x - nx / 2) ** 2) / 90);
      clean[y * nx + x] = s;
      noisy[y * nx + x] = Math.max(0, s + 22 * randn());
    }
  }
  const dims = [1, ny, nx];
  return {
    dims,
    clean,
    noisy,
    spacingUm,
    tiff: { name: "noisy-cells.tif", mimeType: "image/tiff", buffer: Buffer.from(stackTiff(noisy, dims, spacingUm)) },
    nifti: { name: "noisy-cells.nii", mimeType: "application/octet-stream", buffer: Buffer.from(stackNifti(noisy, dims, spacingUm)) },
  };
}

test("app boots on its workspace with the shared bar, About dialog and cross-origin isolation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: "About Denoise", exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("the 2D nuclei example denoises byte-for-byte with Node and downloads TIFF, NIfTI and residual", async ({ page }) => {
  test.setTimeout(180000);
  let exampleBytes = null;
  await page.context().route(firstFile.url, async (route) => {
    const response = await route.fetch();
    exampleBytes = await response.body();
    await route.fulfill({ response, body: exampleBytes });
  });

  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(firstExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText(`${firstFile.name} · 512 × 512 (2D)`);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Image denoised", { timeout: 120000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  expect(exampleBytes).not.toBeNull();
  const inputVol = await readVolume(new File([exampleBytes], firstFile.name, { type: "image/tiff" }));
  const want = denoiseVolume(inputVol.data, inputVol.dims);

  const tiff = await download(page, "Denoised · Aydin FGR-GBDT");
  expect(tiff.name).toBe("dsb2018-nuclei-2d_denoised.tif");
  const tiffStack = await readTiffStack(tiff.bytes);
  expect([...tiffStack.dims, tiffStack.dtype]).toEqual([1, 512, 512, "float32"]);
  expect(sha256(tiffStack.data)).toBe(sha256(want.denoised));

  const nifti = await download(page, "Denoised (NIfTI)");
  expect(nifti.name).toBe("dsb2018-nuclei-2d_denoised.nii.gz");
  const raw = gunzipSync(nifti.bytes);
  const offset = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat32(108, true);
  const voxels = new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.byteLength));
  expect(sha256(voxels)).toBe(sha256(want.denoised));

  const residual = await download(page, "Noise residual");
  expect(residual.name).toBe("dsb2018-nuclei-2d_residual.tif");
  const residualStack = await readTiffStack(residual.bytes);
  expect(sha256(residualStack.data)).toBe(sha256(want.residual));
  expect(want.diagnostics.denoisedNoiseSigma).toBeLessThan(want.diagnostics.inputNoiseSigma);
});

test("delayed example fetch locks Run, keeps one Cancel control, and accepts a canvas drop replacement", async ({ page }) => {
  test.setTimeout(120000);
  const sampleA = syntheticNoisy2d(32, 32, 11);
  const sampleB = syntheticNoisy2d(24, 28, 29);
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    page.context().route(firstFile.url, async (route) => {
      resolve();
      await new Promise((done) => { releaseFetch = done; });
      await route.abort("failed");
    });
  });

  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(sampleA.tiff);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(firstExample.id);
  await fetchStarted;
  await expect(page.locator("#runButton")).toBeDisabled();
  // Sidebar example selector provides the single Cancel control; footer Cancel stays hidden during example fetch.
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("[data-neurodesk-examples] button", { hasText: "Cancel" })).toBeVisible();

  // Dropping a replacement file onto the canvas during a delayed example fetch cancels the fetch and loads it.
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "replacement.tif", { type: "image/tiff" }));
    document.getElementById("gl1").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, Array.from(sampleB.tiff.buffer));
  releaseFetch?.();
  await expect(page.locator("#fileInfo")).toContainText("replacement.tif · 28 × 24 (2D)", { timeout: 30000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("Undo to empty after a rejected initial upload clears the viewer and status without errors", async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sample = syntheticNoisy2d(24, 24, 33);

  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({ name: "bad.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("nope") });
  await expect(status(page)).toContainText("not a TIFF or NIfTI file");

  // Drop a valid NIfTI onto the page so the shell offers Undo back to the empty state.
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "valid.nii", { type: "application/octet-stream" }));
    document.getElementById("gl1").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, Array.from(sample.nifti.buffer));
  await expect(page.locator("#fileInfo")).toContainText("valid.nii · 24 × 24 (2D)", { timeout: 30000 });
  await expect(page.locator("#emptyState")).toBeHidden();
  await expect(page.locator(".nd-status-undo")).toBeVisible();

  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#emptyState")).toBeVisible();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(status(page)).toHaveText("Drag and drop files");
  expect(errors).toEqual([]);
});

test("2D+T millisecond NIfTI movie preserves all frames and time units, and rank-2 NIfTI renders cleanly", async ({ page }) => {
  test.setTimeout(120000);
  const dims = [3, 12, 12];
  const randn = createNormalRng(createRng(61));
  const movie = Float32Array.from({ length: 3 * 12 * 12 }, (_, i) => 50 + (i % 12) * 5 + 8 * randn());
  const movieBuf = stackNifti(movie, dims, { x: 0.2, y: 0.2, z: 1 }, { axisKind: "t", frameInterval: 250 });
  new DataView(movieBuf).setUint8(123, 2 | 16); // mm + ms

  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({
    name: "timelapse.nii",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(movieBuf),
  });
  await expect(page.locator("#fileInfo")).toContainText("timelapse.nii · 12 × 12 × 3 frames · 0.2 × 0.2 µm · 0.25 s/frame");
  await page.locator("#method").selectOption("fgr-ridge");
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Image denoised", { timeout: 60000 });

  const nifti = await download(page, "Denoised (NIfTI)");
  const raw = gunzipSync(nifti.bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  expect(view.getInt16(40, true)).toBe(4);
  expect(view.getInt16(46, true)).toBe(1);
  expect(view.getInt16(48, true)).toBe(3);
  const offset = view.getFloat32(108, true);
  const voxels = new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.byteLength));
  expect(voxels.length).toBe(432);

  // Rank-2 NIfTI with dim[3] === 0 must render cleanly in NiiVue and allow denoising.
  const plane = Float32Array.from({ length: 16 * 16 }, (_, i) => 20 + (i % 16) * 4 + 5 * randn());
  const rank2Buf = stackNifti(plane, [1, 16, 16], { x: 0.5, y: 0.5, z: 1 });
  const r2View = new DataView(rank2Buf);
  r2View.setInt16(40, 2, true);
  r2View.setInt16(46, 0, true);
  await page.locator("#imageInput").setInputFiles({
    name: "rank2.nii",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(rank2Buf),
  });
  await expect(page.locator("#fileInfo")).toContainText("rank2.nii · 16 × 16 (2D)");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Image denoised", { timeout: 60000 });
});

test("cancelling a long run stops it cleanly, leaves no outputs and allows a subsequent run", async ({ page }) => {
  test.setTimeout(180000);
  const sample = syntheticNoisy2d(64, 64, 19);
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(sample.tiff);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#method").selectOption("zs-n2n");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#iterations").fill("1200");
  await page.locator("#channels").fill("32");
  await page.locator("#runButton").click();

  await expect(page.locator("#cancelButton")).toBeVisible({ timeout: 30000 });
  await expect(status(page)).toHaveText(/Training ZS-N2N/, { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(status(page)).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#method").selectOption("fgr-ridge");
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Image denoised", { timeout: 60000 });
  await expect(row(page, "Denoised · Aydin FGR-Ridge")).toHaveCount(1);
});

test("a failed example download recovers on retry with the real checksummed bytes", async ({ page }) => {
  test.setTimeout(120000);
  let failing = true;
  let failures = 0;
  let served = 0;
  await page.context().route(firstFile.url, (route) => {
    if (failing) {
      failures += 1;
      return route.fulfill({ status: 503, body: "unavailable" });
    }
    served += 1;
    return route.fallback();
  });

  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(firstExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  expect(failures).toBeGreaterThan(0);

  failing = false;
  await picker.selectOption(firstExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("512 × 512");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(served).toBe(1);
});

test("anisotropic spacing, disabled-field isolation, rejected file recovery and VST-NLM work cleanly", async ({ page }) => {
  test.setTimeout(120000);
  const sample = syntheticNoisy2d(48, 48, 55, { x: 0.15, y: 0.25, z: 0.3 });
  const want = denoiseVolume(sample.noisy, sample.dims, { method: "vst-nlm", noiseModel: "gaussian", nlmStrength: 1.1 });

  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(sample.nifti);
  await expect(page.locator("#fileInfo")).toContainText("noisy-cells.nii · 48 × 48 (2D) · 0.15 × 0.25 µm");

  // Rejecting an invalid file keeps the previous valid input loaded.
  await page.locator("#imageInput").setInputFiles({ name: "bad.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("nope") });
  await expect(status(page)).toContainText("not a TIFF or NIfTI file");
  await expect(page.locator("#fileInfo")).toContainText("noisy-cells.nii");
  await expect(page.locator("#runButton")).toBeEnabled();

  // Clearing a GBDT-only field (#nTrees) must not block switching to VST-NLM.
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#nTrees").fill("");
  await page.locator("#method").selectOption("vst-nlm");
  await page.locator("#noiseModel").selectOption("gaussian");
  await page.locator("#nlmStrength").fill("1.1");
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Image denoised", { timeout: 60000 });

  const tiff = await download(page, "Denoised · VST-NLM");
  const stack = await readTiffStack(tiff.bytes);
  expect(sha256(stack.data)).toBe(sha256(want.denoised));
});

test("the WebMCP automation operation runs ZS-N2N with parameters and returns replayable provenance", async ({ page }) => {
  test.setTimeout(120000);
  const sample = syntheticNoisy2d(32, 32, 77);
  const parameters = { method: "zs-n2n", iterations: 60, channels: 16, seed: 11 };
  const want = denoiseVolume(sample.noisy, sample.dims, parameters);

  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(sample.tiff);
  const report = await page.evaluate(async (params) => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: params });
    for (;;) {
      const snapshot = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (!["queued", "running"].includes(snapshot.state)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, parameters);

  expect(report.state).toBe("succeeded");
  expect(report.report.provenance.methodId).toBe("zs-n2n");
  expect(report.report.provenance.settings).toEqual(parameters);
  await expect(page.locator("#method")).toHaveValue("zs-n2n");

  const pending = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "image" }));
  const stack = await readTiffStack(readFileSync(await (await pending).path()));
  expect(sha256(stack.data)).toBe(sha256(want.denoised));
});
