import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeTiff } from "../../../packages/elastix/test/decode-tiff.js";
import { calibrationCases, omeTiffFixture } from "../../../test-utils/ome-tiff-fixtures.mjs";
import { readVolume } from "../../../test-utils/registration-similarity.mjs";

const parameters = (await readFile(new URL("fixtures/parameters_Rigid.txt", import.meta.url), "utf8"))
  .replace("(MaximumNumberOfIterations 100)", "(MaximumNumberOfIterations 0)")
  .replace("(NumberOfResolutions 2)", "(NumberOfResolutions 1)");

async function download(page, label) {
  const row = page.locator("#resultList .nd-volume-toggle").filter({ hasText: label });
  const [file] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: "Download" }).click()]);
  return readFile(await file.path());
}

for (const fixture of calibrationCases) {
  test(`decoded original TIFF calibration: ${fixture.name}`, async ({ page }) => {
    test.setTimeout(120000);
    const buffer = omeTiffFixture(fixture);
    await page.goto("/");
    await expect(page.locator("#movingInput")).toBeEnabled();
    for (const role of ["moving", "stationary"]) {
      await page.locator(`#${role}Input`).setInputFiles({ name: "input.ome.tif", mimeType: "image/tiff", buffer });
      await expect(page.locator(`#${role}Info`)).toContainText("input.ome.tif", { timeout: 30000 });
    }
    await page.locator("#advancedSettings > summary").click();
    await page.locator("#parameterInput").setInputFiles({ name: "identity.txt", mimeType: "text/plain", buffer: Buffer.from(parameters) });
    await expect(page.locator("#parameterInfo")).toContainText("EulerTransform", { timeout: 30000 });
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60000 });
    const nifti = await readVolume(await download(page, "Registered NIfTI"));
    expect(nifti.dims.slice(0, 2)).toEqual([20, 20]);
    expect(nifti.data.some((value) => value > 900)).toBe(true);
    await expect(page.locator("#resultList")).toContainText("Transform (OME-Zarr)");
    await expect(page.locator("#resultList")).toContainText("TransformParameters.0.toml");
    if (fixture.issue) {
      await expect(page.locator("#omeTiffNote")).toContainText(fixture.issue);
      await expect(page.locator("#resultList")).not.toContainText("Registered OME-TIFF");
      return;
    }
    await expect(page.locator("#omeTiffNote")).toBeHidden();
    const bytes = await download(page, "Registered OME-TIFF");
    const decoded = await decodeTiff(bytes);
    expect(decoded.units).toEqual([fixture.unit, fixture.unit]);
    expect(decoded.spacing).toEqual(fixture.spacing ?? [0.25, 0.75]);
    expect(decoded.data).toEqual(nifti.data);
  });
}
