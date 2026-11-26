// Browser tests against `vite preview` of the production build: shared shell, LayNii
// LN2_LAYERS + LN2_PROFILE on the pinned hosted Ding2016 and 7T motor examples against native LayNii 2.10.0,
// profile chart/CSV download, validation refusals, worker cancellation, failure/retry, and WebMCP automation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loadLaynii } from "@neurodesk/laynii/node";
import {
  inflate,
  makeCorticalSlabRim,
  makeDepthGradientSignal,
  makeInvalidRim,
  makeOversizedHeaderNifti,
  motorExample,
  niftiFile,
  primaryExample,
  primaryRimFile,
  primarySignalFile,
  sha256,
} from "./fixtures.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const download = await event;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

test("app boots in workspace with idle status and disabled run", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("shared app bar owns About, Cite, Privacy and theme toggle", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const about = page.locator('dialog[data-dialog="about"]');
  await expect(about).toBeVisible();
  await expect(about.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await expect(about).toContainText("LN2_LAYERS");
  await about.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("pinned reference metadata matches primary example", () => {
  expect(expected.example.id).toBe(primaryExample.id);
  expect(expected.example.rim.sha256).toBe(primaryRimFile.sha256);
  expect(expected.example.signal.sha256).toBe(primarySignalFile.sha256);
});

test("hosted occipital example reproduces native LayNii 2.10.0 equidistant and equivolume outputs byte for byte", async ({ page }) => {
  test.setTimeout(240000);
  const eqRef = expected.cases.find((entry) => entry.id === "default-equidist-3");
  const evRef = expected.cases.find((entry) => entry.id === "equivol-thickness-3");
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#runButton")).toHaveText("Compute layers & profile");

  // 1. Default equidistant 3-layer run
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Layers and profile ready", { timeout: 120000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const layers = await downloadRow(page, "Equidistant layers");
  expect(layers.name).toBe("Ding2016_occip_rim_layers_equidist.nii.gz");
  expect(sha256(inflate(layers.bytes))).toBe(eqRef.layersEquidistSha256);

  const metric = await downloadRow(page, "Equidistant depth metric");
  expect(sha256(inflate(metric.bytes))).toBe(eqRef.metricEquidistSha256);

  const profileCsv = await downloadRow(page, "Laminar profile");
  expect(profileCsv.name).toBe("Ding2016_occip_T2star_profile.csv");
  const lines = profileCsv.bytes.toString("utf8").trim().split("\n");
  expect(lines[0]).toBe("layer,mean,std,voxels");
  expect(lines).toHaveLength(4);
  for (let i = 0; i < eqRef.profile.length; i++) {
    const [layer, mean, std, voxels] = lines[i + 1].split(",").map(Number);
    expect(layer).toBe(eqRef.profile[i].layer);
    expect(voxels).toBe(eqRef.profile[i].voxels);
    expect(Math.abs(mean - eqRef.profile[i].mean)).toBeLessThan(1e-3);
    expect(Math.abs(std - eqRef.profile[i].std)).toBeLessThan(1e-3);
  }

  // Switch to the Profile tab and confirm chart + table render cleanly.
  await page.locator('.nd-view-tab[data-view="profile"]').click();
  await expect(page.locator("#profileReport")).toBeVisible();
  await expect(page.locator("#profileSummary")).toContainText("equidistant layers");
  await expect(page.locator("#profileChart svg.laynii-svg")).toBeVisible();
  await expect(page.locator("#profileBody tr")).toHaveCount(3);

  // 2. Equivolume + thickness run on the same hosted dataset against native LayNii 2.10.0 reference
  await page.locator("#equivol").check();
  await page.locator("#advancedSettings").evaluate((el) => { el.open = true; });
  await page.locator("#thickness").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Layers and profile ready", { timeout: 120000 });

  const evLayers = await downloadRow(page, "Equivolume layers");
  expect(sha256(inflate(evLayers.bytes))).toBe(evRef.layersEquivolSha256);
  const evThick = await downloadRow(page, "Cortical thickness");
  expect(sha256(inflate(evThick.bytes))).toBe(evRef.thicknessSha256);
  await expect(page.locator("#resultList")).toContainText("Equivolume mid-GM");
});

test("second hosted example (7T motor cortex BOLD) computes layers and laminar profile", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(motorExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("648 × 648 × 15");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Layers and profile ready", { timeout: 120000 });
  const profileCsv = await downloadRow(page, "Laminar profile");
  const rows = profileCsv.bytes.toString("utf8").trim().split("\n").slice(1).map((line) => line.split(",").map(Number));
  expect(rows).toHaveLength(3);
  for (const [, mean, , voxels] of rows) {
    expect(Number.isFinite(mean)).toBe(true);
    expect(voxels).toBeGreaterThan(10000);
  }
});

test("automation operation computes equivolume layers and profile and matches Node WASM", async ({ page }) => {
  test.setTimeout(120000);
  const rimBytes = makeCorticalSlabRim();
  const sigBytes = makeDepthGradientSignal();
  const parameters = { nrLayers: 4, equivol: true, iterSmooth: 20, thickness: true };
  const expectedNode = await (await loadLaynii()).runLayersAndProfile({
    rim: rimBytes,
    signal: sigBytes,
    ...parameters,
  });

  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(niftiFile("slab_rim.nii", rimBytes));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles(niftiFile("slab_sig.nii", sigBytes));
  const report = await page.evaluate(async (params) => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "signal" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: params });
    for (;;) {
      const snapshot = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (!["queued", "running"].includes(snapshot.state)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, parameters);

  expect(report.state).toBe("succeeded");
  expect(report.report.artifacts.layers_equivol).toBeTruthy();
  expect(report.report.artifacts.midgm_equivol).toBeTruthy();
  expect(report.report.artifacts.thickness).toBeTruthy();
  expect(report.report.artifacts.profile).toBeTruthy();
  await expect(page.locator("#nrLayers")).toHaveValue("4");
  await expect(page.locator("#equivol")).toBeChecked();

  const evDownload = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "layers_equivol" }));
  const evBytes = readFileSync(await (await evDownload).path());
  expect(sha256(evBytes)).toBe(report.report.artifacts.layers_equivol.sha256);
  expect(sha256(inflate(evBytes))).toBe(sha256(expectedNode.layersEquivol));

  const thickDownload = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "thickness" }));
  const thickBytes = readFileSync(await (await thickDownload).path());
  expect(sha256(thickBytes)).toBe(report.report.artifacts.thickness.sha256);
  expect(sha256(inflate(thickBytes))).toBe(sha256(expectedNode.thickness));
});

