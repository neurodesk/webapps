// MedSAM2 browser e2e tests: PyTorch SAM2VideoPredictor reference parity (rolling 10-slice box
// + 5-slice single-point), interactive UI prompting, 3D propagation, undo, multi-series selection
// guard, and failed example retry.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { example, exampleFile, pinned, routeExample, routeModels } from "./fixtures.mjs";
import { extractLabelSlice, readNifti3D } from "../src/volume.js";
import { maskIou } from "../src/segmentation.js";

const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));

function runsToMask(runs, size) {
  const mask = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    if (i % 2 === 1) mask.fill(1, at, at + runs[i]);
    at += runs[i];
  }
  return mask;
}

async function download(page, stage) {
  const pending = page.waitForEvent("download");
  await page.locator(`#resultList .nd-volume-toggle:has-text("${stage}") .nd-download-btn`).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

test("automation matches PyTorch SAM2VideoPredictor for rolling box and single-point 3D propagation", async ({ page }) => {
  test.setTimeout(360000);
  await routeModels(page);
  const bytes = await pinned(exampleFile);
  await page.goto("./");
  const [boxCase, pointCase] = reference.cases;
  const runPrompt = async (promptItem) => {
    await page.locator("#neurodesk-input-transfer").setInputFiles({
      name: exampleFile.name,
      mimeType: "application/gzip",
      buffer: bytes,
    });
    await page.evaluate(async (item) => {
      await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
      await globalThis.neurodeskAutomation.dispatch("start", {
        parameters: {
          prompts: JSON.stringify([item]),
          backend: "wasm",
          stopOnEmpty: false,
        },
      });
    }, promptItem);
    await expect.poll(
      () => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state),
      { timeout: 300000 },
    ).toMatch(/succeeded|failed/);
    const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
    expect(snapshot.error?.message ?? null).toBeNull();
    return snapshot;
  };

  // 1. Box prompt across 10 slices (8 backward steps rolling past num_maskmem=7 + 1 forward)
  const boxSnap = await runPrompt(boxCase.prompt);
  const boxObj = boxSnap.report.provenance.objects[0];
  expect(boxObj.slices).toBe(10);

  const seg = await download(page, "3D labels");
  expect(seg.name).toBe("T1_head_medsam2_seg.nii");
  const segVol = await readNifti3D(seg.name, seg.bytes.buffer.slice(seg.bytes.byteOffset, seg.bytes.byteOffset + seg.bytes.byteLength));
  const [nx, ny] = segVol.dims;
  let totalInter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [zStr, refSlice] of Object.entries(boxCase.slices)) {
    const z = Number(zStr);
    const got = extractLabelSlice(segVol.data, segVol.dims, "axial", z).map((v) => (v === 1 ? 1 : 0));
    const expected = runsToMask(refSlice.runs, nx * ny);
    const iou = maskIou(got, expected);
    for (let i = 0; i < got.length; i++) {
      if (got[i] && expected[i]) totalInter++;
      if (got[i]) totalA++;
      if (expected[i]) totalB++;
    }
    expect(iou, `box slice ${z} IoU`).toBeGreaterThanOrEqual(0.985);
  }
  const dice3d = (2 * totalInter) / (totalA + totalB);
  expect(dice3d).toBeGreaterThanOrEqual(0.995);

  const table = await download(page, "Volume table");
  expect(table.name).toBe("T1_head_medsam2_volumes.tsv");
  const lines = table.bytes.toString("utf8").trim().split("\n");
  expect(lines[0]).toMatch(/^label\tvoxels\tvolume_mm3\tvolume_ml\tslices\tcentroid_x_vx\t/);
  expect(lines).toHaveLength(2);
  expect(Number(lines[1].split("\t")[1])).toBe(boxObj.voxels);

  // 2. Single positive point prompt across 5 slices (multimask_output=true, bidirectional)
  const ptSnap = await runPrompt(pointCase.prompt);
  const ptObj = ptSnap.report.provenance.objects[0];
  expect(ptObj.slices).toBe(5);
  const ptSeg = await download(page, "3D labels");
  const ptVol = await readNifti3D(ptSeg.name, ptSeg.bytes.buffer.slice(ptSeg.bytes.byteOffset, ptSeg.bytes.byteOffset + ptSeg.bytes.byteLength));
  let ptInter = 0;
  let ptA = 0;
  let ptB = 0;
  for (const [zStr, refSlice] of Object.entries(pointCase.slices)) {
    const z = Number(zStr);
    const got = extractLabelSlice(ptVol.data, ptVol.dims, "axial", z).map((v) => (v === 1 ? 1 : 0));
    const expected = runsToMask(refSlice.runs, nx * ny);
    expect(maskIou(got, expected), `point slice ${z} IoU`).toBeGreaterThanOrEqual(0.95);
    for (let i = 0; i < got.length; i++) {
      if (got[i] && expected[i]) ptInter++;
      if (got[i]) ptA++;
      if (expected[i]) ptB++;
    }
  }
  expect((2 * ptInter) / (ptA + ptB)).toBeGreaterThanOrEqual(0.98);
});

