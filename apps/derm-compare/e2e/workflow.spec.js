// End-to-end workflow tests for DermCompare: single-slot inputs, multi-file refusal,
// local corrupt-file refusal, flat-image registration failure, interactive Curtain slider + drag,
// Flicker/Checker/ΔE2000 (including 0% opacity)/Report views, settings invalidation, downloads,
// pinned ISIC example, cancellation & retry, and automation contract execution.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decode as decodePng, encode as encodePng } from "fast-png";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeSyntheticPairPng({ name, size = 160, dx = 0, dy = 0, angleDeg = 0, radiusX = 28, radiusY = 20, lesionRgb = [110, 68, 52] }) {
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) * 0.5;
  const cy = (size - 1) * 0.5;
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rx = x - cx - dx;
      const ry = y - cy - dy;
      const lx = cos * rx - sin * ry;
      const ly = sin * rx + cos * ry;
      const tex = 4 * Math.sin((lx + cx) * 0.22) * Math.cos((ly + cy) * 0.18);
      const eDist = Math.hypot(lx / radiusX, ly / radiusY);
      const lobeDist = Math.hypot((lx - radiusX * 0.45) / (radiusX * 0.42), (ly + radiusY * 0.32) / (radiusY * 0.42));
      const w = 1 / (1 + Math.exp((Math.min(eDist, lobeDist) - 1) * 14));
      const p = (y * size + x) * 4;
      data[p] = Math.max(0, Math.min(255, Math.round((224 + tex) * (1 - w) + lesionRgb[0] * w)));
      data[p + 1] = Math.max(0, Math.min(255, Math.round((184 + tex) * (1 - w) + lesionRgb[1] * w)));
      data[p + 2] = Math.max(0, Math.min(255, Math.round((158 + tex) * (1 - w) + lesionRgb[2] * w)));
      data[p + 3] = 255;
    }
  }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encodePng({ width: size, height: size, data, channels: 4, depth: 8 })),
  };
}

function makeFlatPng(name, value = 140, size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encodePng({ width: size, height: size, data, channels: 4, depth: 8 })),
  };
}

async function downloadRow(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  const dl = await event;
  const bytes = readFileSync(await dl.path());
  return { name: dl.suggestedFilename(), bytes, text: bytes.toString("utf8") };
}

