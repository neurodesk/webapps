// Browser tests against `vite preview` of the production build: the shared shell, the example
// against Fiji and against the committed Node outputs, 2D and 3D synthetic mosaics with exact
// ground truth, refusals, cancellation, the example's failure and retry paths, and the
// automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { compareNames, parseTileConfiguration, positionsFromConfiguration } from "../src/core/tile-layout.js";
import { maxPositionDifference } from "../src/core/pipeline.js";
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { example, exampleFileBytes, readOmeZarrArchive, reference, sha256, syntheticTiles } from "./fixtures.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const fiji = readFileSync(new URL("../validation/fiji/TileConfiguration.registered.txt", import.meta.url), "utf8");

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

async function stitchAndWait(page, timeout = 300000) {
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Stitched", { timeout });
}

function registeredPositions(text, names) {
  const configuration = parseTileConfiguration(text);
  return positionsFromConfiguration(configuration, names, configuration.dims);
}

async function setGrid(page, { columns, rows, overlap }) {
  await page.locator("#layout").selectOption("grid");
  await page.locator("#columns").fill(String(columns));
  await page.locator("#rows").fill(String(rows));
  await page.locator("#overlap").fill(String(overlap));
}

test("app boots on the workspace with the shared bar and About", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator("#infoDialog");
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  for (const guidance of ["Preibisch", "not from Fiji's GPL code", "2.5 × the mean residual", "r × overlapping pixels", "Linear blending", "0.31 px", "0.73 px", "0.17 px"]) {
    await expect(about).toContainText(guidance);
  }
});

test(`example ${example.id}: Fiji's positions within 1 px and the Node pipeline's outputs byte for byte`, async ({ page }) => {
  test.setTimeout(600000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300000 });
  await expect(page.locator("#fileInfo")).toHaveText("16 tiles · 1392 × 1040 · uint16");
  await expect(page.locator("#layout")).toHaveValue("file");
  await expect(page.locator("#layoutInfo")).toContainText("TileConfiguration.txt · 16 tiles · 2D");
  await stitchAndWait(page);
  await expect(page.locator("#statusText")).toContainText(`${reference.outputs.fusedShape.join(" × ")}`);

  const names = example.files.filter((file) => file.role === "tile").map((file) => file.name).sort(compareNames);
  const configuration = await downloadRow(page, "TileConfiguration.registered.txt");
  expect(configuration.name).toBe("TileConfiguration.registered.txt");
  expect(sha256(configuration.bytes)).toBe(reference.outputs.registeredConfigurationSha256);
  const positions = registeredPositions(configuration.bytes.toString("utf8"), names);
  expect(maxPositionDifference(positions, registeredPositions(fiji, names))).toBeLessThan(1);

  const fused = await downloadRow(page, "Fused image · ");
  expect(fused.name).toBe("img_stitched.tif");
  expect(fused.bytes.length).toBe(reference.outputs.fusedTiffBytes);
  expect(sha256(fused.bytes)).toBe(reference.outputs.fusedTiffSha256);

  const zarr = await downloadRow(page, "OME-Zarr");
  expect(zarr.name).toBe("img_stitched.ozx");
  expect(zarr.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  // RFC 9 .ozx stores its entries uncompressed, so the root array's zarr.json is readable here.
  const listing = zarr.bytes.toString("latin1");
  expect(listing).toContain("zarr.json");
  const [width, height] = reference.outputs.fusedShape;
  expect(listing).toMatch(new RegExp(`"shape"\\s*:\\s*\\[\\s*${height}\\s*,\\s*${width}\\s*\\]`));
  expect(listing).toMatch(/"data_type"\s*:\s*"uint16"/);

  const pairs = await downloadRow(page, "Pairs (CSV)");
  const rows = pairs.bytes.toString("utf8").trim().split("\n");
  expect(rows).toHaveLength(43);
  expect(rows.slice(1).every((row) => row.split(",")[7] === "used")).toBe(true);

  await page.locator(".nd-viewer-toolbar").getByRole("button", { name: "Pairs", exact: true }).click();
  await expect(page.locator("#linkReport")).toBeVisible();
  await expect(page.locator("#linkReport tbody tr")).toHaveCount(42);
});

