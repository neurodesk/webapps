// Browser tests against `vite preview` of the production build: the shared shell, both pinned
// examples through analysis and download against the scipy reference and the known synthetic
// directions, TIFF and NIfTI inputs, refusals, cancellation, the example's failure and retry
// paths, and the automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { compareExample } from "../validation/check-example.mjs";
import { DOMAINS } from "../scripts/make-synthetic-example.mjs";
import { direction, axisAngle } from "../test/synthetic.mjs";
import {
  angleDifference,
  cylindersNifti,
  exampleBytes,
  examples,
  gratingTiff,
  readNiftiFloat32,
  readTiffBytes,
  reference,
  sha256,
} from "./fixtures.mjs";
import { buildTiff, omeXml } from "../test/tiff-fixtures.mjs";
import { writeTiff } from "../src/tiff.js";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const [shg, synthetic] = examples;

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

async function run(page) {
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Orientation maps ready", { timeout: 120000 });
}

test("app boots on the workspace with the run button disabled", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("shared app bar owns About, with the method and its conventions, and the theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator('dialog[data-dialog="about"]');
  await expect(about).toBeVisible();
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  for (const guidance of ["OrientationJ", "counterclockwise", "(λ2 − λ3) / (λ2 + λ3)", "at least one voxel", "PSHG-TISS"]) {
    await expect(about).toContainText(guidance);
  }
  await about.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("the SHG example gives the scipy reference's maps, distribution and dominant direction", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(shg.id);
  await expect(page.locator("#fileInfo")).toHaveText(`${shg.files[0].name} · 2D 512 × 512`, { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  const started = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#statusText")).toHaveText("Orientation maps ready", { timeout: 120000 });
  await stopped;
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(7);
  const base = "skin12_shg_polarisation_sum";
  const maps = {};
  for (const [key, label] of [["orientation", "Orientation (degrees)"], ["coherency", "Coherency"], ["energy", "Energy"]]) {
    const map = await downloadRow(page, label);
    expect(map.name).toBe(`${base}_${key}.tif`);
    const image = await readTiffBytes(map.bytes);
    expect(image.dims).toEqual([512, 512, 1]);
    maps[key] = image.data;
  }
  // Float32 maps of float64 sums: equal to the reference at float32 precision.
  const difference = compareExample(maps);
  expect(difference.angle).toBeLessThan(1e-4);
  expect(difference.coherence).toBeLessThan(1e-6);
  expect(difference.power).toBeLessThan(1e-6);
  const csv = await downloadRow(page, "Orientation distribution");
  expect(csv.name).toBe(`${base}_distribution.csv`);
  const rows = csv.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("quantity,bin_low_deg,bin_high_deg,count,fraction");
  expect(rows.slice(1).map((row) => Number(row.split(",")[3]))).toEqual(reference.example.histogram);
  const summary = JSON.parse((await downloadRow(page, "Summary")).bytes.toString("utf8"));
  expect(Math.abs(angleDifference(summary.dominant.orientation, reference.example.dominant.orientation))).toBeLessThan(1e-9);
  expect(summary.countedVoxels).toBe(reference.example.counted);
  expect(summary.settings).toEqual(reference.example.settings);
  const colour = await downloadRow(page, "Colour survey (HSB)");
  expect(colour.name).toBe(`${base}_hsb.png`);
  expect(colour.bytes.subarray(1, 4).toString()).toBe("PNG");
  await expect(page.locator("#technicalLog")).toContainText(`Dominant orientation ${Number(reference.example.dominant.orientation.toFixed(2))}°`);
  // The input row views and downloads the image as loaded.
  const input = await downloadRow(page, "Input image");
  expect(sha256(input.bytes)).toBe(shg.files[0].sha256);
});

test("the synthetic 3D example recovers both fibre domains and writes the direction map", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(synthetic.id);
  await expect(page.locator("#fileInfo")).toHaveText(`${synthetic.files[0].name} · 3D 64 × 64 × 32 · 1 × 1 × 1 micron`, { timeout: 120000 });
  await run(page);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(9);
  const azimuth = await readTiffBytes((await downloadRow(page, "Azimuth (degrees)")).bytes);
  const elevation = await readTiffBytes((await downloadRow(page, "Elevation (degrees)")).bytes);
  expect(azimuth.dims).toEqual([64, 64, 32]);
  for (const domain of DOMAINS) {
    const x = (domain.xs[0] + domain.xs[1]) >> 1;
    const i = x + 64 * (32 + 64 * 16);
    const found = direction(azimuth.data[i], elevation.data[i]);
    expect(axisAngle(found, direction(domain.azimuth, domain.elevation))).toBeLessThan(1);
  }
  const colour = await downloadRow(page, "Direction colour map");
  expect(colour.name).toBe("synthetic_fibres_3d_direction_rgb.tif");
  expect((await readTiffBytes(colour.bytes)).dims).toEqual([64, 64, 32]);
  const vectors = readNiftiFloat32((await downloadRow(page, "Fibre direction vectors")).bytes);
  expect(vectors.dims).toEqual([64, 64, 32, 3]);
  const csv = (await downloadRow(page, "Orientation distribution")).bytes.toString("utf8").trim().split("\n");
  expect(csv).toHaveLength(1 + 360);
  expect(csv[1].startsWith("azimuth,-90,-89,")).toBe(true);
});

test("a dropped TIFF grating is measured within 1° of its angle", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(gratingTiff(-30));
  await expect(page.locator("#statusText")).toHaveText("grating_-30.tif loaded");
  await run(page);
  const orientation = await readTiffBytes((await downloadRow(page, "Orientation (degrees)")).bytes);
  for (const [x, y] of [[64, 64], [40, 80], [90, 50]]) {
    expect(Math.abs(angleDifference(orientation.data[x + 128 * y], -30))).toBeLessThan(1);
  }
});

test("a NIfTI stack with thick slices is refused until σ spans a voxel, then gives NIfTI maps", async ({ page }) => {
  test.setTimeout(120000);
  const { file, direction: truth } = cylindersNifti({ azimuth: 50, elevation: -30 });
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(file);
  await expect(page.locator("#fileInfo")).toHaveText("cylinders.nii · 3D 40 × 40 × 20 · 1 × 1 × 2 mm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("σ is 0.50 voxels along z at this voxel size; set σ to at least 2.");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await page.locator("#sigma").fill("2");
  await page.locator("#rho").fill("4");
  await run(page);
  const vectors = readNiftiFloat32((await downloadRow(page, "Fibre direction vectors")).bytes);
  const n = 40 * 40 * 20;
  const i = 20 + 40 * (20 + 40 * 10);
  expect(axisAngle([vectors.data[i], vectors.data[n + i], vectors.data[2 * n + i]], truth)).toBeLessThan(1);
  const azimuth = await downloadRow(page, "Azimuth (degrees)");
  expect(azimuth.name).toBe("cylinders_azimuth.nii.gz");
  expect(readNiftiFloat32(azimuth.bytes).datatype).toBe(16);
});

test("several 2D slices load as one stack in name order and are analysed in 3D", async ({ page }) => {
  test.setTimeout(120000);
  const slices = [2, 10, 1].map((k) => gratingTiff(20, 32, `slice_${k}.tif`));
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(slices);
  await expect(page.locator("#fileInfo")).toHaveText("3 slices from slice_1.tif · 3D 32 × 32 × 3");
  await expect(page.locator("#statusText")).toHaveText("slice_1_stack.nii loaded");
  await run(page);
  await expect(page.locator("#resultList")).toContainText("Direction colour map");
  const azimuth = await downloadRow(page, "Azimuth (degrees)");
  expect(azimuth.name).toBe("slice_1_stack_azimuth.tif");
  await page.locator("#imageInput").setInputFiles([gratingTiff(20, 32, "a.tif"), gratingTiff(20, 16, "b.tif")]);
  await expect(page.locator("#statusText")).toHaveText("b.tif is 16 × 16; every slice must match a.tif.");
});

test("EXIF-rotated JPEG slices stack on their stored grid, as ImageJ reads them", async ({ page }) => {
  await page.goto("/");
  // A 64 × 32 JPEG from the browser's encoder with an EXIF APP1 (orientation 6: shown 32 × 64) after SOI.
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(64, 32);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 64, 32);
    context.fillStyle = "#000";
    context.fillRect(0, 0, 32, 32);
    const encoded = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 1 })).arrayBuffer());
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    return [0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2, ...exif, ...encoded.subarray(2)];
  });
  const jpeg = (name) => ({ name, mimeType: "image/jpeg", buffer: Buffer.from(bytes) });
  await page.locator("#imageInput").setInputFiles([jpeg("rotated_1.jpg"), jpeg("rotated_2.jpg")]);
  await expect(page.locator("#fileInfo")).toHaveText("2 slices from rotated_1.jpg · 3D 64 × 32 × 2");
});

