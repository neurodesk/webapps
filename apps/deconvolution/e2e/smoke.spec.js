// Browser tests against the built app (vite preview). Every deconvolution the browser runs is
// compared byte for byte with the same WebAssembly module run in Node (src/reference.mjs) or
// with the hash recorded from it (e2e/expected.json).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readTiffStack, writeImageJTiff } from "@neurodesk/microscopy-tiff";
import { readVolume } from "../src/input.js";
import { deconvolveInNode, sha256 } from "../src/reference.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const [example] = examples;
const [exampleFile] = example.files;

const status = (page) => page.locator("#statusText");
const row = (page, text) => page.locator("#resultList .nd-volume-toggle", { hasText: text });

async function download(page, text) {
  const pending = page.waitForEvent("download");
  await row(page, text).locator(".nd-download-btn").click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

/** A small odd-sized stack of blurred points, and an off-centre measured PSF with an offset. */
function syntheticStack() {
  const dims = [9, 20, 17];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (const [z, y, x, v] of [[4, 6, 5, 900], [3, 13, 11, 600], [6, 10, 3, 400]]) {
    for (let k = 0; k < data.length; k += 1) {
      const zz = Math.floor(k / (dims[1] * dims[2]));
      const yy = Math.floor(k / dims[2]) % dims[1];
      const xx = k % dims[2];
      data[k] += v * Math.exp(-((zz - z) ** 2 / 2 + (yy - y) ** 2 / 3 + (xx - x) ** 2 / 3));
    }
  }
  for (let k = 0; k < data.length; k += 1) data[k] = Math.round(data[k] + 10);
  const psfDims = [7, 9, 11];
  const psf = new Float32Array(psfDims[0] * psfDims[1] * psfDims[2]);
  for (let k = 0; k < psf.length; k += 1) {
    const zz = Math.floor(k / (psfDims[1] * psfDims[2]));
    const yy = Math.floor(k / psfDims[2]) % psfDims[1];
    const xx = k % psfDims[2];
    psf[k] = 5 + 1000 * Math.exp(-((zz - 3) ** 2 / 1.5 + (yy - 4) ** 2 / 2 + (xx - 6) ** 2 / 2));
  }
  const spacingUm = { x: 0.1, y: 0.1, z: 0.25 };
  const file = (name, values, [nz, ny, nx]) => ({ name, mimeType: "image/tiff", buffer: Buffer.from(writeImageJTiff({ data: values, width: nx, height: ny, depth: nz, spacingUm })) });
  return { dims, data, psf, psfDims, spacingUm, image: file("points.tif", data, dims), psfFile: file("bead.tif", psf, psfDims) };
}

test("app boots on its workspace with the shared bar and cross-origin isolation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: "About Deconvolution", exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  const notice = await page.request.get(new URL("licenses/deconvolution-NOTICE.txt", page.url()).href);
  expect(notice.ok()).toBe(true);
  expect(await notice.text()).toContain("Sun Microsystems");
});

test("the example deconvolves to the Node reference and downloads calibrated TIFF and NIfTI", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText(`${exampleFile.name} · 256 × 256 × 41 · 0.06589 × 0.06589 × 0.13 µm`);
  await expect(page.locator("#modality")).toHaveValue("confocal");
  await expect(page.locator("#excitation")).toBeEnabled();
  await page.locator("#iterations").fill(String(expected.iterations));
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Stack deconvolved", { timeout: 240000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const tiff = await download(page, "Deconvolved · Richardson-Lucy");
  expect(tiff.name).toBe("hela-phalloidin488-confocal_deconvolved.tif");
  const stack = await readTiffStack(tiff.bytes);
  expect([stack.depth, stack.height, stack.width, stack.dtype]).toEqual([41, 256, 256, "float32"]);
  expect(stack.spacingUm.z).toBe(0.13);
  expect(stack.spacingUm.x).toBeCloseTo(0.0658941, 6);
  expect(sha256(stack.data)).toBe(expected.sha256);

  const nifti = await download(page, "Deconvolved (NIfTI)");
  expect(nifti.name).toBe("hela-phalloidin488-confocal_deconvolved.nii.gz");
  const raw = gunzipSync(nifti.bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  expect([1, 2, 3].map((i) => view.getInt16(40 + i * 2, true))).toEqual([256, 256, 41]);
  // Millimetres: 65.9 nm and 130 nm voxels, with millimetre units in xyzt_units.
  expect(view.getFloat32(80, true)).toBeCloseTo(6.58941e-5, 9);
  expect(view.getFloat32(88, true)).toBeCloseTo(1.3e-4, 9);
  expect(view.getUint8(123) & 7).toBe(2);
  const voxels = new Float32Array(raw.buffer.slice(raw.byteOffset + view.getFloat32(108, true), raw.byteOffset + raw.byteLength));
  expect(sha256(voxels)).toBe(expected.sha256);

  const psf = await readTiffStack((await download(page, "Gibson-Lanni PSF")).bytes);
  expect([psf.depth, psf.height, psf.width]).toEqual(expected.psfDims);
  expect(Math.max(...psf.data)).toBe(1);
});

