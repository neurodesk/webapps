// micro-sam on the pinned example in the production build. The ONNX encoder and decoder on
// ONNX Runtime Web must give micro-sam's PyTorch masks for 24 fixed prompts
// (validation/reference.json, identical SHA-256) and its embedding; the clicked workflow, undo,
// the downloads, cancelling the embedding and a failed example download are checked too.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { example, exampleFile, iou, pinned, reference, routeExample, routeModels, runsToMask } from "./fixtures.mjs";
import { MODELS } from "../src/config.js";
import { readImage } from "../src/image-io.js";

const { width, height } = reference.image;
const KINDS = ["point", "box", "point-negative", "box-point"];
const ofKind = (kind) => reference.cases.filter((item) => item.id === `nucleus-${item.object}-${kind}`);

async function automation(page, prompts) {
  const bytes = await pinned(exampleFile);
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: exampleFile.name, mimeType: "image/tiff", buffer: bytes });
  await page.evaluate(async (parameters) => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters });
  }, { prompts: JSON.stringify(prompts), backend: "wasm" });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 150000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  if (snapshot.error) {
    await page.locator("#technicalLog [role=tab]", { hasText: "Technical" }).click();
    console.log(await page.locator("#technicalLog").innerText());
  }
  expect(snapshot.error?.message ?? null).toBeNull();
  return snapshot.report;
}

