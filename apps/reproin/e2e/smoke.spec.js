// Built-app browser tests (vite preview, see playwright.config.js): shell contract, the example
// through conversion and ZIP download, example failure/retry, cancellation, and a data-gated session.
import { test, expect } from "@playwright/test";
import { verifyStandaloneDialog } from "../../../test-utils/standalone-dialog.mjs";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const example = examples[0];
// ReproIn sessions keep their Investigator/Study root, so the dataset sits below bids/.
const DATASET = "bids/crlab/AgingBrain";
const T1 = `${DATASET}/sub-ro/ses-1/anat/sub-ro_ses-1_T1w`;

async function downloadDataset(page) {
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").first().getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("bids.zip");
  return readFileSync(await download.path());
}

test("app boots cross-origin isolated with the shared app bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
});

test("Standalone links the reproinx release with its dcm2niix prerequisite", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-neurodesk-shell-control="standalone"]:visible').first().click();
  const dialog = page.locator("#neurodeskStandaloneDialog");
  await expect(dialog).toContainText("dcm2niix v1.0.20261011 or later");
  // reproinx has no models; an external command line states its own prerequisites instead.
  await expect(dialog).not.toContainText("Models");
  await expect(dialog.getByRole("link", { name: "rordenlab/reproin-rs", exact: true })).toHaveAttribute("href", "https://github.com/rordenlab/reproin-rs");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await verifyStandaloneDialog(page, "reproin");
});

test(`example ${example.id} converts to BIDS and downloads the dataset`, async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText(`${example.files.length} DICOM files`, { timeout: 240000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("BIDS dataset ready", { timeout: 120000 });
  const zip = await downloadDataset(page);
  for (const name of [`${T1}.nii.gz`, `${T1}.json`, `${DATASET}/dataset_description.json`, `${DATASET}/participants.tsv`]) {
    expect(zip.includes(name), name).toBe(true);
  }
  await page.locator(`#resultList .nd-volume-toggle[data-stage="${T1.slice(5)}.nii.gz"] .nd-view-btn`).click();
  await expect(page.locator("#emptyState")).toBeHidden();
});

test("a failed example download can retry", async ({ page }) => {
  test.setTimeout(150000);
  let attempts = 0;
  // The first file fails once; the retry downloads the pinned session, as the examples are checksummed.
  await page.context().route(example.files[0].url, (route) => (++attempts === 1 ? route.fulfill({ status: 503, body: "" }) : route.fallback()));
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling a conversion leaves no result and permits a rerun", async ({ page }) => {
  await page.goto("/");
  // A converter worker that never answers holds the run open until cancelled.
  await page.evaluate(() => {
    globalThis.RealWorker = globalThis.Worker;
    globalThis.Worker = class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };
  });
  await page.locator("#dicomInput").setInputFiles({ name: "slice.dcm", mimeType: "application/dicom", buffer: Buffer.from("dicom") });
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Conversion cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();
});

// The example session as a folder upload (`node scripts/e2e-test-data.mjs reproin`), or any local
// ReproIn session. REPROIN_E2E_ZIP_OUT saves the ZIP for comparison with the native reproinx output.
test("a local ReproIn session converts to BIDS", async ({ page }) => {
  const dir = process.env.REPROIN_E2E_DICOM_DIR;
  test.skip(!dir, "set REPROIN_E2E_DICOM_DIR to a ReproIn DICOM session");
  test.setTimeout(300000);
  await page.goto("/");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => join(entry.parentPath, entry.name));
  await page.locator("#dicomInput").setInputFiles(files);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("BIDS dataset ready", { timeout: 240000 });
  await expect(page.locator("#statusText")).not.toContainText("failed");
  const zip = await downloadDataset(page);
  for (const name of ["/dataset_description.json", "_bold.nii.gz", "_epi.nii.gz", "_scans.tsv"]) expect(zip.includes(name), name).toBe(true);
  if (process.env.REPROIN_E2E_ZIP_OUT) writeFileSync(process.env.REPROIN_E2E_ZIP_OUT, zip);
});