test("a 3 × 2 grid mosaic with a snake order is recovered within 0.5 px", async ({ page }) => {
  test.setTimeout(180000);
  const { files, truth, grid } = syntheticTiles({ columns: 3, rows: 2, seed: 5 });
  // Acquired as a snake by rows: the second row runs right to left.
  const renamed = files.map((file, k) => (k < 3 ? file : { ...file, name: `tile_2_${3 - (k - 3)}.tif` }));
  const order = [0, 1, 2, 5, 4, 3];
  await page.goto("/");
  await page.locator("#tileInput").setInputFiles(order.map((k) => ({ ...renamed[k], name: `tile_${String(order.indexOf(k) + 1).padStart(2, "0")}.tif` })));
  await expect(page.locator("#fileInfo")).toHaveText("6 tiles · 160 × 128 · uint16", { timeout: 60000 });
  await setGrid(page, grid);
  await page.locator("#gridType").selectOption("snake-row");
  await stitchAndWait(page, 120000);
  const configuration = await downloadRow(page, "TileConfiguration.registered.txt");
  const names = order.map((_, k) => `tile_${String(k + 1).padStart(2, "0")}.tif`);
  const positions = registeredPositions(configuration.bytes.toString("utf8"), names);
  expect(maxPositionDifference(positions, order.map((k) => truth[k]))).toBeLessThan(0.5);
});

test("a 2 × 2 mosaic of 3D stacks is recovered within 0.5 voxel and fused as a z stack", async ({ page }) => {
  test.setTimeout(240000);
  const { files, truth, grid } = syntheticTiles({ columns: 2, rows: 2, shape: [96, 80, 24], overlap: 0.25, jitter: 4, depth: 2, seed: 8, pixelSize: { x: 0.65, y: 0.75 } });
  await page.goto("/");
  await page.locator("#tileInput").setInputFiles(files);
  await expect(page.locator("#fileInfo")).toHaveText("4 tiles · 96 × 80 × 24 · uint16 · 0.65 µm", { timeout: 60000 });
  await setGrid(page, grid);
  await stitchAndWait(page, 180000);
  const configuration = await downloadRow(page, "TileConfiguration.registered.txt");
  expect(configuration.bytes.toString("utf8")).toContain("dim = 3");
  const positions = registeredPositions(configuration.bytes.toString("utf8"), files.map((file) => file.name));
  expect(maxPositionDifference(positions, truth)).toBeLessThan(0.5);
  const fused = await downloadRow(page, "Fused image · ");
  expect(fused.bytes.toString("latin1", 0, 400)).toMatch(/slices=2[4-9]/);

  // The OME-Zarr archive holds the TIFF's pixels and keeps the known XY pixel size although
  // the z spacing is unknown.
  const tiff = await readTiffStack(new Uint8Array(fused.bytes).buffer);
  const archive = await readOmeZarrArchive((await downloadRow(page, "OME-Zarr")).bytes);
  expect(archive.shape).toEqual([tiff.pages, tiff.height, tiff.width]);
  expect(archive.data.constructor).toBe(Uint16Array);
  expect(Buffer.from(archive.data.buffer, archive.data.byteOffset, archive.data.byteLength).equals(Buffer.from(tiff.data.buffer, tiff.data.byteOffset, tiff.data.byteLength))).toBe(true);
  expect(archive.axes.map((axis) => [axis.name, axis.unit ?? null])).toEqual([["z", null], ["y", "micrometer"], ["x", "micrometer"]]);
  expect(archive.scale[0]).toBe(1);
  expect(archive.scale[1]).toBeCloseTo(0.75, 6);
  expect(archive.scale[2]).toBeCloseTo(0.65, 6);
  expect(tiff.metadata.pixelSize.x).toBeCloseTo(archive.scale[2], 6);
  expect(tiff.metadata.pixelSize.y).toBeCloseTo(archive.scale[1], 6);
});

