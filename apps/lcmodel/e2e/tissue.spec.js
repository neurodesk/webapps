// Tissue correction through the real workflow on Osprey's Philips PRESS sub-01
// and its defaced T1: example, voxel on the T1, fractions, corrected table and
// downloads. The MindMap segmentation runs on the CPU module without a GPU
// (about two minutes on eight cores), so that test needs LCMODEL_E2E_LARGE=1;
// typed-in fractions cover the rest of the workflow on every run.
import { test, expect } from "@playwright/test";
import { forceCpu, proxyAssets, REPLACEMENT_TIMEOUT } from "./tissue-runtime.mjs";
import { readFileSync } from "node:fs";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";

const EXAMPLE = "philips-press-t1";

async function loadExample(page) {
  await proxyAssets(page);
  await forceCpu(page);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(EXAMPLE);
  await expect(page.locator("#t1Info")).toContainText("256 × 256 × 204", { timeout: 300000 });
  await expect(page.locator("#t1Canvas")).toBeVisible();
  await expect(page.locator("#viewerNotice")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 300000 });
  await expect(page.locator("#tissueSection")).toHaveAttribute("open", "");
  await expect(page.locator("#measureButton")).toBeEnabled();
}

function row(page, name) {
  return page.locator("#concBody tr").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${name.replace(/[+]/g, "\\+")}$`) }) });
}

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return readFileSync(await (await event).path());
}

test("the voxel sits on the T1 and typed fractions correct the concentrations", async ({ page }) => {
  test.setTimeout(400000);
  await loadExample(page);
  // The SPAR voxel: 30 mm cube centred at (0, -45.0, 37.7) mm RAS.
  await page.locator(".nd-view-tab", { hasText: "Voxel" }).click();
  await expect(page.locator("#plotLabel")).toContainText("Voxel 30 × 30 × 30 mm at 0.0, -45.0, 37.7 mm (RAS)", { timeout: 60000 });
  await expect(page.locator("#t1Canvas")).toBeVisible();
  // Osprey's documented fractions for this subject (SPM12): 0.60, 0.27, 0.13.
  await page.locator("#fGm").fill("0.60");
  await page.locator("#fWm").fill("0.27");
  await page.locator("#fCsf").fill("0.13");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 300000 });
  await expect(page.locator("#corrHeader")).toBeVisible();
  const lcm = Number(await row(page, "NAA+NAAG").locator("td").nth(1).textContent());
  const corrected = Number(await row(page, "NAA+NAAG").locator("td").nth(3).textContent());
  expect(lcm).toBeGreaterThan(3);
  expect(corrected).toBeGreaterThan(lcm);
  // The sidebar's last column switches between the tissue-corrected value and the ratio.
  await page.locator("#concColumn").selectOption("ratio");
  await expect(page.locator("#ratioHeader")).toBeVisible();
  await expect(page.locator("#corrHeader")).toBeHidden();
  expect(Number(await row(page, "NAA+NAAG").locator("td").nth(3).textContent())).toBeGreaterThan(1);
  await page.locator("#concColumn").selectOption("tissue");
  await expect(page.locator("#corrHeader")).toBeVisible();
  // Four columns fit the sidebar: the table needs no sideways scrolling.
  const fits = await page.locator("#concTable").evaluate((t) => t.scrollWidth <= t.parentElement.clientWidth + 1);
  expect(fits).toBe(true);
  // Collapsing and reopening the section keeps the fractions.
  await page.locator("#tissueSection > summary").click();
  await page.locator("#tissueSection > summary").click();
  await expect(page.locator("#fGm")).toHaveValue("0.60");
  const csv = (await download(page, "Tissue-corrected concentrations")).toString("utf8");
  expect(csv.split("\n")[0]).toMatch(/^Metabolite,LCModel \(mM\),SD \(%\),\/Cr\+PCr,Tissue-corrected \(mmol\/kg\),fGM,fWM,fCSF,/);
  expect(csv).toContain(",0.6,0.27,0.13,");
  const report = JSON.parse((await download(page, "Tissue correction inputs")).toString("utf8"));
  // Check the full-precision download: the sidebar displays three significant figures.
  // Osprey quantTiss at TE 35 / TR 2000 ms gives tNAA 25.7583426324 for 12 mM.
  const naa = report.concentrations.find((r) => r.name === "NAA+NAAG");
  expect(naa.corrected / naa.lcmodel).toBeCloseTo(25.7583426324 / 12, 6);
  expect(corrected).toBe(Number(naa.corrected.toPrecision(3)));
  expect(lcm).toBe(Number(naa.lcmodel.toPrecision(3)));
  expect(report.fractionSource).toBe("entered");
  expect(report.voxel.sizeMm).toEqual([30, 30, 30]);
  const mask = await download(page, "Voxel mask");
  expect(mask.length).toBeGreaterThanOrEqual(352 + 256 * 256 * 204 * 4);
});

test("MindMap segments the T1 and measures the voxel", async ({ page }) => {
  test.skip(!process.env.LCMODEL_E2E_LARGE, "set LCMODEL_E2E_LARGE=1: segmentation on the CPU takes minutes");
  test.setTimeout(1200000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 1100000 });
  await expect(page.locator("#tissueSummary")).toContainText("MindMap");
  await expect(page.locator('.nd-view-tab[data-view="voxel"]')).toHaveClass(/active/);
  await expect(page.locator("#tissueMap")).toHaveValue("gm");
  await expect(page.locator("#t1Canvas")).toBeVisible();
  const f = await Promise.all(["#fGm", "#fWm", "#fCsf"].map(async (id) => Number(await page.locator(id).inputValue())));
  // A posterior cingulate voxel on the midline: mostly grey matter, a third
  // white matter, and sulcal and interhemispheric CSF.
  expect(f[0]).toBeGreaterThan(0.4);
  expect(f[0]).toBeLessThan(0.7);
  expect(f[1]).toBeGreaterThan(0.2);
  expect(f[2]).toBeGreaterThan(0.05);
  expect(Math.abs(f[0] + f[1] + f[2] - 1)).toBeLessThan(0.002);
  await expect(page.locator("#corrHeader")).toBeVisible();
  const report = JSON.parse((await download(page, "Tissue correction inputs")).toString("utf8"));
  expect(report.fractionSource.method).toContain("MindMap");
  expect(report.fractionSource.backend).toBe("cpu");
  // MindMap writes 8-bit maps with a scale factor.
  expect((await download(page, "Grey matter map")).length).toBeGreaterThanOrEqual(352 + 256 * 256 * 204);
  await expect(page.locator("#dataInput")).toBeEnabled();
  await page.locator("#dataInput").setInputFiles({
    name: "replacement.nii", mimeType: "application/octet-stream",
    buffer: syntheticNifti({ dims: [32, 32, 32], gzip: false }),
  });
  await expect(page.locator("#t1Info")).toContainText("replacement.nii", { timeout: REPLACEMENT_TIMEOUT });
  await expect(page.locator("#fGm")).toHaveValue("");
  await expect(page.locator("#corrHeader")).toBeHidden();
  await expect(page.locator('#resultList [data-stage="gmMap"]')).toHaveCount(0);
  await expect(page.locator("#t1Canvas")).toBeVisible();
});

test("a GPU run that fails is measured on the CPU instead", async ({ page }) => {
  test.skip(!process.env.LCMODEL_E2E_LARGE, "set LCMODEL_E2E_LARGE=1: segmentation on the CPU takes minutes");
  test.setTimeout(1200000);
  await proxyAssets(page);
  // The page and worker both see a usable WebGPU adapter, so the app picks
  // WebGPU and the worker tries to fetch MindMap's WebGPU weights even in
  // headless Chromium without a GPU. Aborting the weights request makes the
  // GPU run fail deterministically and exercise the real CPU fallback.
  let blockedGpuRequests = 0;
  await page.context().route(/(?:models\/mindmap\.bin|brainchop-mindmap-gl\.(?:js|wasm))$/, (route) => {
    blockedGpuRequests += 1;
    return route.abort();
  });
  const gpuShim = `(() => {
    const limits = { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 256 * 1024 * 1024, maxComputeWorkgroupStorageSize: 32768 };
    const device = { limits, features: new Set(), lost: new Promise(() => {}), destroy() {} };
    const adapter = { info: { isFallbackAdapter: false }, features: new Set(), limits, requestDevice: async () => device };
    Object.defineProperty(navigator, "gpu", { configurable: true, value: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" } });
  })();\n`;
  await page.context().route(/\/tissue-worker-[^/]+\.js$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      contentType: "text/javascript",
      body: gpuShim + (await response.text()),
    });
  });
  await page.addInitScript(gpuShim);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(EXAMPLE);
  await expect(page.locator("#t1Info")).toContainText("256 × 256 × 204", { timeout: 300000 });
  await expect(page.locator("#measureButton")).toBeEnabled();
  await page.locator("#measureButton").click();
  const log = page.locator("#technicalLog");
  await expect(log).toContainText("Segmenting with MindMap on webgpu");
  await expect(log).toContainText("segmenting on the CPU instead", { timeout: 120000 });
  expect(blockedGpuRequests).toBeGreaterThan(0);
  await expect(page.locator("#tissueSummary")).toContainText("MindMap", { timeout: 1100000 });
  await expect(log).toContainText("MindMap tissue maps on cpu");
});

test("both failed segmentation attempts retain their last 40 module log lines", async ({ page }) => {
  test.setTimeout(400000);
  await proxyAssets(page);
  await page.context().route(/\/tissue-worker-[^/]+\.js$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      contentType: "text/javascript",
      body: `self.onmessage = ({ data: { options } }) => {
      const backend = options.backend;
      const log = Array.from({ length: 45 }, (_, index) => backend + " module line " + index);
      self.postMessage({ error: backend + " module failed", log });
      };`,
    });
  });
  await page.addInitScript(() => {
    const adapter = { info: { isFallbackAdapter: false }, features: new Set(["shader-f16"]) };
    Object.defineProperty(navigator, "gpu", { value: { requestAdapter: async () => adapter } });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(EXAMPLE);
  await expect(page.locator("#measureButton")).toBeEnabled({ timeout: 300000 });
  await page.locator("#measureButton").click();
  await expect(page.locator("#statusText")).toContainText("Segmentation failed: cpu module failed");
  const log = page.locator("#technicalLog");
  for (const backend of ["webgpu", "cpu"]) {
    await expect(log).toContainText(`MindMap: ${backend} module line 5`);
    await expect(log).toContainText(`MindMap: ${backend} module line 44`);
    await expect(log).not.toContainText(`MindMap: ${backend} module line 0`);
  }
  await expect(page.locator("#measureButton")).toBeEnabled();
  for (const id of ["#fGm", "#fWm", "#fCsf"]) await expect(page.locator(id)).toHaveValue("");
});
