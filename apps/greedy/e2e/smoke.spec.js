import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

test("live data defaults download and both registration modes complete", async ({ page }) => {
  test.skip(!process.env.GREEDY_LIVE_DATA, "Set GREEDY_LIVE_DATA=1 to exercise the pinned Hugging Face images.");
  await page.goto("/");
  await expect(page.locator("#movingInfo")).toContainText("t1_brain.nii.gz", { timeout: 60_000 });
  await expect(page.locator("#stationaryInfo")).toContainText("MNI152_T1_1mm_brain.nii.gz", { timeout: 60_000 });
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 120_000 });
  await page.locator("#method").selectOption("deformable");
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 120_000 });
});

test("defaults load into three panels and affine registration completes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
  await expect(page.locator("#movingExample")).toHaveValue(/t1_brain\.nii\.gz$/);
  await expect(page.locator("#stationaryExample")).toHaveValue(/MNI152_T1_1mm_brain\.nii\.gz$/);
  await expect(page.locator("#movingInfo")).toContainText("brain extracted");
  await expect(page.locator("#stationaryInfo")).toContainText("brain extracted");
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
});

test("the method selector runs affine plus nonlinear registration", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#method option")).toHaveCount(2);
  await expect(page.locator("#method")).toContainText("Affine · NMI");
  await expect(page.locator("#method")).toContainText("Affine + nonlinear · NMI");
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await page.locator("#method").selectOption("deformable");
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
});

test("a custom image is marked for brain extraction", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await page.locator("#movingInput").setInputFiles({ name: "custom.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#movingInfo")).toContainText("brain extraction required");
  await expect(page.locator("#extractButton")).toBeEnabled();
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

test("page is cross-origin isolated for threaded Greedy WASM", async ({ page }) => {
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
