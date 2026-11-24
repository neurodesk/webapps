// Real browser smoke test against `vite preview` (see playwright.config.js):
// app boot, shared app bar, COOP/COEP, WebMCP automation contract, and example retry/cancel lifecycle.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hasPngSignature } from "fast-png";
import { syntheticDermoscopyPng } from "../test/offline.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const smallestExample = examples[1]; // ISIC_0000013.jpg (38 KB)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cache = new Map();

async function exampleBytes(example) {
  const file = example.files[0];
  if (!cache.has(file.url)) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match examples.json`);
    cache.set(file.url, bytes);
  }
  return cache.get(file.url);
}

test("app boots on the workspace with analysis disabled", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#inspectTool")).toBeDisabled();
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await expect(page.locator("#infoDialog").getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("the automation analyze operation produces all five declared artifacts", async ({ page }) => {
  const sample = syntheticDermoscopyPng();
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles(sample);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {
      parameters: { whiteBalance: false, maskVignette: true, roiMode: "auto" },
    });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state)).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(Object.keys(report.artifacts).sort()).toEqual(["colorimetry", "hemoglobin", "ita", "melanin", "provenance"]);
  expect(report.measurements.comparison.deltaE2000).toBeGreaterThan(15);

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "hemoglobin" }));
  const download = await downloadPromise;
  const bytes = readFileSync(await download.path());
  expect(hasPngSignature(bytes)).toBe(true);
});

for (const failure of ["download", "corrupt bytes"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const bytes = await exampleBytes(smallestExample);
    let attempts = 0;
    await page.context().route(smallestExample.files[0].url, (route) => {
      attempts++;
      return attempts === 1
        ? route.fulfill(failure === "download" ? { status: 503, body: "" } : { status: 200, body: "corrupt bytes" })
        : route.fulfill({ status: 200, contentType: "image/jpeg", body: bytes });
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(smallestExample.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(smallestExample.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  const bytes = await exampleBytes(smallestExample);
  await page.context().route(smallestExample.files[0].url, (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: bytes }));
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
  await picker.selectOption(smallestExample.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(smallestExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
});
