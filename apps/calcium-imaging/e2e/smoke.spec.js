// Browser tests against `vite preview` of the production build: the shared shell, the example's
// rigid shifts against CaImAn, the browser's outputs against the same pipeline in Node,
// piecewise-rigid motion correction, ROI editing, refusals, cancellation, the example's failure
// and retry paths, and the automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { analyse, borderMargin, motionCorrect } from "../src/core/pipeline.js";
import { readSettings } from "../src/config.js";
import { parseShiftsCsv, roisCsv, shiftsCsv, tracesCsv } from "../src/outputs.js";
import { example, exampleBytes, exampleFile, omeStack, sha256, syntheticMovie, tiff } from "./fixtures.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const caiman = JSON.parse(readFileSync(new URL("../validation/caiman-rigid-shifts.json", import.meta.url), "utf8"));
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Two CSV tables with the same header and cells equal to 7 significant digits or 1e-12. */
function expectSameTable(actual, expected) {
  const [actualHeader, ...actualRows] = actual.trim().split("\n");
  const [expectedHeader, ...expectedRows] = expected.trim().split("\n");
  expect(actualHeader).toBe(expectedHeader);
  expect(actualRows).toHaveLength(expectedRows.length);
  let worst = 0;
  actualRows.forEach((row, r) => {
    const a = row.split(",");
    const b = expectedRows[r].split(",");
    expect(a).toHaveLength(b.length);
    a.forEach((cell, c) => {
      if (cell === b[c]) return;
      const x = Number(cell);
      const y = Number(b[c]);
      worst = Math.max(worst, Math.abs(x - y) / Math.max(1e-12, Math.abs(y), 1e-6));
    });
  });
  // Math.exp, Math.log and Math.cos may differ by an ulp between the V8 builds of Node and Chromium.
  expect(worst).toBeLessThan(1e-5);
}

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

async function loadMovie(page, file) {
  await page.locator("#movieInput").setInputFiles(file);
  await expect(page.locator("#statusText")).toHaveText(`${file.name} loaded`, { timeout: 60000 });
}

async function openAdvanced(page) {
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
}

async function runAndWait(page) {
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Preprocessing complete", { timeout: 240000 });
}

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator("#infoDialog");
  await expect(about).toBeVisible();
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  for (const guidance of ["Guizar-Sicairos", "NoRMCorre", "not Suite2p's or CNMF's", "0.7", "OASIS", "register_translation"]) {
    await expect(about).toContainText(guidance);
  }
  await about.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // The worker pool shares the movie through SharedArrayBuffer.
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test(`example ${example.id}: rigid shifts equal CaImAn's and every output equals the Node pipeline`, async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(`${exampleFile.name} · 256 × 256 · 400 frames · uint16 · 3.906 Hz`, { timeout: 180000 });
  await expect(page.locator("#frameRate")).toHaveValue("3.90625");
  await openAdvanced(page);
  // One pass registers every frame to the initial template that CaImAn was given.
  await page.locator("#templatePasses").fill("1");
  await runAndWait(page);

  const shifts = await downloadRow(page, "Shifts");
  expect(shifts.name).toBe("froemke-nv60-a1-gcamp-400frames_shifts.csv");
  const browserShifts = parseShiftsCsv(shifts.bytes.toString("utf8"));
  expect(browserShifts).toHaveLength(400);
  let largest = 0;
  browserShifts.forEach(([dy, dx], frame) => {
    const [cy, cx] = caiman.caimanRegisterTranslation[frame];
    largest = Math.max(largest, Math.abs(dy - cy), Math.abs(dx - cx));
  });
  expect(largest).toBeLessThanOrEqual(1e-9);

  // The same pipeline in Node, one thread, on the same bytes.
  const stack = await readTiffStack(arrayBuffer(await exampleBytes()));
  const dims = { width: 256, height: 256, frames: 400, frameRate: 3.90625 };
  const settings = readSettings({ motion: "rigid", frameRate: "3.90625", templatePasses: "1" });
  const corrected = motionCorrect(Float32Array.from(stack.data), dims, settings);
  const analysis = analyse(corrected.registered, dims, settings, null, { margin: borderMargin(corrected.shifts) });
  expect(analysis.cells.length).toBeGreaterThan(3);
  expect(shifts.bytes.toString("utf8")).toBe(shiftsCsv(corrected, 3.90625));
  const traces = await downloadRow(page, "Traces (CSV)");
  expectSameTable(traces.bytes.toString("utf8"), tracesCsv(analysis.cells, 400, 3.90625));
  const rois = await downloadRow(page, "ROI table");
  expectSameTable(rois.bytes.toString("utf8"), roisCsv(analysis.cells));

  const registered = await downloadRow(page, "Registered movie");
  const movie = await readTiffStack(arrayBuffer(registered.bytes));
  expect([movie.pages, movie.height, movie.width, movie.dtype]).toEqual([400, 256, 256, "uint16"]);
  expect(movie.metadata.frameInterval).toBe(0.256);
  const rounded = Uint16Array.from(corrected.registered, (value) => Math.min(65535, Math.max(0, Math.round(value))));
  expect(sha256(Buffer.from(movie.data.buffer))).toBe(sha256(Buffer.from(rounded.buffer)));

  const labels = await downloadRow(page, "ROI labels");
  const labelImage = await readTiffStack(arrayBuffer(labels.bytes));
  expect(labelImage.dtype).toBe("uint16");
  expect(Array.from(labelImage.data)).toEqual(Array.from(analysis.labels));
  const correlation = await readTiffStack(arrayBuffer((await downloadRow(page, "Correlation image")).bytes));
  expect(Array.from(correlation.data)).toEqual(Array.from(analysis.correlation));
  const plot = await downloadRow(page, "Trace plot");
  expect(plot.bytes.toString("utf8")).toContain("<svg");

  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Traces", exact: true }).click();
  await expect(page.locator("#traceReport")).toBeVisible();
  await expect(page.locator("#traceReport figure")).toHaveCount(2);
});

