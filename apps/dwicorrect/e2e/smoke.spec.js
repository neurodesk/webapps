// Browser tests against `vite preview` of the production build: boot and the shared shell,
// cross-origin isolation for the threaded module, the defaults the synthetic phantom sets, the
// hosted ds006676 example through the whole correction (MindGrab mask, field from the PA b0,
// shoreline) to its downloads, a failed example download and its retry, and cancellation and
// retry of a correction.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { exampleFiles, phantomDir } from "./fixtures.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
// The example's outliers with the MindGrab mask from the threaded CPU module, which headless
// Chromium without a GPU runs: 144 slices in 51 volumes.
const OUTLIER_STATUS = "144 outlier slices replaced";
const FLAGGED_VOLUMES = 51;

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return readFileSync(await (await event).path());
}

// The phantom is built by cargo on first use, which takes longer than one test may.
test.beforeAll(() => {
  test.setTimeout(600_000);
  phantomDir();
});

async function loadPhantom(page, options) {
  await page.goto("/");
  // The app is ready once it has built its example selector.
  await page.locator("select[data-neurodesk-example]").waitFor();
  await page.locator("#imageInput").setInputFiles(exampleFiles(options));
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60_000 });
}

test("app boots on its workspace, isolated for threads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
});

test("the series sets the defaults, and each states its rule", async ({ page }) => {
  await loadPhantom(page);
  await expect(page.locator("#fileInfo")).toHaveText("sub-phantom_dwi.nii.gz");
  await expect(page.locator("#seriesInfo")).toHaveText("102 vol: 6\u00a0b0 · b1000×32 · b2000×64");
  await expect(page.locator("#acquisitionInfo")).toHaveText("PE j, 50 ms readout");
  await expect(page.locator("#fieldInfo")).toContainText("Reverse-PE b0: sub-phantom_dir-reverse_epi.nii.gz");
  await expect(page.locator("#fieldSource")).toHaveValue("reverse");
  await expect(page.locator("#model")).toHaveValue("shore");

  await expect(page.locator("#imageLabel")).toHaveText("Input, volume 1");
  await expect(page.locator("#preview")).toBeHidden();
  await expect(page.locator("#outlierType")).toHaveValue("sw");
  await expect(page.locator("#sliceToVolume")).toBeDisabled();
  // The sidecar has phase encoding and readout but neither MultibandAccelerationFactor nor
  // SliceTiming, so only the Multiband field asks.
  await expect(page.locator("#acquisitionFields")).toBeVisible();
  await expect(page.locator("#multibandField")).toBeVisible();
  await expect(page.locator("#multiband")).toHaveValue("1");
  await expect(page.locator("#phaseEncodingField")).toBeHidden();
  await expect(page.locator("#readoutField")).toBeHidden();
});

// The full runs use the hosted example, ds006676 S3P1 (multiband 3 with a PA b0): MindGrab finds
// no brain in the synthetic phantom, so a phantom run stops at the mask.
const example = examples[0];

async function loadExample(page) {
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300_000 });
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60_000 });
}

/** The dims and frame count of a NIfTI-1 file, from its header. */
function niftiShape(bytes) {
  expect(bytes.readInt32LE(0)).toBe(348);
  const dim = [1, 2, 3, 4].map((i) => bytes.readInt16LE(40 + 2 * i));
  return { dims: dim.slice(0, 3), frames: dim[3] };
}

