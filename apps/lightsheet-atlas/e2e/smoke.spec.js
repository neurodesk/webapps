// Browser tests against the production build: both examples run their real analysis on the
// hosted bytes, and the downloads match the references the Node tests hold the pipeline to.
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fetchPinned } from "../validation/run-example.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const cellfinder = JSON.parse(readFileSync(new URL("../validation/cellfinder-crop-reference.json", import.meta.url), "utf8"));
const brainreg = JSON.parse(readFileSync(new URL("../validation/brainreg-reference.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../../models/lightsheet-atlas.manifest.json", import.meta.url), "utf8"));
const example = (id) => examples.find((entry) => entry.id === id);

// Serve the pinned example and atlas bytes from a checksum-verified Node cache, so a slow or
// dropped connection to Hugging Face under load does not fail a scientific test. The bytes are the
// hosted ones (fetchPinned downloads and checks them against the manifests' sha256).
const PINNED = [...examples.flatMap((entry) => entry.files), ...manifest.assets];
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes("failed example download")) return;
  for (const asset of PINNED) {
    await page.context().route(asset.url, async (route) => route.fulfill({ body: await fetchPinned(asset) }));
  }
});

async function downloadRow(page, label) {
  const row = page.locator("#resultList .nd-volume-toggle").filter({ hasText: label });
  const downloadPromise = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

test("app boots on the workspace with the shared app bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
});

test("the cellfinder crop example finds cellfinder's 38 candidates", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("cellfinder-crop");
  await expect(page.locator("#fileInfo")).toContainText("cellfinder-crop.ome.tif · 26 × 1116 × 627", { timeout: 120000 });
  await expect(page.locator("#voxelZ")).toHaveValue("5");
  await expect(page.locator("#voxelX")).toHaveValue("2");
  await expect(page.locator("#register")).not.toBeChecked();
  await expect(page.locator("#detect")).toBeChecked();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("38 cell candidates", { timeout: 200000 });
  const cells = await downloadRow(page, "Cell candidates");
  expect(cells.name).toBe("cellfinder-crop_candidates.csv");
  const rows = cells.bytes.toString().trim().split("\n").slice(1).map((line) => line.split(",").slice(0, 3).map(Number));
  const expected = cellfinder.cells.map((cell) => cell.slice(0, 3));
  expect(rows.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0])).toEqual(expected.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]));
});

test("the detection threshold set in the form reaches the worker", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("cellfinder-crop");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#nSdsAboveMeanThresh").fill("20");
  await page.locator("#runButton").click();
  // cellfinder's default 10 SD gives 38 candidates on the crop; 20 SD gives 10 (Node pipeline).
  await expect(page.locator("#statusText")).toHaveText("10 cell candidates", { timeout: 200000 });
});

// A two-chunk OME-Zarr 0.4 image (zarr v2, uncompressed uint16), 6 planes of 24 × 32 at 5 × 2 × 2 µm.
function writeOmeZarr(root) {
  const shape = [6, 24, 32];
  mkdirSync(join(root, "0"), { recursive: true });
  writeFileSync(join(root, ".zgroup"), JSON.stringify({ zarr_format: 2 }));
  const axes = ["z", "y", "x"].map((name) => ({ name, type: "space", unit: "micrometer" }));
  writeFileSync(join(root, ".zattrs"), JSON.stringify({ multiscales: [{ version: "0.4", axes, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [5, 2, 2] }] }] }] }));
  writeFileSync(join(root, "0", ".zarray"), JSON.stringify({ zarr_format: 2, shape, chunks: [3, 24, 32], dtype: "<u2", compressor: null, fill_value: 0, order: "C", filters: null }));
  for (const chunk of [0, 1]) {
    const data = Uint16Array.from({ length: 3 * 24 * 32 }, (_, i) => 100 + ((i + chunk) % 7));
    writeFileSync(join(root, "0", `${chunk}.0.0`), Buffer.from(data.buffer));
  }
}

test("an OME-Zarr folder chosen with the folder picker loads and runs", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const root = testInfo.outputPath("sample.ome.zarr");
  writeOmeZarr(root);
  await page.goto("/");
  await page.locator("#folderInput").setInputFiles(root);
  await expect(page.locator("#fileInfo")).toHaveText("sample.ome.zarr · 6 × 24 × 32 (z × y × x) · uint16", { timeout: 60000 });
  await expect(page.locator("#voxelZ")).toHaveValue("5");
  await expect(page.locator("#voxelX")).toHaveValue("2");
  await page.locator("#orientation").fill("asr");
  await page.locator("#register").uncheck();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("0 cell candidates", { timeout: 60000 });
  await expect(page.locator("#resultList")).toContainText("Cell candidates · 0");
});

test("the whole-brain example registers to the Allen atlas as the Node pipeline does", async ({ page }) => {
  test.setTimeout(600000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("brainreg-test-brain");
  await expect(page.locator("#fileInfo")).toContainText("brainreg-test-brain.ome.tif · 270 × 193 × 271", { timeout: 120000 });
  await expect(page.locator("#orientation")).toHaveValue("psl");
  await expect(page.locator("#detect")).not.toBeChecked();
  // The orientation must survive closing and reopening its section.
  await page.locator("#sampleSection > summary").click();
  await page.locator("#sampleSection > summary").click();
  await expect(page.locator("#orientation")).toHaveValue("psl");
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Registered to the Allen atlas", { timeout: 540000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  const atlas = await downloadRow(page, "Allen atlas labels");
  expect(atlas.name).toBe("brainreg-test-brain_registered-atlas.nii.gz");
  const nifti = gunzipSync(atlas.bytes);
  const voxels = nifti.subarray(nifti.readFloatLE(108));
  expect(createHash("sha256").update(voxels).digest("hex")).toBe(brainreg.ours.registeredAtlasSha256);
  const regions = await downloadRow(page, "Regions");
  expect(createHash("sha256").update(regions.bytes).digest("hex")).toBe(brainreg.ours.regionsCsvSha256);
});

test("cancelling a run stops the worker and allows a new run", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("brainreg-test-brain");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a wrong orientation is refused at its field", async ({ page }) => {
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("brainreg-test-brain");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#orientation").fill("pss");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Orientation pss names one anatomical axis twice.");
  await expect(page.locator("#orientation")).toBeFocused();
});

test("a failed example download can be retried", async ({ page }) => {
  test.setTimeout(120000);
  const entry = example("cellfinder-crop");
  const hosted = Buffer.from(await (await fetch(entry.files[0].url)).arrayBuffer());
  let failing = true;
  let failures = 0;
  // Every request fails, automatic retries included, until the test lets the pinned bytes through.
  await page.route(entry.files[0].url, (route) => {
    if (!failing) return route.fulfill({ body: hosted });
    failures++;
    return route.fulfill({ status: 503, body: "" });
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(entry.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 60000 });
  expect(failures).toBeGreaterThan(0);
  await expect(page.locator("#runButton")).toBeDisabled();
  failing = false;
  await picker.selectOption(entry.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
  await expect(page.locator("#fileInfo")).toContainText("cellfinder-crop.ome.tif");
  await expect(page.locator("#runButton")).toBeEnabled();
});
