import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { affineDifference, downsampledExamplePair, ncc, readVolume, resampleToGrid } from "../../../test-utils/registration-similarity.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

// Replaces only the registration worker and records what the page posts to it.
// The reply exists so the page can finish; nothing asserted comes from it.
async function recordRegistrationRequests(page) {
  await page.addInitScript(() => {
    window.registrationRequests = [];
    const OriginalWorker = window.Worker;
    window.Worker = class WorkerStub {
      constructor(url, options) {
        if (!String(url).includes("/cfireants/worker.js")) return new OriginalWorker(url, options);
      }

      postMessage({ fixed, moving, options }) {
        window.registrationRequests.push({
          backend: options.backend,
          transform: options.transform,
          gzip: options.gzip,
          fixedBytes: fixed.byteLength,
          movingBytes: moving.byteLength,
        });
        queueMicrotask(() => {
          const image = moving.buffer.slice(moving.byteOffset, moving.byteOffset + moving.byteLength);
          this.onmessage?.({ data: { type: "done", result: { image, elapsedMs: 25, variant: "mt", threads: 1, log: "" } } });
        });
      }

      terminate() {}
    };
  });
}

function serveExamples(page, bodyFor) {
  return page.route("**/reg/**", (route) => route.fulfill({
    body: bodyFor(route.request().url()),
    contentType: "application/gzip",
    headers: {
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  }));
}

// Interface tests only need a loadable image, so they get one small fixture for
// both roles. The alignment test below replaces this route.
test.beforeEach(async ({ page }) => {
  await serveExamples(page, () => fixture);
  await page.addInitScript(() => {
    performance.measureUserAgentSpecificMemory = async () => ({
      bytes: 768 * 1024 * 1024,
      breakdown: [{ bytes: 128 * 1024 * 1024, types: ["GPU"] }],
    });
  });
});

async function loadExample(page) {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
  await expect(page.locator("#runButton")).toBeEnabled();
}

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

test("CPU and Greedy are the defaults posted to the worker, and GPU and SyN choices are forwarded", async ({ page }) => {
  test.setTimeout(180_000);
  await recordRegistrationRequests(page);
  await loadExample(page);
  await expect(page.locator("#useGpu")).not.toBeChecked();
  await expect(page.locator("#useSyn")).not.toBeChecked();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await expect(page.locator("#technicalLog")).toContainText("Peak sampled page RAM (cpu): 768.0 MiB");
  await page.locator("#useGpu").check();
  await page.locator("#useSyn").check();
  await expect(page.locator("#resultList")).toBeEmpty();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#technicalLog")).toContainText("GPU-attributed memory: 128.0 MiB", { timeout: 60_000 });
  const sizes = { fixedBytes: fixture.length, movingBytes: fixture.length };
  expect(await page.evaluate(() => window.registrationRequests)).toEqual([
    { backend: "cpu", transform: "greedy", gzip: true, ...sizes },
    { backend: "webgpu", transform: "syn", gzip: true, ...sizes },
  ]);
});

// The packaged CPU worker registers the app's two example images block-averaged
// to 3 mm. Alignment is judged here, not by the app: the moving image is put on
// the template grid by world coordinates alone (no registration) and compared
// with what the app returned. Measured: NCC 0.597 before and 0.964 after. An
// output that copies either input, or a wrong transform, stays near "before".
test("the packaged CPU worker aligns the example T1 with the MNI template on the template grid", async ({ page }) => {
  test.setTimeout(900_000);
  const { moving, fixed, files } = await downsampledExamplePair(examples[0], 3);
  await serveExamples(page, (url) => files[url.split("/").pop()]);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 780_000 });
  await expect(page.locator("#statusText")).toContainText("end to end");
  await expect(page.locator("#statusText")).toContainText(/\d+ CPU threads?/);
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#resultList").getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("t1_brain_registered.nii.gz");
  const warped = await readVolume(await readFile(await download.path()));
  const before = ncc(resampleToGrid(moving, fixed).data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.7);
  expect(after).toBeGreaterThan(0.9);
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
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("[data-neurodesk-example]")).toBeEnabled();
  await expect(page.locator("#useGpu")).toBeDisabled();
  await expect(page.locator("#runButton")).toBeEnabled();
});
