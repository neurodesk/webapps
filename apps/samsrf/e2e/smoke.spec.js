// Browser tests against `vite preview` of the built app (playwright.config.js).
// SAMSRF_EXAMPLE_DIR serves the example from a local copy instead of Hugging Face.
//
// The analyses run @neurodesk/samsrf in the app's workers. The checks here are the app's:
// SamSrf's file names, one value per surface vertex, fitted R², and a downloadable zip.
// Numeric parity belongs to @neurodesk/samsrf's own tests.
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { unzipSync } from "fflate";
import { analysisSpec, createJob, exportGiis, hrf, readAnalysisInputs, readGifti, readOldSchoolHrf, runJob } from "@neurodesk/samsrf/node";
import { matFile } from "../../../packages/samsrf/test/fixtures.js";
import { serveSite } from "../../../test-utils/serve-site.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const example = examples[0];
const local = process.env.SAMSRF_EXAMPLE_DIR;
// lh.white and lh.inflated of the example both have this many vertices.
const VERTICES = 134260;
let dataServer;

test.beforeAll(async () => {
  if (local) {
    const files = new Map(example.files.map(file => [`/${file.name}`, join(local, file.name)]));
    dataServer = await serveSite(local, { files });
  }
});
test.afterAll(async () => { await dataServer?.close(); });

async function serveLocalExample(page) {
  if (!local) return;
  for (const file of example.files) {
    // Whole-surface runs exceed the DevTools base64 message limit; stream their bytes.
    await page.route(file.url, route => route.fulfill({
      status: 307, body: '',
      headers: { location: `${dataServer.origin}/${file.name}`, 'access-control-allow-origin': '*' },
    }));
  }
}

async function exampleBytes(file) {
  if (local) return readFileSync(join(local, file.name));
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function loadExample(page) {
  await serveLocalExample(page);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300000 });
  await expect(page.locator("#runsInfo")).toContainText("lh_uBars6.gii");
}

/** The one map a SamSrf GIfTI holds. */
function giftiMap(bytes) {
  const { arrays } = readGifti(new Uint8Array(bytes));
  expect(arrays).toHaveLength(1);
  return arrays[0].data;
}

const RUNS = {
  prf: { outcome: "pRF maps ready", outName: "lh_pRF_Gaussian", maps: ["pol", "ecc", "r^2", "x0", "y0", "sigma", "beta", "noise_ceiling"] },
  rc: { outcome: "Reverse-correlation maps ready", outName: "lh_pRF_Rcp", maps: ["pol", "ecc", "r^2", "x0", "y0", "fwhm", "beta", "noise_ceiling"] },
  cf: { outcome: "Connective field maps ready", outName: "lh_CF_Rcp", maps: ["pol", "ecc", "r^2", "x0", "y0", "centre", "fwhm", "noise_ceiling"] },
};

// The first vertices of the example's V1-V3 label: every analysis path in about a
// minute, where the pRF fit of the whole label takes several.
const SMALL_ROI = 150;

async function useSmallRoi(page) {
  const lines = (await exampleBytes(example.files[7])).toString("utf8").split("\n");
  const vertices = lines.slice(2, 2 + SMALL_ROI);
  const label = [lines[0], String(vertices.length), ...vertices, ""].join("\n");
  await page.locator("#roiInput").setInputFiles({ name: "lh.V123_small.label", mimeType: "application/octet-stream", buffer: Buffer.from(label) });
  await expect(page.locator("#roiDrop")).toContainText("lh.V123_small.label");
}

