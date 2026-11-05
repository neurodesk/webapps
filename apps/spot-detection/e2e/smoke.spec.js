// Browser tests on the production build: the hosted Big-FISH example through detection and
// download (checked against Big-FISH's recorded spots), the 2D projection, cancel, failed
// downloads with retry, and the automation contract.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { analyse } from "../src/pipeline.js";
import { syntheticImage } from "../src/synthetic.js";
import { writeTiffStack } from "../test/tiff-fixture.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8")).cases;
const example = examples[0];
const syntheticStack = syntheticImage([8, 48, 56], 25, 9);
const syntheticTiff = writeTiffStack(syntheticStack);

function parseCsv(text) {
  const [header, ...rows] = text.trim().split("\n");
  const names = header.split(",");
  return rows.map((row) => Object.fromEntries(row.split(",").map((value, i) => [names[i], value])));
}

async function downloadRow(page, label) {
  const download = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle", { hasText: label }).getByRole("button", { name: "Download", exact: true }).click();
  const file = await download;
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), "utf8") };
}

function expectBigFishSpots(rows, expected, axes) {
  expect(rows.map((row) => axes.map((a) => Number(row[`${a}_px`])))).toEqual(expected.spots);
  expect(rows.map((row) => Number(row.intensity))).toEqual(expected.intensity);
  const close = rows.filter((row, i) => axes.every((a, k) => Math.abs(Number(row[a]) - expected.subpixel[i][k]) <= 1.5e-3));
  expect(close.length).toBeGreaterThanOrEqual(Math.floor(0.97 * rows.length));
}

async function loadExample(page) {
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText("experiment_1_smfish_fov_1.tif · 23 × 650 × 500 · uint16", { timeout: 120000 });
  await expect(page.locator("#labelField")).toContainText("experiment_1_cell_label.tif · 2 cells");
  await expect(page.locator("#runButton")).toBeEnabled();
}

