// Full end-to-end ViT classification workflow on the pinned ISIC nevus example,
// fail-once WASM worker recovery, settings invalidation, real 5x5 occlusion saliency PNG export,
// and WebMCP / neurodeskAutomation contract (including error visibility).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { nevusExample, nevusFile, pinned, routeExample, routeModel } from "./fixtures.mjs";

async function downloadResult(page, label) {
  const pending = page.waitForEvent("download");
  await page.locator(`#resultList .nd-volume-toggle:has-text("${label}") .nd-download-btn`).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

test("classifies ISIC_0000000 nevus as NV, downloads CSV/provenance, and clears outputs on settings change", async ({
  page,
}) => {
  test.setTimeout(300000);
  await routeModel(page);
  await routeExample(page, nevusFile);
  await page.goto("./");

  // Track progress values during the run to verify monotonic progression (never moves backward).
  await page.evaluate(() => {
    window.__progressValues = [];
    const bar = document.getElementById("progress");
    const observer = new MutationObserver(() => {
      if (bar.hasAttribute("value")) {
        window.__progressValues.push(Number(bar.getAttribute("value")));
      }
    });
    observer.observe(bar, { attributes: true, attributeFilter: ["value"] });
  });

  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(nevusExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", {
    timeout: 60000,
  });
  await expect(page.locator("#fileInfo")).toContainText(nevusFile.name);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.evaluate(() => {
    window.__progressValues = [];
  });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Classified: NV /, { timeout: 180000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  const progressValues = await page.evaluate(() => window.__progressValues);
  for (let i = 1; i < progressValues.length; i++) {
    expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
  }

  // Report view shows research-only notice, uncalibrated softmax wording, 7-row table, and SVG bar chart
  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#report .nd-message.warning")).toContainText(/uncalibrated softmax scores/i);
  await expect(page.locator("#report .nd-data-table tbody tr")).toHaveCount(7);
  await expect(page.locator("#report .nd-data-table tbody tr").first()).toContainText("NV");
  await expect(page.locator("#report svg.nd-chart")).toBeVisible();

  // Switch back to image view cleanly
  await page.locator("nd-viewer-toolbar").getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.locator("#canvas")).toBeVisible();
  await expect(page.locator("#report")).toBeHidden();

  // Download predictions CSV with disclaimer header and uncalibrated softmax columns
  const csv = await downloadResult(page, "Predictions");
  expect(csv.name).toBe("ISIC_0000000_dermvit-predictions.csv");
  const lines = csv.bytes.toString("utf8").trim().split("\n");
  expect(lines[0]).toMatch(/^# Research & educational use only/);
  expect(lines[1]).toBe("rank,class_index,code,label,softmax_score,softmax_percent,logit");
  expect(lines).toHaveLength(9);
  expect(lines[2]).toMatch(/^1,4,NV,Melanocytic nevi,/);
  const topScore = Number(lines[2].split(",")[4]);
  expect(topScore).toBeGreaterThan(0.5);

  // Download provenance JSON
  const prov = await downloadResult(page, "Provenance");
  expect(prov.name).toBe("ISIC_0000000_dermvit-provenance.json");
  const parsed = JSON.parse(prov.bytes.toString("utf8"));
  expect(parsed.app).toBe("dermvit");
  expect(parsed.researchOnly).toBe(true);
  expect(parsed.prediction.scoreType).toBe("uncalibrated-softmax");
  expect(parsed.prediction.topClass).toBe("NV");
  expect(parsed.preprocessing.colorSpace).toBe("srgb");
  expect(parsed.preprocessing.resize).toMatch(/Pillow antialiased bilinear/i);
  expect(parsed.runtime.backend).toMatch(/^(wasm|webgpu)$/);

  // Changing settings after a run invalidates stale outputs and returns to image view
  await page.locator("#colorConstancy").check();
  await expect(page.locator("#outputSection")).not.toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#report")).toBeHidden();
  await expect(page.locator("#canvas")).toBeVisible();
  await expect(page.locator("#runButton")).toBeEnabled();

  // Re-run briefly (cached session) then fail a replacement upload -> outputs clear, previous image preserved
  await page.locator("#colorConstancy").uncheck();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Classified: NV /, { timeout: 180000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  await page.locator("#imageInput").setInputFiles({
    name: "bad.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#outputSection")).not.toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#fileInfo")).toContainText(nevusFile.name);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("recreates worker cleanly after a fail-once WASM runtime initialization failure", async ({ page }) => {
  test.setTimeout(300000);
  await routeModel(page);
  await routeExample(page, nevusFile);

  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__dermvitWorkersCreated = 0;
    globalThis.Worker = class TrackedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        globalThis.__dermvitWorkersCreated += 1;
      }
    };
  });

  let failWasm = true;
  let failedRequests = 0;
  await page.route("**/ort-wasm*", async (route) => {
    if (failWasm) {
      failedRequests += 1;
      await route.fulfill({ status: 503, body: "Transient WASM unavailable" });
      return;
    }
    await route.continue();
  });

  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(nevusExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", {
    timeout: 60000,
  });

  // Explicitly select wasm backend so the failure is deterministic regardless of GPU availability.
  await page.locator("#advancedSettings summary").click();
  await page.locator("#backend").selectOption("wasm");

  // First run fails on WASM runtime initialization -> worker is terminated and nulled out.
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveClass(/error/, { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(failedRequests).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => globalThis.__dermvitWorkersCreated)).toBe(1);

  // Allow WASM fetches to succeed on retry -> a fresh worker is spawned and classifies NV cleanly.
  failWasm = false;
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Classified: NV /, { timeout: 180000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  expect(await page.evaluate(() => globalThis.__dermvitWorkersCreated)).toBe(2);
});

