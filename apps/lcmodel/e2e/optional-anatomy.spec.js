import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { exampleFiles } from "../../../packages/lcmodel/validation/reference.mjs";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";

const file = (name, buffer) => ({ name, mimeType: "application/octet-stream", buffer });
const anatomy = file("previous-patient.nii", syntheticNifti({ dims: [16, 16, 16], gzip: false }));
const fourD = Buffer.concat([anatomy.buffer, anatomy.buffer.subarray(352)]);
fourD.writeInt16LE(4, 40);
fourD.writeInt16LE(2, 48);
const noPixels = dicomSeries({ slices: 1 })[0];
const pixelTag = noPixels.buffer.indexOf(Buffer.from([0xe0, 0x7f, 0x10, 0, 0x4f, 0x57]));
if (pixelTag < 132) throw new Error("Synthetic DICOM pixel tag missing");
const invalidAnatomies = [
  file("dynamic.nii", fourD),
  file("no-pixels.dcm", noPixels.buffer.subarray(0, pixelTag)),
];

async function spectra(id) {
  return Promise.all((await exampleFiles(id)).map(async entry => file(entry.name, await readFile(entry.path))));
}

async function previousAnatomy(page) {
  await page.goto("/");
  await page.locator("#tissueSection > summary").click();
  await page.locator("#t1Input").setInputFiles(anatomy);
  await expect(page.locator("#t1Info")).toContainText(anatomy.name);
  await expect(page.locator("#dataInput")).toBeEnabled();
  await page.locator("#fGm").fill("0.6");
  await page.locator("#fWm").fill("0.3");
  await page.locator("#fCsf").fill("0.1");
}

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
async function adopt(page, role, files) {
  await page.locator("#neurodesk-input-transfer").setInputFiles(files);
  await dispatch(page, "adopt", { role });
}

for (const example of ["lcmodel-test", "philips-press-t1"]) {
  for (const invalid of invalidAnatomies) {
    test(`${example} imports spectra with unusable ${invalid.name} and clears unrelated anatomy`, async ({ page }) => {
      await previousAnatomy(page);
      await page.locator("#dataInput").setInputFiles([...await spectra(example), invalid]);
      await expect(page.locator("#datasetSummary")).toContainText(example === "lcmodel-test" ? "LCModel .RAW" : "with water", { timeout: 30000 });
      await expect(page.locator("#runButton")).toBeEnabled();
      await expect(page.locator("#t1Info")).toBeHidden();
      await expect(page.locator("#t1Canvas")).toBeHidden();
      await expect(page.locator("#statusText")).not.toHaveClass(/error/);
      await expect(page.locator("#statusText")).toContainText("anatomy skipped");
      for (const id of ["fGm", "fWm", "fCsf"]) await expect(page.locator(`#${id}`)).toHaveValue("");
    });
  }
}

for (const invalid of invalidAnatomies) {
  test(`image-only ${invalid.name} is rejected and preserves resident anatomy`, async ({ page }) => {
    await previousAnatomy(page);
    await page.locator("#dataInput").setInputFiles(invalid);
    await expect(page.locator("#statusText")).toHaveClass(/error/, { timeout: 30000 });
    await expect(page.locator("#t1Info")).toContainText(anatomy.name);
    await expect(page.locator("#plotLabel")).toHaveText(anatomy.name);
    await expect(page.locator("#t1Canvas")).toBeVisible();
    await expect(page.locator("#fGm")).toHaveValue("0.6");
    await expect(page.locator("#fWm")).toHaveValue("0.3");
    await expect(page.locator("#fCsf")).toHaveValue("0.1");
  });
}

test("a mixed session can choose None and replaces unrelated resident anatomy", async ({ page }, testInfo) => {
  await previousAnatomy(page);
  await page.locator("#dataInput").setInputFiles([
    ...await spectra("lcmodel-test"), anatomy, file("other-series.nii", anatomy.buffer),
  ]);
  await expect(page.locator("#anatomySeries")).toBeVisible();
  const none = page.locator("#anatomySeries option").filter({ hasText: /^None/ });
  await expect(none).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("optional-anatomy-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#anatomySeries").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("optional-anatomy-phone.png"), fullPage: true });
  await page.locator("#anatomySeries").selectOption(await none.getAttribute("value"));
  await expect(page.locator("#anatomySeries")).toBeHidden();
  await expect(page.locator("#datasetSummary")).toContainText("LCModel .RAW");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#t1Info")).toBeHidden();
});

for (const images of [[anatomy], [anatomy, file("second.nii", anatomy.buffer)], [invalidAnatomies[0]]]) {
  test(`automation ignores ${images.map(image => image.name).join(" and ")} inside spectra`, async ({ page }) => {
    test.setTimeout(180000);
    await previousAnatomy(page);
    const files = await spectra("lcmodel-test");
    await adopt(page, "spectra", [...files.filter(entry => !/\.basis$/i.test(entry.name)), ...images]);
    await adopt(page, "basis", files.filter(entry => /\.basis$/i.test(entry.name)));
    await dispatch(page, "start", { operation: "fit", parameters: { lineBroadening: "lcmodel" } });
    await expect.poll(async () => {
      const result = await dispatch(page, "snapshot");
      return await page.locator("#anatomySeries").isVisible() ? "prompted" : result.state;
    }, { timeout: 120000 }).not.toBe("running");
    await expect(page.locator("#anatomySeries")).toBeHidden();
    const result = await dispatch(page, "snapshot");
    expect(result.state, JSON.stringify(result.error)).toBe("succeeded");
    expect(result.report.measurements.tissue).toBeNull();
    expect(result.report.measurements.metabolites.NAA.concentration).toBeCloseTo(1.91e-6, 8);
    await expect(page.locator("#t1Info")).toBeHidden();
  });
}