test("app boots on its workspace with the shared bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator('dialog[data-dialog="about"]');
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  for (const text of ["Big-FISH 0.6.2", "771 spots", "Levenberg-Marquardt", "Dense-region decomposition"]) await expect(about).toContainText(text);
  await about.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("the hosted example gives Big-FISH's spots, threshold and cell counts", async ({ page }) => {
  test.setTimeout(240000);
  const responses = [];
  page.on("response", (response) => {
    let request = response.request();
    while (request.redirectedFrom()) request = request.redirectedFrom();
    if (example.files.some((file) => file.url === request.url()) && response.ok()) responses.push(request.url());
  });
  await loadExample(page);
  expect(new Set(responses).size).toBe(2);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("771 spots detected", { timeout: 180000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList")).toContainText("Spots · 771 at threshold 355");
  const spots = await downloadRow(page, "Spots");
  expect(spots.name).toBe("experiment_1_smfish_fov_1_spots.csv");
  const rows = parseCsv(spots.text);
  expectBigFishSpots(rows, reference["example-3d"], ["z", "y", "x"]);
  const cells = await downloadRow(page, "Cell counts");
  expect(cells.name).toBe("experiment_1_smfish_fov_1_cell_counts.csv");
  const expectedCells = reference["example-3d"].cells.map(([id, n, area]) => `${id},${n},${area}`).join("\n");
  expect(cells.text).toBe(`cell_id,spots,area_px\n${expectedCells}\n0,${reference["example-3d"].spotsOutsideCells},\n`);
  expect(rows.filter((row) => row.cell_id === "0").length).toBe(reference["example-3d"].spotsOutsideCells);

  // The same stack in its maximum projection: Big-FISH's 2D result.
  await page.locator("#detectIn").selectOption("projection");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("656 spots detected", { timeout: 180000 });
  await expect(page.locator("#resultList")).toContainText("Spots · 656 at threshold 203");
  const projected = await downloadRow(page, "Spots");
  expect(projected.name).toBe("experiment_1_smfish_fov_1_mip_spots.csv");
  expectBigFishSpots(parseCsv(projected.text), reference["example-mip-2d"], ["y", "x"]);
});

test("cancelling a run keeps no outputs and the run can be repeated", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#threshold").fill("400");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^\d+ spots detected$/, { timeout: 180000 });
  await expect(page.locator("#resultList")).toContainText("at threshold 400");
});

test("a failed example download can be retried", async ({ page }) => {
  test.setTimeout(240000);
  // Every request fails, automatic retries included, until the example reports the error; the
  // user's retry then gets the real file, which must pass the downloader's size and SHA-256 check.
  let failing = true;
  let attempts = 0;
  await page.context().route(example.files[0].url, (route) => {
    attempts++;
    return failing ? route.fulfill({ status: 503, body: "" }) : route.fallback();
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  const state = page.locator("[data-neurodesk-examples]");
  await picker.selectOption(example.id);
  await expect(state).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  const failed = attempts;
  expect(failed).toBeGreaterThan(0);
  failing = false;
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(state).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toHaveText("experiment_1_smfish_fov_1.tif · 23 × 650 × 500 · uint16");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(failed + 1);
});

test("a corrupt example file is reported and leaves no input", async ({ page }) => {
  await page.route(example.files[0].url, (route) => route.fulfill({ body: "not a tiff" }));
  await page.route(example.files[1].url, (route) => route.fulfill({ body: "not a tiff" }));
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("cancelling an example download permits retry", async ({ page }) => {
  test.setTimeout(240000);
  // The first request's real response is held until after the cancel; the retry is not held.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  await page.context().route(example.files[0].url, async (route) => {
    attempts++;
    if (attempts === 1) await gate;
    await route.fallback().catch(() => {});
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  const state = page.locator("[data-neurodesk-examples]");
  await picker.selectOption(example.id);
  await expect.poll(() => attempts).toBe(1);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await expect(state).toHaveAttribute("data-example-state", "cancelled");
  release();
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(state).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toHaveText("experiment_1_smfish_fov_1.tif · 23 × 650 × 500 · uint16");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("an image without spots finishes with zero spots and no threshold", async ({ page }) => {
  await page.goto("/");
  const blank = writeTiffStack({ data: new Uint16Array(20 * 20), shape: [20, 20] });
  await page.locator("#imageInput").setInputFiles({ name: "blank.tif", mimeType: "image/tiff", buffer: blank });
  await expect(page.locator("#fileInfo")).toContainText("20 × 20");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("0 spots detected");
  await expect(page.locator("#resultList")).toContainText("Spots · 0 at threshold none");
});

test("3D cell labels with the maximum projection are refused before a worker starts", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({ name: "synthetic.tif", mimeType: "image/tiff", buffer: syntheticTiff });
  await expect(page.locator("#fileInfo")).toContainText("8 × 48 × 56");
  await page.locator("#labelSection > summary").click();
  const labels = writeTiffStack({ data: new Uint16Array(8 * 48 * 56).fill(1), shape: [8, 48, 56] });
  await page.locator("#labelInput").setInputFiles({ name: "cells.tif", mimeType: "image/tiff", buffer: labels });
  await expect(page.locator("#labelField")).toContainText("cells.tif · 1 cell");
  await page.locator("#detectIn").selectOption("projection");
  const workers = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^3D cell labels cannot count spots found in the 2D maximum projection/);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(workers).toEqual([]);
});

test("the form and the automation operation take the voxel size from TIFF metadata", async ({ page }) => {
  test.setTimeout(120000);
  // ImageJ metadata: 250 nm between planes, 90 nm pixels, unlike the 300 and 103 nm defaults.
  const tiff = writeTiffStack(syntheticStack, { description: "ImageJ=1.53t\nimages=8\nslices=8\nunit=micron\nspacing=0.25\n", resolution: [1 / 0.09, 1 / 0.09] });
  const settings = { spotRadius: [350, 150, 150], threshold: 150 };
  const expected = analyse(syntheticStack, { ...settings, voxelSize: [250, 90, 90] }).spotsCsv;
  expect(expected.split("\n").length).toBeGreaterThan(3);
  expect(analyse(syntheticStack, { ...settings, voxelSize: [300, 103, 103] }).spotsCsv).not.toBe(expected);

  await page.goto("/");
  await page.locator("#imageInput").setInputFiles({ name: "calibrated.tif", mimeType: "image/tiff", buffer: tiff });
  await expect(page.locator("#fileInfo")).toContainText("8 × 48 × 56");
  await expect(page.locator("#voxelZ")).toHaveValue("250");
  await expect(page.locator("#voxelYx")).toHaveValue("90");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#threshold").fill("150");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^\d+ spots detected$/, { timeout: 60000 });
  expect((await downloadRow(page, "Spots")).text).toBe(expected);

  await page.locator("#voxelZ").fill("300");
  await page.locator("#voxelYx").fill("103");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "calibrated.tif", mimeType: "image/tiff", buffer: tiff });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { threshold: 150 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.voxelSizeNm).toEqual([250, 90, 90]);
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "spots" }));
  expect(readFileSync(await (await download).path(), "utf8")).toBe(expected);
});

test("the automation operation writes the spots table the Node pipeline writes", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "synthetic.tif", mimeType: "image/tiff", buffer: syntheticTiff });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { threshold: 150 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  const expected = analyse(syntheticStack, { voxelSize: [300, 103, 103], spotRadius: [350, 150, 150], threshold: 150 });
  expect(report.provenance.threshold).toBe(150);
  expect(report.provenance.spots).toBe(expected.spots.length);
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "spots" }));
  expect(readFileSync(await (await download).path(), "utf8")).toBe(expected.spotsCsv);
  expect(automation.defaultOperation).toBe("detect-spots");
});
