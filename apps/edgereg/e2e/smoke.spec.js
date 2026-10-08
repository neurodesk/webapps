// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { affineDifference, downsampledExamplePair, ncc, readVolume, resampleToGrid } from "../../../test-utils/registration-similarity.mjs";

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

// Interface tests only need a loadable image, so they get one small fixture for
// both roles. The alignment test below replaces this route.
test.beforeEach(async ({ page }) => {
  await serveExamples(page, () => fixture);
});

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
});

// CI registers the app's two example images block-averaged by two (a 1.76 mm
// head onto the 2 mm MNI template). Alignment is judged here, not by the app:
// the moving image is put on the template grid by world coordinates alone (no
// registration) and compared with what the app returned. Measured: NCC 0.754
// before and 0.885 after. These are whole heads of different people aligned
// with an affine, so scalp and neck keep the ceiling well below 1; an output
// that copies either input, or a wrong transform, stays near the "before" value.
test("affine registration aligns the example T1 with the MNI template on the template grid", async ({ page }) => {
  test.setTimeout(300_000);
  const { moving, fixed, files } = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#movingInfo")).toHaveText("t1_crop.nii.gz");
  await expect(page.locator("#stationaryInfo")).toHaveText("MNI152_T1_1mm.nii.gz");
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Registration complete", { timeout: 240_000 });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#resultList").getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("t1_crop_registered.nii");
  const warped = await readVolume(await readFile(await download.path()));
  const before = ncc(resampleToGrid(moving, fixed).data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.8);
  expect(after).toBeGreaterThan(0.85);
  // A different subject cannot match the template exactly (measured 0.88-0.96), while returning
  // the stationary image itself would score 1 and pass every check above.
  expect(after).toBeLessThan(0.99);
});

test("cancellation keeps controls locked until registration exits", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  const cancel = page.locator("#cancelButton");
  await expect(cancel).toBeVisible({ timeout: 60_000 });
  const stayedLocked = await page.evaluate(() => {
    document.getElementById("cancelButton").click();
    return document.getElementById("runButton").disabled;
  });
  expect(stayedLocked).toBe(true);
  await expect(page.locator("#statusText")).toHaveText("Registration cancelled. Your images are unchanged.");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a failed replacement cannot register the previous moving image", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120_000 });
  await page.locator("#movingInput").setInputFiles({ name: "broken.nii", mimeType: "application/octet-stream", buffer: Buffer.from("not a NIfTI image") });
  await expect(page.locator("#movingInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("a failed example download keeps the loaded pair and can retry", async ({ page }) => {
  await page.goto("/");
  const select = page.locator("[data-neurodesk-example]");
  await select.selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await page.route("**/t1_crop.nii.gz", route => route.fulfill({ status: 503 }));
  await select.selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(select).toHaveValue("");
  await expect(select).toBeEnabled();
  await expect(page.locator("#movingInfo")).toHaveText("t1_crop.nii.gz");
});

test("image controls stay disabled without WebGPU", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { value: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-neurodesk-example]")).toBeDisabled();
  await expect(page.locator("#statusText")).toContainText("WebGPU is unavailable");
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Use light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // Threaded ONNX Runtime needs this; asserts the shared isolation policy worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