/** Run each analysis on the loaded inputs and check SamSrf's files. */
async function runEveryAnalysis(page, timeout) {
  for (const [analysis, expected] of Object.entries(RUNS)) {
    await page.locator("#analysis").selectOption(analysis);
    await page.locator("#advancedSettings").evaluate(element => { element.open = true; });
    await page.locator("#exportConvention").selectOption("samsrfx-10.003");
    const run = page.locator("#runButton");
    await expect(run).toBeEnabled();
    await run.click();
    for (const setting of ["exportConvention", "dataPrecision", "cssConvention"]) {
      await expect(page.locator(`#${setting}`)).toBeDisabled();
    }
    // The previous analysis leaves the output section open; its status line names the analysis.
    await expect(page.locator("#statusText")).toContainText(expected.outcome, { timeout });
    for (const setting of ["exportConvention", "dataPrecision", "cssConvention"]) {
      await expect(page.locator(`#${setting}`)).toBeEnabled();
    }
    await expect(page.locator("#exportConvention")).toHaveValue("samsrfx-10.003");
    await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
    for (const label of ["Polar angle", "Eccentricity", "R²"]) {
      await expect(page.locator("#resultList")).toContainText(label);
    }
    await expect(page.locator("#location")).toContainText("vertices with R²");

    const row = page.locator("#resultList .nd-volume-toggle", { hasText: "Polar angle" });
    const single = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download", exact: true }).click();
    const download = await single;
    expect(download.suggestedFilename()).toBe(`${expected.outName}_pol.gii`);
    expect(giftiMap(readFileSync(await download.path()))).toHaveLength(VERTICES);

    const zipped = page.waitForEvent("download");
    await page.locator("#downloadAll").click();
    const archive = await zipped;
    expect(archive.suggestedFilename()).toBe(`${expected.outName}_maps.zip`);
    const entries = unzipSync(readFileSync(await archive.path()));
    for (const map of expected.maps) expect(Object.keys(entries)).toContain(`${expected.outName}_${map}.gii`);
    const r2 = giftiMap(entries[`${expected.outName}_r^2.gii`]);
    expect(r2).toHaveLength(VERTICES);
    expect(r2.filter((value) => value > 0).length, `${analysis}: vertices with R² > 0`).toBeGreaterThan(0);
    const x = giftiMap(entries[`${expected.outName}_x0.gii`]);
    const y = giftiMap(entries[`${expected.outName}_y0.gii`]);
    const ecc = giftiMap(entries[`${expected.outName}_ecc.gii`]);
    const mismatch = ecc.findIndex((value, v) => {
      const radius = Math.fround(Math.sqrt(Math.fround(Math.fround(x[v] * x[v]) + Math.fround(y[v] * y[v]))));
      return !Object.is(value, r2[v] === 0 ? 0 : Math.fround(radius - 0.5));
    });
    expect(mismatch, `${analysis}: legacy eccentricity at vertex ${mismatch}`).toBe(-1);
  }
}

test("app boots on its workspace with the shared bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("legacy export selection survives presets, disclosure and a saved model", async ({ page }) => {
  await page.goto("/");
  const advanced = page.getByText("Advanced settings", { exact: true });
  await advanced.click();
  const convention = page.getByLabel("Map export", { exact: true });
  await expect(convention).toHaveValue("samsrf-10.4");
  await convention.selectOption("samsrfx-10.003");
  await advanced.click();
  await page.locator("#analysis").selectOption("cf");
  await advanced.click();
  await expect(convention).toHaveValue("samsrfx-10.003");
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save model JSON" }).click();
  const model = JSON.parse(readFileSync(await (await saved).path(), "utf8"));
  expect(model.Export_Convention).toBe("samsrfx-10.003");
  await convention.selectOption("samsrf-10.4");
  await page.locator("#modelInput").setInputFiles({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(model)) });
  await expect(convention).toHaveValue("samsrfx-10.003");
});

