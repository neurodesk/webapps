import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { proxyAssets } from "./tissue-runtime.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
async function spectroscopyFiles(id = "philips-press-t1") {
  const example = examples.find((e) => e.id === id);
  return Promise.all(example.files.filter((file) => file.role !== "t1").map(async (file) => {
    const response = await fetch(file.url);
    expect(response.ok).toBe(true);
    return { name: file.name, mimeType: "application/octet-stream", buffer: Buffer.from(await response.arrayBuffer()) };
  }));
}

test("a separate water reference keeps the spectrum and a failed replacement keeps the resident fit", async ({ page }) => {
  test.setTimeout(300000);
  await proxyAssets(page);
  const files = await spectroscopyFiles();
  const spectra = files.filter((file) => file.name.includes("_act."));
  const water = files.filter((file) => file.name.includes("_ref.")).map((file) => ({ ...file, name: `reference.${file.name.split(".").at(-1)}` }));
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(spectra);
  await expect(page.locator("#datasetSummary")).toContainText("no water reference");
  await page.locator("#waterSection > summary").click();
  await page.locator("#waterInput").setInputFiles(water);
  await expect(page.locator("#statusText")).toHaveText("Water reference attached to the selected dataset.");
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await expect(page.locator("#waterInfo")).toContainText("reference");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 120000 });
  const naa = page.locator("#concBody tr").filter({ has: page.locator("td:first-child", { hasText: /^NAA$/ }) }).locator("td").nth(1);
  const concentration = await naa.textContent();
  expect(Number(concentration)).toBeGreaterThan(3);
  await page.locator("#dataInput").setInputFiles({ name: "unreadable.dat", mimeType: "application/octet-stream", buffer: Buffer.from("unreadable") });
  await expect(page.locator("#statusText")).toContainText("No readable spectroscopy data found.");
  await expect(naa).toHaveText(concentration);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 120000 });
  await expect(naa).toHaveText(concentration);
  await page.locator("#waterInput").setInputFiles({ name: "bad-reference.dat", mimeType: "application/octet-stream", buffer: Buffer.from("unreadable water") });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(naa).toHaveText(concentration);
  await expect(page.locator("#datasetSummary")).toContainText("with water");
});