/** The viewer canvas once two consecutive captures agree (NiiVue has drawn the last change). */
async function settledCanvas(page) {
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const shot = await page.locator("#gl1").screenshot();
    if (previous && shot.equals(previous)) return shot;
    previous = shot;
    await page.waitForTimeout(150);
  }
  throw new Error("The viewer did not settle");
}

test("Layout and Stitched share the zoom, and tile outlines can be hidden", async ({ page }) => {
  test.setTimeout(180000);
  const { files, grid } = syntheticTiles({ columns: 3, rows: 2, seed: 5, jitter: 6 });
  await page.goto("/");
  await page.locator("#tileInput").setInputFiles(files);
  await expect(page.locator("#fileInfo")).toHaveText("6 tiles · 160 × 128 · uint16", { timeout: 60000 });
  const toolbar = page.locator(".nd-viewer-toolbar");
  const outlines = toolbar.getByRole("button", { name: "Outlines", exact: true });
  await expect(outlines).toBeVisible();
  await expect(outlines).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#outlineLegend")).toHaveText("Outlines: cyan layout");
  await toolbar.getByRole("button", { name: "Stitched", exact: true }).click();
  await expect(page.locator("#statusText")).toHaveText("Stitch the tiles to see this view");
  await expect(toolbar.getByRole("button", { name: "Layout", exact: true })).toHaveAttribute("aria-pressed", "true");

  await setGrid(page, grid);
  await stitchAndWait(page, 120000);
  await expect(page.locator("#statusText")).toContainText(/moved up to \d+\.\d px/);
  await expect(toolbar.getByRole("button", { name: "Stitched", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#outlineLegend")).toHaveText("Outlines: cyan layout · orange stitched");

  // The first tile keeps its layout position, so where it alone covers the mosaic both views
  // put the same voxel, with the same value, under the same point of the canvas.
  const box = await page.locator("#gl1").boundingBox();
  const firstTile = { x: box.x + box.width * 0.12, y: box.y + box.height * 0.3 };
  const locationAt = async (view) => {
    await toolbar.getByRole("button", { name: view, exact: true }).click();
    await settledCanvas(page);
    await page.mouse.click(firstTile.x, firstTile.y);
    await expect(page.locator("#location")).not.toHaveText("");
    return page.locator("#location").textContent();
  };
  const stitchedVoxel = await locationAt("Stitched");
  expect(await locationAt("Layout")).toBe(stitchedVoxel);
  await toolbar.getByRole("button", { name: "Stitched", exact: true }).click();

  // Zoom into the middle of the mosaic.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const unzoomed = await settledCanvas(page);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  const stitched = await settledCanvas(page);
  expect(stitched.equals(unzoomed)).toBe(false);

  await toolbar.getByRole("button", { name: "Layout", exact: true }).click();
  const layout = await settledCanvas(page);
  expect(layout.equals(stitched)).toBe(false);
  await toolbar.getByRole("button", { name: "Stitched", exact: true }).click();
  // Back on the stitched image at the same zoom and position, pixel for pixel.
  expect((await settledCanvas(page)).equals(stitched)).toBe(true);

  await outlines.click();
  await expect(outlines).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#outlineLegend")).toHaveText("");
  const bare = await settledCanvas(page);
  expect(bare.equals(stitched)).toBe(false);
  await toolbar.getByRole("button", { name: "Layout", exact: true }).click();
  await toolbar.getByRole("button", { name: "Stitched", exact: true }).click();
  expect((await settledCanvas(page)).equals(bare)).toBe(true);
  await outlines.click();
  expect((await settledCanvas(page)).equals(stitched)).toBe(true);
});

test("refusals: one tile, an RGB tile, mixed sample types and a grid that does not fit", async ({ page }) => {
  test.setTimeout(120000);
  const { files } = syntheticTiles();
  await page.goto("/");
  await page.locator("#tileInput").setInputFiles(files[0]);
  await expect(page.locator("#statusText")).toHaveText(/stitching needs at least two/);
  const rgb = { name: "rgb.tif", mimeType: "image/tiff", buffer: readFileSync(new URL("../../../packages/components/test/fixtures/rgb-uint8.tif", import.meta.url)) };
  await page.locator("#tileInput").setInputFiles([files[0], rgb]);
  await expect(page.locator("#statusText")).toHaveText(/rgb\.tif: .*3 samples per pixel \(RGB\)/, { timeout: 30000 });
  const fixture = (name) => readFileSync(new URL(`../../../packages/components/test/fixtures/${name}`, import.meta.url));
  await page.locator("#tileInput").setInputFiles([files[0], { name: "movie.tif", mimeType: "image/tiff", buffer: fixture("stack-imagej-float32.tif") }]);
  await expect(page.locator("#statusText")).toHaveText("movie.tif is a time series (3 time points); save one time point per tile.", { timeout: 30000 });
  await page.locator("#tileInput").setInputFiles([files[0], { name: "signed.tif", mimeType: "image/tiff", buffer: fixture("stack-lzw-int16.tif") }]);
  await expect(page.locator("#statusText")).toHaveText("The tiles mix sample types (int16, uint16); save them all with one type.", { timeout: 30000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#tileInput").setInputFiles(files);
  await expect(page.locator("#fileInfo")).toHaveText("4 tiles · 160 × 128 · uint16", { timeout: 30000 });
  await page.locator("#columns").fill("3");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("A 3 × 2 grid holds 6 tiles, but 4 are loaded.");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("cancelling a run stops its workers, leaves no output and permits a complete retry", async ({ page }) => {
  test.setTimeout(600000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 300000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registering tile pairs", { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await stitchAndWait(page);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(5);
});

for (const failure of ["download", "corrupt bytes"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(420000);
    const target = example.files[0];
    let failing = true;
    let attempts = 0;
    // Every example file is served from hosted bytes Node fetched once and checked against its
    // pinned SHA-256, so only the deliberate failure of the first tile varies between attempts.
    for (const file of example.files) {
      await page.context().route(file.url, async (route) => {
        if (file !== target) return route.fulfill({ body: await exampleFileBytes(file), contentType: "application/octet-stream" });
        attempts++;
        if (!failing) return route.fulfill({ body: await exampleFileBytes(target), contentType: "image/tiff" });
        return route.fulfill(failure === "download" ? { status: 503, body: "" } : { status: 200, body: "not the example" });
      });
    }
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeDisabled();
    const failedAttempts = attempts;
    expect(failedAttempts).toBeGreaterThanOrEqual(1);
    failing = false;
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(failedAttempts + 1);
  });
}

test("the automation operation stitches tiles and downloads its declared artifacts", async ({ page }) => {
  test.setTimeout(180000);
  const { files, truth } = syntheticTiles({ seed: 9 });
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(files);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "tiles" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { layout: "grid", columns: 2, rows: 2, overlap: 20 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 120000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(Object.keys(report.artifacts).sort()).toEqual(Object.keys(automation.operations.stitch.artifacts).sort());
  expect(report.provenance.summary.used).toBe(report.provenance.summary.links);
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "configuration" }));
  const configuration = readFileSync(await (await download).path());
  expect(sha256(configuration)).toBe(report.artifacts.configuration.sha256);
  const positions = registeredPositions(configuration.toString("utf8"), files.map((file) => file.name));
  expect(maxPositionDifference(positions, truth)).toBeLessThan(0.5);
});
