// Real browser smoke test against `vite preview` (see playwright.config.js):
// app boot, shared app bar, COOP/COEP isolation, automation operation, example
// loading/failure/retry/cancel/race behaviour, invalid local files, and worker cancel.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { syntheticWoundPng } from "../test/offline.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));

const cachedExamples = new Map();
async function exampleBytes(example) {
  if (!cachedExamples.has(example.id)) {
    const response = await fetch(example.files[0].url);
    if (!response.ok) throw new Error(`Failed to fetch ${example.files[0].url}: ${response.status}`);
    cachedExamples.set(example.id, Buffer.from(await response.arrayBuffer()));
  }
  return cachedExamples.get(example.id);
}

test("app boots on the workspace with primary action disabled", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
  await expect(page.locator("#rybSettings")).not.toHaveAttribute("open", "");
  await expect(page.locator("#annotationCoordinates")).not.toHaveAttribute("open", "");
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await expect(page.locator("#infoDialog")).toContainText("color-based");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("automation measure operation produces all 4 artifacts and valid provenance", async ({ page }) => {
  const sample = syntheticWoundPng();
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles(sample);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      operation: "measure",
      parameters: { pixelsPerMm: 10 },
    });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state)).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.woundDetected).toBe(true);
  expect(report.provenance.segmentation.seedFallback).toBe(false);
  expect(report.provenance.planimetry.calibrated).toBe(true);
  expect(report.provenance.planimetry.areaCm2).toBeGreaterThan(0.3);
  expect(report.provenance.planimetry.circularity).toBeLessThanOrEqual(1);
  expect(report.provenance.ryb.classes.red.percent).toBeGreaterThan(35);
  expect(report.provenance.ryb.classes.unclassified.label).toBe("Unclassified");
  expect(report.provenance.method).toContain("color-based RYB");
  expect(Object.keys(report.artifacts).sort()).toEqual(["mask", "planimetry", "provenance", "rybOverlay"]);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const example = examples[0];
    const bytes = await exampleBytes(example);
    let attempts = 0;
    await page.route(example.files[0].url, (route) => {
      attempts++;
      return attempts === 1
        ? route.fulfill({ status: failure === "download" ? 404 : 200, body: "" })
        : route.fulfill({ status: 200, contentType: "image/jpeg", body: bytes });
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  const example = examples[0];
  const bytes = await exampleBytes(example);
  await page.route(example.files[0].url, (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: bytes }));
  await page.goto("./");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
});

test("example fetch immediately disables Measure and a newer local pick supersedes it cleanly", async ({ page }) => {
  const example = examples[0];
  const bytes = await exampleBytes(example);
  let releaseRoute;
  const routeStarted = new Promise((resolve) => {
    page.route(example.files[0].url, async (route) => {
      resolve();
      await new Promise((done) => {
        releaseRoute = done;
      });
      await route.fulfill({ status: 200, contentType: "image/jpeg", body: bytes });
    });
  });

  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng("first.png"));
  await expect(page.locator("#runButton")).toBeEnabled();

  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await routeStarted;

  // Measure must already be disabled before fetchFiles() resolves.
  await expect(page.locator("#runButton")).toBeDisabled();

  // Picking a newer local file cancels the pending example fetch and loads cleanly.
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng("replacement.png"));
  await expect(page.locator("#fileInfo")).toContainText("replacement.png");
  await expect(page.locator("#runButton")).toBeEnabled();

  releaseRoute();
  await page.waitForTimeout(150);
  await expect(page.locator("#fileInfo")).toContainText("replacement.png");
});

test("invalid local file import resets progress bar from indeterminate and surfaces error", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello world"),
  });
  await expect(page.locator("#statusText")).toContainText("not a PNG or JPEG");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#runButton")).toBeDisabled();
  const progressValue = await page.locator("#progress").getAttribute("value");
  expect(progressValue).toBe("0");
});

test("cancelling a running worker measurement restores controls cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class DelayedWorker extends NativeWorker {
      postMessage(msg, transfer) {
        this._delayedTimer = setTimeout(() => {
          super.postMessage(msg, transfer);
        }, 5000);
      }
      terminate() {
        clearTimeout(this._delayedTimer);
        super.terminate();
      }
    };
  });
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(syntheticWoundPng());
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  const progressValue = await page.locator("#progress").getAttribute("value");
  expect(progressValue).toBe("0");
});
