// Real browser tests: cross-origin isolation, app boot and the full example pipeline in Chromium.
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { hardwareGpu } from "../../../test-utils/hardware-gpu.mjs";

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
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

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("the example runs end to end and downloads the derivatives @slow", async ({ page }) => {
  // SwiftShader takes hours for MindGrab and SynthSR; the full pipeline needs NEURODESK_HARDWARE_GPU=1
  test.skip(!hardwareGpu, "needs a hardware GPU");
  test.setTimeout(60 * 60 * 1000);
  const log = [];
  page.on("console", (m) => log.push(m.text()));
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("motor3t");
  await expect(page.locator("#fileInfo")).toContainText("6 files · sub-01", { timeout: 300_000 });
  const t0 = Date.now();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/fastprep finished|error|failed/i, { timeout: 55 * 60 * 1000 });
  await expect(page.locator("#statusText")).toContainText("fastprep finished");
  await expect(page.frameLocator("#viewer iframe").locator("h1")).toContainText("fastprep: sub-01");
  const download = page.waitForEvent("download");
  await page.locator("#resultList").getByRole("button", { name: "Download", exact: true }).click();
  const files = unzipSync(new Uint8Array(readFileSync(await (await download).path())));
  const names = Object.keys(files);
  for (const want of ["fastprep/sub-01.html", "fastprep/sub-01_task-motor.html", "fastprep/work/commands.sh",
    "fastprep/sub-01/func/sub-01_task-motor_space-MNI152NLin2009cAsym_desc-preproc_bold.nii.gz",
    "fastprep/sub-01/func/sub-01_task-motor_desc-confounds_timeseries.tsv"]) expect(names).toContain(want);
  // keep the derivatives for comparison with a native run when asked
  if (process.env.FASTPREP_E2E_OUT) {
    for (const [name, bytes] of Object.entries(files)) {
      const p = `${process.env.FASTPREP_E2E_OUT}/${name}`;
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, bytes);
    }
    writeFileSync(`${process.env.FASTPREP_E2E_OUT}/browser.log`, `${(Date.now() - t0) / 1000} s\n${log.join("\n")}\n`);
  }
});
