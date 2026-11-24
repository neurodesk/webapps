// Interactive workflow e2e test: synthetic dermoscopy analysis, view switching, pixel hover,
// interactive circular ROI placement & keyboard coordinates, empty/transparent/neutral-gray ROIs,
// vignette exclusion on ISIC_0000004, cancelled rerun atomicity, example-switch race, and downloads.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { encode as encodePng, hasPngSignature } from "fast-png";
import { syntheticDermoscopyPng, verifyOffline } from "../test/offline.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));

function makePngFile(name, width, height, fillPixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fillPixel(x, y);
      const idx = (y * width + x) << 2;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  const png = encodePng({ width, height, data, channels: 4, depth: 8 });
  return { name, mimeType: "image/png", buffer: Buffer.from(png) };
}

async function downloadResult(page, labelSubstring) {
  const promise = page.waitForEvent("download");
  await page.locator(`#resultList .nd-volume-toggle:has-text("${labelSubstring}") .nd-download-btn`).click();
  const dl = await promise;
  return { filename: dl.suggestedFilename(), path: await dl.path() };
}

test("full interactive chromophore workflow: maps, hover inspection, manual ROIs, and report", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticDermoscopyPng());
  await expect(page.locator("#fileInfo")).toContainText("synthetic-vascular.png");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/);
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(5);

  // Switch viewer tabs: Melanin, ITA°, Report, back to Hemoglobin
  await page.getByRole("button", { name: "Melanin", exact: true }).click();
  await page.getByRole("button", { name: "ITA°", exact: true }).click();
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report")).toBeVisible();
  await expect(page.locator("#report table")).toBeVisible();
  await expect(page.locator("#report svg")).toBeVisible();
  await expect(page.locator("#report")).toContainText("CIEDE2000");

  await page.getByRole("button", { name: "Hemoglobin", exact: true }).click();
  await expect(page.locator("#canvas")).toBeVisible();

  // Hover center pixel to verify live Lab, ITA°, EI, MI readout
  const box = await page.locator("#canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await expect(page.locator("#location")).toContainText("L*");
  await expect(page.locator("#location")).toContainText("ITA");
  await expect(page.locator("#location")).toContainText("EI");
  await expect(page.locator("#location")).toContainText("MI");

  // Place manual Target ROI by dragging on canvas, then Reset to Auto
  await page.locator("#targetRoiTool").click();
  await expect(page.locator("#targetRoiTool")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 24, cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#statusText")).toContainText("Target ROI updated");
  await expect(page.locator("#resetRoiButton")).toBeEnabled();

  await page.locator("#resetRoiButton").click();
  await expect(page.locator("#statusText")).toContainText("Auto ROIs restored");
  await expect(page.locator("#resetRoiButton")).toBeDisabled();
});

test("offline helper verifies synthetic PNG analysis and downloads", async ({ page }) => {
  await page.goto("./");
  const summary = await verifyOffline(page, {
    download: async (selector) => {
      const promise = page.waitForEvent("download");
      await page.locator(selector).click();
      const dl = await promise;
      return { filename: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
    },
  });
  expect(summary.deltaE2000).toBeGreaterThan(15);
});

test("pinned example runs through worker analysis and downloads valid PNG & CSV", async ({ page }) => {
  test.setTimeout(120000);
  const example = examples[1]; // ISIC_0000013.jpg (38 KB pigmented melanoma)
  await page.goto("./");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name, { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/, { timeout: 60000 });

  const csvPromise = page.waitForEvent("download");
  await page.locator('#resultList .nd-volume-toggle:has-text("Colorimetry metrics") .nd-download-btn').click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toBe("ISIC_0000013_colorimetry.csv");
  const csvText = readFileSync(await csvDownload.path(), "utf8");
  expect(csvText).toContain("target_minus_reference");

  const melPromise = page.waitForEvent("download");
  await page.locator('#resultList .nd-volume-toggle:has-text("Melanin map") .nd-download-btn').click();
  const melDownload = await melPromise;
  expect(melDownload.suggestedFilename()).toBe("ISIC_0000013_melanin.png");
  expect(hasPngSignature(readFileSync(await melDownload.path()))).toBe(true);
});

test("ISIC_0000004 excludes dark circular dermoscope vignette and records proxy model in provenance", async ({ page }) => {
  test.setTimeout(120000);
  const example = examples[2]; // ISIC_0000004.jpg
  await page.goto("./");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name, { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/, { timeout: 60000 });

  const provDl = await downloadResult(page, "Provenance");
  expect(provDl.filename).toBe("ISIC_0000004_provenance.json");
  const prov = JSON.parse(readFileSync(provDl.path, "utf8"));
  expect(prov.preprocessing.vignetteExcludedPixels).toBeGreaterThan(100000);
  expect(prov.preprocessing.vignetteGuardTriggered).toBe(false);
  expect(prov.methods.chromophoreModel.perImageIca).toBe(false);
  expect(prov.methods.chromophoreModel.calibratedSpectrophotometry).toBe(false);
  expect(prov.methods.chromophoreModel.basisMatrix).toHaveLength(3);
  expect(prov.display.hemoglobin.range).toHaveLength(2);
  expect(prov.display.melanin.range).toHaveLength(2);
  expect(prov.overlapPixels).toBe(0);
});

test("1x1 image, transparent PNG, and neutral gray b*<=0 ITA domain produce honest unavailable/outside-domain outputs", async ({ page }) => {
  // 1. 1x1 skin image -> Reference ROI has 0 px -> Unavailable / em-dash, empty CSV delta_e2000
  const oneByOne = makePngFile("one-pixel.png", 1, 1, () => [215, 175, 145, 255]);
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(oneByOne);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/);

  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report")).toContainText("Unavailable");
  await expect(page.locator("#report")).toContainText("0 px");
  await expect(page.locator("#report")).not.toContainText("NaN");
  const oneCsvDl = await downloadResult(page, "Colorimetry metrics");
  const oneCsvLines = readFileSync(oneCsvDl.path, "utf8").trim().split("\n");
  const diffCols = oneCsvLines[3].split(",");
  expect(diffCols[diffCols.length - 1]).toBe("");

  // 2. Half-transparent, half-neutral-gray PNG with maskVignette OFF
  const halfTransGray = makePngFile("transparent-gray.png", 64, 64, (x) => (
    x < 32 ? [255, 0, 0, 0] : [140, 140, 140, 255]
  ));
  await page.locator("#imageInput").setInputFiles(halfTransGray);
  await expect(page.locator("#fileInfo")).toContainText("transparent-gray.png");
  await page.locator("#advancedSettings summary").click();
  await page.locator("#maskVignette").uncheck();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/);

  // Hover left half (transparent) and right half (neutral gray b* <= 0)
  const box = await page.locator("#canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.5);
  await expect(page.locator("#location")).toContainText("Transparent (excluded)");
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.5);
  await expect(page.locator("#location")).toContainText("ITA n/a (Outside skin domain)");

  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report")).toContainText("Outside skin domain");
  const provDl = await downloadResult(page, "Provenance");
  const prov = JSON.parse(readFileSync(provDl.path, "utf8"));
  expect(prov.preprocessing.alphaExcludedPixels).toBe(32 * 64);
  expect(prov.summary.target.itaValidPixels).toBe(0);
  expect(prov.summary.target.ita.mean).toBeNull();
});

