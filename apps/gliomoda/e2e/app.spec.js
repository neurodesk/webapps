import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readVolume } from "@neurodesk/synthsr";
import { compareLabels } from "@neurodesk/gliomoda/results";
import { MODELS } from "@neurodesk/gliomoda/models";
import reference from "../../../packages/gliomoda/validation/container-reference.json" with { type: "json" };

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const example = examples[0];
const defaultModel = MODELS.find(({ id }) => id === "t1c-t2f-t1n-t2w");
const containerLabels = async (file) => readVolume(gunzipSync(await readFile(new URL(`../../../packages/gliomoda/validation/container/${file}`, import.meta.url))).buffer);
const bytesOf = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

async function loadExample(page) {
  await page.goto("./");
  await page.getByLabel("Input", { exact: true }).selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#runButton")).toBeEnabled();
}

async function download(page, name) {
  if (!await page.locator("#outputSection").evaluate((element) => element.open)) {
    await page.locator("#outputSection summary").click();
  }
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: name }).locator(".nd-download-btn").click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

test("the example assigns each file to its sequence and picks the four-sequence model", async ({ page }) => {
  await loadExample(page);
  for (const { role, name } of example.files) {
    await expect(page.locator(`#${role}Select option:checked`)).toHaveText(name);
  }
  await expect(page.locator("#modelHint")).toHaveText("Model: T1c + FLAIR + T1 + T2");
  await page.locator("#advancedSettings summary").click();
  await expect(page.locator("#resEncL")).toBeEnabled();
  await page.locator("#t1nSelect").selectOption("");
  await expect(page.locator("#modelHint")).toHaveText("GlioMODA has no T1c + FLAIR + T2 model. Add or remove a sequence.");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#resEncL")).toBeDisabled();
  await page.locator("#t2wSelect").selectOption("");
  await expect(page.locator("#modelHint")).toHaveText("Model: T1c + FLAIR");
  await expect(page.locator("#runButton")).toBeEnabled();
  for (const role of ["t1c", "t2f"]) await page.locator(`#${role}Select`).selectOption("");
  await expect(page.locator("#modelHint")).toHaveText("Load at least one of T1c, FLAIR, T1 or T2.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("an image off the atlas grid is refused by name", async ({ page }) => {
  await page.goto("./");
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  for (const [k, n] of [3, 182, 218, 182, 1, 1, 1, 1].entries()) header.writeInt16LE(n, 40 + 2 * k);
  header.writeInt16LE(2, 70);
  header.writeInt16LE(8, 72);
  for (let k = 0; k < 4; k++) header.writeFloatLE(1, 76 + 4 * k);
  header.writeFloatLE(352, 108);
  header.write("n+1\0", 344, "latin1");
  await page.locator("#imageInput").setInputFiles({ name: "mni_t1c.nii", mimeType: "application/octet-stream", buffer: Buffer.concat([header, Buffer.alloc(182 * 218 * 182)]) });
  await expect(page.locator("#statusText")).toHaveText("mni_t1c.nii is 182 × 218 × 182 at 1.00 × 1.00 × 1.00 mm. GlioMODA needs the 240 × 240 × 155, 1 mm BraTS/SRI24 grid.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

// The untagged run: the default model without mirroring, on the CPU (CI's headless Chromium has no
// WebGPU adapter in workers), against the container's nnU-Net with use_mirroring=False.
test("automation segments the example without mirroring like the container", async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);
  await loadExample(page);
  const inputs = {};
  for (const { role, name, url, sha256 } of example.files) {
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    inputs[role] = { name, bytes };
  }
  for (const [role, file] of Object.entries(inputs)) {
    await page.locator("#neurodesk-input-transfer").setInputFiles({ name: file.name, mimeType: "application/gzip", buffer: file.bytes });
    await page.evaluate((role) => window.neurodeskAutomation.dispatch("adopt", { role }), role);
  }
  await page.evaluate(() => window.neurodeskAutomation.dispatch("start", { operation: "segment", parameters: { mirror: false } }));
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · whole tumour [\d.]+ ml$/, { timeout: 28 * 60 * 1000 });
  await expect.poll(() => page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot").then((value) => value.state))).toBe("succeeded");
  const report = await page.evaluate(() => window.neurodeskAutomation.dispatch("snapshot").then((value) => value.report));
  expect(Object.keys(report.artifacts).sort()).toEqual(["segmentation", "volumes"]);
  expect(report.provenance.backend).toBe("wasm");
  expect(report.provenance.mirroring).toBe(false);
  expect(report.provenance.model.sha256).toBe(defaultModel.sha256);
  const segmentation = await download(page, "Tumour labels");
  expect(segmentation.name).toBe("UPENN-GBM-00002_11_gliomoda_seg.nii.gz");
  const labels = readVolume(bytesOf(gunzipSync(segmentation.bytes)));
  const t1c = readVolume(bytesOf(gunzipSync(inputs.t1c.bytes)));
  expect(labels.dims).toEqual(t1c.dims);
  expect(labels.affine).toEqual(t1c.affine);
  const expected = reference.runs.find(({ model, mirror }) => model === "t1c-t2f-t1n-t2w" && !mirror);
  const comparison = compareLabels(Uint8Array.from(labels.data), Uint8Array.from((await containerLabels(expected.file)).data));
  console.log(`Browser against the container: ${JSON.stringify(comparison)}`);
  expect(comparison.differing).toBeLessThanOrEqual(reference.gates.differingVoxels);
  for (const region of ["WT", "TC", "ET"]) expect(comparison.dice[region]).toBeGreaterThanOrEqual(reference.gates.dice);
  const table = await download(page, "Volumes");
  const rows = table.bytes.toString().trim().split("\n");
  expect(rows[0]).toBe("label\tstructure\tvoxels\tvolume_ml");
  expect(rows.map((row) => row.split("\t")[0])).toEqual(["label", "1", "2", "3", "WT", "TC", "ET"]);
  expect(rows.slice(1, 4).map((row) => Number(row.split("\t")[2]))).toEqual(comparison.counts.slice(1));
  await expect(page.locator("#labelLegend")).toContainText("Enhancing tumour");
});

// The container's own command line, mirroring included, on the four-sequence model.
test("the default run with mirroring matches the container's command line", async ({ page }) => {
  test.setTimeout(240 * 60 * 1000);
  await loadExample(page);
  await page.locator("#advancedSettings summary").click();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · whole tumour [\d.]+ ml$/, { timeout: 238 * 60 * 1000 });
  const segmentation = await download(page, "Tumour labels");
  const labels = readVolume(bytesOf(gunzipSync(segmentation.bytes)));
  const expected = reference.runs.find(({ model, mirror }) => model === "t1c-t2f-t1n-t2w" && mirror);
  const comparison = compareLabels(Uint8Array.from(labels.data), Uint8Array.from((await containerLabels(expected.file)).data));
  console.log(`Browser against the container: ${JSON.stringify(comparison)}`);
  expect(comparison.differing).toBeLessThanOrEqual(reference.gates.differingVoxels);
  for (const region of ["WT", "TC", "ET"]) expect(comparison.dice[region]).toBeGreaterThanOrEqual(reference.gates.dice);
});

test("a failed model download is reported and the run can be retried", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  let attempts = 0;
  await page.context().route(defaultModel.url, (route) => {
    attempts++;
    return route.fulfill({ status: 503, body: "" });
  });
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\)/, { timeout: 120000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\)/, { timeout: 120000 });
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("cancelling a run stops it and keeps the inputs ready", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.context().route(defaultModel.url, () => {});
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Downloading the GlioMODA model…", { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#t1cSelect option:checked")).toHaveText(example.files[0].name);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed example ${failure} can retry the same example`, async ({ page }) => {
    const [first] = example.files;
    let attempts = 0;
    await page.route(first.url, async (route) => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
      return route.continue();
    });
    await page.goto("./");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling an example download leaves nothing loaded and permits a retry", async ({ page }) => {
  const [first] = example.files;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  await page.route(first.url, async (route) => {
    attempts++;
    if (attempts === 1) await held;
    return route.continue();
  });
  await page.goto("./");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "loading");
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  release();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#sequenceFields")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
});
