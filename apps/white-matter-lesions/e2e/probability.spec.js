import { test, expect } from "@playwright/test";
import { writeVolume, readVolume } from "@neurodesk/synthsr";
import { readFile } from "node:fs/promises";

const dims = [32, 32, 32];
const affine = [[1, 0, 0, -16], [0, 1, 0, -16], [0, 0, 1, -16], [0, 0, 0, 1]];
const flair = new Float32Array(32 ** 3);
const probability = new Float32Array(flair.length);
for (let z = 4; z < 28; z++) {
  for (let y = 4; y < 28; y++) {
    for (let x = 4; x < 28; x++) {
      const i = x + 32 * (y + 32 * z);
      flair[i] = 100 + x;
      probability[i] = x >= 14 && x < 18 && y >= 14 && y < 18 && z >= 14 && z < 18 ? 0.9 : 0.01;
    }
  }
}
const volume = (data) => Buffer.from(writeVolume({ dims, affine, data }));
const bytesOf = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const buffer = (bytes) => `new Uint8Array(${JSON.stringify([...bytes])}).buffer`;

// Supply deterministic worker results; use the real output controls and NiiVue renderer.
async function segmentWithMockedWorker(page, {
  input = volume(flair),
  resampledFlair = null,
  lesionProbability = probability,
  lesions = [{ ml: 0.064, world: [-0.5, -0.5, -0.5] }],
} = {}) {
  await page.route(/\/worker-[^/]+\.js$/, (route) => route.fulfill({
    contentType: "text/javascript",
    headers: { "cross-origin-embedder-policy": "require-corp" },
    body: `self.onmessage = () => self.postMessage({
      type: "result",
      mask: ${buffer(volume(Uint8Array.from(lesionProbability, (p) => p > 0.5)))},
      probability: ${buffer(volume(lesionProbability))},
      resampledFlair: ${resampledFlair ? buffer(resampledFlair) : "null"},
      tsv: "lesion\\tvoxels\\n1\\t64\\n",
      summary: { count: ${lesions.length}, totalMl: ${lesions.reduce((sum, { ml }) => sum + ml, 0)} },
      lesions: ${JSON.stringify(lesions)}, provenance: {}
    });`,
  }));
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "flair.nii", mimeType: "application/octet-stream", buffer: input });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Segmentation complete");
}