test("single-slot loading runs comparison, exercises Curtain slider + drag, all views, downloads, and settings invalidation", async ({ page }) => {
  const baseFile = makeSyntheticPairPng({ name: "nevus_t0.png", dx: 0, dy: 0, angleDeg: 0, radiusX: 28, radiusY: 20, lesionRgb: [116, 74, 56] });
  const follFile = makeSyntheticPairPng({ name: "nevus_t1.png", dx: 8, dy: -6, angleDeg: 10, radiusX: 33, radiusY: 23, lesionRgb: [70, 38, 30] });

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(baseFile);
  await expect(page.locator("#baselineInfo")).toContainText("nevus_t0.png · 160 × 160");
  await expect(page.locator("#runButton")).toBeDisabled();

  await page.locator("#followupInput").setInputFiles(follFile);
  await expect(page.locator("#followupInfo")).toContainText("nevus_t1.png · 160 × 160");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 60000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);

  // Keyboard-accessible Curtain split slider updates split percentage.
  const curtainSlider = page.getByRole("slider", { name: "Curtain split", exact: true });
  await expect(curtainSlider).toBeEnabled();
  await curtainSlider.focus();
  await curtainSlider.fill("75");
  await expect(page.locator("#viewHint")).toContainText("Curtain 75%");
  await curtainSlider.press("ArrowRight");
  await expect(page.locator("#viewHint")).toContainText("Curtain 76%");

  // Pointer drag on canvas also updates the Curtain split slider.
  const box = await page.locator("#canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  expect(Number(await curtainSlider.inputValue())).toBeLessThan(50);

  // Flicker view activates playback toggle, disables Curtain slider, and pauses cleanly.
  await page.locator(".nd-view-tab", { hasText: "Flicker" }).click();
  await expect(page.locator("#flickerToggle")).toBeEnabled();
  await expect(curtainSlider).toBeDisabled();
  await expect(page.locator("#viewHint")).toContainText("Flicker:");
  await page.locator("#flickerToggle").click();
  await expect(page.locator("#flickerToggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#viewHint")).toContainText("paused");

  // Checker view disables flicker toggle.
  await page.locator(".nd-view-tab", { hasText: "Checker" }).click();
  await expect(page.locator("#flickerToggle")).toBeDisabled();
  await expect(page.locator("#viewHint")).toContainText("Checkerboard");

  // ΔE2000 view shows 0–30 legend hint and respects 0% opacity.
  await page.locator(".nd-view-tab", { hasText: "ΔE2000" }).click();
  await expect(page.locator("#viewHint")).toContainText("ΔE2000 (0–30)");
  const overlaySlider = page.locator(".nd-viewer-toolbar input[type='range']");
  await overlaySlider.fill("0");
  await expect(page.locator("#viewHint")).toContainText("heatmap hidden");

  // Report view.
  await page.locator(".nd-view-tab", { hasText: "Report" }).click();
  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#report")).toContainText("Registration");
  await expect(page.locator("#report")).toContainText("Lesion mean ΔE2000 (normalized)");
  await expect(page.locator("#report")).toContainText("Lesion mean ΔE2000 (raw)");

  // Verify all 4 downloads.
  const aligned = await downloadRow(page, "Aligned follow-up");
  expect(aligned.name).toBe("nevus_t0_vs_nevus_t1_aligned.png");
  const alignedDecoded = decodePng(aligned.bytes);
  expect(alignedDecoded.width).toBe(160);
  expect(alignedDecoded.height).toBe(160);

  const changeMap = await downloadRow(page, "ΔE2000 change map");
  expect(changeMap.name).toBe("nevus_t0_vs_nevus_t1_deltaE2000.png");

  const metrics = await downloadRow(page, "Comparison metrics");
  expect(metrics.name).toBe("nevus_t0_vs_nevus_t1_metrics.csv");
  expect(metrics.text).toContain("aligned_ncc");
  expect(metrics.text).toContain("lesion_mean_delta_e2000");

  const prov = await downloadRow(page, "Provenance report");
  expect(prov.name).toBe("nevus_t0_vs_nevus_t1_provenance.json");
  const provJson = JSON.parse(prov.text);
  expect(provJson.app).toBe("derm-compare");
  expect(provJson.registration.alignedNcc).toBeGreaterThan(provJson.registration.initialNcc);
  expect(provJson.registration.scale).toBe(1);

  // Changing a processing setting clears stale comparison outputs.
  await page.locator("#advancedSettings summary").click();
  await page.locator("#allowScale").check();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#statusText")).toContainText("Settings changed");
});