test("the example is corrected: field from the PA b0, motion, outliers, downloads", async ({ page }) => {
  test.setTimeout(900_000);
  await loadExample(page);
  await expect(page.locator("#fileInfo")).toHaveText(example.files[0].name);
  await expect(page.locator("#fieldSource")).toHaveValue("reverse");
  await expect(page.locator("#multibandField")).toBeHidden();
  await expect(page.locator("#outlierType")).toHaveValue("both");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Corrected in", { timeout: 840_000 });
  await expect(page.locator("#statusText")).toContainText("outlier slices replaced");
  for (const label of ["Corrected series", "b-values", "Rotated b-vectors", "Sidecar", "Movement per volume", "Outlier slices", "Brain mask (MindGrab)", "Field map (Hz)", "Log"]) {
    await expect(page.locator("#resultList .nd-volume-toggle").filter({ hasText: label })).toHaveCount(1);
  }
  expect(niftiShape(gunzipSync(await download(page, "Corrected series")))).toEqual({ dims: [112, 112, 72], frames: 141 });
  const confounds = (await download(page, "Movement per volume")).toString().trim().split("\n").map((line) => line.split("\t"));
  expect(confounds[0].slice(0, 6)).toEqual(["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z"]);
  expect(confounds).toHaveLength(142);
  // Head motion in a cooperative adult: every translation under 5 mm, every rotation under 0.1 rad.
  for (const row of confounds.slice(1)) {
    for (let a = 0; a < 3; a++) expect(Math.abs(Number(row[a]))).toBeLessThan(5);
    for (let a = 3; a < 6; a++) expect(Math.abs(Number(row[a]))).toBeLessThan(0.1);
  }
  const bvecs = (await download(page, "Rotated b-vectors")).toString().trim().split("\n");
  expect(bvecs).toHaveLength(3);
  expect(bvecs[0].trim().split(/\s+/)).toHaveLength(141);
  const sidecar = JSON.parse((await download(page, "Sidecar")).toString());
  expect(sidecar.DwicorrectSettings.SusceptibilityField).toBe("estimated");
  expect(sidecar.DwicorrectSettings.CommandLine).toContain("--field=field.nii.gz");
  expect(sidecar.DwicorrectSettings.CommandLine).toContain("--ol_type=both");
  expect(sidecar.DwicorrectSettings.CommandLine).toContain("--mb=3");
  expect(sidecar.PhaseEncodingDirection).toBe("j-");
  const mask = sidecar.DwicorrectSettings.BrainMask;
  expect(mask).toMatch(/^mindgrab-/);
  await expect(page.locator("#statusText"), `outliers with the mask from ${mask}`).toContainText(OUTLIER_STATUS);
  await expect(page.locator("#preview")).toBeVisible();
  expect(await page.locator("#preview").evaluate((img) => img.naturalWidth > 0 && img.src.startsWith("blob:"))).toBe(true);
  await page.locator("#viewer .nd-view-tab", { hasText: "Motion" }).click();
  await expect(page.locator("#motionReport")).toBeVisible();
  await expect(page.locator("#motionReport tr[data-flag]")).toHaveCount(FLAGGED_VOLUMES);
});

test("without the reverse b0 the series is corrected without a field", async ({ page }) => {
  await loadPhantom(page, { skip: ["sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  await expect(page.locator("#fieldSource")).toHaveValue("none");

});

test("a full series with the opposite phase encoding is the reverse, whichever file comes first", async ({ page }) => {
  const files = exampleFiles({ skip: ["sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  const sidecar = JSON.parse(files.find((file) => file.name.endsWith(".json")).buffer);
  const pe = sidecar.PhaseEncodingDirection;
  const opposite = { ...sidecar, PhaseEncodingDirection: pe.endsWith("-") ? pe.slice(0, -1) : `${pe}-` };
  const second = files.map((file) => ({
    ...file,
    name: file.name.replace("sub-phantom_dwi", "sub-phantom_run-2_dwi"),
    buffer: file.name.endsWith(".json") ? Buffer.from(JSON.stringify(opposite)) : file.buffer,
  }));
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").waitFor();
  // The same number of volumes: the series is the first by name, the other its reverse.
  await page.locator("#imageInput").setInputFiles([...second, ...files]);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#fileInfo")).toHaveText("sub-phantom_dwi.nii.gz");
  await expect(page.locator("#fieldInfo")).toHaveText("Reverse-PE b0: sub-phantom_run-2_dwi.nii.gz");
  await expect(page.locator("#fieldSource")).toHaveValue("reverse");
});

test("a sidecar without phase encoding asks for it", async ({ page }) => {
  await loadPhantom(page, { skip: ["sub-phantom_dwi.json", "sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  await expect(page.locator("#acquisitionFields")).toBeVisible();
});

// The completed run after the cancel is the run above, with the same settings, so it waits for
// the nightly tier.
test("a correction can be cancelled and run again", { tag: "@slow" }, async ({ page }) => {
  test.setTimeout(900_000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Correcting", { timeout: 300_000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Corrected in", { timeout: 840_000 });
  await expect(page.locator("#statusText")).toContainText(OUTLIER_STATUS);
});

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    test.setTimeout(400_000);
    const image = example.files.find((file) => file.role === "image");
    let attempts = 0;
    await page.context().route(image.url, (route) => {
      attempts++;
      if (attempts > 1) return route.fallback();
      return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 120_000 });
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(page.locator("#inputInfo")).toBeHidden();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 300_000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    await expect(page.locator("#fileInfo")).toHaveText(image.name);
    expect(attempts).toBe(2);
  });
}

test("the example selector lists the examples", async ({ page }) => {
  await page.goto("/");
  const options = await page.locator("select[data-neurodesk-example] option").evaluateAll((list) => list.map((o) => o.value).filter(Boolean));
  expect(options).toEqual(examples.map((example) => example.id));
});
