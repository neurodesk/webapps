// SyN-SDC in the browser: the acquisition fields and their refusal, the mask fields, the example
// end to end against packages/sdc's Node pipeline (e2e/syn-reference.json, written by
// scripts/syn-node-reference.mjs), cancellation and a retry after a failed prior download.
// MindGrab runs on its CPU modules, which headless Chromium can finish (#394).
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { routeExample, syntheticPair } from "./fixtures.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../../models/sdc.manifest.json", import.meta.url), "utf8"));
const reference = JSON.parse(readFileSync(new URL("./syn-reference.json", import.meta.url), "utf8"));
const example = examples.find((entry) => entry.method === "syn");
const exampleUrls = examples.flatMap((entry) => entry.files.map((file) => file.url));
const HOUR = 3600000;

/** A small DWI series (b = 0, 0, 1000) with the given sidecar and a T1w, for setInputFiles. */
function synFiles(sidecar) {
  const [dwi, , bval, image] = syntheticPair();
  return [
    dwi,
    { name: "sub-01_dir-AP_dwi.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sidecar)) },
    bval,
    { name: "sub-01_dir-AP_dwi.bvec", mimeType: "text/plain", buffer: Buffer.from("0 0 1\n0 0 0\n0 0 0\n") },
    { ...image, name: "sub-01_T1w.nii.gz" },
  ];
}

async function chooseSyn(page) {
  await page.goto("/");
  await page.locator("#method").selectOption("syn");
  await expect(page.locator("#runButton")).toHaveText("Correct distortion");
}

test("SyN-SDC asks for a missing phase-encoding direction and readout time and refuses to run without them", async ({ page }) => {
  await chooseSyn(page);
  await page.locator("#imageInput").setInputFiles(synFiles({ EchoTime: 0.09 }));
  await expect(page.locator("#fileInfo")).toHaveText("DWI: sub-01_dir-AP_dwi.nii.gz · 8×40×4×3 · b = 0 mean of 2");
  await expect(page.locator("#pairInfo")).toHaveText("T1w: sub-01_T1w.nii.gz");
  await expect(page.locator("#statusText")).toHaveText("No sidecar gives the phase-encoding direction or the total readout time; enter it");
  await expect(page.locator("#directionField")).toBeVisible();
  await expect(page.locator("#readoutField")).toBeVisible();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("The phase-encoding direction is missing");
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await page.locator("#direction").selectOption("j-");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("The total readout time is missing");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);

  // A sidecar with both hides the fields again.
  await page.locator("#imageInput").setInputFiles(synFiles({ PhaseEncodingDirection: "j-", EffectiveEchoSpacing: 0.0005 }));
  await expect(page.locator("#statusText")).toHaveText("sub-01_dir-AP_dwi.nii.gz and sub-01_T1w.nii.gz loaded");
  await expect(page.locator("#directionField")).toBeHidden();
  await expect(page.locator("#readoutField")).toBeHidden();
});

test("SyN-SDC takes uploaded brain masks in place of MindGrab's", async ({ page }) => {
  await chooseSyn(page);
  await page.locator("#imageInput").setInputFiles(synFiles({ PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05 }));
  await page.locator("#advancedSettings > summary").click();
  const [, , , mask] = syntheticPair();
  await page.locator("#dwiMaskInput").setInputFiles({ ...mask, name: "dwi_mask.nii.gz" });
  await expect(page.locator("#statusText")).toHaveText("dwi_mask.nii.gz will be the DWI brain mask");
  await page.locator("#t1wMaskInput").setInputFiles({ ...mask, name: "t1w_mask.nii.gz" });
  await expect(page.locator("#clearMasks")).toBeVisible();
  await page.locator("#clearMasks").click();
  await expect(page.locator("#statusText")).toHaveText("Using MindGrab brain masks");
  await expect(page.locator("#clearMasks")).toBeHidden();
});

test("a SyN-SDC run after a failed prior download can run again and be cancelled", async ({ page }) => {
  test.skip(!process.env.SDC_EXAMPLE_DIR, "set SDC_EXAMPLE_DIR (node scripts/e2e-test-data.mjs sdc --cpu)");
  test.setTimeout(600000);
  await routeExample(page.context(), exampleUrls);
  const atlas = manifest.base_url + manifest.assets[0].filename;
  let failures = 0;
  await page.context().route(atlas, (route) => {
    if (failures) return route.fallback();
    failures++;
    return route.fulfill({ status: 503, body: "" });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#method")).toHaveValue("syn");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveClass(/error/, { timeout: 120000 });
  expect(failures).toBe(1);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Building the EPI reference|Brain masks/, { timeout: 300000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

test("SyN-SDC on the example writes the Node pipeline's outputs", async ({ page }) => {
  test.skip(!process.env.SDC_EXAMPLE_DIR, "set SDC_EXAMPLE_DIR (node scripts/e2e-test-data.mjs sdc --cpu)");
  test.setTimeout(4 * HOUR);
  await routeExample(page.context(), exampleUrls);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
  await expect(page.locator("#fileInfo")).toHaveText("DWI: sub-01_dir-AP_desc-slab_dwi.nii.gz · 67×92×10×137 · b = 0 mean of 13", { timeout: 120000 });
  await expect(page.locator("#pairInfo")).toHaveText("T1w: sub-01_run-001_T1w.nii.gz");
  await expect(page.locator("#directionField")).toBeHidden();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Distortion corrected", { timeout: 4 * HOUR - 300000 });
  await expect(page.locator("#technicalLog")).toContainText("MindGrab brain masks on cpu, cpu");
  await expect(page.locator("#technicalLog")).toContainText(/Field in the DWI brain mask \(\d+ voxels\): median \|f\| [\d.]+ Hz/);

  const rows = page.locator("#resultList .nd-volume-toggle");
  const downloaded = {};
  for (let i = 0; i < (await rows.count()); i++) {
    const event = page.waitForEvent("download");
    await rows.nth(i).getByRole("button", { name: "Download" }).click();
    const download = await event;
    const bytes = readFileSync(await download.path());
    const name = download.suggestedFilename();
    downloaded[name] = createHash("sha256").update(name.endsWith(".gz") ? gunzipSync(bytes) : bytes).digest("hex");
  }
  console.log(JSON.stringify({ downloaded }, null, 2));
  for (const [name, sha256] of Object.entries(reference.outputs)) expect(downloaded[name], name).toBe(sha256);
  expect(Object.keys(downloaded)).toEqual(expect.arrayContaining(["sub-01_dir-AP_desc-beforeQC_b0.nii.gz", "sub-01_dir-AP_desc-afterQC_b0.nii.gz"]));
});