test("multi-file pick in one input is refused cleanly without mutating the other slot", async ({ page }) => {
  const baseFile = makeSyntheticPairPng({ name: "slot_base.png" });
  const follFile = makeSyntheticPairPng({ name: "slot_foll.png", dx: 4, dy: -3 });

  await page.goto("./");
  await page.locator("#followupInput").setInputFiles(follFile);
  await expect(page.locator("#followupInfo")).toContainText("slot_foll.png");

  await page.locator("#baselineInput").setInputFiles([baseFile, follFile]);
  await expect(page.locator("#statusText")).toContainText("Select one image for baseline (and one for follow-up in its slot).");
  await expect(page.locator("#baselineInfo")).toBeHidden();
  await expect(page.locator("#followupInfo")).toContainText("slot_foll.png");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("direct local corrupt file is refused cleanly", async ({ page }) => {
  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles({
    name: "corrupt_lesion.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("definitely-not-a-valid-jpeg"),
  });
  await expect(page.locator("#statusText")).toContainText("corrupt_lesion.jpg is not a supported PNG or JPEG image.");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#baselineInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("unregistrable flat images surface explicit registration failure and suppress downloads", async ({ page }) => {
  const flatA = makeFlatPng("flat_a.png", 140);
  const flatB = makeFlatPng("flat_b.png", 140);

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(flatA);
  await page.locator("#followupInput").setInputFiles(flatB);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Insufficient image texture or overlap for registration", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator(".nd-view-tab", { hasText: "Report" }).click();
  await expect(page.locator("#report")).toContainText("Registration failed");
  await expect(page.locator("#report")).toContainText("Scientific metrics and downloads are suppressed");
});

test("pinned ISIC nevus example loads both captures, improves NCC at unit scale, and downloads artifacts", async ({ page }) => {
  test.setTimeout(180000);
  const example = examples[0];
  await page.goto("./");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#baselineInfo")).toContainText(example.files[0].name, { timeout: 120000 });
  await expect(page.locator("#followupInfo")).toContainText(example.files[1].name, { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 120000 });

  const prov = JSON.parse((await downloadRow(page, "Provenance report")).text);
  expect(prov.registration.registered).toBe(true);
  expect(prov.registration.scale).toBe(1);
  expect(prov.registration.alignedNcc).toBeGreaterThanOrEqual(prov.registration.initialNcc);
  expect(prov.registration.overlapPct).toBeGreaterThan(50);
  expect(prov.metrics.baselineAreaPx).toBeGreaterThan(1000);
  expect(prov.metrics.followupAreaPx).toBeGreaterThan(1000);
});

test("automation compare operation produces all four declared artifacts", async ({ page }) => {
  const baseFile = makeSyntheticPairPng({ name: "auto_base.png", dx: 0, dy: 0, angleDeg: 0 });
  const follFile = makeSyntheticPairPng({ name: "auto_foll.png", dx: 6, dy: -4, angleDeg: 7 });

  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles(baseFile);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("adopt", { role: "baseline" }));
  await page.locator("#neurodesk-input-transfer").setInputFiles(follFile);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "followup" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      operation: "compare",
      parameters: { normalizeColor: true, suppressHair: true, allowScale: false, maxAngle: 20 },
    });
  });

  await expect.poll(
    () => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state),
    { timeout: 60000 },
  ).toMatch(/succeeded|failed/);

  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error?.message ?? null).toBeNull();
  expect(Object.keys(snapshot.report.artifacts).sort()).toEqual(["aligned", "changeMap", "metrics", "provenance"]);
  expect(snapshot.report.provenance.registration.alignedNcc).toBeGreaterThan(snapshot.report.provenance.registration.initialNcc);

  const dlPromise = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "metrics" }));
  const dlBytes = readFileSync(await (await dlPromise).path());
  expect(sha256(dlBytes)).toBe(snapshot.report.artifacts.metrics.sha256);
});

test("cancelling a comparison run leaves no outputs and allows retry", async ({ page }) => {
  const baseFile = makeSyntheticPairPng({ name: "cancel_base.png" });
  const follFile = makeSyntheticPairPng({ name: "cancel_foll.png", dx: 5, dy: 4, angleDeg: 6 });

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(baseFile);
  await page.locator("#followupInput").setInputFiles(follFile);

  // Hold the first worker reply so the cancel button can terminate it deterministically.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message?.type === "compare" && !window.heldCompare) {
        window.heldCompare = true;
        this.onmessage = () => {};
      }
      return post.call(this, message, transfer);
    };
  });

  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.heldCompare === true);
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
});

function makeNoisePng(name, seed, size = 128) {
  let state = seed >>> 0;
  const nextByte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 24) & 255;
  };
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = nextByte();
    data[i + 1] = nextByte();
    data[i + 2] = nextByte();
    data[i + 3] = 255;
  }
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(encodePng({ width: size, height: size, data, channels: 4, depth: 8 })),
  };
}