test("piecewise rigid motion correction writes patch shifts within the allowed deviation", async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 180000 });
  await page.locator("#motion").selectOption("piecewise");
  await runAndWait(page);
  const text = (await downloadRow(page, "Shifts")).bytes.toString("utf8");
  const [header, ...rows] = text.trim().split("\n");
  const columns = header.split(",");
  // 256 px with 64 px patches and 32 px overlap: a 7 × 7 grid.
  expect(columns.filter((name) => name.endsWith("_y_px"))).toHaveLength(1 + 49);
  expect(columns).toContain("patch_r7_c7_x_px");
  for (const row of rows) {
    const cells = row.split(",").map(Number);
    const [dy, dx] = [cells[2], cells[3]];
    for (let i = 4; i < cells.length; i += 2) {
      expect(Math.abs(cells[i] - dy)).toBeLessThanOrEqual(3 + 1e-9);
      expect(Math.abs(cells[i + 1] - dx)).toBeLessThanOrEqual(3 + 1e-9);
    }
  }
  await expect(page.locator("#resultList")).toContainText("Registered movie · Piecewise rigid");
});

test("ROIs can be added and removed at the cursor, and the traces follow", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await loadMovie(page, tiff("synthetic.tif", syntheticMovie()));
  await runAndWait(page);
  const before = (await downloadRow(page, "ROI table")).bytes.toString("utf8").trim().split("\n").length - 1;
  expect(before).toBeGreaterThanOrEqual(3);
  // Off the canvas centre on both axes, so a transposed or mirrored cursor would put the ROI
  // elsewhere; the point lies between the four cells, away from the image centre (24, 32).
  const canvas = page.locator("#gl1");
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width / 2 + box.height * 0.06, y: box.height * 0.58 } });
  await expect(page.locator("#addRoi")).toBeEnabled();
  const [, cursorX, cursorY] = (await page.locator("#location").textContent()).match(/^x (\d+), y (\d+)/).map(Number);
  expect(cursorX).not.toBe(32);
  expect(cursorY).not.toBe(24);
  await page.locator("#addRoi").click();
  await expect(page.locator("#statusText")).toHaveText(`ROIs updated · ${before + 1} ROIs`, { timeout: 60000 });
  const added = (await downloadRow(page, "ROI table")).bytes.toString("utf8").trim().split("\n");
  expect(added).toHaveLength(before + 2);
  // The new disc is the highest id; a whole disc clear of the other ROIs is centred on the cursor.
  const header = added[0].split(",");
  const row = added.slice(1).map((line) => line.split(",")).find((cells) => Number(cells[0]) === before + 1);
  expect(Number(row[header.indexOf("centroid_y_px")])).toBeCloseTo(cursorY, 5);
  expect(Number(row[header.indexOf("centroid_x_px")])).toBeCloseTo(cursorX, 5);
  await expect(page.locator("#removeRoi")).toBeEnabled();
  await page.locator("#removeRoi").click();
  await expect(page.locator("#statusText")).toHaveText(`ROIs updated · ${before} ROIs`, { timeout: 60000 });
  const provenance = JSON.parse((await downloadRow(page, "Provenance")).bytes.toString("utf8"));
  expect(provenance.rois.source).toBe("detected and edited");
});

