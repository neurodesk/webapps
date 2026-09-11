// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.route("**/reg/**", (route) => route.fulfill({
    body: fixture,
    contentType: "application/gzip",
    headers: {
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  }));
});

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
});

test("defaults load and registration reaches the resliced panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#movingExample")).toHaveValue(/t1_crop\.nii\.gz$/);
  await expect(page.locator("#stationaryExample")).toHaveValue(/MNI152_T1_1mm\.nii\.gz$/);
  await expect(page.locator("#movingInfo")).toHaveText("t1_crop.nii.gz");
  await expect(page.locator("#stationaryInfo")).toHaveText("MNI152_T1_1mm.nii.gz");
  await expect(page.locator("#statusText")).toHaveText("Registration complete", { timeout: 60_000 });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#resultList").getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("t1_crop_registered.nii");
  const image = await readFile(await download.path());
  expect(image.readInt32LE(0)).toBe(348);
  expect(image.length).toBeGreaterThan(352);

});

test("cancellation keeps controls locked until registration exits", async ({ page }) => {
  await page.goto("/");
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
  await page.route("**/CT_Philips.nii.gz", (route) => route.fulfill({ body: "not a NIfTI image" }));
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Registration complete", { timeout: 60_000 });
  await page.locator("#movingExample").selectOption({ label: "CT_Philips" });
  await expect(page.locator("#movingInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("a failed preset download keeps the loaded selection", async ({ page }) => {
  await page.route("**/CT_Philips.nii.gz", (route) => route.fulfill({ status: 503 }));
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Registration complete", { timeout: 60_000 });
  const select = page.locator("#movingExample");
  const previous = await select.inputValue();
  await select.selectOption({ label: "CT_Philips" });
  await expect(page.locator("#statusText")).toHaveText("Example download failed (503).");
  await expect(select).toHaveValue(previous);
  await expect(page.locator("#movingInfo")).toHaveText("t1_crop.nii.gz");
});

test("image controls stay disabled without WebGPU", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { value: undefined }));
  await page.goto("/");
  await expect(page.locator("#movingExample")).toBeDisabled();
  await expect(page.locator("#stationaryExample")).toBeDisabled();
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

test("a web worker loads and responds", async ({ page }) => {
  await page.goto("/");
  const ok = await page.evaluate(async () => {
    const src = "self.onmessage = () => self.postMessage('pong');";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    return await new Promise((resolve) => {
      const finish = (result) => {
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      w.onmessage = (e) => finish(e.data === "pong");
      w.onerror = () => finish(false);
      w.postMessage("ping");
    });
  });
  expect(ok).toBe(true);
});