function makeCropPairPngs() {
  const fw = 2048;
  const fh = 1344;
  const bw = 1024;
  const bh = 672;
  const radiusX = 160;
  const radiusY = 110;
  const follData = new Uint8Array(fw * fh * 4);
  const cx = (fw - 1) * 0.5;
  const cy = (fh - 1) * 0.5;
  for (let y = 0; y < fh; y++) {
    const dy = y - cy;
    const row = y * fw;
    for (let x = 0; x < fw; x++) {
      const dx = x - cx;
      const tex = 4 * Math.sin(dx * 0.14) * Math.cos(dy * 0.12);
      const eDist = Math.hypot(dx / radiusX, dy / radiusY);
      const lobeDist = Math.hypot((dx - radiusX * 0.45) / (radiusX * 0.42), (dy + radiusY * 0.32) / (radiusY * 0.42));
      const w = 1 / (1 + Math.exp((Math.min(eDist, lobeDist) - 1) * 14));
      const p = (row + x) * 4;
      follData[p] = Math.max(0, Math.min(255, Math.round((224 + tex) * (1 - w) + 102 * w)));
      follData[p + 1] = Math.max(0, Math.min(255, Math.round((184 + tex) * (1 - w) + 62 * w)));
      follData[p + 2] = Math.max(0, Math.min(255, Math.round((158 + tex) * (1 - w) + 46 * w)));
      follData[p + 3] = 255;
    }
  }
  const baseData = new Uint8Array(bw * bh * 4);
  const xOff = Math.floor((fw - bw) / 2);
  const yOff = Math.floor((fh - bh) / 2);
  for (let y = 0; y < bh; y++) {
    const srcStart = ((y + yOff) * fw + xOff) * 4;
    baseData.set(follData.subarray(srcStart, srcStart + bw * 4), y * bw * 4);
  }
  return {
    baseline: {
      name: "crop_1024x672.png",
      mimeType: "image/png",
      buffer: Buffer.from(encodePng({ width: bw, height: bh, data: baseData, channels: 4, depth: 8 })),
    },
    followup: {
      name: "full_2048x1344.png",
      mimeType: "image/png",
      buffer: Buffer.from(encodePng({ width: fw, height: fh, data: follData, channels: 4, depth: 8 })),
    },
  };
}

test("uncorrelated noise images are rejected with low correlation failure and suppress downloads", async ({ page }) => {
  const noiseA = makeNoisePng("noise_a.png", 0x11223344);
  const noiseB = makeNoisePng("noise_b.png", 0x88776655);

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(noiseA);
  await page.locator("#followupInput").setInputFiles(noiseB);
  await page.locator("#runButton").click();

  await expect(page.locator("#statusText")).toContainText("Images could not be reliably aligned (low correlation)", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator(".nd-view-tab", { hasText: "Report" }).click();
  await expect(page.locator("#report")).toContainText("Registration failed");
  await expect(page.locator("#report")).toContainText("Scientific metrics and downloads are suppressed");
});

test("1024x672 vs 2048x1344 crop uses shared uniform working scale and preserves ~0% area change", async ({ page }) => {
  test.setTimeout(120000);
  const { baseline, followup } = makeCropPairPngs();

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(baseline);
  await expect(page.locator("#baselineInfo")).toContainText("crop_1024x672.png · 1024 × 672");
  await page.locator("#followupInput").setInputFiles(followup);
  await expect(page.locator("#followupInfo")).toContainText("full_2048x1344.png · 2048 × 1344");

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 90000 });

  const prov = JSON.parse((await downloadRow(page, "Provenance report")).text);
  expect(prov.inputs.baseline.width).toBe(512);
  expect(prov.inputs.baseline.height).toBe(336);
  expect(prov.inputs.baseline.originalWidth).toBe(1024);
  expect(prov.inputs.baseline.originalHeight).toBe(672);
  expect(prov.inputs.followup.width).toBe(1024);
  expect(prov.inputs.followup.height).toBe(672);
  expect(prov.inputs.followup.originalWidth).toBe(2048);
  expect(prov.inputs.followup.originalHeight).toBe(1344);
  expect(prov.registration.scale).toBe(1);
  expect(prov.registration.alignedNcc).toBeGreaterThan(0.9);
  expect(Math.abs(prov.metrics.areaChangePct)).toBeLessThan(8);
});

