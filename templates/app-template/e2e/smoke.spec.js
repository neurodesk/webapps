// Real browser smoke test. Proves the deployed contract that Node tests cannot:
// cross-origin isolation, worker loading, and app boot. Runs against `vite preview`
// (see playwright.config.js) so it exercises the built, header-served output.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  // Threaded ONNX Runtime needs this; asserts the shared isolation policy worked.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);
});

test("a web worker loads and responds", async ({ page }) => {
  await page.goto("/");
  const ok = await page.evaluate(async () => {
    const src = "self.onmessage = () => self.postMessage('pong');";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url, { type: "module" });
    return await new Promise((resolve) => {
      const finish = (result) => {
        w.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      w.onmessage = (e) => finish(e.data === "pong");
      w.onerror = () => finish(false);
      w.postMessage("ping");
    });
  });
  expect(ok).toBe(true);
});

for (const example of examples) {
  test(`example ${example.id} runs the demonstration and downloads its unchanged image`, async ({ page }) => {
    test.setTimeout(120000);
    await page.goto("/");
    const responsePromise = page.waitForResponse(response => {
      let request = response.request();
      while (request.redirectedFrom()) request = request.redirectedFrom();
      return request.url() === example.files[0].url && response.ok();
    });
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("#fileInfo")).toContainText(example.files[0].name, { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    const inputBytes = await (await responsePromise).body();
    expect(inputBytes.length).toBeGreaterThan(0);
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText("Input copy ready · no scientific processing applied");
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#resultList").getByRole("button", { name: "Download", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(example.files[0].name);
    expect(readFileSync(await download.path())).toEqual(inputBytes);
  });
}

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const example = examples[0];
    let attempts = 0;
    await page.route(example.files[0].url, route => {
      attempts++;
      return attempts === 1
        ? route.fulfill({ status: failure === "download" ? 503 : 200, body: "" })
        : route.fulfill({ body: "sample image bytes" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Example", exact: true });
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
  await page.route(example.files[0].url, route => route.fulfill({ body: "sample image bytes" }));
  await page.goto("/");
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
  const picker = page.getByRole("combobox", { name: "Example", exact: true });
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