async function download(page, stage) {
  const pending = page.waitForEvent("download");
  await page.locator(`#resultList .nd-volume-toggle:has-text("${stage}") .nd-download-btn`).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

async function readLabels(bytes) {
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const image = await tiff.getImage();
  const [data] = await image.readRasters();
  return { width: image.getWidth(), height: image.getHeight(), data };
}

test("fixed prompts give micro-sam's PyTorch masks and embedding", async ({ page }) => {
  test.setTimeout(600000);
  await routeModels(page);
  await page.goto("./");
  let first = true;
  for (const kind of KINDS) {
    const cases = ofKind(kind);
    const report = await automation(page, cases.map((item) => item.prompt));
    expect(report.provenance.backend).toBe("wasm");
    if (first) {
      // The embedding at 512 fixed positions, against PyTorch's.
      const { embedding } = report.provenance;
      expect(embedding.length).toBe(256 * 64 * 64);
      expect(embedding.stride).toBe(reference.embedding.stride);
      const diff = Math.max(...embedding.samples.map((value, i) => Math.abs(value - reference.embedding.samples[i])));
      console.log(`embedding: max abs difference ${diff.toExponential(2)} at 512 positions; mean ${embedding.mean.toExponential(4)} (PyTorch ${reference.embedding.mean.toExponential(4)})`);
      expect(diff).toBeLessThan(1e-3);
      expect(Math.abs(embedding.mean - reference.embedding.mean)).toBeLessThan(1e-5);
      expect(Math.abs(embedding.std - reference.embedding.std)).toBeLessThan(1e-5);
      first = false;
    }
    expect(report.provenance.objects).toHaveLength(cases.length);
    report.provenance.objects.forEach((object, i) => {
      const want = cases[i];
      const score = iou(runsToMask(object.runs, width * height), runsToMask(want.runs, width * height));
      console.log(`${want.id}: token ${object.token}, ${object.area} px (PyTorch ${want.area}), IoU ${score.toFixed(5)}${object.sha256 === want.sha256 ? ", identical" : ""}`);
      expect(object.token).toBe(want.token);
      expect(score).toBeGreaterThanOrEqual(0.99);
      // Measured: every mask equals PyTorch's byte for byte on ONNX Runtime Web's CPU backend.
      expect(object.sha256).toBe(want.sha256);
    });
  }
});

test("clicking, boxing, accepting and undoing objects writes the label TIFF and table", async ({ page }) => {
  test.setTimeout(300000);
  await routeModels(page);
  await routeExample(page);
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
  await expect(page.locator("#fileInfo")).toContainText("360 × 360");
  await page.locator("#embedButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Embeddings ready/, { timeout: 150000 });

  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  const scale = Math.min(box.width / width, box.height / height);
  const at = ([x, y]) => ({ x: box.x + (box.width - width * scale) / 2 + (x + 0.5) * scale, y: box.y + (box.height - height * scale) / 2 + (y + 0.5) * scale });

  // A click on the first reference nucleus' centroid, accepted with Enter.
  const [point] = ofKind("point");
  const click = at(point.prompt.points[0]);
  await page.mouse.click(click.x, click.y);
  await expect(page.locator("#acceptButton")).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(page.locator("#statusText")).toHaveText("Object 1 accepted · 1 object");

  // A box dragged around the second, accepted with the button.
  const boxed = ofKind("box")[1];
  const [x0, y0, x1, y1] = boxed.prompt.box;
  const start = at([x0 - 0.5, y0 - 0.5]);
  const end = at([x1 - 0.5, y1 - 0.5]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#acceptButton")).toBeEnabled();
  await page.locator("#acceptButton").click();
  await expect(page.locator("#statusText")).toHaveText("Object 2 accepted · 2 objects");
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const labels = await download(page, "Object labels");
  expect(labels.name).toBe("bbbc038-nuclei_microsam-labels.tif");
  const image = await readLabels(labels.bytes);
  expect([image.width, image.height]).toEqual([width, height]);
  const reference1 = runsToMask(point.runs, width * height);
  const reference2 = runsToMask(boxed.runs, width * height);
  expect(iou(image.data.map((v) => (v === 1 ? 1 : 0)), reference1)).toBeGreaterThanOrEqual(0.99);
  expect(iou(image.data.map((v) => (v === 2 ? 1 : 0)), reference2)).toBeGreaterThanOrEqual(0.98);

  const table = await download(page, "Object table");
  expect(table.name).toBe("bbbc038-nuclei_microsam-objects.csv");
  const rows = table.bytes.toString("utf8").trim().split("\n");
  expect(rows[0]).toBe("id,area_px,centroid_x,centroid_y,bbox_x0,bbox_y0,bbox_x1,bbox_y1,mean_intensity,predicted_iou,prompt");
  expect(rows).toHaveLength(3);
  const areas = rows.slice(1).map((row) => Number(row.split(",")[1]));
  expect(areas).toEqual([1, 2].map((id) => image.data.filter((v) => v === id).length));
  expect(rows[1].endsWith(",1+")).toBe(true);
  expect(rows[2].endsWith(",box")).toBe(true);

  // Views and undo: Ctrl+Z removes the last object, and the outputs follow.
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Outlines", exact: true }).click();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#statusText")).toHaveText("Object 2 removed");
  await expect(page.locator("#objectInfo")).toHaveText("1 object accepted");
  await expect(page.locator("#resultList")).toContainText("1 object");

  // A negative point needs a positive one to segment; Escape clears the prompt.
  await page.locator("#negativeTool").click();
  await page.mouse.click(click.x, click.y);
  await expect(page.locator("#clearButton")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#clearButton")).toBeDisabled();
});

test("cancelling the embedding stops it and a new run succeeds", async ({ page }) => {
  test.setTimeout(300000);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let holding = true;
  await routeModels(page, { hold: () => (holding ? held : null) });
  await routeExample(page);
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("#embedButton")).toBeEnabled({ timeout: 90000 });
  await page.locator("#embedButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#positiveTool")).toBeDisabled();
  holding = false;
  release();
  await expect(page.locator("#embedButton")).toBeEnabled();
  await page.locator("#embedButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Embeddings ready/, { timeout: 150000 });
  await expect(page.locator("#positiveTool")).toBeEnabled();
});

test("a failed example download can be retried", async ({ page }) => {
  test.setTimeout(180000);
  const body = await pinned(exampleFile);
  let attempts = 0;
  let failing = true;
  await page.route(exampleFile.url, (route) => {
    attempts++;
    // 429 is the status the downloader retries; fail every automatic retry of the first
    // selection (five attempts), and give the second selection the pinned bytes.
    return failing
      ? route.fulfill({ status: 429, headers: { "retry-after": "0" }, body: "" })
      : route.fulfill({ body, headers: { "content-type": "image/tiff", "access-control-allow-origin": "*" } });
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
  expect(attempts).toBe(5);
  await expect(page.locator("#embedButton")).toBeDisabled();
  failing = false;
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
  await expect(page.locator("#fileInfo")).toContainText(exampleFile.name);
  await expect(page.locator("#embedButton")).toBeEnabled();
});

test("prompts outside the image are refused before the embedding", async ({ page }) => {
  await page.goto("./");
  const bytes = await pinned(exampleFile);
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: exampleFile.name, mimeType: "image/tiff", buffer: bytes });
  const snapshot = await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters: { prompts: JSON.stringify([{ points: [[400, 10, 1]] }]) } });
    for (;;) {
      const state = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (state.state !== "running") return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  expect(snapshot.state).toBe("failed");
  expect(snapshot.error.message).toBe("Object 1: point (400, 10) is outside the 360 × 360 image.");
});

