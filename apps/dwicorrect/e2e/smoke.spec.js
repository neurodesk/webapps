// Browser tests against `vite preview` of the production build: boot and the shared shell,
// cross-origin isolation for the threaded module, the defaults the synthetic phantom sets, the
// hosted ds006676 example through the whole correction (MindGrab mask, field from the PA b0,
// shoreline) to its downloads, a failed example download and a cancelled example load with
// their retries, and cancellation and retry of a correction.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleFiles, fieldmapOffGrid, seriesWithNaN } from "./fixtures.mjs";
import { INPUTS, args as agreementArgs, assertAgreement, runNative } from "../../../packages/shoreline/test/agreement.mjs";

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

test("a refused selection leaves the loaded series, its settings and the footer as they were", async ({ page }) => {
  await loadPhantom(page);
  await expect(page.locator("#fieldSource")).toHaveValue("reverse");
  await page.locator("#imageInput").setInputFiles([...exampleFiles(), ...fieldmapOffGrid()]);
  await expect(page.locator("#statusText")).toHaveText(/sub-phantom_fieldmap\.nii\.gz is not on the series' grid/);
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#fileInfo")).toHaveText("sub-phantom_dwi.nii.gz");
  await expect(page.locator("#fieldInfo")).toContainText("Reverse-PE b0");
  await expect(page.locator("#fieldSource")).toHaveValue("reverse");
  await expect(page.locator('#fieldSource option[value="upload"]')).toBeDisabled();
  await expect(page.locator("#runButton")).toBeEnabled();
  // The footer bar is reset, not left animating.
  await expect(page.locator("#status progress")).toHaveAttribute("value", "0");
  await expect(page.locator("#cancelButton")).toBeHidden();

  await page.locator("#imageInput").setInputFiles([seriesWithNaN(), ...exampleFiles({ skip: ["sub-phantom_dwi.nii.gz"] })]);
  await expect(page.locator("#statusText")).toHaveText("sub-phantom_dwi.nii.gz holds values that are not finite numbers (NaN or infinity).");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a multiband factor that does not divide the slices is refused before the run", async ({ page }) => {
  await loadPhantom(page);
  await page.locator("#multiband").fill("7");
  await expect(page.locator("#statusText")).toHaveText(/The multiband factor 7 does not divide the \d+ slices\./);
  await expect(page.locator("#runButton")).toBeDisabled();
  await page.locator("#multiband").fill("1");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#statusText")).toHaveText(/loaded: \d+ volumes/);
  await expect(page.locator("#statusText")).not.toHaveClass(/error/);
});

test("Outliers stays off after a run while replacement is off", async ({ page }) => {
  // Without the sidecar the readout is entered; 0 fails at once, before the brain mask.
  await loadPhantom(page, { skip: ["sub-phantom_dwi.json", "sub-phantom_dir-reverse_epi.nii.gz", "sub-phantom_dir-reverse_epi.json"] });
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#replaceOutliers").uncheck();
  await expect(page.locator("#outlierType")).toBeDisabled();
  await page.locator("#readoutTime").fill("0");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Give the series' total readout time in seconds.");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#outlierType")).toBeDisabled();
});

test("the threaded WebAssembly module agrees with the native binary on a phantom", async ({ page }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "dwicorrect-agreement-"));
  try {
    runNative(dir);
    // On the context: the requests come from a worker.
    await page.context().route("**/__agreement__/*", (route) => route.fulfill({ body: readFileSync(join(dir, new URL(route.request().url()).pathname.split("/").pop())) }));
    await page.goto("/");
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
    const run = await page.evaluate(async ({ inputs, args }) => {
      // Threaded WebAssembly blocks on Atomics.wait, which only a worker may: run it in one.
      const source = `
        import init, { initThreadPool, Session } from "${new URL("shoreline-wasm/threads/shoreline_wasm.js", document.baseURI)}";
        self.onmessage = async ({ data }) => {
          try {
            await init();
            await initThreadPool(data.threads);
            const session = new Session();
            for (const name of data.inputs) session.addFile(name, new Uint8Array(await (await fetch(data.base + "__agreement__/" + name)).arrayBuffer()));
            session.run(data.args, () => {});
            const outputs = {};
            for (const name of session.fileNames()) if (name.startsWith("wasm.")) outputs[name] = session.takeFile(name);
            self.postMessage({ outputs });
          } catch (error) {
            self.postMessage({ error: String(error?.message ?? error) });
          }
        };`;
      const threads = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 2));
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })), { type: "module" });
      const reply = await new Promise((resolve) => {
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => resolve({ error: event.message || "the worker failed" });
        worker.postMessage({ inputs, args, threads, base: document.baseURI });
      });
      worker.terminate();
      if (reply.error) return { error: reply.error };
      const base64 = (bytes) => {
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      return { threads, outputs: Object.fromEntries(Object.entries(reply.outputs).map(([name, bytes]) => [name, base64(bytes)])) };
    }, { inputs: INPUTS, args: agreementArgs("wasm") });
    expect(run.error).toBeUndefined();
    const outputs = Object.fromEntries(Object.entries(run.outputs).map(([name, text]) => [name, Buffer.from(text, "base64")]));
    const differences = assertAgreement(outputs, dir);
    console.log(`threaded WebAssembly (${run.threads} threads) against native (2 threads), largest relative difference: ${JSON.stringify(differences)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  for (const label of ["Corrected series", "b-values", "Rotated b-vectors", "Sidecar", "Movement per volume", "Outlier slices", "Brain mask (MindGrab)", "Field map (Hz)", "Field map JSON", "Log"]) {
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
  const fieldSidecar = JSON.parse((await download(page, "Field map JSON")).toString());
  expect(fieldSidecar.Units).toBe("Hz");
  expect(fieldSidecar.PhaseEncodingDirection).toBe("j-");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(sidecar.GeneratedBy[0].Version).toBe(version);
  expect(fieldSidecar.GeneratedBy[0].Version).toBe(version);
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

test("a failed example download shows the error and the same example can load again", async ({ page }) => {
  test.setTimeout(300_000);
  const bval = example.files.find((file) => file.role === "bval");
  let attempts = 0;
  await page.context().route(bval.url, (route) => {
    attempts++;
    if (attempts > 1) return route.fallback();
    return route.fulfill({ status: 503, body: "" });
  });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  const selector = page.locator("[data-neurodesk-examples]");
  await picker.selectOption(example.id);
  await expect(selector).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#statusText")).toHaveText(`Could not download ${bval.name} (HTTP 503). Load the example again to retry.`);
  await expect(page.locator("#inputInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(selector).toHaveAttribute("data-example-state", "ready", { timeout: 240_000 });
  await expect(page.locator("#fileInfo")).toHaveText(example.files[0].name);
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling an example load commits nothing and the example can load again", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  // Hold the first read of a downloaded file until the load is cancelled, so the files arrive
  // after the cancel.
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
  const selector = page.locator("[data-neurodesk-examples]");
  await picker.selectOption(example.id);
  await expect(selector).toHaveAttribute("data-example-state", "loading");
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120_000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await expect(selector).toHaveAttribute("data-example-state", "cancelled");
  await page.evaluate(() => window.finishExampleRead());
  // Give the released read time to reach the page; it must not load the series.
  await page.waitForTimeout(2_000);
  await expect(selector).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#inputInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(selector).toHaveAttribute("data-example-state", "ready", { timeout: 240_000 });
  await expect(page.locator("#fileInfo")).toHaveText(example.files[0].name);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("the example selector lists the examples", async ({ page }) => {
  await page.goto("/");
  const options = await page.locator("select[data-neurodesk-example] option").evaluateAll((list) => list.map((o) => o.value).filter(Boolean));
  expect(options).toEqual(examples.map((example) => example.id));
});
