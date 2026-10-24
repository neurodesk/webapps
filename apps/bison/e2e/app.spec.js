// The workspace, the examples and the refusals, against the built app (vite preview). The real
// BISON worker starts here; it refuses before any download, because the held model files have no
// URL in this build.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";
import { T1, downloaded } from "./fixtures.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const held = Boolean(process.env.BISON_ASSET_DIR);
const NOT_PUBLISHED = "The BISON model files are not published yet, so this app cannot segment images.";

// Hosted runners have 7 GB, so their Chromium reports 4 GB; the refusal tests choose the value.
const reportMemory = (page, gigabytes) => page.addInitScript((value) => {
  Object.defineProperty(Navigator.prototype, "deviceMemory", { configurable: true, get: () => value });
}, gigabytes);

test("T1 and FLAIR inputs convert extensionless DICOM series", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(dicomSeries({ series: 601, extension: "" }));
  await expect(page.locator("#fileInfo")).toContainText("16 × 16 × 4", { timeout: 60000 });
  await page.locator("#flairInput").setInputFiles(dicomSeries({ series: 602, extension: "" }));
  await expect(page.locator("#flairInfo")).toContainText("16 × 16 × 4", { timeout: 60000 });
  await expect(page.locator("#modeHint")).toContainText("BISON-WMH: 9 classes");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#outputSection").evaluate((section) => { section.open = true; });
  for (const label of ["T1", "FLAIR"]) {
    const pending = page.waitForEvent("download");
    await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
    const { bytes } = await downloaded(await pending);
    const image = readNiftiFrames(bytes[0] === 0x1f ? gunzipSync(bytes) : bytes);
    expect(image.dims).toEqual([16, 16, 4]);
    expect(image.frames).toBe(1);
    expect(Math.min(...image.data)).toBe(100);
    expect(Math.max(...image.data)).toBe(655);
  }
});

test("multiple DICOM series are refused and a NIfTI input can recover", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles([...dicomSeries({ series: 603 }), ...dicomSeries({ series: 604 })]);
  await expect(page.locator("#statusText")).toHaveText("Choose one T1 NIfTI image or one DICOM series at a time.", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#imageInput").setInputFiles(T1);
  await expect(page.locator("#fileInfo")).toContainText(T1.name);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("app boots on its workspace, cross-origin isolated, with the shared app bar", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("dialog[open]")).toContainText("BISON");
  await page.locator("dialog[open]").getByRole("button", { name: "Close", exact: true }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("BISON");
  await page.locator("dialog[open]").last().getByRole("button", { name: "Close", exact: true }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("dialog[open]")).toContainText("processed locally in this browser");
});

test("the T1 comes before the FLAIR, and the kernels and runtime are served", async ({ page, request }) => {
  await page.goto("./");
  const order = await page.evaluate(() => {
    const t1 = document.querySelector("#imageInput");
    const flair = document.querySelector("#flairInput");
    return Boolean(t1.compareDocumentPosition(flair) & Node.DOCUMENT_POSITION_FOLLOWING) && flair.dataset.neurodeskInput;
  });
  expect(order).toBe("image");
  await expect(page.locator("#flairDrop")).toBeVisible();
  for (const path of ["hmc-registration/src/worker.js", "hmc-registration/wasm/hmc-registration.wasm", "ants-denoise/src/worker.js", "ants-denoise/wasm/ants-denoise.wasm"]) {
    const response = await request.get(`bison-runtime/${path}`);
    expect(response.ok(), path).toBe(true);
  }
});

for (const [index, mode, hint] of [[0, "t1", /^BISON: 8 tissue classes/], [1, "t1-flair", /^BISON-WMH: 9 classes/]]) {
  test(`example ${examples[index].id} loads its pinned images and enables Run (${mode})`, async ({ page }) => {
    test.setTimeout(180000);
    const example = examples[index];
    await page.goto("./");
    await page.getByLabel("Input", { exact: true }).selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 150000 });
    await expect(page.locator("#fileInfo")).toContainText(example.files[0].name);
    await expect(page.locator("#fileInfo")).toContainText("mm");
    if (example.files[1]) await expect(page.locator("#flairInfo")).toContainText(example.files[1].name);
    else await expect(page.locator("#flairInfo")).toBeHidden();
    await expect(page.locator("#modeHint")).toHaveText(hint);
    await expect(page.locator("#runButton")).toBeEnabled();
    await expect(page.locator("#runButton")).toHaveText("Run segmentation");
    await expect(page.locator("#emptyState")).toBeHidden();
  });
}

test("a failed example download can retry the same example", async ({ page }) => {
  const example = examples[0];
  let attempts = 0;
  await page.route(example.files[0].url, (route) => (++attempts === 1 ? route.fulfill({ status: 503, body: "" }) : route.continue()));
  await page.goto("./");
  const picker = page.getByLabel("Input", { exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 150000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("a T1 that is not one 3D volume is refused with the reason", async ({ page }) => {
  const single = gunzipSync(T1.buffer);
  const series = Buffer.concat([single, single.subarray(352)]);
  series.writeInt16LE(4, 40);
  series.writeInt16LE(2, 48);
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "series.nii", mimeType: "application/x-nifti", buffer: series });
  await expect(page.locator("#statusText")).toHaveText("The T1 must be a single 3D volume.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("Run refuses on a device that reports less memory than BISON needs", async ({ page }) => {
  await reportMemory(page, 4);
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(T1);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("This device reports 4 GB of memory. BISON needs 8 GB or more.");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("Run says the held model files are not published, before any download", async ({ page }) => {
  test.skip(held, "BISON_ASSET_DIR serves the held files to this build");
  await reportMemory(page, 8);
  const downloads = [];
  page.on("request", (request) => {
    if (/huggingface\.co\/.*\/bison\/(templates|models)\//.test(request.url())) downloads.push(request.url());
  });
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(T1);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(NOT_PUBLISHED, { timeout: 60000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#technicalLog").getByRole("tab", { name: "Technical" }).click();
  await expect(page.locator("#technicalLog")).toContainText("Give the URL of a local BISON asset directory");
  expect(downloads).toEqual([]);
});

test("automation reports the held model files as a failed run", async ({ page }) => {
  test.skip(held, "BISON_ASSET_DIR serves the held files to this build");
  await reportMemory(page, 8);
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles(T1);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "t1" });
    await globalThis.neurodeskAutomation.dispatch("start", { operation: "segment" });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 }).toBe("failed");
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error.message).toMatch(/not published yet/);
});
