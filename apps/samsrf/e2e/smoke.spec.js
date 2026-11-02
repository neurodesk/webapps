// Browser tests against `vite preview` of the built app (playwright.config.js).
// SAMSRF_EXAMPLE_DIR serves the example from a local copy instead of Hugging Face.
//
// The analyses run whatever engine src/engine.js wires. The checks here hold for the
// placeholder engine and for SamSrf alike: SamSrf's file names, one value per surface
// vertex, and a downloadable zip. Numeric parity belongs to @neurodesk/samsrf's own tests.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const example = examples[0];
const local = process.env.SAMSRF_EXAMPLE_DIR;
// lh.white and lh.inflated of the example both have this many vertices.
const VERTICES = 134260;

async function serveLocalExample(page) {
  if (!local) return;
  for (const file of example.files) {
    await page.route(file.url, (route) => route.fulfill({ body: readFileSync(join(local, file.name)) }));
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

function giftiVertices(bytes) {
  const match = /Dim0="(\d+)"/.exec(Buffer.from(bytes).subarray(0, 4096).toString("utf8"));
  return match ? Number(match[1]) : null;
}

const RUNS = {
  prf: { outName: "lh_pRF_Gaussian", maps: ["pol", "ecc", "r^2", "x0", "y0", "sigma"] },
  rc: { outName: "lh_pRF", maps: ["pol", "ecc", "r^2", "x0", "y0"] },
  cf: { outName: "lh_CF_Rcp", maps: ["pol", "ecc", "r^2", "x0", "y0"] },
};

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

test("the example runs every analysis and downloads SamSrf's maps", async ({ page }) => {
  test.setTimeout(1800000);
  await loadExample(page);
  await expect(page.locator(".nd-viewer-empty")).toBeHidden();
  for (const [analysis, expected] of Object.entries(RUNS)) {
    await page.locator("#analysis").selectOption(analysis);
    const run = page.locator("#runButton");
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.locator("#outputSection")).toHaveAttribute("open", "", { timeout: 1500000 });
    await expect(page.locator("#statusText")).toContainText("maps ready");
    for (const label of ["Polar angle", "Eccentricity", "R²"]) {
      await expect(page.locator("#resultList")).toContainText(label);
    }
    await expect(page.locator("#location")).toContainText("vertices with R²");

    const row = page.locator("#resultList .nd-volume-toggle", { hasText: "Polar angle" });
    const single = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download", exact: true }).click();
    const download = await single;
    expect(download.suggestedFilename()).toBe(`${expected.outName}_pol.gii`);
    expect(giftiVertices(readFileSync(await download.path()))).toBe(VERTICES);

    const zipped = page.waitForEvent("download");
    await page.locator("#downloadAll").click();
    const archive = await zipped;
    expect(archive.suggestedFilename()).toBe(`${expected.outName}_maps.zip`);
    const entries = unzipSync(readFileSync(await archive.path()));
    for (const map of expected.maps) expect(Object.keys(entries)).toContain(`${expected.outName}_${map}.gii`);
  }
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

test("automation runs a reverse-correlation analysis on the example's files", async ({ page }) => {
  test.setTimeout(1800000);
  const roles = { runs: example.files.filter(({ role }) => role === "run").slice(0, 1), apertures: [example.files[6]], roi: [example.files[7]], surfaces: [example.files[10], example.files[11]] };
  await page.goto("/");
  for (const [role, files] of Object.entries(roles)) {
    const payloads = [];
    for (const file of files) payloads.push({ name: file.name, mimeType: "application/octet-stream", buffer: await exampleBytes(file) });
    await page.locator("#neurodesk-input-transfer").setInputFiles(payloads);
    await page.evaluate((target) => globalThis.neurodeskAutomation.dispatch("adopt", { role: target }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", { operation: "rc", parameters: { tr: 1, scalingFactor: 9.5 } }));
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 1500000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("samsrf-rc");
  expect(report.provenance.model.Aperture_File).toBe("aps_Bars");
});