test("lesion probability colors lesions without tinting the background", async ({ page }, testInfo) => {
  await segmentWithMockedWorker(page);
  const probabilityRow = page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Lesion probability" });
  await probabilityRow.getByRole("button", { name: "View", exact: true }).click();
  await expect(probabilityRow.locator(".nd-view-btn")).toHaveClass(/active/);
  for (const layout of ["Axial", "3-Plane"]) {
    await page.getByRole("button", { name: layout, exact: true }).click();
    const screenshot = await page.locator("#gl1").screenshot();
    await testInfo.attach(`probability-${layout}`, { body: screenshot, contentType: "image/png" });
    const coloredFraction = await page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > data[i + 2] + 30 && data[i + 1] > data[i + 2] + 20) colored++;
      }
      return colored / (canvas.width * canvas.height);
    }, screenshot.toString("base64"));
    expect(coloredFraction, "lesions remain visible").toBeGreaterThan(0.001);
    expect(coloredFraction, "background remains transparent").toBeLessThan(0.1);
  }
  const pending = page.waitForEvent("download");
  await probabilityRow.getByRole("button", { name: "Download", exact: true }).click();
  const downloaded = await readFile(await (await pending).path());
  const output = readVolume(bytesOf(downloaded));
  expect(output.data).toEqual(probability);
  await page.screenshot({ path: testInfo.outputPath("probability-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("probability-phone.png"), fullPage: true });
});

test("the viewer steps through lesions, largest first, and the overlay can be hidden", async ({ page }, testInfo) => {
  // A 4 mm cube at voxel 15.5 and a 2 mm cube at voxel 23.5: world -0.5 and 7.5 mm.
  const twoLesions = new Float32Array(flair.length);
  for (const [start, size] of [[14, 4], [23, 2]]) {
    for (let z = start; z < start + size; z++) {
      for (let y = start; y < start + size; y++) {
        for (let x = start; x < start + size; x++) twoLesions[x + 32 * (y + 32 * z)] = 0.9;
      }
    }
  }
  await segmentWithMockedWorker(page, {
    lesionProbability: twoLesions,
    lesions: [{ ml: 0.064, world: [-0.5, -0.5, -0.5] }, { ml: 0.008, world: [7.5, 7.5, 7.5] }],
  });
  const stats = page.getByRole("table", { name: "Lesion statistics" });
  await expect(stats.locator("tr")).toHaveText(["Lesions2", "Total volume0.07 ml", "Largest0.064 ml", "Median0.036 ml", "Smallest0.008 ml"]);
  const navigator = page.getByRole("group", { name: "Lesions" });
  const next = navigator.getByRole("button", { name: "Next lesion" });
  const previous = navigator.getByRole("button", { name: "Previous lesion" });
  await expect(navigator).toContainText("2 lesions");
  const crosshair = async () => (await page.locator("#location").textContent()).match(/-?\d+(\.\d+)?/g)?.slice(0, 3).map(Number);
  await next.click();
  await expect(navigator).toContainText("Lesion 1 of 2 · 0.064 ml");
  await expect.poll(crosshair).toEqual([-0.5, -0.5, -0.5]);
  await next.click();
  await expect(navigator).toContainText("Lesion 2 of 2 · 0.008 ml");
  await expect.poll(crosshair).toEqual([7.5, 7.5, 7.5]);
  await next.click();
  await expect(navigator).toContainText("Lesion 1 of 2");
  await previous.click();
  await expect(navigator).toContainText("Lesion 2 of 2");

  const redFraction = async () => {
    const screenshot = await page.locator("#gl1").screenshot();
    return page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let red = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > data[i + 1] + 60 && data[i] > data[i + 2] + 60) red++;
      return red / (bitmap.width * bitmap.height);
    }, screenshot.toString("base64"));
  };
  const overlay = page.getByRole("button", { name: "Overlay", exact: true });
  await expect(overlay).toHaveAttribute("aria-pressed", "true");
  // The crosshair is red too, so the hidden mask shows as fewer red pixels, not none.
  const shown = await redFraction();
  await page.screenshot({ path: testInfo.outputPath("lesions-desktop.png") });
  await overlay.click();
  await expect(overlay).toHaveAttribute("aria-pressed", "false");
  await expect.poll(redFraction, { message: "the hidden mask leaves the FLAIR" }).toBeLessThan(shown - 0.0005);
  const rows = page.locator("#resultList .nd-volume-toggle");
  await rows.filter({ hasText: "Lesion probability" }).getByRole("button", { name: "View", exact: true }).click();
  await expect(overlay).toHaveAttribute("aria-pressed", "false");
  await expect.poll(crosshair, { message: "switching results keeps the lesion in view" }).toEqual([7.5, 7.5, 7.5]);
  await rows.filter({ hasText: "FLAIR" }).getByRole("button", { name: "View", exact: true }).click();
  await expect(overlay).toBeHidden();
  await expect(navigator).toBeVisible();
  await rows.filter({ hasText: "Lesion mask" }).getByRole("button", { name: "View", exact: true }).click();
  await overlay.click();
  await expect(overlay).toHaveAttribute("aria-pressed", "true");
  await expect.poll(redFraction, { message: "the mask is drawn again" }).toBeCloseTo(shown, 4);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("lesions-phone.png"), fullPage: true });
});