test("cancelling a running computation terminates its worker, leaves no output and permits retry", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });

  // Enable equivol + high smoothing iterations so the worker stays busy long enough to cancel deterministically.
  await page.locator("#equivol").check();
  await page.locator("#advancedSettings").evaluate((el) => { el.open = true; });
  await page.locator("#iterSmooth").fill("500");

  const workerPromise = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  const worker = await workerPromise;
  const closed = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await closed;

  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();

  // Retry cleanly with fast equidistant settings on a small slab.
  await page.locator("#equivol").uncheck();
  await page.locator("#imageInput").setInputFiles(niftiFile("slab_rim.nii", makeCorticalSlabRim()));
  await expect(page.locator("#statusText")).toHaveText("slab_rim.nii loaded", { timeout: 60000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cortical layers ready", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
});

test("malformed rim, scaled rim, affine-mismatched signal and oversized volume header are refused before WASM runs", async ({ page }) => {
  await page.goto("/");

  // 1. Invalid rim values (not 0..3)
  await page.locator("#imageInput").setInputFiles(niftiFile("not_a_rim.nii", makeInvalidRim()));
  await expect(page.locator("#statusText")).toContainText("raw integer labels 0");
  await expect(page.locator("#runButton")).toBeDisabled();

  // 2. Non-identity NIfTI scaling on rim
  await page.locator("#imageInput").setInputFiles(niftiFile("scaled_rim.nii", makeCorticalSlabRim([16, 16, 16], { sclSlope: 2.0 })));
  await expect(page.locator("#statusText")).toContainText("non-identity NIfTI intensity scaling");
  await expect(page.locator("#runButton")).toBeDisabled();

  // 3. Oversized volume (> 8M voxels) rejected before allocation
  await page.locator("#imageInput").setInputFiles(niftiFile("huge_7t.nii", makeOversizedHeaderNifti()));
  await expect(page.locator("#statusText")).toContainText("above the browser limit");
  await expect(page.locator("#runButton")).toBeDisabled();

  // 4. Valid rim loads, then mismatched matrix and mismatched affine signals are refused
  await page.locator("#imageInput").setInputFiles(niftiFile("slab_rim.nii", makeCorticalSlabRim([16, 16, 16])));
  await expect(page.locator("#statusText")).toHaveText("slab_rim.nii loaded", { timeout: 60000 });
  await page.locator("#signalInput").setInputFiles(niftiFile("wrong_grid.nii", makeDepthGradientSignal([16, 16, 12])));
  await expect(page.locator("#statusText")).toContainText("does not match the rim grid");
  await expect(page.locator("#clearSignal")).toBeHidden();

  await page.locator("#signalInput").setInputFiles(niftiFile("shifted_affine.nii", makeDepthGradientSignal([16, 16, 16], { offset: [0, 0, 5] })));
  await expect(page.locator("#statusText")).toContainText("orientation/affine does not match");
  await expect(page.locator("#clearSignal")).toBeHidden();
});

test("failed example download can retry cleanly", async ({ page }) => {
  test.setTimeout(150000);
  let attempts = 0;
  await page.context().route(primaryRimFile.url, (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, body: "" });
    return route.fallback();
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling during example read prevents a late commit and allows retry", async ({ page }) => {
  test.setTimeout(150000);
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
  await picker.selectOption(primaryExample.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});
