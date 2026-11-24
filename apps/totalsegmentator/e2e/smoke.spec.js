// Browser end-to-end tests for TotalSegmentator against the built, header-served app.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));

test("app boots with shared app bar, theme switch and cross-origin isolation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const aboutDialog = page.getByRole("dialog");
  await expect(aboutDialog).toBeVisible();
  await expect(aboutDialog.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await aboutDialog.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("task, resolution and subset controls stay synchronized", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#resolutionField")).toBeVisible();
  await expect(page.locator("#subsetField")).toBeHidden();
  await page.locator("#resolutionSelect").selectOption("full");
  await expect(page.locator("#subsetField")).toBeVisible();
  await expect(page.locator("#subsetSelect option")).toHaveCount(6);
  await page.locator("#taskSelect").selectOption("total_mr");
  await expect(page.locator("#subsetSelect option")).toHaveCount(3);
  await page.locator("#taskSelect").selectOption("vertebrae_mr");
  await expect(page.locator("#resolutionField")).toBeHidden();
  await expect(page.locator("#subsetField")).toBeHidden();
  await page.locator("#taskSelect").selectOption("abdominal_muscles");
  await expect(page.locator("#modelHint")).toContainText("trunk crop");
});

test("CT example runs 3 mm segmentation, populates Results table and downloads NIfTI + TSV", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("ct-abdomen");
  await expect(page.locator("#fileInfo")).toContainText("example_ct_sm.nii.gz", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Segmentation complete", { timeout: 180000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  // Check Results report tab
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await expect(page.locator("#reportView")).toBeVisible();
  const rowCount = await page.locator("#reportTable tbody tr").count();
  expect(rowCount).toBeGreaterThanOrEqual(25);
  await page.locator("#reportSearch").fill("liver");
  await expect(page.locator("#reportTable tbody tr")).toHaveCount(1);
  await page.locator("#reportSearch").fill("");

  // Download segmentation NIfTI and verify dimensions + uint8 labels
  const segDownloadPromise = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle", { hasText: "Segmentation mask" }).getByRole("button", { name: "Download", exact: true }).click();
  const segDownload = await segDownloadPromise;
  expect(segDownload.suggestedFilename()).toBe("example_ct_sm_totalseg_total.nii.gz");
  const nifti = gunzipSync(readFileSync(await segDownload.path()));
  expect([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)]).toEqual([122, 101, 30]);
  expect(nifti.readInt16LE(70)).toBe(2);
  const uniqueLabels = new Set(nifti.subarray(352));
  expect(uniqueLabels.size).toBeGreaterThanOrEqual(25);

  // Download TSV statistics
  const tsvDownloadPromise = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle", { hasText: "Structure statistics" }).getByRole("button", { name: "Download", exact: true }).click();
  const tsvDownload = await tsvDownloadPromise;
  expect(tsvDownload.suggestedFilename()).toBe("example_ct_sm_totalseg_total_stats.tsv");
  const tsvText = readFileSync(await tsvDownload.path(), "utf8");
  expect(tsvText).toContain("mean_hu");
  expect(tsvText).toContain("liver");
});

test("MRI example runs 3 mm total_mr segmentation on LPS scan", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("#taskSelect").selectOption("total_mr");
  await page.locator("select[data-neurodesk-example]").selectOption("mr-abdomen");
  await expect(page.locator("#fileInfo")).toContainText("example_mr_sm.nii.gz", { timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Segmentation complete", { timeout: 180000 });

  const segDownloadPromise = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle", { hasText: "Segmentation mask" }).getByRole("button", { name: "Download", exact: true }).click();
  const segDownload = await segDownloadPromise;
  const nifti = gunzipSync(readFileSync(await segDownload.path()));
  expect([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)]).toEqual([117, 91, 20]);
  const uniqueLabels = new Set(nifti.subarray(352));
  expect(uniqueLabels.size).toBeGreaterThanOrEqual(15);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const example = examples[0];
    let attempts = 0;
    await page.route(example.files[0].url, (route) => {
      attempts++;
      if (attempts === 1) {
        return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
      }
      return route.continue();
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  const example = examples[0];
  await page.goto("/");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
});
