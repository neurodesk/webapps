// Browser tests against `vite preview` of the production build: shared shell, input
// refusals, settings validation, and example failure, retry and cancellation paths.
// workflow.spec.js runs Cellpose 2D and 3D models end to end.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { examples } from "./reference.mjs";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const [example] = examples;
const [exampleFile] = example.files;

test("app boots into the workspace with the examples offered", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  const options = await page.locator("select[data-neurodesk-example] option").evaluateAll((items) => items.map((item) => item.value).filter(Boolean));
  expect(options).toEqual(examples.map((item) => item.id));
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#technicalLog")).toHaveClass(/collapsed/);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.locator("#infoDialog");
  await expect(dialog.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await expect(dialog).toContainText("cyto3");
  await dialog.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("a file that is not an image or has corrupt TIFF headers is refused, and the run stays unavailable", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "scan.nii", mimeType: "application/octet-stream", buffer: Buffer.alloc(400, 1) });
  await expect(page.locator("#statusText")).toHaveText("scan.nii is not a TIFF, OME-TIFF or PNG image.");
  await expect(page.locator("#runButton")).toBeDisabled();
  // Corrupt TIFF magic bytes exercise decoder rejection directly (bypassing example SHA-256 verification).
  await page.locator("#imageInput").setInputFiles({ name: "corrupt.tif", mimeType: "image/tiff", buffer: Buffer.from([0x49, 0x49, 42, 0, 99, 0, 0, 0]) });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("invalid thresholds are refused and model defaults restore cleanly", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
  await expect(page.locator("#diameter")).toHaveValue("60");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#flowThresh").fill("5");
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("The flow error threshold must be between 0 and 3.");
  await expect(page.locator("#advancedSettings")).toHaveAttribute("open", "");
  await page.locator("#resetSettings").click();
  await expect(page.locator("#flowThresh")).toHaveValue("0.4");
  await expect(page.locator("#diameter")).toHaveValue("30");
  await page.locator("#model").selectOption("nuclei");
  await expect(page.locator("#diameter")).toHaveValue("17");
  await expect(page.locator("#nuclearChannelField")).toBeHidden();
});

for (const failure of ["download", "unreadable image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(120000);
    let attempts = 0;
    await page.route(exampleFile.url, async (route) => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: failure === "download" ? 503 : 200, body: failure === "download" ? "" : "not an image" });
      return route.fulfill({ response: await route.fetch() });
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 60000 });
    await expect(page.locator("#runButton")).toBeDisabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
    await expect(page.locator("#fileInfo")).toHaveText(`${exampleFile.name} · 256 × 256 · OME-TIFF · 2 channels`);
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling the example download leaves no input and permits a retry", async ({ page }) => {
  test.setTimeout(120000);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route(exampleFile.url, async (route) => {
    attempts++;
    if (attempts === 1) await held;
    return route.fulfill({ response: await route.fetch() }).catch(() => {});
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  release();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 90000 });
});