test("EM organelle model (vit_t_em_organelles) and 3D Z-stack propagation work end to end", async ({ page }) => {
  test.setTimeout(360000);
  await routeModels(page, { models: MODELS });
  await page.goto("./");

  // 1. Run vit_t_em_organelles via automation on the example image
  const bytes = await pinned(exampleFile);
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: exampleFile.name, mimeType: "image/tiff", buffer: bytes });
  const [firstBox] = ofKind("box");
  await page.evaluate(async (parameters) => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { parameters });
  }, { prompts: JSON.stringify([firstBox.prompt]), model: "vit_t_em_organelles", backend: "wasm" });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 150000 }).toMatch(/succeeded|failed/);
  const emSnap = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(emSnap.error?.message ?? null).toBeNull();
  expect(emSnap.report.provenance.model).toBe("vit_t_em_organelles");
  expect(emSnap.report.provenance.objects[0].area).toBeGreaterThan(100);

  // 2. Build a real 3-slice 360x360 microscopy Z-stack with distinct shifted planes per slice,
  // verify 3D controls appear, prompt a real nucleus on the middle slice, propagate in 3D across
  // all 3 slices, and verify reopening the exported 3D label TIFF preserves Z-axis metadata and
  // distinct per-slice masks.
  const img2d = await readImage(exampleFile.name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const plane0 = img2d.planes[0].data;
  const planeLen = img2d.width * img2d.height;
  const shiftPlane = (src, dx) => {
    const out = new src.constructor(planeLen);
    for (let y = 0; y < img2d.height; y++) {
      const row = y * img2d.width;
      for (let x = 0; x < img2d.width; x++) {
        const sx = Math.min(img2d.width - 1, Math.max(0, x - dx));
        out[row + x] = src[row + sx];
      }
    }
    return out;
  };
  const stackData = new plane0.constructor(planeLen * 3);
  stackData.set(shiftPlane(plane0, -3), 0);
  stackData.set(plane0, planeLen);
  stackData.set(shiftPlane(plane0, 3), planeLen * 2);
  const stackBytes = Buffer.from(writeTiffStack({
    width: img2d.width,
    height: img2d.height,
    data: stackData,
    description: "ImageJ=1.54f\nimages=3\nslices=3\n",
  }));
  await page.locator("#imageInput").setInputFiles({ name: "nuclei-stack.tif", mimeType: "image/tiff", buffer: stackBytes });
  await expect(page.locator("#sliceField")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#sliceLabel")).toHaveText("2 / 3");
  await expect(page.locator("#propagateButton")).toBeVisible();
  await page.locator("#model").selectOption("vit_t_lm");
  await page.locator("#advancedSettings summary").click();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#embedButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Embeddings ready/, { timeout: 150000 });

  const [firstPoint] = ofKind("point");
  const [px, py] = firstPoint.prompt.points[0];
  const canvas = page.locator("#canvas");
  const box = await canvas.boundingBox();
  const scale = Math.min(box.width / img2d.width, box.height / img2d.height);
  const ox = (box.width - img2d.width * scale) / 2;
  const oy = (box.height - img2d.height * scale) / 2;
  await page.mouse.click(box.x + ox + (px + 0.5) * scale, box.y + oy + (py + 0.5) * scale);
  await expect(page.locator("#propagateButton")).toBeEnabled({ timeout: 30000 });
  await page.locator("#propagateButton").click();
  await expect(page.locator("#statusText")).toContainText("Propagated across 3 slices", { timeout: 240000 });
  await page.locator("#acceptButton").click();
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  const table = await download(page, "Object table");
  const lines = table.bytes.toString("utf8").trim().split("\n");
  expect(lines[0]).toMatch(/^id,volume_vx,slices,centroid_x,centroid_y,centroid_z,/);
  const [, volumeVx, slices] = lines[1].split(",");
  expect(Number(slices)).toBe(3);
  expect(Number(volumeVx)).toBeGreaterThan(3000);
  const labelsTiff = await download(page, "Object labels");
  const reopened = await readImage(labelsTiff.name, labelsTiff.bytes.buffer.slice(labelsTiff.bytes.byteOffset, labelsTiff.bytes.byteOffset + labelsTiff.bytes.byteLength));
  expect(reopened.depth).toBe(3);
  expect(reopened.planes).toHaveLength(1);
  const s0 = reopened.slices[0][0].data;
  const s1 = reopened.slices[1][0].data;
  const s2 = reopened.slices[2][0].data;
  expect(s0.some(Boolean)).toBe(true);
  expect(s1.some(Boolean)).toBe(true);
  expect(s2.some(Boolean)).toBe(true);
  // Distinct per-slice masks confirm slice order and content are preserved (no duplication/permutation).
  let diff02 = 0;
  for (let i = 0; i < s0.length; i++) if (s0[i] !== s2[i]) diff02++;
  expect(diff02).toBeGreaterThan(50);
});
