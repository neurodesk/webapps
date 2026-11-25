// Browser smoke tests against the production build (`vite preview`):
// workspace boot, shared app bar & About/Privacy/theme, COOP/COEP isolation,
// corrupt local upload recovery & Undo hygiene, uniform-image segmentation failure,
// example failure/retry, and cancellation via footer × during download, decode, and worker runs.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { encode } from "fast-png";
import { syntheticLesionPng } from "../test/offline.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cache = new Map();

function uniformSkinPng() {
  const size = 96;
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    rgba[o] = 212;
    rgba[o + 1] = 176;
    rgba[o + 2] = 154;
    rgba[o + 3] = 255;
  }
  const buffer = Buffer.from(encode({ width: size, height: size, data: rgba, channels: 4, depth: 8 }));
  return { name: "uniform-skin.png", mimeType: "image/png", buffer };
}

async function pinnedExampleBytes(example) {
  const file = example.files[0];
  if (!cache.has(file.url)) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`${file.name}: SHA-256 does not match examples.json`);
    }
    cache.set(file.url, bytes);
  }
  return cache.get(file.url);
}

test("app boots on its workspace with analysis disabled and D unscored by default", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#differentialStructures")).toHaveValue("0");
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
});

test("shared app bar owns information actions, sRGB/alpha assumptions, and theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.locator("#infoDialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: `About ${automation.title}`, exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("DullRazor");
  await expect(dialog).toContainText("Shades of Gray");
  await expect(dialog).toContainText("sRGB");
  await expect(dialog).toContainText("alpha < 128");
  await expect(dialog).toContainText("clinician-scored lesions");
  await dialog.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("corrupt local upload resets progress, reports error, preserves prior input, and restores nd-files", async ({ page }) => {
  const valid = syntheticLesionPng();
  await page.goto("./");

  await page.evaluate(() => {
    window.recordedNdFiles = [];
    document.addEventListener("nd-files", (event) => {
      window.recordedNdFiles.push({
        files: [...(event.detail?.files ?? [])].map((f) => f.name),
        cancelPending: Boolean(event.detail?.cancelPending),
      });
    });
  });

  await page.locator("#imageInput").setInputFiles(valid);
  await expect(page.locator("#fileInfo")).toContainText("synthetic-nevus.png");
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#imageInput").setInputFiles({
    name: "corrupt.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("not a valid jpeg"),
  });

  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#statusText")).toContainText("not a PNG or JPEG");
  // Progress bar must be reset to determinate 0 (never left indeterminate without value attribute).
  const progressState = await page.locator("#progress").evaluate((el) => ({
    hasValue: el.hasAttribute("value"),
    value: el.value,
  }));
  expect(progressState).toEqual({ hasValue: true, value: 0 });
  // Previous valid input stays loaded and runnable, and nd-files restored it with cancelPending.
  await expect(page.locator("#fileInfo")).toContainText("synthetic-nevus.png");
  await expect(page.locator("#runButton")).toBeEnabled();
  const events = await page.evaluate(() => window.recordedNdFiles);
  expect(events.at(-1)).toEqual({ files: ["synthetic-nevus.png"], cancelPending: true });
});

test("uniform image reports segmentation failure with no bogus outputs exported", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(uniformSkinPng());
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();

  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#statusText")).toContainText("No lesion detected");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#outputSection")).not.toHaveAttribute("open", "");
});

for (const failure of ["download", "corrupt image"]) {
  test(`a failed ${failure} can retry the same example and resets progress`, async ({ page }) => {
    const example = examples[0];
    const bytes = await pinnedExampleBytes(example);
    let attempts = 0;
    await page.context().route(example.files[0].url, (route) => {
      attempts++;
      if (attempts === 1) {
        return route.fulfill(
          failure === "download"
            ? { status: 404, body: "" }
            : { status: 200, contentType: "image/jpeg", body: "not a valid image" },
        );
      }
      return route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        headers: { "access-control-allow-origin": "*" },
        body: bytes,
      });
    });

    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    expect(await page.locator("#progress").evaluate((el) => el.hasAttribute("value"))).toBe(true);

    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("example download disables Run from the start and can be cancelled via footer cancel button", async ({ page }) => {
  const example = examples[0];
  let releaseDownload;
  const downloadHeld = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  let routeStarted;
  const startedPromise = new Promise((resolve) => {
    routeStarted = resolve;
  });

  await page.context().route(example.files[0].url, async (route) => {
    routeStarted();
    await downloadHeld;
    await route.abort("aborted").catch(() => {});
  });

  await page.goto("./");
  // Load a valid image first so #runButton is initially enabled.
  await page.locator("#imageInput").setInputFiles(syntheticLesionPng());
  await expect(page.locator("#runButton")).toBeEnabled();

  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await startedPromise;

  // #runButton must be disabled immediately while the example downloads, and footer × visible.
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  releaseDownload();

  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(await page.locator("#progress").evaluate((el) => el.hasAttribute("value"))).toBe(true);
});

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  const example = examples[0];
  const bytes = await pinnedExampleBytes(example);
  await page.context().route(example.files[0].url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      headers: { "access-control-allow-origin": "*" },
      body: bytes,
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
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();

  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling an active worker analysis leaves no output and permits a complete retry", async ({ page }) => {
  const sample = syntheticLesionPng();
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles(sample);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (!window.heldWorkerOnce) {
        window.heldWorkerOnce = true;
        const origOnMessage = this.onmessage;
        this.onmessage = (event) => {
          if (event.data?.type === "progress") origOnMessage?.(event);
        };
      }
      return post.call(this, message, transfer);
    };
  });

  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.heldWorkerOnce === true);
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeEnabled();

  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Analysis complete · A\d+ B/);
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
});