test("custom model grids survive radius edits and circular tuning fixes its scale", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Advanced settings", { exact: true }).click();
  const editor = page.locator("#modelJson");
  const custom = { ...JSON.parse(await editor.inputValue()), Param1: [0.123, 0.456], Param2: [0.789], Param3: [1.234], Hrf: [0.2, 1, 0.5] };
  await editor.fill(JSON.stringify(custom));
  await editor.blur();
  await expect(page.locator("#hrf")).toHaveValue("custom");
  await page.locator("#scalingFactor").fill("12");
  await page.locator("#scalingFactor").blur();
  expect(JSON.parse(await editor.inputValue())).toMatchObject({ ...custom, Scaling_Factor: 12 });
  await page.locator("#preset").selectOption("tuning-circular");
  await expect(page.locator("#scalingFactor")).toHaveValue("1");
  await expect(page.locator("#scalingFactor")).toHaveAttribute("readonly", "");
  expect(JSON.parse(await editor.inputValue()).Scaling_Factor).toBe(1);
  await page.locator("#preset").selectOption("gaussian");
  await expect(page.locator("#scalingFactor")).toHaveValue("12");
  expect(JSON.parse(await editor.inputValue()).Param2[0]).toBe(12 / 32);
  await page.locator("#preset").selectOption("tuning-circular");
  await page.locator("#analysis").selectOption("rc");
  await expect(page.locator("#scalingFactor")).toHaveValue("12");
  await page.locator("#analysis").selectOption("prf");
  await page.locator("#preset").selectOption("tuning-circular");
  await page.locator("#analysis").selectOption("cf");
  await page.locator("#analysis").selectOption("prf");
  await page.locator("#preset").selectOption("gaussian");
  await expect(page.locator("#scalingFactor")).toHaveValue("12");
  expect(JSON.parse(await editor.inputValue()).Param2[0]).toBe(12 / 32);
});

for (const target of ['#runsDrop label', 'body']) {
  test(`Clear inputs abandons pending folder discovery on ${target}`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate(target => {
      const entry = { isFile: true, isDirectory: false, name: 'lh_old.gii', file: callback => {
        globalThis.finishOldDrop = () => callback(new File(['x'], 'lh_old.gii'));
      } };
      let read = false;
      const directory = { isDirectory: true, isFile: false, name: 'old', createReader: () => ({ readEntries: callback => {
        callback(read ? [] : [entry]);
        read = true;
      } }) };
      const event = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => directory }], files: [] } });
      document.querySelector(target).dispatchEvent(event);
    }, target);
    await expect.poll(() => page.evaluate(() => typeof globalThis.finishOldDrop)).toBe('function');
    await page.getByRole('button', { name: 'Clear inputs', exact: true }).click();
    await page.evaluate(async () => {
      globalThis.finishOldDrop();
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator('#runsInfo')).toBeHidden();
    await expect(page.locator('#runButton')).toBeDisabled();
    await page.locator('#runsInput').setInputFiles(['rh_new.gii', 'aps.mat'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('x') })));
    await expect(page.locator('#runsInfo')).toHaveText('rh_new.gii');
    await expect(page.locator('#runButton')).toBeEnabled();
  });
}

test("a folder with ambiguous anatomy is rejected without replacing inputs", async ({ page }) => {
  await page.goto("/");
  await page.locator("#runsInput").setInputFiles(['lh.area', 'rh.area'].map(name => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from('x') })));
  await expect(page.locator("#statusText")).toContainText("ambiguous");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("hemisphere replacements disable Run until consistent and inputs can be cleared", async ({ page }) => {
  await page.goto("/");
  const file = name => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from('x') });
  await page.locator("#runsInput").setInputFiles(['lh_run.gii', 'aps.mat', 'lh.V123.label'].map(file));
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runsInput").setInputFiles(file('rh_run.gii'));
  await expect(page.locator("#runsInfo")).toHaveText('rh_run.gii');
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#runHint")).toContainText('matching hemispheres');
  await page.locator("#roiInput").setInputFiles(file('rh.V123.label'));
  await expect(page.locator("#runButton")).toBeEnabled();
  // The example retains CF files and anatomy even while pRF is selected.
  await loadExample(page);
  await page.locator("#runsInput").setInputFiles(file('rh_run.gii'));
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.getByRole('button', { name: 'Clear inputs', exact: true }).click();
  await expect(page.locator("#runsInfo")).toBeHidden();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "idle");
  await expect(page.locator(".nd-viewer-empty")).toBeVisible();
  await page.locator("#runsInput").setInputFiles(['rh_run.gii', 'aps.mat', 'rh.V123.label'].map(file));
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#analysis").selectOption('cf');
  await expect(page.locator("#templateDrop")).not.toContainText('lh_benson.gii');
  await expect(page.locator("#seedDrop")).not.toContainText('lh.V1_seed.label');
});