test("cancelled rerun preserves previous committed provenance and settings atomically", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticDermoscopyPng());
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/);

  const firstProvDl = await downloadResult(page, "Provenance");
  const firstProv = JSON.parse(readFileSync(firstProvDl.path, "utf8"));
  expect(firstProv.settings.whiteBalance).toBe(false);

  // Delay next worker start so Cancel can deterministically abort mid-run
  await page.evaluate(() => {
    const OrigWorker = window.Worker;
    window.Worker = class DelayedWorker extends OrigWorker {
      postMessage(...args) {
        this._delayTimer = setTimeout(() => super.postMessage(...args), 2000);
      }
      terminate() {
        clearTimeout(this._delayTimer);
        super.terminate();
      }
    };
  });

  await page.locator("#advancedSettings summary").click();
  await page.locator("#whiteBalance").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");

  // Previous committed provenance must still record whiteBalance: false
  const secondProvDl = await downloadResult(page, "Provenance");
  const secondProv = JSON.parse(readFileSync(secondProvDl.path, "utf8"));
  expect(secondProv.settings.whiteBalance).toBe(false);
  expect(secondProv.summary.comparison.deltaE2000).toBeCloseTo(firstProv.summary.comparison.deltaE2000, 4);
});

test("example switch disables Analyze immediately while download is pending and connects footer Cancel", async ({ page }) => {
  const example = examples[1];
  let releaseRoute;
  await page.context().route(example.files[0].url, (route) => new Promise((resolve) => {
    releaseRoute = async () => {
      await route.abort();
      resolve();
    };
  }));

  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticDermoscopyPng());
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  // Immediately disabled before network response resolves
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#cancelButton")).toBeVisible();

  await page.locator("#cancelButton").click();
  if (releaseRoute) await releaseRoute();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("keyboard manual ROI coordinates support overlap warning, empty excluded ROI, and Report disables canvas tools", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticDermoscopyPng());
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis ready/);

  // Canvas ROI tools disable when viewing Report
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#inspectTool")).toBeDisabled();
  await expect(page.locator("#targetRoiTool")).toBeDisabled();
  await expect(page.locator("#refRoiTool")).toBeDisabled();

  await page.getByRole("button", { name: "Hemoglobin", exact: true }).click();
  await expect(page.locator("#targetRoiTool")).toBeEnabled();

  // Keyboard-entered overlapping ROIs trigger overlap warning
  await page.locator("#manualRoiSection summary").click();
  await page.locator("#targetX").fill("50");
  await page.locator("#targetY").fill("50");
  await page.locator("#targetR").fill("15");
  await page.locator("#refX").fill("55");
  await page.locator("#refY").fill("50");
  await page.locator("#refR").fill("15");
  await page.locator("#refR").press("Enter");
  await expect(page.locator("#statusText")).toContainText("Manual ROI coordinates updated");

  await page.getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator("#report .nd-message.warning")).toContainText("overlap");
  const overlapProvDl = await downloadResult(page, "Provenance");
  const overlapProv = JSON.parse(readFileSync(overlapProvDl.path, "utf8"));
  expect(overlapProv.overlapPixels).toBeGreaterThan(0);

  // Keyboard-entered Target ROI entirely inside dark vignette corner -> 0 valid px, Unavailable
  await page.locator("#targetX").fill("2");
  await page.locator("#targetY").fill("2");
  await page.locator("#targetR").fill("2");
  await page.locator("#applyManualRoiButton").click();
  await expect(page.locator("#statusText")).toContainText("Manual ROI coordinates updated");
  await expect(page.locator("#report")).toContainText("0 valid pixels");
  await expect(page.locator("#report")).toContainText("Unavailable");
  await expect(page.locator("#report svg")).not.toContainText("Target (coord ITA");

  await page.locator("#resetRoiButton").click();
  await expect(page.locator("#statusText")).toContainText("Auto ROIs restored");
  await expect(page.locator("#resetRoiButton")).toBeDisabled();
});
