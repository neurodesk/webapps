import { affineDifference, downsampledExamplePair, ncc, readVolume, resampleToGrid } from "../../../test-utils/registration-similarity.mjs";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readTransformArchive, resampleThroughArchive } from "./ome-zarr-transform.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

function serveExamples(page, bodyFor) {
  return page.route("**/reg/**", (route) => route.fulfill({
    body: bodyFor(route.request().url()),
    contentType: "application/gzip",
    headers: {
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  }));
}

// Pipelines are staged into the build; a request to the jsDelivr default
// means a pipeline base URL was not set before the first call.
test.beforeEach(async ({ page }) => {
  page.on("request", (request) => {
    if (request.url().includes("cdn.jsdelivr.net")) throw new Error(`Pipeline fetched from a CDN: ${request.url()}`);
  });
});

async function selectExample(page) {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#movingInfo")).toContainText("t1_brain.nii.gz");
  await expect(page.locator("#stationaryInfo")).toContainText("MNI152_T1_1mm_brain.nii.gz");
  await expect(page.locator("#resultList")).toBeEmpty();
}

async function downloadResult(page, label) {
  const row = page.locator("#resultList .nd-volume-toggle").filter({ hasText: label });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row.getByRole("button", { name: "Download" }).click(),
  ]);
  return download;
}

// Alignment is judged here, not by the app: the moving image is put on the
// template grid by world coordinates alone and compared with what the app
// returned. An output that copies either input, or a wrong transform, stays
// near the "before" value; a different subject cannot match the template
// exactly, while returning the template itself would score 1.
function expectAligned(registered, moving, fixed) {
  const before = ncc(resampleToGrid(moving, fixed).data, fixed.data);
  const after = ncc(registered.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(registered.dims).toEqual(fixed.dims);
  expect(affineDifference(registered.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.7);
  expect(after).toBeGreaterThan(0.9);
  expect(after).toBeLessThan(0.99);
}

// CI registers the two example images block-averaged to 2 mm, so the
// test also covers non-NIfTI-native pixel data and an affine written by Node.
test("affine registration aligns the example T1 with the MNI template and writes every output", async ({ page }) => {
  test.setTimeout(600_000);
  const { moving, fixed, files } = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  await selectExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 480_000 });
  for (const label of ["Registered NIfTI", "Registered OME-Zarr", "Transform (ITK HDF5)", "Transform (OME-Zarr)", "TransformParameters.2.toml"]) {
    await expect(page.locator("#resultList")).toContainText(label);
  }
  const nifti = await downloadResult(page, "Registered NIfTI");
  expect(nifti.suggestedFilename()).toBe("t1_brain_registered.nii.gz");
  const registered = await readVolume(await readFile(await nifti.path()));
  expectAligned(registered, moving, fixed);

  const transform = await downloadResult(page, "Transform (ITK HDF5)");
  expect(transform.suggestedFilename()).toBe("t1_brain_transform.h5");
  expect((await readFile(await transform.path())).subarray(0, 8).toString("latin1")).toBe("\x89HDF\r\n\x1a\n");

  const last = await downloadResult(page, "TransformParameters.2.toml");
  expect(last.suggestedFilename()).toBe("t1_brain_TransformParameters.2.toml");
  const parameters = await readFile(await last.path(), "utf8");
  expect(parameters).toMatch(/^Transform = "AffineTransform"$/m);
  expect(parameters).toMatch(/^InitialTransformParameterFileName = "t1_brain_TransformParameters.1.toml"$/m);

  const zarr = await downloadResult(page, "Registered OME-Zarr");
  expect(zarr.suggestedFilename()).toBe("t1_brain_registered.ome.zarr.ozx");
  expect((await readFile(await zarr.path())).subarray(0, 2).toString("latin1")).toBe("PK");

  const archive = await downloadResult(page, "Transform (OME-Zarr)");
  expect(archive.suggestedFilename()).toBe("t1_brain_transform.ome.zarr.ozx");
  await expectTransformArchiveReproduces(await readFile(await archive.path()), "affine", registered, moving, fixed);
});