test("the example runs every analysis on part of V1-V3 and downloads SamSrf's maps", async ({ page }) => {
  test.setTimeout(900000);
  await loadExample(page);
  await expect(page.locator(".nd-viewer-empty")).toBeHidden();
  await useSmallRoi(page);
  await runEveryAnalysis(page, 600000);
});

test("the example runs every analysis on the whole V1-V3 label", { tag: '@slow' }, async ({ page }) => {
  test.setTimeout(3600000);
  await loadExample(page);
  await runEveryAnalysis(page, 3000000);
});

test("the R² threshold hides vertices without rerunning", async ({ page }) => {
  test.setTimeout(1800000);
  await loadExample(page);
  await page.locator("#analysis").selectOption("rc");
  await page.locator("#runButton").click();
  await expect(page.locator("#location")).toContainText("vertices with R²", { timeout: 1500000 });
  const count = async () => Number(/(\d+) vertices/.exec(await page.locator("#location").textContent())[1]);
  const before = await count();
  await page.locator("#r2Threshold").fill("0.9");
  await expect(page.locator("#location")).toContainText("R² > 0.90");
  expect(await count()).toBeLessThan(before);
});

test("cancelling a run leaves the inputs ready for another", async ({ page }) => {
  test.setTimeout(600000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("a failed example download can be retried", async ({ page }) => {
  test.setTimeout(600000);
  await serveLocalExample(page);
  let attempts = 0;
  await page.route(example.files[6].url, async (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ body: await exampleBytes(example.files[6]) });
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 300000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("a dropped folder fills every input slot", async ({ page }) => {
  await page.goto("/");
  const file = (name, text = "x") => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
  await page.locator("#runsInput").setInputFiles([
    file("lh_uBars2.gii"), file("lh_uBars1.gii"), file("aps_Bars.mat"), file("lh.V123.label"),
    file("lh.V1_seed.label"), file("lh_benson.gii"), file("lh.white"), file("lh.area"),
  ]);
  await expect(page.locator("#runsInfo")).toHaveText("lh_uBars1.gii, lh_uBars2.gii");
  await expect(page.locator("#aperturesDrop")).toContainText("aps_Bars.mat");
  await expect(page.locator("#roiDrop")).toContainText("lh.V123.label");
  await expect(page.locator("#surfacesDrop")).toContainText("lh.white, lh.area");
  await page.locator("#analysis").selectOption("cf");
  await expect(page.locator("#templateDrop")).toContainText("lh_benson.gii");
  await expect(page.locator("#seedDrop")).toContainText("lh.V1_seed.label");
  await expect(page.locator("#runButton")).toBeEnabled();
});

/** A FreeSurfer surface as MATLAB's write_surf writes it: nothing after the faces. */
function withoutTags(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counts = bytes.indexOf(0x0a, bytes.indexOf(0x0a, 3) + 1) + 1;
  const end = counts + 8 + (view.getInt32(counts, false) + view.getInt32(counts + 4, false)) * 12;
  expect(end, "the example surface ends with FreeSurfer's tags").toBeLessThan(bytes.length);
  return bytes.subarray(0, end);
}

test("maps draw on a FreeSurfer surface written without tags", async ({ page }) => {
  test.setTimeout(900000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loadExample(page);
  await useSmallRoi(page);
  const inflated = example.files.find((file) => file.role === "inflated");
  const curv = example.files.find((file) => file.role === "curv");
  await page.locator("#surfacesInput").setInputFiles([
    { name: inflated.name, mimeType: "application/octet-stream", buffer: withoutTags(await exampleBytes(inflated)) },
    { name: curv.name, mimeType: "application/octet-stream", buffer: await exampleBytes(curv) },
  ]);
  await expect(page.locator("#statusText")).toHaveText("Ready");
  await expect(page.locator(".nd-viewer-empty")).toBeHidden();
  await page.locator("#analysis").selectOption("rc");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(RUNS.rc.outcome, { timeout: 600000 });
  await expect(page.locator("#location")).toContainText("vertices with R²");
  expect(errors).toEqual([]);
});

/** Hold the first read of each named file until the test releases it: the app and NiiVue read dropped files with arrayBuffer(). */
async function holdFirstReads(page, names) {
  await page.addInitScript((held) => {
    const read = Blob.prototype.arrayBuffer;
    const pending = new Set(held);
    const waiting = new Map();
    Blob.prototype.arrayBuffer = function () {
      if (!(this instanceof File) || !pending.delete(this.name)) return read.call(this);
      return new Promise((resolve, reject) => waiting.set(this.name, () => read.call(this).then(resolve, reject)));
    };
    globalThis.heldReads = () => [...waiting.keys()];
    globalThis.releaseRead = (name) => {
      waiting.get(name)();
      waiting.delete(name);
    };
  }, names);
}

async function heldRead(page, name) {
  await expect.poll(() => page.evaluate(() => globalThis.heldReads())).toEqual([name]);
}

/** The canvas once two screenshots a second apart agree. */
async function settledCanvas(page) {
  let previous = await page.locator("#gl1").screenshot();
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(1000);
    const next = await page.locator("#gl1").screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error("the viewer kept changing");
}

const showingLines = async (page) => (await page.locator("#technicalLog").textContent()).match(/Showing lh\.inflated/g)?.length ?? 0;

test("clearing the inputs while a surface loads leaves no surface for the next run", async ({ page }, testInfo) => {
  test.setTimeout(900000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // NiiVue reads the curvature layer after it has taken the mesh it will add the layer to.
  await holdFirstReads(page, ["lh.curv.mz3"]);
  await page.goto("/");
  await page.locator("#analysis").selectOption("rc");
  await page.locator("#surfacesInput").setInputFiles([await examplePath(testInfo, "lh.inflated"), await examplePath(testInfo, "lh.curv")]);
  await heldRead(page, "lh.curv.mz3");
  await page.getByRole("button", { name: "Clear inputs", exact: true }).click();
  await page.evaluate(() => globalThis.releaseRead("lh.curv.mz3"));
  await expect(page.locator(".nd-viewer-empty")).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(page.locator(".nd-viewer-empty")).toBeVisible();
  await expect(page.locator("#surfacesDrop")).toContainText("Drop surfaces");
  expect(await showingLines(page)).toBe(0);
  await page.locator("#runsInput").setInputFiles([await examplePath(testInfo, "lh_uBars1.gii"), await examplePath(testInfo, "aps_Bars.mat"), await smallRoiPath(testInfo)]);
  await page.locator("#runButton").click();
  await expect(page.locator("#downloadAll")).toBeEnabled({ timeout: 600000 });
  await expect(page.locator("#statusText")).toHaveText(/^Reverse-correlation maps ready \(\d+\.\d s\)$/);
  await expect(page.locator("#location")).toHaveText("");
  expect(errors).toEqual([]);
});

test("a surface replaced while it loads leaves only the replacement on screen", async ({ page }, testInfo) => {
  test.setTimeout(600000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await holdFirstReads(page, ["lh.inflated"]);
  await page.goto("/");
  await page.locator("#surfacesInput").setInputFiles([await examplePath(testInfo, "lh.inflated"), await examplePath(testInfo, "lh.curv")]);
  await heldRead(page, "lh.inflated");
  // The white surface under the inflated surface's name: same vertices, other geometry.
  await page.locator("#surfacesInput").setInputFiles({ name: "lh.inflated", mimeType: "application/octet-stream", buffer: readFileSync(await examplePath(testInfo, "lh.white")) });
  await expect(page.locator("#technicalLog")).toContainText("Showing lh.inflated shaded by lh.curv");
  await expect(page.locator(".nd-viewer-empty")).toBeHidden();
  const replacement = await settledCanvas(page);
  await page.evaluate(() => globalThis.releaseRead("lh.inflated"));
  await page.waitForTimeout(3000);
  expect((await settledCanvas(page)).equals(replacement), "the viewer still shows the replacement").toBe(true);
  expect(await showingLines(page)).toBe(1);
  await expect(page.locator("#statusText")).toHaveText("Add the remaining inputs");
  expect(errors).toEqual([]);
});

test("a surface the viewer cannot read is reported in the status bar", async ({ page }) => {
  await page.goto("/");
  const file = (name, text) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
  await page.locator("#surfacesInput").setInputFiles(file("lh.inflated", "not a surface"));
  await expect(page.locator("#statusText")).toHaveText("The surface could not be shown: lh.inflated: FreeSurfer: unknown surface magic number 7237492");
  await expect(page.locator(".nd-viewer-empty")).toBeVisible();
  await page.locator("#surfacesInput").setInputFiles(file("lh.inflated.surf.gii", "<GIFTI"));
  await expect(page.locator("#statusText")).toHaveText("The surface could not be shown: lh.inflated.surf.gii: GIFTI: tag at byte 0 is never closed");
  await expect(page.locator(".nd-viewer-empty")).toBeVisible();
  // The engine reads a surface without vertices; NiiVue logs that it cannot load it and adds nothing.
  const empty = Buffer.concat([Buffer.from([0xff, 0xff, 0xfe]), Buffer.from("created by test\n\n"), Buffer.alloc(8)]);
  await page.locator("#surfacesInput").setInputFiles({ name: "lh.inflated", mimeType: "application/octet-stream", buffer: empty });
  await expect(page.locator("#statusText")).toHaveText("The surface could not be shown: lh.inflated: the viewer could not draw this surface.");
  await expect(page.locator(".nd-viewer-empty")).toBeVisible();
});

test("automation runs a reverse-correlation analysis on the example's files", async ({ page }, testInfo) => {
  test.setTimeout(1800000);
  const roles = { runs: example.files.filter(({ role }) => role === "run").slice(0, 1), apertures: [example.files[6]], roi: [example.files[7]], surfaces: [example.files[10], example.files[11]] };
  await page.goto("/");
  await page.locator("#preset").selectOption("tuning-circular");
  for (const [role, files] of Object.entries(roles)) {
    const paths = [];
    for (const file of files) {
      const path = local ? join(local, file.name) : testInfo.outputPath(file.name);
      if (!local) writeFileSync(path, await exampleBytes(file));
      paths.push(path);
    }
    await page.locator("#neurodesk-input-transfer").setInputFiles(paths);
    await page.evaluate((target) => globalThis.neurodeskAutomation.dispatch("adopt", { role: target }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", { operation: "rc", parameters: { tr: 1, scalingFactor: 9.5 } }));
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 1500000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("samsrf-rc");
  expect(report.provenance.model.Aperture_File).toBe("aps_Bars");
  expect(report.provenance.model.Scaling_Factor).toBe(9.5);
});

/** Run each (analysis, precision) in the app on part of the example and require every downloaded map to equal the package's in-process job. */
/** A path to an example file, written from Hugging Face unless SAMSRF_EXAMPLE_DIR has it. */
async function examplePath(testInfo, name) {
  const path = local ? join(local, name) : testInfo.outputPath(name);
  if (!local) writeFileSync(path, await exampleBytes(example.files.find(file => file.name === name)));
  return path;
}

/** The first SMALL_ROI vertices of the example's V1-V3 label, as a label file. */
async function smallRoiPath(testInfo) {
  const roi = testInfo.outputPath("lh.V123_small.label");
  const lines = (await exampleBytes(example.files.find((file) => file.name === "lh.V123.label"))).toString("utf8").split("\n");
  writeFileSync(roi, [lines[0], String(SMALL_ROI), ...lines.slice(2, 2 + SMALL_ROI), ""].join("\n"));
  return roi;
}

async function downloadsEqualInProcessJobs(page, testInfo, runs, { subjectHrf } = {}) {
  const file = (name) => examplePath(testInfo, name);
  const roi = await smallRoiPath(testInfo);
  const paths = {
    runs: [await file("lh_uBars1.gii")], apertures: [await file("aps_Bars.mat")], roi: [roi],
    surfaces: [await file("lh.white"), await file("lh.area")], template: [await file("lh_benson.gii")], seed: [await file("lh.V1_seed.label")],
  };
  await page.goto("/");
  const roles = { prf: ["runs", "apertures", "roi", "surfaces"], rc: ["runs", "apertures", "roi", "surfaces"], cf: ["runs", "roi", "surfaces", "template", "seed"] };
  for (const [analysis, precision] of runs) {
    const inputs = readAnalysisInputs({
      runs: paths.runs, roi, seed: paths.seed[0], apertures: paths.apertures[0], template: paths.template[0],
      white: paths.surfaces[0], area: paths.surfaces[1], hemisphere: "lh", precision,
    });
    await page.locator("#analysis").selectOption(analysis);
    for (const role of roles[analysis]) await page.locator(`#${role}Input`).setInputFiles(paths[role]);
    if (subjectHrf) {
      // A drop reaches the first input, as the shell's page drop delivers it; the fit finds its own slot.
      await page.locator("#runsInput").setInputFiles(subjectHrf);
      await expect(page.locator("#subjectHrfDrop")).toContainText(basename(subjectHrf));
      await expect(page.locator("#hrf")).toHaveValue("subject");
    }
    await page.locator("#advancedSettings").evaluate(element => { element.open = true; });
    await page.locator("#dataPrecision").selectOption(precision);
    const model = JSON.parse(await page.locator("#modelJson").inputValue());
    expect(model.Data_Precision).toBe(precision);
    if (subjectHrf) expect(model.Hrf).toBe(basename(subjectHrf, ".mat"));
    await expect(page.locator("#runButton")).toBeEnabled();
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText(RUNS[analysis].outcome, { timeout: 1500000 });
    const zipped = page.waitForEvent("download");
    await page.locator("#downloadAll").click();
    const entries = unzipSync(readFileSync(await (await zipped).path()));
    const spec = analysisSpec(inputs, analysis, model);
    if (subjectHrf) spec.hrf = hrf.oldSchool(model.TR, readOldSchoolHrf(readFileSync(subjectHrf)));
    const job = createJob(spec);
    const prefix = `lh_${job.modelName}${job.outSuffix}`;
    let expected;
    try {
      expected = exportGiis(runJob(job).maps, prefix, null, model.Export_Convention);
    } finally {
      job.free();
    }
    expect(expected.length).toBeGreaterThan(0);
    for (const { name, bytes } of expected) {
      expect(entries[name], `${analysis}: ${name}`).toBeDefined();
      expect(Buffer.from(entries[name]).equals(Buffer.from(bytes)), `${analysis}: ${name} equals the package's map`).toBe(true);
    }
    const r2 = giftiMap(entries[`${prefix}_r^2.gii`]);
    expect(r2.filter(value => value > 0).length, `${analysis}: vertices with R² > 0`).toBeGreaterThan(0);
  }
}

test("MATLAB single precision RC and CF downloads equal the package's in-process jobs", async ({ page }, testInfo) => {
  test.setTimeout(1800000);
  await downloadsEqualInProcessJobs(page, testInfo, [["rc", "single"], ["cf", "single"]]);
});

test("double pRF downloads equal the package's in-process job", async ({ page }, testInfo) => {
  test.setTimeout(1800000);
  await downloadsEqualInProcessJobs(page, testInfo, [["prf", "double"]]);
});

test("a dropped subject HRF fit runs reverse correlation and pRF fits as the package's jobs do", async ({ page }, testInfo) => {
  test.setTimeout(1800000);
  const subjectHrf = testInfo.outputPath("hrf_subject.mat");
  writeFileSync(subjectHrf, matFile({ fP: { dims: [1, 4], data: [5.5, 15.5, 5, 2] } }));
  await downloadsEqualInProcessJobs(page, testInfo, [["rc", "double"], ["prf", "single"]], { subjectHrf });
});

test("a subject HRF fit must be named hrf_*.mat; a malformed fit or a vertex-wise map stops the run", async ({ page }, testInfo) => {
  test.setTimeout(600000);
  const file = (name, text) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
  const roi = await smallRoiPath(testInfo);
  await page.goto("/");
  await page.locator("#analysis").selectOption("rc");
  await page.locator("#runsInput").setInputFiles(await examplePath(testInfo, "lh_uBars1.gii"));
  await page.locator("#aperturesInput").setInputFiles(await examplePath(testInfo, "aps_Bars.mat"));
  await page.locator("#roiInput").setInputFiles(roi);
  await expect(page.locator("#subjectHrfField")).toBeHidden();
  await page.locator("#advancedSettings").evaluate(element => { element.open = true; });
  const setHrf = async (value) => {
    const model = JSON.parse(await page.locator("#modelJson").inputValue());
    await page.locator("#modelJson").fill(JSON.stringify({ ...model, Hrf: value }));
    await page.locator("#modelJson").dispatchEvent("change");
  };
  await setHrf("hrf_fit");
  await expect(page.locator("#subjectHrfField")).toBeVisible();
  await expect(page.locator("#runHint")).toHaveText("Needs the subject HRF hrf_fit.mat");
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#subjectHrfInput").setInputFiles(file("fit.mat", "x"));
  await expect(page.locator("#statusText")).toHaveText("fit.mat: SamSrf reads a subject HRF fit from a file named hrf_*.mat.");
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#subjectHrfInput").setInputFiles(file("hrf_fit.mat", "not a MAT file"));
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("hrf_fit.mat: ", { timeout: 300000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#downloadAll")).toBeDisabled();
  await setHrf("lh_hrf_fits");
  await expect(page.locator("#hrf")).toHaveValue("custom");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("model: Hrf lh_hrf_fits is a vertex-wise HRF fit map: the caller must load it", { timeout: 300000 });
  await expect(page.locator("#downloadAll")).toBeDisabled();
});

test("MATLAB fit settings round-trip through JSON and remain in collapsed settings", async ({ page }) => {
  await page.goto("./");
  await page.locator("#advancedSettings").evaluate(element => { element.open = true; });
  await page.locator("#dataPrecision").selectOption("single");
  const model = JSON.parse(await page.locator("#modelJson").inputValue());
  model.Compressive_Nonlinearity = true;
  await page.locator("#modelJson").fill(JSON.stringify(model));
  await page.locator("#modelJson").dispatchEvent("change");
  await expect(page.locator("#cssConvention")).toBeVisible();
  await page.locator("#cssConvention").selectOption("samsrf");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#advancedSettings > summary").click();
  await expect(page.locator("#dataPrecision")).toHaveValue("single");
  await expect(page.locator("#cssConvention")).toHaveValue("samsrf");
  const downloading = page.waitForEvent("download");
  await page.locator("#saveModel").click();
  const download = await downloading;
  const saved = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(saved.Data_Precision).toBe("single");
  expect(saved.Css_Convention).toBe("samsrf");
  expect(saved.Compressive_Nonlinearity).toBe(true);
  await page.locator("#analysis").selectOption("cf");
  await expect(page.locator("#dataPrecision")).toHaveValue("single");
  expect(JSON.parse(await page.locator("#modelJson").inputValue()).Data_Precision).toBe("single");
  await expect(page.locator("#cssConvention")).toBeHidden();
});
