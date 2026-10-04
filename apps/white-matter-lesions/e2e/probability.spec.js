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

// Supply deterministic worker results; use the real output controls and NiiVue renderer.
async function segmentWithMockedWorker(page) {
  await page.route(/\/worker-[^/]+\.js$/, (route) => route.fulfill({
    contentType: "text/javascript",
    headers: { "cross-origin-embedder-policy": "require-corp" },
    body: `self.onmessage = () => self.postMessage({
      type: "result",
      mask: new Uint8Array(${JSON.stringify([...volume(Uint8Array.from(probability, (p) => p > 0.5))])}).buffer,
      probability: new Uint8Array(${JSON.stringify([...volume(probability)])}).buffer,
      tsv: "lesion\\tvoxels\\n1\\t64\\n",
      summary: { count: 1, totalMl: 0.064 }, provenance: {}
    });`,
  }));
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "flair.nii", mimeType: "application/octet-stream", buffer: volume(flair) });
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
