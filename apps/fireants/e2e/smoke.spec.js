import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

async function stubRegistration(page) {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class WorkerStub {
      constructor(url, options) {
        if (!String(url).includes("/cfireants/worker.js")) return new OriginalWorker(url, options);
      }

      postMessage({ moving, options }) {
        queueMicrotask(() => {
          this.onmessage?.({ data: { type: "log", line: `TEST OPTIONS ${options.backend} ${options.transform} gzip=${options.gzip}` } });
          const image = moving.buffer.slice(moving.byteOffset, moving.byteOffset + moving.byteLength);
          const gpu = options.backend === "webgpu";
          this.onmessage?.({ data: { type: "done", result: { image, elapsedMs: 25, variant: gpu ? "gpu" : "mt", threads: gpu ? 1 : 4, log: "" } } });
        });
      }

      terminate() {}
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/reg/**", (route) => route.fulfill({
    body: fixture,
    contentType: "application/gzip",
    headers: {
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  }));
  await page.addInitScript(() => {
    performance.measureUserAgentSpecificMemory = async () => ({
      bytes: 768 * 1024 * 1024,
      breakdown: [{ bytes: 128 * 1024 * 1024, types: ["GPU"] }],
    });
  });
});

test("built runtime assets include CPU, WebGPU, worker, and legal files", async ({ request }) => {
  for (const path of ["cfireants/cfireants-mt.js", "cfireants/cfireants.js", "cfireants/cfireants-gpu.js", "cfireants/worker.js"]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/javascript/);
    expect(await response.text()).not.toMatch(/<!doctype html>/i);
  }
  for (const path of ["cfireants/cfireants-mt.wasm", "cfireants/cfireants.wasm", "cfireants/cfireants-gpu.wasm"]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect([...(await response.body()).subarray(0, 4)]).toEqual([0, 97, 115, 109]);
  }
  for (const path of ["cfireants/LICENSE", "cfireants/THIRD_PARTY_NOTICES.md"]) {
    expect((await request.get(path)).ok()).toBe(true);
  }
});

test("CPU and Greedy are defaults and registration reports timing and memory", async ({ page }) => {
  await stubRegistration(page);
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
  await expect(page.locator("#useGpu")).not.toBeChecked();
  await expect(page.locator("#useSyn")).not.toBeChecked();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("end to end");
  await expect(page.locator("#statusText")).toContainText("4 CPU threads");
  await expect(page.locator("#technicalLog")).toContainText("TEST OPTIONS cpu greedy");
  await expect(page.locator("#technicalLog")).toContainText("gzip=true");
  await expect(page.locator("#technicalLog")).toContainText("Peak sampled page RAM (cpu): 768.0 MiB");
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
});

test("GPU and SyN choices are forwarded and GPU-attributed memory is logged", async ({ page }) => {
  await stubRegistration(page);
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#useGpu").check();
  await page.locator("#useSyn").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("WebGPU");
  await expect(page.locator("#technicalLog")).toContainText("TEST OPTIONS webgpu syn");
  await expect(page.locator("#technicalLog")).toContainText("GPU-attributed memory: 128.0 MiB");
});

test("the packaged CPU worker completes a small Greedy registration", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 120_000 });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
});

test("shared shell owns information actions and the page is isolated", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("FireANTs registers");
});

test("CPU registration stays available without WebGPU", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { value: undefined }));
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("[data-neurodesk-example]")).toBeEnabled();
  await expect(page.locator("#useGpu")).toBeDisabled();
  await expect(page.locator("#runButton")).toBeEnabled();
});