test("transparent baseline hole zeros alpha in downloaded aligned follow-up PNG", async ({ page }) => {
  const size = 160;
  const baseOrig = makeSyntheticPairPng({ name: "hole_base.png", size, dx: 0, dy: 0, angleDeg: 0 });
  const baseDecoded = decodePng(baseOrig.buffer);
  const baseData = new Uint8Array(baseDecoded.data);
  for (let y = 74; y <= 84; y++) {
    for (let x = 74; x <= 84; x++) {
      const p = (y * size + x) * 4;
      baseData[p] = 0;
      baseData[p + 1] = 0;
      baseData[p + 2] = 0;
      baseData[p + 3] = 0;
    }
  }
  const holeBase = {
    name: "hole_base.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePng({ width: size, height: size, data: baseData, channels: 4, depth: 8 })),
  };
  const opaqueFoll = makeSyntheticPairPng({ name: "opaque_foll.png", size, dx: 4, dy: -3, angleDeg: 5 });

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(holeBase);
  await page.locator("#followupInput").setInputFiles(opaqueFoll);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 60000 });

  const aligned = await downloadRow(page, "Aligned follow-up");
  const alignedDecoded = decodePng(aligned.bytes);
  expect(alignedDecoded.data[(79 * size + 79) * 4 + 3]).toBe(0);
  expect(alignedDecoded.data[(20 * size + 20) * 4 + 3]).toBe(255);
});

