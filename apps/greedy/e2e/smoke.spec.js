import { verifyStandaloneDialog } from '../../../test-utils/standalone-dialog.mjs';
import { affineDifference, downsampledExamplePair, ncc, readVolume, resampleToGrid } from '../../../test-utils/registration-similarity.mjs';
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));

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
// both roles. The alignment tests below replace this route or bypass it.
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith("live data")) return;
  await serveExamples(page, () => fixture);
});

async function loadExample(page) {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#movingInfo")).toContainText("t1_brain.nii.gz · brain extracted");
  await expect(page.locator("#stationaryInfo")).toContainText("MNI152_T1_1mm_brain.nii.gz · brain extracted");
  await expect(page.locator(".nd-viewer-panel")).toHaveCount(3);
}

async function registerWith(page, method, timeout) {
  await page.locator("#method").selectOption(method);
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#resultList").getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("t1_brain_registered.nii.gz");
  return readVolume(await readFile(await download.path()));
}

// Alignment is judged here, not by the app: the moving image is put on the
// template grid by world coordinates alone (no registration) and compared with
// what the app returned. Measured on this pair at 2 mm: NCC 0.588 before,
// 0.939 after affine and 0.957 after affine plus nonlinear. An output that copies
// either input, or a wrong transform, stays near the "before" value.
function alignment(warped, moving, fixed) {
  const before = ncc(resampleToGrid(moving, fixed).data, fixed.data);
  const after = ncc(warped.data, fixed.data);
  test.info().annotations.push({ type: "ncc", description: `before ${before.toFixed(3)}, after ${after.toFixed(3)}` });
  expect(warped.dims).toEqual(fixed.dims);
  expect(affineDifference(warped.affine, fixed.affine)).toBeLessThan(1e-3);
  expect(before).toBeLessThan(0.7);
  return after;
}

async function expectBothMethodsAlign(page, pair, timeout) {
  await loadExample(page);
  const affine = alignment(await registerWith(page, "affine", timeout), pair.moving, pair.fixed);
  expect(affine).toBeGreaterThan(0.9);
  const deformable = alignment(await registerWith(page, "deformable", timeout), pair.moving, pair.fixed);
  expect(deformable).toBeGreaterThan(0.93);
  expect(deformable).toBeGreaterThan(affine);
}

test("live data examples download and both registration modes align the 1 mm pair", async ({ page }) => {
  test.skip(!process.env.GREEDY_LIVE_DATA, "Set GREEDY_LIVE_DATA=1 to exercise the pinned Hugging Face images.");
  test.setTimeout(900_000);
  await expectBothMethodsAlign(page, await downsampledExamplePair(examples[0], 1), 400_000);
});

// CI registers the same two example images block-averaged to 2 mm, which keeps
// both methods to seconds on a two-core runner.
test("affine and nonlinear registration align the example T1 with the MNI template on the template grid", async ({ page }) => {
  test.setTimeout(600_000);
  const pair = await downsampledExamplePair(examples[0], 2);
  await serveExamples(page, (url) => pair.files[url.split("/").pop()]);
  await expectBothMethodsAlign(page, pair, 240_000);
});

test("the method selector runs affine plus nonlinear registration", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#method option")).toHaveCount(2);
  await expect(page.locator("#method")).toContainText("Affine · NMI");
  await expect(page.locator("#method")).toContainText("Affine + nonlinear · NMI");
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  const lockedWhileClearing = await page.evaluate(() => {
    const method = document.getElementById("method");
    method.value = "deformable";
    method.dispatchEvent(new Event("change"));
    return document.getElementById("runButton").disabled;
  });
  expect(lockedWhileClearing).toBe(true);
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await expect(page.locator("#resultList")).toContainText("Registered moving image");
});

test("custom images are flagged and can be brain extracted per image", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-neurodesk-example]").selectOption("t1-mni");
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120_000 });
  await expect(page.locator("#resultList")).toBeEmpty();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Registration complete", { timeout: 60_000 });
  await page.locator("#movingInput").setInputFiles({ name: "custom.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#movingInfo")).toContainText("not brain extracted");
  await expect(page.locator("#movingExtractButton")).toBeEnabled();
  await expect(page.locator("#stationaryExtractButton")).toBeDisabled();
  await page.locator("#stationaryInput").setInputFiles({ name: "template.nii.gz", mimeType: "application/gzip", buffer: fixture });
  await expect(page.locator("#stationaryInfo")).toContainText("not brain extracted");
  await expect(page.locator("#stationaryExtractButton")).toBeEnabled();
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#controls > #standaloneBtn")).toBeHidden();
  await verifyStandaloneDialog(page, 'greedy');
  await bar.getByRole("button", { name: "Use light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated for threaded Greedy WASM", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test("image controls stay disabled without WebGPU", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { value: undefined }));
  await page.goto("/");
  await expect(page.locator("[data-neurodesk-example]")).toBeDisabled();
  await expect(page.locator("#statusText")).toContainText("WebGPU is unavailable");
});
