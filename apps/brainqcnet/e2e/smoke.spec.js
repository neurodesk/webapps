// Browser tests against `vite preview` of the production build: the shared shell, input
// refusals, cancelling a run, the examples' failure, retry and cancellation paths, and the
// automation contract. workflow.spec.js runs the examples to completion.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { examples, series4d } from "./fixtures.mjs";

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
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.locator("#infoDialog");
  await expect(dialog.getByRole("heading", { name: `About ${automation.title}`, exact: true })).toBeVisible();
  await expect(dialog).toContainText("ResNet152");
  await dialog.getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("./");
  // Threaded ONNX Runtime Web needs this.
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("a 4D series is refused, and the run stays unavailable", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: series4d() });
  await expect(page.locator("#statusText")).toHaveText("This image has 3 volumes. Choose one 3D T1-weighted volume.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("analysis errors and technical lifecycle messages stay in separate logs", async ({ page }) => {
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: series4d() });
  const error = "This image has 3 volumes. Choose one 3D T1-weighted volume.";
  const analysis = page.getByRole("tabpanel", { name: "Analysis log" });
  const technical = page.getByRole("tabpanel", { name: "Technical log" });
  await expect(analysis).toBeVisible();
  await expect(analysis).toContainText(error);
  await expect(analysis).not.toContainText("Reading image");
  await page.getByRole("tab", { name: "Technical", exact: true }).click();
  await expect(technical).toContainText("Reading image");
  await expect(technical).not.toContainText(error);
  await page.locator("#technicalLog").getByRole("button", { name: "Clear", exact: true }).click();
  await expect(technical).toHaveText("");
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await expect(analysis).toContainText(error);
});

test("an areas count outside the offered range is refused at its field", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await page.locator("#advancedSettings").evaluate((section) => { section.open = true; });
  await page.locator("#areas").fill("11");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Areas per axis must be a whole number from 1 to 10.");
  await expect(page.locator("#cancelButton")).toBeHidden();
});

test("cancelling a run stops its worker, leaves no output and permits a retry", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("./");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  const started = page.waitForEvent("worker", (worker) => worker.url().includes("/assets/worker-"));
  await page.locator("#runButton").click();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await stopped;
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Quality verdict" })).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("automation refuses a 4D series with the app's message", async ({ page }) => {
  await page.goto("./");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "sub-01_dwi.nii.gz", mimeType: "application/gzip", buffer: series4d() });
  const snapshot = await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", { operation: "check-quality", parameters: { backend: "wasm" } });
    for (;;) {
      const value = await globalThis.neurodeskAutomation.dispatch("snapshot");
      if (!["queued", "running"].includes(value.state)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  expect(snapshot.state).toBe("failed");
  expect(JSON.stringify(snapshot)).toContain("This image has 3 volumes.");
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(180000);
    let attempts = 0;
    await page.context().route(exampleFile.url, (route) => {
      attempts++;
      if (attempts > 1) return route.fallback();
      return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(180000);
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
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});
