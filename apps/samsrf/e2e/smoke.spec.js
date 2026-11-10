// Browser tests against `vite preview` of the built app (playwright.config.js).
// SAMSRF_EXAMPLE_DIR serves the example from a local copy instead of Hugging Face.
//
// The analyses run @neurodesk/samsrf in the app's workers. The checks here are the app's:
// SamSrf's file names, one value per surface vertex, fitted R², and a downloadable zip.
// Numeric parity belongs to @neurodesk/samsrf's own tests.
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { readGifti } from "@neurodesk/samsrf/node";
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
  await expect(page.locator("#dataPrecision")).toBeHidden();
  await expect(page.locator("#cssConvention")).toBeHidden();
});