test("the normal picker attaches a water-only selection and explains water before spectrum", async ({ page }) => {
  const files = await spectroscopyFiles();
  const spectra = files.filter((file) => file.name.includes("_act."));
  const water = files.filter((file) => file.name.includes("_ref."));
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(water);
  await expect(page.locator("#statusText")).toContainText("Load its spectrum first");
  await page.locator("#dataInput").setInputFiles(spectra);
  await expect(page.locator("#datasetSummary")).toContainText("no water reference");
  await page.locator("#dataInput").setInputFiles(water);
  await expect(page.locator("#statusText")).toHaveText("Water reference attached to the selected dataset.");
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("identical spectrum and reference filenames remain separate and preserve editing choices", async ({ page }) => {
  const files = await spectroscopyFiles("philips-megapress");
  const rename = (file) => ({ ...file, name: `scan.${file.name.split(".").at(-1)}` });
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(files.filter((file) => file.name.includes("_act.")).map(rename));
  await expect(page.locator("#datasetSummary")).toContainText("no water reference");
  await expect(page.locator("#editedToggle")).toBeChecked();
  await page.locator("#editedToggle").uncheck();
  await expect(page.locator("#datasetSummary")).not.toContainText("MEGA-PRESS");
  await page.locator("#waterSection > summary").click();
  await page.locator("#waterInput").setInputFiles(files.filter((file) => file.name.includes("_ref.")).map(rename));
  await expect(page.locator("#statusText")).toHaveText("Water reference attached to the selected dataset.");
  await expect(page.locator("#datasetSummary")).not.toContainText("MEGA-PRESS");
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await expect(page.locator("#editedToggle")).not.toBeChecked();
});

test("a mixed session imports anatomical DICOM slices and spectroscopy in either file order", async ({ page }) => {
  const files = await spectroscopyFiles();
  for (const imageFirst of [true, false]) {
    await page.goto("/");
    const images = dicomSeries({ extension: "" });
    await page.locator("#dataInput").setInputFiles(imageFirst ? [...images, ...files] : [...files, ...images]);
    await expect(page.locator("#t1Info")).toContainText("16 × 16 × 4", { timeout: 60000 });
    await expect(page.locator("#datasetSummary")).toContainText("with water");
    await expect(page.locator("#t1Canvas")).toBeVisible();
    await expect(page.locator("#viewerNotice")).toBeHidden();
    await expect(page.locator("#runButton")).toBeEnabled();
  }
});

test("a RAW session imports anatomical DICOM and selects its supplied custom basis", async ({ page }) => {
  const files = await spectroscopyFiles("lcmodel-test");
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles([...files, ...dicomSeries()]);
  await expect(page.locator("#t1Info")).toContainText("16 × 16 × 4", { timeout: 60000 });
  await expect(page.locator("#datasetSummary")).toContainText("LCModel .RAW");
  await expect(page.locator("#t1Canvas")).toBeVisible();
  await expect(page.locator("#viewerNotice")).toBeHidden();
  await expect(page.locator("#basisSelect")).toHaveValue("custom");
  await expect(page.locator("#basisInfo")).toContainText("3t.basis");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a mixed session offers the anatomical series choice and cancellation keeps the spectrum", async ({ page }) => {
  const files = await spectroscopyFiles();
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(files);
  await expect(page.locator("#datasetSummary")).toContainText("with water");
  await page.locator("#dataInput").setInputFiles([...files, ...dicomSeries(), ...dicomSeries({ series: 2 })]);
  await expect(page.locator("#anatomySeries")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Loading cancelled");
  await expect(page.locator("#anatomySeries")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#dataInput").setInputFiles([...files, ...dicomSeries(), ...dicomSeries({ series: 2 })]);
  await expect(page.locator("#anatomySeries option")).toHaveCount(4);
  await page.locator("#anatomySeries").selectOption("1");
  await expect(page.locator("#t1Info")).toContainText("test_scan_2", { timeout: 60000 });
  await expect(page.locator("#t1Canvas")).toBeVisible();
});

test("an anatomical NIfTI in the main picker is visible without a spectrum", async ({ page }) => {
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles({
    name: "anatomy.nii", mimeType: "application/octet-stream",
    buffer: syntheticNifti({ dims: [16, 16, 16], gzip: false }),
  });
  await expect(page.locator("#t1Canvas")).toBeVisible();
  await expect(page.locator("#plotLabel")).toHaveText("anatomy.nii");
  await expect(page.locator("#runButton")).toBeDisabled();
});


test("mixing RAW and vendor spectra rejects the import and keeps the resident fit", async ({ page }) => {
  test.setTimeout(180000);
  const vendor = (await spectroscopyFiles()).filter((file) => file.name.includes("_act."));
  const raw = ["data.raw", "3t.basis", "control.file"].map((name) => ({
    name, mimeType: "application/octet-stream",
    buffer: readFileSync(new URL(`../../../exes/lcmodel/tests/data/test_lcm/${name}`, import.meta.url)),
  }));
  await page.goto("/");
  await page.locator("#dataInput").setInputFiles(vendor);
  await expect(page.locator("#datasetSummary")).toContainText("no water reference");
  await page.locator("#dataInput").setInputFiles(raw);
  await expect(page.locator("#basisSelect")).toHaveValue("custom");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 120000 });
  const summary = await page.locator("#datasetSummary").textContent();
  const results = await page.locator("#concBody").textContent();
  expect(results).toContain("NAA");
  const replacement = { ...raw[0], name: "replacement.raw" };
  for (const files of [[replacement, ...vendor], [...vendor, replacement]]) {
    await page.locator("#dataInput").setInputFiles(files);
    await expect(page.locator("#statusText")).toContainText("Import LCModel .RAW and vendor spectra separately.");
    await expect(page.locator("#statusText")).toHaveClass(/error/);
    await expect(page.locator("#datasetSummary")).toHaveText(summary);
    await expect(page.locator("#concBody")).toHaveText(results);
    await expect(page.locator("#basisSelect")).toHaveValue("custom");
    await expect(page.locator("#runButton")).toBeEnabled();
  }
});
