// The whole BISON pipeline in the browser on both examples: registration, denoising, N4 and the
// forest, with the held model files served from BISON_ASSET_DIR (vite.config.js). With
// BISON_BROWSER_OUTPUT set, each output is also written to <it>/<example id>/, which
// packages/bison/validation/browser-reference.mjs records for the command line's check.
// These are the only completed runs of each model, so both remain in the PR suite. The held
// files are not public, so CI cannot run them until publication.
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { downloaded } from "./fixtures.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const SLUGS = ["ventricles", "csf", "cerebellar-gm", "cerebellar-wm", "brainstem", "deep-gm", "cortical-gm", "wm"];
const RUN_TIMEOUT = 3 * 60 * 60 * 1000;

// Downloads the labels and the mask from their rows and every output from "Download all (zip)":
// headless Chromium refuses a page's 11th download, as Chrome asks the user to allow multiple
// downloads. Checks names and NIfTI headers, and writes the files to BISON_BROWSER_OUTPUT/<example
// id>/ when that variable is set.
async function checkDownloads(page, example, slugs) {
  const stem = example.files.find((file) => file.role === "t1").name.replace(/\.nii\.gz$/, "");
  const expected = [`${stem}_bison-labels.nii.gz`, ...slugs.map((slug) => `${stem}_bison-prob-${slug}.nii.gz`), `${stem}_bison-mask.nii.gz`];
  const buttons = page.locator("#resultList .nd-download-btn");
  // The first rows are the inputs.
  const inputs = example.files.length;
  await expect(buttons).toHaveCount(inputs + expected.length);
  for (const k of [0, expected.length - 1]) {
    const pending = page.waitForEvent("download");
    await buttons.nth(inputs + k).click();
    expect((await downloaded(await pending)).name).toBe(expected[k]);
  }
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all (zip)" }).click();
  const zip = await downloaded(await pending);
  const files = unzipSync(new Uint8Array(zip.bytes));
  expect(Object.keys(files).sort()).toEqual([...expected].sort());
  for (const [name, bytes] of Object.entries(files)) {
    const header = gunzipSync(bytes).subarray(0, 352);
    expect(header.readInt32LE(0)).toBe(348);
    expect(header.readInt16LE(40)).toBe(3);
    if (process.env.BISON_BROWSER_OUTPUT) {
      const directory = join(process.env.BISON_BROWSER_OUTPUT, example.id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, name), bytes);
    }
  }
}

async function runExample(page, example, status) {
  await page.goto("./");
  await page.getByLabel("Input", { exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText(status, { timeout: RUN_TIMEOUT - 600000 });
}

test("the T1 example segments into 8 classes on the T1 grid, and a second run cancels", async ({ page }) => {
  test.skip(!process.env.BISON_ASSET_DIR, "BISON_ASSET_DIR is not set; the BISON model files are not published");
  test.setTimeout(RUN_TIMEOUT);
  await runExample(page, examples[0], "Segmentation complete · 8 classes");
  await expect(page.locator("#classLegend .nd-legend-item")).toHaveCount(8);
  await checkDownloads(page, examples[0], SLUGS);

  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText(/Registering T1 to the template \(affine\)/, { timeout: 300000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Segmentation cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-download-btn")).toHaveCount(1);
});

test("the T1 + FLAIR example segments into 9 classes, with white matter hyperintensities", async ({ page }) => {
  test.skip(!process.env.BISON_ASSET_DIR, "BISON_ASSET_DIR is not set; the BISON model files are not published");
  test.setTimeout(RUN_TIMEOUT);
  await runExample(page, examples[1], "Segmentation complete · 9 classes with WMH");
  await expect(page.locator("#classLegend .nd-legend-item")).toHaveCount(9);
  await checkDownloads(page, examples[1], [...SLUGS, "wmh"]);
});
