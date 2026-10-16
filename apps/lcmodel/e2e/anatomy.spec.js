import { test, expect } from "@playwright/test";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { forceCpu } from "./tissue-runtime.mjs";

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log(await page.locator("#statusText").textContent({ timeout: 1000 }).catch(() => page.url()));
    await page.screenshot({ path: info.outputPath("failure.png") });
  }
});

const anatomy = {
  name: "anatomy.nii",
  mimeType: "application/octet-stream",
  buffer: syntheticNifti({ dims: [32, 32, 32], spacing: [1, 1, 1], gzip: false, value: (i) => 10 + i % 101 }),
};

async function uploadAnatomy(page) {
  await page.locator("#tissueSection > summary").click();
  await page.locator("#t1Input").setInputFiles(anatomy);
}

async function colors(page) {
  const png = await page.locator("#t1Canvas").screenshot({ path: test.info().outputPath("canvas.png") });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const counts = { gray: 0, green: 0, blue: 0, red: 0 };
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      if (r > 30 && r === g && g === b) counts.gray++;
      if (g > r + 20 && g > b + 20) counts.green++;
      if (b > r + 20 && b > g + 20) counts.blue++;
      if (r > g + 20 && r > b + 20) counts.red++;
    }
    return counts;
  }, png.toString("base64"));
}

test("a T1 opens immediately without spectroscopy and failed replacement keeps it visible", async ({ page }) => {
  await page.goto("/");
  const deferredViewerRequests = [];
  page.context().on("request", (request) => {
    if (/niivue[^/]*\.js/i.test(request.url())) deferredViewerRequests.push(request.url());
  });
  await uploadAnatomy(page);
  await expect(page.locator("#plotLabel")).toHaveText("anatomy.nii");
  await expect(page.locator("#t1Canvas")).toBeVisible();
  await expect(page.locator("#viewerNotice")).toBeHidden();
  await expect(page.locator("#measureButton")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Show spectroscopy voxel" })).toBeDisabled();
  expect((await colors(page)).gray).toBeGreaterThan(1000);
  expect(deferredViewerRequests).toEqual([]);
  await page.locator("#t1Input").setInputFiles({ name: "broken.nii", mimeType: "application/octet-stream", buffer: Buffer.from("not an image") });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#plotLabel")).toHaveText("anatomy.nii");
  expect((await colors(page)).gray).toBeGreaterThan(1000);
});

test("an unsuccessful viewer attachment can be retried", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    let failed = false;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (this.id === "t1Canvas" && kind === "webgl2" && !failed) {
        failed = true;
        return null;
      }
      return original.call(this, kind, ...args);
    };
  });
  await page.goto("/");
  await uploadAnatomy(page);
  await expect(page.locator("#viewerNotice")).toContainText("unavailable");
  await page.locator('.nd-view-tab[data-view="voxel"]').click();
  await expect(page.locator("#viewerNotice")).toBeHidden();
  await expect(page.locator("#plotLabel")).toHaveText("anatomy.nii");
  expect((await colors(page)).gray).toBeGreaterThan(1000);
});

test("segmentation displays a tissue map and independent voxel overlay", async ({ page }) => {
  await forceCpu(page);
  await page.context().route(/\/tissue-worker-[^/]+\.js$/, async (route) => route.fulfill({
    response: await route.fetch(),
    contentType: "text/javascript",
    body: `self.onmessage = ({data: {input}}) => {
      const tissues = {};
      for (const [key, fraction] of Object.entries({gm: 0.6, wm: 0.3, csf: 0.1})) {
        tissues[key] = input.slice(0);
        new Float32Array(tissues[key], 352).fill(fraction);
      }
      self.postMessage({result: {tissues, backend: "cpu", elapsedMs: 1}});
    };`,
  }));
  await page.goto("/");
  const header = {
    samples: 64, rows: 2, synthesizer_frequency: 127731000,
    sample_frequency: 2000, echo_time: 35, repetition_time: 2000, scan_id: "PRESS",
    lr_size: 10, ap_size: 10, cc_size: 10,
    lr_off_center: -16, ap_off_center: -16, cc_off_center: 16,
    lr_angulation: 0, ap_angulation: 0, cc_angulation: 0,
  };
  await page.locator("#dataInput").setInputFiles([
    { name: "scan.sdat", mimeType: "application/octet-stream", buffer: Buffer.alloc(64 * 2 * 8) },
    { name: "scan.spar", mimeType: "text/plain", buffer: Buffer.from(Object.entries(header).map(([key, value]) => `${key} : ${value}\n`).join("")) },
  ]);
  await expect(page.locator("#runButton")).toBeEnabled();
  await uploadAnatomy(page);
  await expect(page.locator("#measureButton")).toBeEnabled();
  await page.locator("#measureButton").click();
  await expect(page.locator("#fGm")).toHaveValue("0.600");
  await expect(page.locator("#statusText")).toContainText("Tissue fractions");
  await expect(page.locator("#outputSection #tissueMap")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Tissue map" })).toHaveValue("gm");
  expect((await colors(page)).green).toBeGreaterThan(1000);
  const redWithVoxel = (await colors(page)).red;
  expect(redWithVoxel).toBeGreaterThan(500);
  await page.getByRole("button", { name: "Show spectroscopy voxel" }).click();
  await expect.poll(async () => (await colors(page)).red).toBeLessThan(redWithVoxel / 2);
  await page.getByRole("combobox", { name: "Tissue map" }).selectOption("wm");
  await expect.poll(async () => (await colors(page)).blue).toBeGreaterThan(1000);
  await page.screenshot({ path: test.info().outputPath("tissue-output-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#tissueMap").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("tissue-output-phone.png"), fullPage: true });
  await page.locator("[data-neurodesk-theme-toggle]").click();
  await page.screenshot({ path: test.info().outputPath("tissue-output-phone-light.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Tissue map" }).selectOption("anatomy");
  await expect.poll(async () => (await colors(page)).gray).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "Show spectroscopy voxel" }).click();
  await expect.poll(async () => (await colors(page)).red).toBeGreaterThan(500);
});