test("computes 5x5 occlusion saliency, shows relative sensitivity hover readout, and exports bounded PNG", async ({
  page,
}) => {
  test.setTimeout(300000);
  await routeModel(page);
  await routeExample(page, nevusFile);
  await page.goto("./");

  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(nevusExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", {
    timeout: 60000,
  });

  await page.locator("#computeSaliency").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Classified: NV /, { timeout: 240000 });
  await expect(page.locator("#canvas")).toBeVisible();
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");

  // Hover over the center of the canvas to verify relative occlusion sensitivity readout.
  const box = await page.locator("#canvas").boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#location")).toContainText("relative drop % of max positive drop");

  // Download saliency PNG encoded in worker at bounded max 512px resolution (1022x767 -> 512x384).
  const saliencyPng = await downloadResult(page, "Occlusion saliency");
  expect(saliencyPng.name).toBe("ISIC_0000000_dermvit-saliency.png");
  const decoded = decodePng(saliencyPng.bytes);
  expect(decoded.width).toBe(512);
  expect(decoded.height).toBe(384);

  const prov = await downloadResult(page, "Provenance");
  const parsed = JSON.parse(prov.bytes.toString("utf8"));
  expect(parsed.saliency).toBeTruthy();
  expect(parsed.saliency.grid).toBe(5);
  expect(parsed.saliency.targetClass).toBe("NV");
  expect(parsed.saliency.exportWidth).toBe(512);
  expect(parsed.saliency.exportHeight).toBe(384);
  expect(parsed.saliency.exportOpacity).toBe(0.6);
});

test("neurodeskAutomation classify succeeds on valid image and surfaces errors visibly on failure", async ({
  page,
}) => {
  test.setTimeout(300000);
  await routeModel(page);
  const bytes = await pinned(nevusFile);
  await page.goto("./");

  // First verify automation error visibility on a fully transparent PNG.
  const transparentPng = Buffer.from(
    encodePng({
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(8 * 8 * 4),
      channels: 4,
      depth: 8,
    }),
  );
  await page.locator("#neurodesk-input-transfer").setInputFiles({
    name: "transparent.png",
    mimeType: "image/png",
    buffer: transparentPng,
  });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      parameters: { backend: "wasm", colorConstancy: false, computeSaliency: false },
    });
  });
  await expect
    .poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), {
      timeout: 30000,
    })
    .toBe("failed");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#statusText")).toContainText("Image is fully transparent and has no visible pixels.");

  // Now run valid NV classification through automation.
  await page.locator("#neurodesk-input-transfer").setInputFiles({
    name: nevusFile.name,
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      parameters: { backend: "wasm", colorConstancy: false, computeSaliency: false },
    });
  });

  await expect
    .poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), {
      timeout: 180000,
    })
    .toMatch(/succeeded|failed/);

  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error?.message ?? null).toBeNull();
  expect(snapshot.state).toBe("succeeded");
  expect(snapshot.report.provenance.runtime.backend).toBe("wasm");
  expect(snapshot.report.provenance.prediction.topClass).toBe("NV");
  expect(snapshot.report.measurements.topClass).toBe("NV");
  expect(snapshot.report.measurements.topSoftmaxScore).toBeGreaterThan(0.5);
  expect(snapshot.report.artifacts.predictions).toBeTruthy();
  expect(snapshot.report.artifacts.provenance).toBeTruthy();

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "predictions" }));
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe("ISIC_0000000_dermvit-predictions.csv");
  const csvText = readFileSync(await downloaded.path(), "utf8");
  expect(csvText).toContain("# Research & educational use only");
  expect(csvText).toContain("1,4,NV,Melanocytic nevi,");
});