test("automation requires explicit selection when multiple volumes are provided", async ({ page }) => {
  const bytes = await pinned(exampleFile);
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles([
    { name: "series_a.nii.gz", mimeType: "application/gzip", buffer: bytes },
    { name: "series_b.nii.gz", mimeType: "application/gzip", buffer: bytes },
  ]);
  const snapshot = await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      parameters: {
        prompts: JSON.stringify([{ axis: "axial", slice: 80, points: [[88, 115, 1]], propagate: false }]),
        backend: "wasm",
      },
    });
    for (;;) {
      const state = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (state.state !== "running") return state;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  expect(snapshot.state).toBe("failed");
  expect(snapshot.error.message).toMatch(/image|series|1|multiple|select/i);
});

test("interactive box prompt, 3D propagation, accept and undo work through the UI", async ({ page }) => {
  test.setTimeout(360000);
  await routeModels(page);
  await routeExample(page);
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
  await expect(page.locator("#fileInfo")).toContainText("T1_head.nii.gz");

  // Limit range to 2 slices per side so CPU propagation stays fast in CI
  await page.locator("#advancedSettings summary").click();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#maxRange").fill("2");

  const canvas = page.locator("#promptCanvas");
  const box = await canvas.boundingBox();
  const sx = box.x + box.width * 0.38;
  const sy = box.y + box.height * 0.38;
  const ex = box.x + box.width * 0.62;
  const ey = box.y + box.height * 0.62;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 4 });
  await page.mouse.move(ex, ey, { steps: 4 });
  await page.mouse.up();

  await expect(page.locator("#acceptButton")).toBeEnabled({ timeout: 120000 });
  await expect(page.locator("#propagateButton")).toBeEnabled();
  await page.locator("#propagateButton").click();
  await expect(page.locator("#statusText")).toContainText("Propagated across", { timeout: 240000 });
  await page.locator("#acceptButton").click();
  await expect(page.locator("#objectInfo")).toHaveText("1 object accepted");
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  await page.keyboard.press("Control+z");
  await expect(page.locator("#statusText")).toHaveText("Object 1 removed");
  await expect(page.locator("#objectInfo")).toHaveText("0 objects accepted");
});

test("a failed example download can be retried", async ({ page }) => {
  test.setTimeout(180000);
  const body = await pinned(exampleFile);
  let attempts = 0;
  let failing = true;
  await page.route(exampleFile.url, (route) => {
    attempts++;
    return failing
      ? route.fulfill({ status: 429, headers: { "retry-after": "0" }, body: "" })
      : route.fulfill({ body, headers: { "content-type": "application/gzip", "access-control-allow-origin": "*" } });
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
  expect(attempts).toBe(5);
  failing = false;
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 60000 });
  await expect(page.locator("#fileInfo")).toContainText(exampleFile.name);
});
