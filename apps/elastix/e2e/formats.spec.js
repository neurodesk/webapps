// OME-Zarr and TIFF inputs, local and remote, on a synthetic 2D pair with a
// known shift: the recovered translation and the registered image are checked
// against that ground truth, not against the app's own output.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ncc, readVolume } from "../../../test-utils/registration-similarity.mjs";
import { fixedPixels, movingPixels, pyramidalTiff, SHIFT_PX, SPACING, syntheticPair, totalTranslation } from "./fixtures.mjs";
import { memoryStoreToZip } from "@fideus-labs/ngff-zarr";
import { readTransformArchive } from "./ome-zarr-transform.mjs";

const pair = await syntheticPair();
const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));
const REMOTE = "https://images.example.org";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-range, content-length, accept-ranges",
  "cross-origin-resource-policy": "cross-origin",
};

// An OME-Zarr folder served key by key; missing keys are 404 as on a real server.
async function serveZarr(page, role) {
  const prefix = `${REMOTE}/${role}.ome.zarr/`;
  await page.route(`${prefix}**`, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const bytes = pair[role].store.get(route.request().url().slice(prefix.length));
    return bytes ? route.fulfill({ body: Buffer.from(bytes), headers: cors }) : route.fulfill({ status: 404, headers: cors });
  });
  return prefix;
}

// A TIFF served by HTTP range request, as object stores and static hosts do.
async function serveTiff(page, role, requests) {
  const url = `${REMOTE}/${role}.ome.tif`;
  const bytes = pair[role].tiff;
  await page.route(url, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    if (!range) return route.fulfill({ body: bytes, headers: { ...cors, "accept-ranges": "bytes" } });
    requests.push(range[0]);
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
    return route.fulfill({
      status: 206,
      body: bytes.subarray(start, end + 1),
      headers: { ...cors, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  });
  return url;
}

async function download(page, label) {
  const row = page.locator("#resultList .nd-volume-toggle").filter({ hasText: label });
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), row.getByRole("button", { name: "Download" }).click()]);
  return readFile(await file.path());
}

async function registerRigidAndCheck(page) {
  await page.locator("#method").selectOption("rigid");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 240_000 });
  const registered = await readVolume(await download(page, "Registered NIfTI"));
  expect(registered.dims.slice(0, 2)).toEqual([128, 128]);
  const before = ncc(Float32Array.from(movingPixels), Float32Array.from(fixedPixels));
  const after = ncc(registered.data, Float32Array.from(fixedPixels));
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(before).toBeLessThan(0.8);
  expect(after).toBeGreaterThan(0.98);
  const texts = [];
  for (const label of ["TransformParameters.0.toml", "TransformParameters.1.toml"]) texts.push((await download(page, label)).toString("utf8"));
  const [tx, ty] = totalTranslation(texts);
  test.info().annotations.push({ type: "translation", description: `${tx.toFixed(3)}, ${ty.toFixed(3)}` });
  expect(Math.abs(tx - SHIFT_PX[0] * SPACING)).toBeLessThan(0.5 * SPACING);
  expect(Math.abs(ty - SHIFT_PX[1] * SPACING)).toBeLessThan(0.5 * SPACING);
  // The OME-Zarr transform is one affine on (y, x): identity plus the shift.
  const { transformation } = await readTransformArchive(await download(page, "Transform (OME-Zarr)"));
  expect(transformation.type).toBe("affine");
  const [[a, b, y], [c, d, x]] = transformation.affine;
  [a - 1, b, c, d - 1].forEach((value) => expect(Math.abs(value)).toBeLessThan(0.01));
  expect(Math.abs(x - SHIFT_PX[0] * SPACING)).toBeLessThan(0.5 * SPACING);
  expect(Math.abs(y - SHIFT_PX[1] * SPACING)).toBeLessThan(0.5 * SPACING);
}