test("cancelling a run stops it, leaves no outputs and allows another run", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#iterations").fill("400");
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText(/iteration [1-9]\d* of 400/, { timeout: 120000 });
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(status(page)).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#iterations").fill("1");
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Stack deconvolved", { timeout: 120000 });
  await expect(row(page, "Deconvolved · Richardson-Lucy, 1 iterations")).toHaveCount(1);
});

test("a failed example download is retried with the real, checksummed bytes", async ({ page }) => {
  test.setTimeout(150000);
  let failing = true;
  let failures = 0;
  let served = 0;
  // Fail every request until the app reports the error, so the downloader's own retries
  // (HTTP 429 only) cannot hide the failure; then let the pinned file through.
  await page.context().route(exampleFile.url, (route) => {
    if (failing) {
      failures += 1;
      return route.fulfill({ status: 503, body: "unavailable" });
    }
    served += 1;
    return route.fallback();
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  expect(failures).toBeGreaterThan(0);
  failing = false;
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("256 × 256 × 41");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(served).toBe(1);
});

test("a measured PSF on an odd-sized TIFF stack gives the Node result", async ({ page }) => {
  test.setTimeout(120000);
  const synthetic = syntheticStack();
  const volume = await readVolume(new File([synthetic.image.buffer], synthetic.image.name));
  const psfVolume = await readVolume(new File([synthetic.psfFile.buffer], synthetic.psfFile.name));
  const want = deconvolveInNode(volume, { measuredPsf: psfVolume, iterations: 3 });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(synthetic.image);
  await expect(page.locator("#fileInfo")).toContainText("points.tif · 17 × 20 × 9 · 0.1 × 0.1 × 0.25 µm");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#psfInput").setInputFiles(synthetic.psfFile);
  await expect(status(page)).toHaveText("The measured PSF bead.tif replaces the theoretical one");
  await expect(page.locator("#na")).toBeDisabled();
  await page.locator("#iterations").fill("3");
  await page.locator("#runButton").click();
  await expect(status(page)).toHaveText("Stack deconvolved", { timeout: 60000 });
  const stack = await readTiffStack((await download(page, "Deconvolved · Richardson-Lucy")).bytes);
  expect(sha256(stack.data)).toBe(sha256(want.estimate));
  const psf = await readTiffStack((await download(page, "Measured PSF · bead.tif")).bytes);
  expect([psf.depth, psf.height, psf.width]).toEqual(want.psfDims);
  // The bead peaks at (3, 4, 6); the largest odd box centred there is 7 × 9 × 9.
  expect(want.psfDims).toEqual([7, 9, 9]);
});

test("the automation operation runs RL-TV with its parameters and reports its artifacts", async ({ page }) => {
  test.setTimeout(120000);
  const synthetic = syntheticStack();
  const volume = await readVolume(new File([synthetic.image.buffer], synthetic.image.name));
  const optics = { modality: "widefield", na: 0.8, immersionIndex: 1.0, sampleIndex: 1.33, emissionNm: 600, excitationNm: 488, depthUm: 0 };
  const want = deconvolveInNode(volume, { spacingUm: { x: 0.2, y: 0.2, z: 0.5 }, optics, method: "rltv", iterations: 4, tvWeight: 0.01 });
  const parameters = { modality: "widefield", numericalAperture: 0.8, immersionIndex: 1.0, sampleIndex: 1.33, emissionNm: 600, voxelSizeXYUm: 0.2, voxelSizeZUm: 0.5, method: "rltv", iterations: 4, tvWeight: 0.01 };
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(synthetic.image);
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
  expect(report.report.provenance.method).toContain("total variation");
  expect(report.report.provenance.psf.numericalAperture).toBe(0.8);
  await expect(page.locator("#method")).toHaveValue("rltv");
  const pending = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "image" }));
  const stack = await readTiffStack(readFileSync(await (await pending).path()));
  expect(sha256(stack.data)).toBe(sha256(want.estimate));
});