// Resampling the moving image through the downloaded OME-Zarr transform, with
// nothing but the archive and the NIfTI affines, must reproduce elastix's own
// registered image (which uses cubic rather than linear interpolation).
async function expectTransformArchiveReproduces(bytes, type, registered, moving, fixed) {
  const archive = await readTransformArchive(bytes);
  expect(archive.transformation).toMatchObject({ type, name: "fixed_to_moving", input: { name: "fixed" }, output: { name: "moving" } });
  const resampled = resampleThroughArchive(archive, moving, fixed);
  const agreement = ncc(resampled, registered.data);
  test.info().annotations.push({ type: "transform archive", description: `${type}: NCC with elastix's result ${agreement.toFixed(4)}` });
  expect(agreement).toBeGreaterThan(0.99);
  return archive;
}

test("affine + B-spline registration adds a deformable stage that keeps the alignment", async ({ page }) => {
  test.setTimeout(600_000);
  const { moving, fixed, files } = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  await selectExample(page);
  await page.locator("#method").selectOption("bspline");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#gridSpacing").fill("20");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 480_000 });
  const parameters = (await readFile(await (await downloadResult(page, "TransformParameters.3.toml")).path(), "utf8"));
  expect(parameters).toMatch(/^Transform = "BSplineTransform"$/m);
  expect(parameters).toMatch(/^InitialTransformParameterFileName = "t1_brain_TransformParameters.2.toml"$/m);
  const registered = await readVolume(await readFile(await (await downloadResult(page, "Registered NIfTI")).path()));
  expectAligned(registered, moving, fixed);
  const bytes = await readFile(await (await downloadResult(page, "Transform (OME-Zarr)")).path());
  const archive = await expectTransformArchiveReproduces(bytes, "displacements", registered, moving, fixed);
  expect(archive.transformation.path).toBe("displacements");
  expect(archive.field.shape).toEqual([3, ...fixed.dims.slice().reverse()]);
  expect(archive.multiscales.datasets).toHaveLength(1);
  expect(archive.multiscales.type).toBeUndefined();
});

test("the hosted example registers rigidly in the browser", async ({ page }) => {
  test.setTimeout(900_000);
  await selectExample(page);
  await page.locator("#method").selectOption("rigid");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 840_000 });
  await expect(page.locator("#resultList")).toContainText("TransformParameters.1.toml");
  await expect(page.locator("#resultList")).not.toContainText("TransformParameters.2.toml");
});

test("cancelling a registration releases the controls and a new run still completes", async ({ page }) => {
  test.setTimeout(600_000);
  const { files } = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  await selectExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Registration cancelled. Your images are unchanged.");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList")).toBeEmpty();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 480_000 });
  await expect(page.locator("#cancelButton")).toBeHidden();
});

test("elastix parameter files replace the method preset", async ({ page }) => {
  test.setTimeout(600_000);
  const { files } = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  await selectExample(page);
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#parameterInput").setInputFiles(fileURLToPath(new URL("fixtures/parameters_Rigid.txt", import.meta.url)));
  await expect(page.locator("#parameterInfo")).toHaveText("1 parameter file · EulerTransform");
  await expect(page.locator("#method")).toBeDisabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 480_000 });
  await expect(page.locator("#resultList")).toContainText("TransformParameters.0.toml");
  await expect(page.locator("#resultList")).not.toContainText("TransformParameters.1.toml");
  await page.locator("#parameterClear").click();
  await expect(page.locator("#method")).toBeEnabled();
  await expect(page.locator("#resultList")).toBeEmpty();
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const example = examples[0];
    let attempts = 0;
    await serveExamples(page, () => fixture);
    await page.route(example.files[0].url, (route) => {
      attempts++;
      return attempts === 1
        ? route.fulfill({ status: failure === "download" ? 503 : 200, body: "" })
        : route.fulfill({ body: fixture, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Example", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60_000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling an example download leaves no image and permits retry", async ({ page }) => {
  const example = examples[0];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await serveExamples(page, () => fixture);
  await page.route(example.files[0].url, async (route) => {
    await held;
    await route.fulfill({ body: fixture, headers: { "access-control-allow-origin": "*" } });
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Example", exact: true });
  await picker.selectOption(example.id);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  release();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#movingInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60_000 });
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});