test("over-limit, non-finite and multi-channel TIFFs are refused at load, keeping the loaded image", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(gratingTiff(20, 32, "kept.tif"));
  await expect(page.locator("#statusText")).toHaveText("kept.tif loaded");
  const tiff = (name, buffer) => ({ name, mimeType: "image/tiff", buffer: Buffer.from(buffer) });
  const side = 4096;
  await page.locator("#imageInput").setInputFiles(tiff("big.tif", buildTiff({ width: side, height: side, pages: [new Uint8Array(side * side)], deflate: true })));
  await expect(page.locator("#statusText")).toHaveText("big.tif: The image has 16,777,216 voxels; crop or bin it to at most 8,388,608.");
  const data = new Float32Array(16 * 16).fill(1);
  data[16 * 3 + 5] = Number.NaN;
  await page.locator("#imageInput").setInputFiles(tiff("nan.tif", writeTiff({ data, dims: [16, 16, 1] })));
  await expect(page.locator("#statusText")).toContainText("nan.tif: it has a NaN value at x 5, y 3.");
  const pages = Array.from({ length: 6 }, () => new Uint8Array(16 * 16));
  await page.locator("#imageInput").setInputFiles(tiff("two.ome.tif", buildTiff({ width: 16, height: 16, pages, description: omeXml({ prefix: "ome", channels: 2, SizeX: 16, SizeY: 16, SizeZ: 3, SizeC: 2 }) })));
  await expect(page.locator("#statusText")).toContainText("hyperstack with 2 channels");
  await expect(page.locator("#fileInfo")).toHaveText("kept.tif · 2D 32 × 32");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a file that is not an image is refused and the previous state is kept", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.locator("#statusText")).toHaveText("notes.txt is not a TIFF, NIfTI, PNG or JPEG image.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("cancelling a run terminates its worker, leaves no outputs and permits a new run", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(gratingTiff(10, 2048, "large.tif"));
  await expect(page.locator("#statusText")).toHaveText("large.tif loaded", { timeout: 60000 });
  await page.locator("#rho").fill("12");
  const started = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await stopped;
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#imageInput").setInputFiles(gratingTiff(10));
  await expect(page.locator("#statusText")).toHaveText("grating_10.tif loaded");
  await run(page);
});

