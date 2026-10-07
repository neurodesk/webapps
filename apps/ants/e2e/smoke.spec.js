import { verifyStandaloneDialog } from '../../../test-utils/standalone-dialog.mjs';
import { affineDifference, downsampledExamplePair, ncc, readVolume, resampleToGrid } from '../../../test-utils/registration-similarity.mjs';
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
// both roles. The alignment tests below replace this route or bypass it.
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith("live data")) return;
  await serveExamples(page, () => fixture);
});

async function registerSelectedExample(page, timeout) {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#movingInfo")).toContainText("t1_brain.nii.gz · brain extracted");
  await expect(page.locator("#stationaryInfo")).toContainText("MNI152_T1_1mm_brain.nii.gz · brain extracted");
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout });
  for (const label of ["Registered moving image", "Affine transform", "Forward warp", "Inverse warp"]) {
    await expect(page.locator("#resultList")).toContainText(label);
  }
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#resultList").getByRole("button", { name: "Download" }).first().click(),
  ]);
  expect(download.suggestedFilename()).toBe("t1_brain_registered.nii.gz");
  return readVolume(await readFile(await download.path()));
}

// Alignment is judged here, not by the app: the moving image is put on the
// template grid by world coordinates alone (no registration) and compared with
// what the app returned. Measured on this pair: NCC 0.588 before and 0.964
// after at 2 mm, 0.597 and 0.961 at 3 mm. An output that copies either input,
// or a wrong transform, stays near the "before" value.
function expectAligned(warped, moving, fixed) {
  const before = ncc(resampleToGrid(moving, fixed).data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.7);
  expect(after).toBeGreaterThan(0.9);
}

test("live data examples download and SyN registration aligns the 1 mm pair", async ({ page }) => {
  test.skip(!process.env.ANTS_LIVE_DATA, "Set ANTS_LIVE_DATA=1 to exercise the pinned Hugging Face images (about a minute on a fast GPU laptop).");
  test.setTimeout(900_000);
  const { moving, fixed } = await downsampledExamplePair(examples[0], 1);
  expectAligned(await registerSelectedExample(page, 840_000), moving, fixed);
});

// The 1 mm pair takes about a minute on an M4 Pro, too long for a two-core CI
// runner, so CI registers the same two example images block-averaged to 2 mm.
test("SyN registration aligns the example T1 with the MNI template on the template grid", async ({ page }) => {
  test.setTimeout(600_000);
  const { moving, fixed, files } = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  expectAligned(await registerSelectedExample(page, 480_000), moving, fixed);
});

test("cancelling a registration releases the controls and a new run still completes", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Registration cancelled. Your images are unchanged.");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList")).toBeEmpty();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 240_000 });
  await expect(page.locator("#cancelButton")).toBeHidden();
});

test("custom images are flagged and can be brain extracted per image", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await page.locator("#movingInput").setInputFiles({ name: "custom.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#movingInfo")).toContainText("not brain extracted");
  await expect(page.locator("#movingExtractButton")).toBeEnabled();
  await expect(page.locator("#stationaryExtractButton")).toBeDisabled();
  await page.locator("#stationaryInput").setInputFiles({ name: "template.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#stationaryInfo")).toContainText("not brain extracted");
  await expect(page.locator("#stationaryExtractButton")).toBeEnabled();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#controls > #standaloneBtn")).toBeHidden();
  await verifyStandaloneDialog(page, 'ants');
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test("image controls stay disabled without WebGPU", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { value: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-neurodesk-example]")).toBeDisabled();
  await expect(page.locator("#statusText")).toContainText("WebGPU is unavailable");
});