test("fresh baseline drop and follow-up drop/replacement both offer Undo and keep slots independent", async ({ page }) => {
  const baseFile = makeSyntheticPairPng({ name: "undo_base.png" });
  const follFileA = makeSyntheticPairPng({ name: "drop_foll_a.png", dx: 4, dy: -2 });
  const follFileB = makeSyntheticPairPng({ name: "drop_foll_b.png", dx: -3, dy: 5 });

  await page.goto("./");
  await page.evaluate(() => {
    window.__baselineNdFiles = [];
    document.getElementById("baselineInput").addEventListener("nd-files", (event) => {
      window.__baselineNdFiles.push(event.detail?.files?.length ?? -1);
    });
  });

  // 1. Fresh page (no prior history): drop directly onto page -> Undo must appear and clear baseline.
  await page.evaluate(({ name, bytes }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { name: baseFile.name, bytes: [...baseFile.buffer] });

  await expect(page.locator("#baselineInfo")).toContainText("undo_base.png");
  await expect(page.locator("#baselineDropZone")).toHaveClass(/has-files/);
  await expect(page.locator(".nd-status-undo")).toBeVisible();

  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#baselineInfo")).toBeHidden();
  await expect(page.locator("#baselineDropZone")).not.toHaveClass(/has-files/);
  await expect(page.locator("#emptyState")).toBeVisible();
  await expect(page.locator("#runButton")).toBeDisabled();
  const ndHistory = await page.evaluate(() => window.__baselineNdFiles);
  expect(ndHistory[ndHistory.length - 1]).toBe(0);

  // 2. Load baseline, drop follow-up A onto #followupDropZone -> Undo clears follow-up without touching baseline.
  await page.locator("#baselineInput").setInputFiles(baseFile);
  await expect(page.locator("#baselineInfo")).toContainText("undo_base.png");

  const dropOnFollowup = async (file) => {
    await page.evaluate(({ name, bytes }) => {
      const zone = document.getElementById("followupDropZone");
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { name: file.name, bytes: [...file.buffer] });
  };

  await dropOnFollowup(follFileA);
  await expect(page.locator("#followupInfo")).toContainText("drop_foll_a.png");
  await expect(page.locator("#baselineInfo")).toContainText("undo_base.png");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator(".nd-status-undo")).toBeVisible();

  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#followupInfo")).toBeHidden();
  await expect(page.locator("#baselineInfo")).toContainText("undo_base.png");
  await expect(page.locator("#runButton")).toBeDisabled();

  // 3. Load follow-up A, then replace via drop with follow-up B -> Undo restores follow-up A.
  await page.locator("#followupInput").setInputFiles(follFileA);
  await expect(page.locator("#followupInfo")).toContainText("drop_foll_a.png");

  await dropOnFollowup(follFileB);
  await expect(page.locator("#followupInfo")).toContainText("drop_foll_b.png");
  await expect(page.locator(".nd-status-undo")).toBeVisible();

  await page.locator(".nd-status-undo").click();
  await expect(page.locator("#followupInfo")).toContainText("drop_foll_a.png");
  await expect(page.locator("#baselineInfo")).toContainText("undo_base.png");
  await expect(page.locator("#runButton")).toBeEnabled();

  // 4. A delayed follow-up drop read superseded by a newer file pick must NOT overwrite the newer pick.
  const staleDropFile = makeSyntheticPairPng({ name: "stale_drop.png", dx: -4, dy: 4 });
  const newerPickFile = makeSyntheticPairPng({ name: "newer_pick.png", dx: 2, dy: -3 });
  await page.evaluate(({ name, bytes }) => {
    const zone = document.getElementById("followupDropZone");
    const file = new File([new Uint8Array(bytes)], name, { type: "image/png" });
    let releaseRead;
    window.__releaseDelayedFollowupDrop = () => releaseRead?.();
    const fakeEntry = {
      isFile: true,
      isDirectory: false,
      file(resolve) {
        releaseRead = () => resolve(file);
      },
    };
    const fakeItems = [
      {
        kind: "file",
        webkitGetAsEntry: () => fakeEntry,
        getAsFile: () => file,
      },
    ];
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], items: fakeItems, files: [file] },
    });
    zone.dispatchEvent(event);
  }, { name: staleDropFile.name, bytes: [...staleDropFile.buffer] });

  await page.locator("#followupInput").setInputFiles(newerPickFile);
  await expect(page.locator("#followupInfo")).toContainText("newer_pick.png");

  await page.evaluate(() => window.__releaseDelayedFollowupDrop());
  await page.waitForTimeout(150);
  await expect(page.locator("#followupInfo")).toContainText("newer_pick.png");
  await expect(page.locator("#followupInfo")).not.toContainText("stale_drop.png");
});

test("cancelling a rerun from ΔE2000 view immediately clears the ΔE2000 heatmap from canvas", async ({ page }) => {
  const baseFile = makeSyntheticPairPng({ name: "rerun_base.png", lesionRgb: [118, 76, 58] });
  const follFile = makeSyntheticPairPng({ name: "rerun_foll.png", dx: 6, dy: -4, angleDeg: 6, radiusX: 34, radiusY: 24, lesionRgb: [58, 30, 24] });

  await page.goto("./");
  await page.locator("#baselineInput").setInputFiles(baseFile);
  await page.locator("#followupInput").setInputFiles(follFile);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Aligned (NCC", { timeout: 60000 });

  await page.locator(".nd-view-tab", { hasText: "ΔE2000" }).click();
  await expect(page.locator("#canvas")).toHaveAttribute("data-mode", "diff");
  const diffCanvasPng = await page.evaluate(() => document.getElementById("canvas").toDataURL());

  // Hold the rerun worker so Cancel triggers deterministically while in ΔE2000 view.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message?.type === "compare" && !window.heldRerun) {
        window.heldRerun = true;
        this.onmessage = () => {};
      }
      return post.call(this, message, transfer);
    };
  });

  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.heldRerun === true);
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();

  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#canvas")).toHaveAttribute("data-mode", "preview");
  await expect(page.locator("#viewHint")).toContainText("Preview");
  const afterCancelPng = await page.evaluate(() => document.getElementById("canvas").toDataURL());
  expect(afterCancelPng).not.toBe(diffCanvasPng);
});