for (const failure of ["download", "unreadable image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(120000);
    const bytes = await exampleBytes(shg);
    let attempts = 0;
    await page.route(shg.files[0].url, (route) => {
      attempts++;
      if (attempts > 1) return route.fulfill({ body: bytes });
      // The selector checks the pinned checksum: a wrong body fails like a broken download.
      return failure === "download" ? route.fulfill({ status: 503, body: "" }) : route.fulfill({ body: "not a tiff" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(shg.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(shg.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  const bytes = await exampleBytes(shg);
  await page.route(shg.files[0].url, (route) => route.fulfill({ body: bytes }));
  await page.goto("/");
  await page.evaluate(() => {
    // TIFF headers are read through Blob slices.
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          Blob.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(shg.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(shg.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
});

test("the automation operation analyses a TIFF and reports every declared artifact", async ({ page }) => {
  test.setTimeout(120000);
  const grating = gratingTiff(45, 64, "auto.tif");
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(grating);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { sigma: 1, rho: 4 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(Object.keys(report.artifacts).sort()).toEqual(["coherency", "colour", "distribution", "energy", "orientation", "summary"]);
  expect(report.artifacts.orientation.role).toBe("maps");
  expect(report.provenance.settings).toEqual({ sigma: 1, rho: 4, minCoherency: 0.2, minEnergy: 0.01 });
  expect(Math.abs(angleDifference(report.provenance.dominant.orientation, 45))).toBeLessThan(1);
  await expect(page.locator("#sigma")).toHaveValue("1");
  await expect(page.locator("#rho")).toHaveValue("4");
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "summary" }));
  const summary = JSON.parse(readFileSync(await (await download).path(), "utf8"));
  expect(summary.input).toBe("auto.tif");
});