test("local OME-Zarr archives register and the result reopens as OME-Zarr", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  await page.locator("#movingInput").setInputFiles({ name: "moving.ome.zarr.ozx", mimeType: "application/zip", buffer: pair.moving.ozx });
  await expect(page.locator("#movingInfo")).toContainText("moving.ome.zarr.ozx · 128×128 uint16 · pyramid level 1 of 1");
  await page.locator("#stationaryInput").setInputFiles({ name: "fixed.ome.zarr.ozx", mimeType: "application/zip", buffer: pair.fixed.ozx });
  await expect(page.locator("#stationaryInfo")).toContainText("fixed.ome.zarr.ozx");
  await expect(page.locator(".nd-view-tab[aria-pressed='true']")).toHaveText("Axial");
  await registerRigidAndCheck(page);
  const zarr = await download(page, "Registered OME-Zarr");
  await page.locator("#movingInput").setInputFiles({ name: "moving_registered.ome.zarr.ozx", mimeType: "application/zip", buffer: zarr });
  await expect(page.locator("#movingInfo")).toContainText("moving_registered.ome.zarr.ozx · 128×128 float32");
});

test("local OME-TIFF files register", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  await page.locator("#movingInput").setInputFiles({ name: "moving.ome.tif", mimeType: "image/tiff", buffer: pair.moving.tiff });
  await expect(page.locator("#movingInfo")).toContainText("moving.ome.tif · 128×128 uint16");
  await page.locator("#stationaryInput").setInputFiles({ name: "fixed.ome.tif", mimeType: "image/tiff", buffer: pair.fixed.tiff });
  await expect(page.locator("#stationaryInfo")).toContainText("fixed.ome.tif");
  await registerRigidAndCheck(page);
});

// fiff before 0.8.2 could not read SubIFD levels with geotiff 3.
test("a pyramidal OME-TIFF opens with its SubIFD levels", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stationaryInput")).toBeEnabled();
  await page.locator("#stationaryInput").setInputFiles({ name: "pyramid.ome.tif", mimeType: "image/tiff", buffer: await pyramidalTiff() });
  await expect(page.locator("#stationaryInfo")).toHaveText("pyramid.ome.tif · 128×128 uint16 · pyramid level 1 of 2");
});

test("a remote OME-Zarr folder and a remote TIFF read by range request register", async ({ page }) => {
  test.setTimeout(300_000);
  const ranges = [];
  const movingUrl = await serveZarr(page, "moving");
  const fixedUrl = await serveTiff(page, "fixed", ranges);
  await page.goto("/");
  await expect(page.locator("#urlButton")).toBeEnabled();
  await page.locator("#urlSection > summary").click();
  await page.locator("#movingUrl").fill(movingUrl);
  await page.locator("#stationaryUrl").fill(fixedUrl);
  await page.locator("#urlButton").click();
  await expect(page.locator("#statusText")).toHaveText("Opened moving and stationary image URLs.");
  await expect(page.locator("#movingInfo")).toContainText("moving.ome.zarr · 128×128 uint16");
  await expect(page.locator("#stationaryInfo")).toContainText("fixed.ome.tif · 128×128 uint16");
  expect(ranges.length).toBeGreaterThan(0);
  await registerRigidAndCheck(page);
});

test("a 2D image and a 3D image are refused before registration", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  await page.locator("#movingInput").setInputFiles({ name: "moving.ome.zarr.ozx", mimeType: "application/zip", buffer: pair.moving.ozx });
  await expect(page.locator("#movingInfo")).toBeVisible();
  await page.locator("#stationaryInput").setInputFiles({ name: "volume.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#stationaryInfo")).toBeVisible();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("The moving image is 2D and the stationary image is 3D; choose two 2D or two 3D images.");
  await expect(page.locator("#resultList")).toBeEmpty();
});

test("an unreachable URL shows an error and keeps the URL controls usable", async ({ page }) => {
  await page.route(`${REMOTE}/missing.ome.zarr/**`, (route) => route.fulfill({ status: 404, headers: cors }));
  await page.goto("/");
  await expect(page.locator("#urlButton")).toBeEnabled();
  await page.locator("#urlSection > summary").click();
  await page.locator("#movingUrl").fill(`${REMOTE}/missing.ome.zarr/`);
  await page.locator("#urlButton").click();
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#movingInfo")).toBeHidden();
  await expect(page.locator("#urlButton")).toBeEnabled();
});

