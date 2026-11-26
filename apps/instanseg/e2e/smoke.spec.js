// Browser tests against `vite preview` of the production build: shared shell, cross-origin
// isolation, RGB image validation, example load/failure/cancel/retry, running-job cancellation,
// and full H&E brightfield nuclei segmentation parity against upstream InstanSeg v0.1.2.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL_ID, modelById } from "@neurodesk/instanseg/models";
import { writeLabelsTiff } from "@neurodesk/instanseg/image-io";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const primaryExample = examples[0];
const primaryFile = primaryExample.files[0];
const primaryModel = modelById(DEFAULT_MODEL_ID);
// Upstream instanseg v0.1.2 brightfield_nuclei count on he_brightfield_512.ome.tif: 1115 nuclei.
const ORACLE_NUCLEI_COUNT = 1115;

function makeGreyscaleTiff(width = 32, height = 32) {
  const bytes = writeLabelsTiff(new Int32Array(width * height), width, height, 0.5);
  return { name: "gray.tif", mimeType: "image/tiff", buffer: Buffer.from(bytes) };
}

test("app boots in workspace with idle status and disabled run", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("shared app bar opens About, Cite, Privacy and switches theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("dialog[open]")).toContainText("brightfield_nuclei");
  await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("InstanSeg: an embedding-based instance segmentation algorithm");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("never uploaded");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("non-image and greyscale inputs are refused before running", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(page.locator("#statusText")).toContainText("not a TIFF, OME-TIFF, or PNG image");
  await expect(page.locator("#runButton")).toBeDisabled();

  await page.locator("#imageInput").setInputFiles(makeGreyscaleTiff());
  await expect(page.locator("#statusText")).toContainText("not a 3-channel 2D RGB brightfield image");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("hosted example loads cleanly, handles download failure retry, and cancels during download", async ({ page }) => {
  test.setTimeout(150000);
  let attempts = 0;
  let releasePending;
  await page.context().route(primaryFile.url, async (route) => {
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, body: "" });
    if (attempts === 2) {
      await new Promise((resolve) => { releasePending = resolve; });
      await route.abort("aborted").catch(() => {});
      return;
    }
    return route.fallback();
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();

  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "loading");
  await page.getByRole("button", { name: "Cancel" }).click();
  releasePending?.();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#runButton")).toBeDisabled();

  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("512 × 512");
  await expect(page.locator("#fileInfo")).toContainText("0.500 µm/px");
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(3);
});

test("cancelling a running segmentation terminates the worker and re-enables controls", async ({ page }) => {
  test.setTimeout(150000);
  let releaseModel;
  await page.context().route(primaryModel.url, async (route) => {
    await new Promise((resolve) => { releaseModel = resolve; });
    await route.abort("aborted").catch(() => {});
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  releaseModel?.();
  await expect(page.locator("#statusText")).toHaveText("Segmentation cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("segments hosted H&E example matching upstream brightfield_nuclei parity and downloads TIFF + CSV", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(primaryExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmented \d+ nuclei · median area /, { timeout: 120000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const statusText = await page.locator("#statusText").textContent();
  const count = Number(statusText.match(/Segmented (\d+) nuclei/)?.[1] || 0);
  expect(count).toBe(ORACLE_NUCLEI_COUNT);

  const tiffEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Nuclei labels" }).getByRole("button", { name: "Download" }).click();
  const tiffDl = await tiffEvent;
  expect(tiffDl.suggestedFilename()).toBe("he_brightfield_512_instanseg_labels.tif");
  const tiffBytes = readFileSync(await tiffDl.path());
  expect(tiffBytes.byteLength).toBeGreaterThan(512 * 512 * 2);

  const csvEvent = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Nuclei morphometry" }).getByRole("button", { name: "Download" }).click();
  const csvDl = await csvEvent;
  expect(csvDl.suggestedFilename()).toBe("he_brightfield_512_instanseg_nuclei.csv");
  const csvLines = readFileSync(await csvDl.path(), "utf8").trim().split("\n");
  expect(csvLines[0]).toBe("id,centroid_x_px,centroid_y_px,area_px,area_um2,equiv_diameter_um,bbox_x,bbox_y,bbox_w,bbox_h");
  expect(csvLines.length - 1).toBe(ORACLE_NUCLEI_COUNT);
});