test("refusals: an RGB TIFF, a movie too short and a missing frame rate", async ({ page }) => {
  await page.goto("/");
  const rgb = readFileSync(new URL("../../../packages/components/test/fixtures/rgb-uint8.tif", import.meta.url));
  await page.locator("#movieInput").setInputFiles(tiff("rgb.tif", rgb));
  await expect(page.locator("#statusText")).toContainText("3 samples per pixel (RGB)");
  await expect(page.locator("#runButton")).toBeDisabled();
  // A 30-plane Z-stack, two OME series and a SizeT that is not the page count are not movies.
  await page.locator("#movieInput").setInputFiles(tiff("zstack.ome.tif", omeStack({ pages: 30, sizeZ: 30, sizeT: 1 })));
  await expect(page.locator("#statusText")).toHaveText("zstack.ome.tif is a Z-stack of 30 planes, not a movie; this app needs one plane over time.");
  const twoSeries = readFileSync(new URL("../../../packages/components/test/fixtures/two-series.ome.tif", import.meta.url));
  await page.locator("#movieInput").setInputFiles(tiff("two-series.ome.tif", twoSeries));
  await expect(page.locator("#statusText")).toContainText("holds 2 image series");
  await page.locator("#movieInput").setInputFiles(tiff("sizet.ome.tif", omeStack({ pages: 30, sizeT: 25 })));
  // Its TiffData maps 30 planes against a declared SizeT of 25: the shared reader refuses it.
  await expect(page.locator("#statusText")).toContainText("maps 30 planes but its Pixels declare 25");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#fileInfo")).toBeHidden();
  await page.locator("#movieInput").setInputFiles(tiff("short.tif", syntheticMovie(10)));
  await expect(page.locator("#statusText")).toContainText("needs at least 20 frames");
  await loadMovie(page, tiff("synthetic.tif", syntheticMovie()));
  await page.locator("#frameRate").fill("");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Enter the frame rate in Hz.");
  await expect(page.locator("#frameRate")).toBeFocused();
  await openAdvanced(page);
  await page.locator("#frameRate").fill("10");
  await page.locator("#patchOverlap").fill("64");
  await page.locator("#motion").selectOption("piecewise");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Patch overlap must be smaller than the patch size.");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("a frame rate entered over the file's sets the movie TIFF's frame interval, as in the CSVs", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await loadMovie(page, tiff("synthetic.tif", syntheticMovie(60, { frameRate: 10 })));
  await expect(page.locator("#frameRate")).toHaveValue("10");
  await page.locator("#frameRate").fill("20");
  await runAndWait(page);
  const movie = await readTiffStack(arrayBuffer((await downloadRow(page, "Registered movie")).bytes));
  expect(movie.pages).toBe(60);
  expect(movie.metadata.frameInterval).toBe(0.05);
  const shifts = (await downloadRow(page, "Shifts")).bytes.toString("utf8").trim().split("\n");
  expect(shifts[2].split(",")[1]).toBe("0.05");
  const traces = (await downloadRow(page, "Traces (CSV)")).bytes.toString("utf8").trim().split("\n");
  expect(traces[2].split(",")[1]).toBe("0.05");
});

test("the registered movie TIFF is built only when it is downloaded", async ({ page }) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    const Native = File;
    globalThis.__builtFiles = [];
    globalThis.File = class extends Native {
      constructor(parts, name, options) {
        super(parts, name, options);
        globalThis.__builtFiles.push(name);
      }
    };
  });
  await page.goto("/");
  await loadMovie(page, tiff("lazy.tif", syntheticMovie(40, { frameRate: 10 })));
  await runAndWait(page);
  const built = () => page.evaluate(() => globalThis.__builtFiles.filter((name) => name.endsWith("_registered.tif")));
  expect(await built()).toEqual([]);
  await downloadRow(page, "Registered movie");
  expect(await built()).toHaveLength(1);
});

test("cancelling a run stops its workers, leaves no output and permits a complete retry", async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 180000 });
  await page.locator("#motion").selectOption("piecewise");
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Motion correction");
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#motion").selectOption("rigid");
  await runAndWait(page);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(10);
});

for (const failure of ["download", "corrupt bytes"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(240000);
    let attempts = 0;
    await page.context().route(exampleFile.url, async (route) => {
      attempts++;
      if (attempts > 1) return route.fulfill({ body: await exampleBytes(), contentType: "image/tiff" });
      return route.fulfill(failure === "download" ? { status: 503, body: "" } : { status: 200, body: "not the example" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during movie reading prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(240000);
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
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 180000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("the automation operation preprocesses a movie and downloads its declared artifacts", async ({ page }) => {
  test.setTimeout(180000);
  const bytes = syntheticMovie();
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(tiff("synthetic.tif", bytes));
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "movie" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { motion: "rigid", diameter: 6 } });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 120000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(Object.keys(report.artifacts).sort()).toEqual(Object.keys(automation.operations.preprocess.artifacts).sort());
  expect(report.provenance.frameRateHz).toBe(10);
  expect(report.provenance.motionCorrection.mode).toBe("rigid");
  expect(report.provenance.rois.cellDiameterPx).toBe(6);
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "traces" }));
  const traces = readFileSync(await (await download).path());
  expect(sha256(traces)).toBe(report.artifacts.traces.sha256);
  expect(traces.toString("utf8").split("\n")[0]).toMatch(/^frame,time_s,roi1_F,roi1_Fneu,roi1_Fcorrected,roi1_dFF,roi1_denoised,roi1_spikes/);
});