test("cancelling a remote TIFF read retains the selected image and permits a fresh import", async ({ page }) => {
  await page.addInitScript(() => {
    window.createdWorkers = [];
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(url, options) {
        super(url, options);
        window.createdWorkers.push(String(url));
      }
    };
  });
  const url = `${REMOTE}/cancelled.ome.tif`;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  await page.route(url, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    started();
    await pending;
    const bytes = pair.moving.tiff;
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    await route.fulfill({ status: range ? 206 : 200, body: bytes.subarray(start, end + 1), headers: {
      ...cors, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}`,
    } });
  });
  await page.goto("/");
  await page.locator("#movingInput").setInputFiles({ name: "selected.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#movingInfo")).toContainText("selected.nii.gz");
  const selected = await page.locator("#movingInfo").textContent();
  const inputValue = await page.locator("#movingInput").inputValue();
  await page.locator("#urlSection > summary").click();
  await page.locator("#movingUrl").fill(url);
  await page.locator("#urlButton").click();
  await reading;
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toContainText(/cancelled/i);
  const workersAfterCancel = await page.evaluate(() => window.createdWorkers.length);
  release();
  // fiff 0.8.2 cannot abort its metadata fetch. Let that read finish after cancel.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.createdWorkers.length)).toBe(workersAfterCancel);
  await expect(page.locator("#movingInfo")).toHaveText(selected);
  await expect(page.locator("#movingInput")).toHaveJSProperty("value", inputValue);
  await expect(page.locator("#movingUrl")).toHaveValue(url);
  const retry = await serveZarr(page, "moving");
  await page.locator("#movingUrl").fill(retry);
  await page.locator("#urlButton").click();
  await expect(page.locator("#statusText")).toHaveText("Opened moving image URL.");
  await expect(page.locator("#movingInfo")).toContainText("moving.ome.zarr · 128×128 uint16");
});


test("an identity transform exports on a tiny OME-Zarr grid far from the origin", async ({ page }) => {
  const store = new Map(pair.fixed.store);
  const root = JSON.parse(new TextDecoder().decode(store.get("zarr.json")));
  root.attributes.ome.multiscales[0].datasets[0].coordinateTransformations = [
    { type: "scale", scale: [1e-5 / 127, 1e-5 / 127] },
    { type: "translation", translation: [1000, 1000] },
  ];
  store.set("zarr.json", new TextEncoder().encode(JSON.stringify(root)));
  const bytes = Buffer.from(memoryStoreToZip(store));
  await page.goto("/");
  for (const role of ["moving", "stationary"]) {
    await page.locator(`#${role}Input`).setInputFiles({ name: `${role}.ozx`, mimeType: "application/zip", buffer: bytes });
    await expect(page.locator(`#${role}Info`)).toContainText(`${role}.ozx`);
  }
  const parameters = (await readFile(new URL("fixtures/parameters_Rigid.txt", import.meta.url), "utf8"))
    .replace('(MaximumNumberOfIterations 100)', '(MaximumNumberOfIterations 0)');
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#parameterInput").setInputFiles({ name: "identity.txt", mimeType: "text/plain", buffer: Buffer.from(parameters) });
  await expect(page.locator("#parameterInfo")).toContainText("EulerTransform");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete");
  const { transformation } = await readTransformArchive(await download(page, "Transform (OME-Zarr)"));
  expect(transformation.type).toBe("affine");
  expect(transformation.affine.flat().every(Number.isFinite)).toBe(true);
  for (const point of [[1000, 1000], [1000.00001, 1000.00001], [1000.0000037, 1000.0000081]]) {
    transformation.affine.forEach((row, axis) => {
      const mapped = row[0] * point[0] + row[1] * point[1] + row[2];
      expect(Math.abs(mapped - point[axis])).toBeLessThan(1e-9);
    });
  }
});
