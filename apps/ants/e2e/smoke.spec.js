import { verifyStandaloneDialog } from '../../../test-utils/standalone-dialog.mjs';
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith("live data")) return;
  await page.route("**/reg/**", (route) => route.fulfill({
    body: fixture,
    contentType: "application/gzip",
    headers: {
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  }));
});

test("live data defaults download and SyN registration completes", async ({ page }) => {
  test.skip(!process.env.ANTS_LIVE_DATA, "Set ANTS_LIVE_DATA=1 to exercise the pinned Hugging Face images (about a minute on a fast GPU laptop).");
  test.setTimeout(900_000);
  await page.goto("/");
  await expect(page.locator("#movingInfo")).toContainText("t1_brain.nii.gz", { timeout: 60_000 });
  await expect(page.locator("#stationaryInfo")).toContainText("MNI152_T1_1mm_brain.nii.gz", { timeout: 60_000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 840_000 });
});

test("defaults load into three panels and SyN registration completes on demand", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
  await expect(page.locator("#movingExample")).toHaveValue(/t1_brain\.nii\.gz$/);
  await expect(page.locator("#stationaryExample")).toHaveValue(/MNI152_T1_1mm_brain\.nii\.gz$/);
  await expect(page.locator("#movingInfo")).toContainText("brain extracted");
  await expect(page.locator("#stationaryInfo")).toContainText("brain extracted");
  await expect(page.locator("#statusText")).toContainText("Examples loaded", { timeout: 60_000 });
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 240_000 });
  for (const label of ["Registered moving image", "Affine transform", "Forward warp", "Inverse warp"]) {
    await expect(page.locator("#resultList")).toContainText(label);
  }
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#resultList").getByRole("button", { name: "Download" }).first().click(),
  ]);
  expect(download.suggestedFilename()).toBe("t1_brain_registered.nii.gz");
  const image = gunzipSync(await readFile(await download.path()));
  expect(image.readInt32LE(0)).toBe(348);
  expect(image.length).toBeGreaterThan(352);
});

test("custom images are flagged and can be brain extracted per image", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toContainText("Examples loaded", { timeout: 60_000 });
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
  await expect(page.locator("#movingExample")).toBeDisabled();
  await expect(page.locator("#stationaryExample")).toBeDisabled();
  await expect(page.locator("#statusText")).toContainText("WebGPU is unavailable");
});