test("editing the lesion mask replaces its download and recomputes the lesion summary", async ({ page }) => {
  await segmentWithMockedWorker(page);
  const rows = page.locator("#resultList .nd-volume-toggle");
  const maskRow = rows.filter({ hasText: "Lesion mask" });
  const tableRow = rows.filter({ hasText: "Lesion table" });
  await expect(page.locator("#resultList .nd-edit-btn")).toHaveCount(1);
  const download = async (row) => {
    const pending = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download", exact: true }).click();
    const file = await pending;
    return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
  };
  const original = await download(maskRow);
  const editor = page.locator("nd-mask-editor");
  const strokeAcrossCentre = async () => {
    await page.getByRole("button", { name: "Axial", exact: true }).click();
    const box = await page.locator("#gl1").boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.35, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(box.x + box.width * (0.35 + 0.03 * step), y);
    await page.mouse.up();
  };
  await maskRow.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Editing Lesion mask");
  await expect(maskRow.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await strokeAcrossCentre();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(maskRow.locator(".nd-stage-label")).toHaveText("Lesion mask · 1 lesion · 0.06 ml");
  expect((await download(maskRow)).bytes.equals(original.bytes)).toBe(true);
  await maskRow.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor).toBeVisible();
  await strokeAcrossCentre();
  await editor.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(maskRow.locator(".nd-stage-label")).toHaveText(/^Lesion mask · 1 lesion · [\d.]+ ml \(edited\)$/);
  await expect(tableRow.locator(".nd-stage-label")).toHaveText("Lesion table (TSV) (edited)");
  const edited = await download(maskRow);
  expect(edited.name).toBe(original.name);
  expect(edited.bytes.readInt16LE(70)).toBe(2);
  const before = readVolume(bytesOf(original.bytes));
  const after = readVolume(bytesOf(edited.bytes));
  expect(after.dims).toEqual(dims);
  expect(after.affine).toEqual(affine);
  const voxels = after.data.reduce((sum, value) => sum + value, 0);
  expect(voxels).toBeGreaterThan(before.data.reduce((sum, value) => sum + value, 0));
  const [, ml] = (await maskRow.locator(".nd-stage-label").textContent()).match(/([\d.]+) ml/);
  expect(ml).toBe((voxels / 1000).toFixed(2));
  const table = (await download(tableRow)).bytes.toString("utf8").trim().split("\n");
  expect(table).toHaveLength(2);
  expect(table[1].split("\t")[1]).toBe(String(voxels));
  await maskRow.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor).toBeVisible();
  await page.locator("#imageInput").setInputFiles({ name: "flair.nii", mimeType: "application/octet-stream", buffer: volume(flair) });
  await expect(editor).toBeHidden();
  await expect(rows).toHaveCount(1);
});

test("a FLAIR finer than the FLAMeS grid is replaced by its resampled copy, so the mask can be edited over it", async ({ page }) => {
  // The worker downsampled a 0.5 mm input onto the 1 mm grid the results use.
  const fine = new Float32Array(64 ** 3).fill(100);
  const input = Buffer.from(writeVolume({ dims: [64, 64, 64], affine: [[0.5, 0, 0, -16.25], [0, 0.5, 0, -16.25], [0, 0, 0.5, -16.25], [0, 0, 0, 1]], data: fine }));
  const resampled = volume(flair);
  await segmentWithMockedWorker(page, { input, resampledFlair: resampled });
  const rows = page.locator("#resultList .nd-volume-toggle");
  const flairRow = rows.filter({ hasText: "FLAIR" }).first();
  await expect(flairRow.locator(".nd-stage-label")).toHaveText("FLAIR · downsampled for FLAMeS");
  const pending = page.waitForEvent("download");
  await flairRow.getByRole("button", { name: "Download", exact: true }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe("flair_flair_resampled.nii");
  expect((await readFile(await file.path())).equals(resampled)).toBe(true);
  const maskRow = rows.filter({ hasText: "Lesion mask" });
  await maskRow.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("nd-mask-editor")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText("Editing Lesion mask");
});
