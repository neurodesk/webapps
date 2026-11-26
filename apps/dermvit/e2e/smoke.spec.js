// Real browser smoke tests against `vite preview` (see playwright.config.js):
// app boot, shared app bar, COOP/COEP cross-origin isolation, invalid file refusal,
// and example download failure/cancel/retry lifecycle.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { encode as encodePng } from "fast-png";
import { examples, nevusExample, nevusFile, pinned } from "./fixtures.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const melanomaExample = examples.find((item) => item.id === "isic-melanoma");
const melanomaFile = melanomaExample.files[0];

test("app boots on the workspace with run disabled and log collapsed", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
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

test("invalid non-image files are refused cleanly", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("plain text payload"),
  });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#statusText")).toContainText(/not a PNG or JPEG/i);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("fully transparent PNG is rejected cleanly", async ({ page }) => {
  const transparentPng = Buffer.from(
    encodePng({
      width: 16,
      height: 16,
      data: new Uint8ClampedArray(16 * 16 * 4),
      channels: 4,
      depth: 8,
    }),
  );
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({
    name: "empty-alpha.png",
    mimeType: "image/png",
    buffer: transparentPng,
  });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#statusText")).toContainText("Image is fully transparent and has no visible pixels.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("pending example download disables Classify and wires footer cancel", async ({ page }) => {
  const validJpeg = await pinned(nevusFile);
  let releaseSecond;
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  await page.route(nevusFile.url, (route) =>
    route.fulfill({
      body: validJpeg,
      headers: {
        "content-type": "image/jpeg",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    }),
  );
  await page.route(melanomaFile.url, async (route) => {
    await secondGate;
    await route.abort("failed");
  });

  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(nevusExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#runButton")).toBeEnabled();

  await picker.selectOption(melanomaExample.id);
  // Immediately while download is in flight, Classify is disabled and footer cancel is visible.
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#cancelButton")).toBeVisible();

  await page.locator("#cancelButton").click();
  releaseSecond();

  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  // Previous image identity is preserved and Classify re-enables.
  await expect(page.locator("#fileInfo")).toContainText(nevusFile.name);
  await expect(page.locator("#runButton")).toBeEnabled();
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const validJpeg = await pinned(nevusFile);
    let attempts = 0;
    await page.route(nevusFile.url, (route) => {
      attempts++;
      return attempts === 1
        ? route.fulfill({ status: failure === "download" ? 503 : 200, body: "" })
        : route.fulfill({
            body: validJpeg,
            headers: {
              "content-type": "image/jpeg",
              "access-control-allow-origin": "*",
              "cross-origin-resource-policy": "cross-origin",
            },
          });
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(nevusExample.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(nevusExample.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  const validJpeg = await pinned(nevusFile);
  await page.route(nevusFile.url, (route) =>
    route.fulfill({
      body: validJpeg,
      headers: {
        "content-type": "image/jpeg",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    }),
  );
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
  await picker.selectOption(nevusExample.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(nevusExample.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
});
