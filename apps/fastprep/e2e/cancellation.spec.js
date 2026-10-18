import { test, expect } from "@playwright/test";

// Control only worker completion after the production app boots. These tests prove lifecycle, not science.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.neurodeskAutomation);
  await page.evaluate(async () => {
    await window.neurodeskAutomation.dispatch("describe");
    window.pipelineWorkers = [];
    window.runControllers = [];
    const Controller = window.AbortController;
    window.AbortController = class extends Controller {
      constructor() {
        super();
        const listeners = new Set();
        const { addEventListener, removeEventListener } = this.signal;
        this.signal.addEventListener = function (type, callback, options) {
          if (type === "abort") listeners.add(callback);
          return addEventListener.call(this, type, callback, options);
        };
        this.signal.removeEventListener = function (type, callback, options) {
          if (type === "abort") listeners.delete(callback);
          return removeEventListener.call(this, type, callback, options);
        };
        this.listeners = listeners;
        window.runControllers.push(this);
      }
    };
    window.Worker = class {
      terminated = false;
      constructor() { window.pipelineWorkers.push(this); }
      postMessage(message) { this.message = message; }
      terminate() { this.terminated = true; }
    };
  });
});

async function start(page, subject = "01") {
  await page.evaluate(async (subject) => {
    const transfer = new DataTransfer();
    for (const suffix of ["T1w", "task-motor_bold"]) {
      transfer.items.add(new File(["lifecycle fixture"], `sub-${subject}_${suffix}.nii.gz`));
    }
    document.getElementById("neurodesk-input-transfer").files = transfer.files;
    await window.neurodeskAutomation.dispatch("adopt", { role: "dataset" });
    await window.neurodeskAutomation.dispatch("start", { operation: "preprocess" });
  }, subject);
}

async function state(page) {
  return page.evaluate(async () => (await window.neurodeskAutomation.dispatch("snapshot")).state);
}

test("automation cancellation stops its worker, restores Run and allows a retry", async ({ page }) => {
  await start(page);
  await expect.poll(() => page.evaluate(() => window.pipelineWorkers.length)).toBe(1);
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.evaluate(() => window.neurodeskAutomation.dispatch("cancel"));
  await expect.poll(() => state(page)).toBe("cancelled");
  expect(await page.evaluate(() => window.pipelineWorkers[0].terminated)).toBe(true);
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  expect(await page.evaluate(() => window.runControllers[0].listeners.size)).toBe(0);

  await start(page, "02");
  await expect.poll(() => page.evaluate(() => window.pipelineWorkers.length)).toBe(2);
  await page.evaluate(() => {
    window.runControllers[0].signal.dispatchEvent(new Event("abort"));
    window.pipelineWorkers[0].onerror({ message: "late failure" });
    window.pipelineWorkers[0].onmessage({ data: { error: "late message" } });
  });
  expect(await page.evaluate(() => window.pipelineWorkers[1].terminated)).toBe(false);
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#statusText")).toHaveText("Preprocessing…");
  await page.locator("#cancelButton").click();
  await expect.poll(() => state(page)).toBe("failed");
  expect(await page.evaluate(() => window.pipelineWorkers[1].terminated)).toBe(true);
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
});

for (const outcome of ["done", "error", "crash"]) {
  test(`worker ${outcome} removes its abort listener before a later run`, async ({ page }) => {
    await start(page);
    await expect.poll(() => page.evaluate(() => window.pipelineWorkers.length)).toBe(1);
    await page.evaluate((outcome) => {
      const worker = window.pipelineWorkers[0];
      if (outcome === "crash") worker.onerror({ message: "controlled worker crash" });
      else worker.onmessage({ data: outcome === "error"
        ? { error: "controlled pipeline failure" }
        : { done: [["sub-01.html", new TextEncoder().encode("<h1>Lifecycle fixture</h1>")]] } });
    }, outcome);
    await expect.poll(() => state(page)).toBe(outcome === "done" ? "succeeded" : "failed");
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(await page.evaluate(() => window.pipelineWorkers[0].terminated)).toBe(true);
    expect(await page.evaluate(() => window.runControllers[0].listeners.size)).toBe(0);
    await start(page, "02");
    await expect.poll(() => page.evaluate(() => window.pipelineWorkers.length)).toBe(2);
    await page.evaluate(() => {
      window.runControllers[0].abort();
      window.runControllers[0].signal.dispatchEvent(new Event("abort"));
    });
    expect(await page.evaluate(() => window.pipelineWorkers[1].terminated)).toBe(false);
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(page.locator("#fileInfo")).toHaveText("2 files · sub-02");
    await page.evaluate(() => window.neurodeskAutomation.dispatch("cancel"));
    expect(await page.evaluate(() => window.pipelineWorkers[1].terminated)).toBe(true);
    await expect(page.locator("#runButton")).toBeEnabled();
  });
}
