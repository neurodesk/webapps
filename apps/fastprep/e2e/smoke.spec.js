// Real browser tests: cross-origin isolation, app boot and the full example pipeline in Chromium.
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { hardwareGpu } from "../../../test-utils/hardware-gpu.mjs";

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
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

const [example] = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const exampleUrls = example.files.map((file) => file.url);
const picker = (page) => page.locator("select[data-neurodesk-example]");
const exampleState = (page) => page.locator("[data-neurodesk-examples]");
// Only paths matter until Run, so placeholder bytes stand in for the images.
const BIDS = ["dataset_description.json", "sub-01/anat/sub-01_T1w.nii.gz", "sub-01/func/sub-01_task-motor_bold.nii.gz"];

// The example's downloads, answered by respond(index, route) unless it returns null. Routed on the
// context so requests from the app's service worker are caught too.
async function routeExample(page, respond) {
  await page.context().route((url) => exampleUrls.includes(url.href), (route) =>
    respond(exampleUrls.indexOf(route.request().url()), route) ?? route.continue());
}

test("files dropped over the viewer load as the dataset", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((names) => {
    const transfer = new DataTransfer();
    for (const name of names) transfer.items.add(new File(["x"], name.split("/").at(-1)));
    const target = document.getElementById("gl1");
    for (const type of ["dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, BIDS);
  await expect(page.locator("#fileInfo")).toHaveText("3 files · sub-01");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("the native folder chooser reads a BIDS tree", async ({ page }, testInfo) => {
  const root = testInfo.outputPath("bids");
  for (const name of BIDS) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), "x");
  }
  await page.addInitScript(() => { window.showDirectoryPicker = undefined; });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await picker(page).selectOption(await picker(page).locator('[data-action="folder"]').elementHandle());
  await (await chooser).setFiles(root);
  await expect(page.locator("#fileInfo")).toHaveText("3 files · sub-01");
});

test("Undo restores an example after a dropped replacement", async ({ page }) => {
  await page.goto("/");
  await picker(page).selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText("6 files · sub-01", { timeout: 300_000 });
  await page.locator("#synthsr").selectOption("off");
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["replacement"], "sub-02_T1w.nii.gz"));
    document.getElementById("gl1").dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    }));
  });
  await expect(page.locator("#fileInfo")).toHaveText("1 files · sub-02");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#fileInfo")).toHaveText("6 files · sub-01");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#synthsr")).toHaveValue("off");
  await expect(page.locator("#resultList button")).toHaveCount(0);
});

test("a failed example download can be retried", async ({ page }) => {
  let failing = true;
  await routeExample(page, (index, route) => (failing && index === 0 ? route.fulfill({ status: 503, body: "" }) : null));
  await page.goto("/");
  await picker(page).selectOption(example.id);
  await expect(exampleState(page)).toHaveAttribute("data-example-state", "error", { timeout: 60_000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  failing = false;
  await picker(page).selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText("6 files · sub-01", { timeout: 300_000 });
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a cancelled example download loads nothing and can be retried", async ({ page }) => {
  const held = [];
  await routeExample(page, (index, route) => (held.length ? null : held.push(route)));
  await page.goto("/");
  await picker(page).selectOption(example.id);
  await expect.poll(() => held.length).toBe(1);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await expect(exampleState(page)).toHaveAttribute("data-example-state", "cancelled");
  await held[0].abort();
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker(page).selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText("6 files · sub-01", { timeout: 300_000 });
});

test("the example runs end to end and downloads the derivatives @slow", async ({ page }) => {
  // SwiftShader takes hours for MindGrab and SynthSR; the full pipeline needs NEURODESK_HARDWARE_GPU=1
  test.skip(!hardwareGpu, "needs a hardware GPU");
  test.setTimeout(60 * 60 * 1000);
  const log = [];
  page.on("console", (m) => log.push(m.text()));
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("motor3t");
  await expect(page.locator("#fileInfo")).toContainText("6 files · sub-01", { timeout: 300_000 });
  const t0 = Date.now();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/fastprep finished|error|failed/i, { timeout: 55 * 60 * 1000 });
  await expect(page.locator("#statusText")).toContainText("fastprep finished");
  await expect(page.frameLocator("#viewer iframe").locator("h1")).toContainText("fastprep: sub-01");
  const download = page.waitForEvent("download");
  await page.locator("#resultList").getByRole("button", { name: "Download", exact: true }).click();
  const files = unzipSync(new Uint8Array(readFileSync(await (await download).path())));
  const names = Object.keys(files);
  for (const want of ["fastprep/sub-01.html", "fastprep/sub-01_task-motor.html", "fastprep/work/commands.sh",
    "fastprep/sub-01/func/sub-01_task-motor_space-MNI152NLin2009cAsym_desc-preproc_bold.nii.gz",
    "fastprep/sub-01/func/sub-01_task-motor_desc-confounds_timeseries.tsv"]) expect(names).toContain(want);
  // keep the derivatives for comparison with a native run when asked
  if (process.env.FASTPREP_E2E_OUT) {
    for (const [name, bytes] of Object.entries(files)) {
      const p = `${process.env.FASTPREP_E2E_OUT}/${name}`;
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, bytes);
    }
    writeFileSync(`${process.env.FASTPREP_E2E_OUT}/browser.log`, `${(Date.now() - t0) / 1000} s\n${log.join("\n")}\n`);
  }
});

test("the multi-echo example runs ME-ICA end to end @slow", async ({ page }) => {
  // the 3-echo run adds meica (single-threaded WASM) to the pipeline above; same hardware-GPU requirement
  test.skip(!hardwareGpu, "needs a hardware GPU");
  test.setTimeout(60 * 60 * 1000);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption("motor3t-me");
  await expect(page.locator("#fileInfo")).toContainText("10 files · sub-01", { timeout: 600_000 });
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/fastprep finished|error|failed/i, { timeout: 55 * 60 * 1000 });
  await expect(page.locator("#statusText")).toContainText("fastprep finished");
  const report = page.frameLocator("#viewer iframe");
  await expect(report.locator("h3", { hasText: "Multi-echo ICA" })).toBeVisible();
  await expect(report.locator("body")).toContainText("tree tedana_orig");
  const download = page.waitForEvent("download");
  await page.locator("#resultList").getByRole("button", { name: "Download", exact: true }).click();
  const files = unzipSync(new Uint8Array(readFileSync(await (await download).path())));
  const names = Object.keys(files);
  for (const space of ["T1w", "MNI152NLin2009cAsym"]) {
    expect(names).toContain(`fastprep/sub-01/func/sub-01_task-motor_space-${space}_desc-preproc_bold.nii.gz`);
    expect(names).toContain(`fastprep/sub-01/func/sub-01_task-motor_space-${space}_desc-denoised_bold.nii.gz`);
  }
  const metrics = new TextDecoder().decode(files["fastprep/sub-01/func/sub-01_task-motor_desc-tedana_metrics.tsv"]);
  expect(metrics).toMatch(/\trejected(\t|$)/m);
  expect(names).toContain("fastprep/sub-01/func/sub-01_task-motor_space-T1w_stat-t_desc-leftActiveDenoised_boldmap.nii.gz");
});
