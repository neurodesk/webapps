// Real browser tests against the built app (vite preview): cross-origin isolation, the
// WebAssembly worker (single-threaded, as @niivue/meica ships), the example through denoising, downloads and automation. Outputs must be
// byte-identical to the native me-ica CLI (e2e/expected.json, recorded from `me-ica` on the
// example). ME_ICA_EXAMPLE_DIR serves the example from a local copy instead of Hugging Face.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const example = examples[0];
const local = process.env.ME_ICA_EXAMPLE_DIR;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function exampleBytes(file) {
  if (local) return readFileSync(join(local, file.name));
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Example files on disk (Playwright refuses in-memory uploads over 50 MB). */
async function examplePaths(role) {
  const files = example.files.filter((f) => f.role === role);
  if (local) return files.map((f) => join(local, f.name));
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "me-ica-example-"));
  return Promise.all(files.map(async (f) => {
    const path = join(dir, f.name);
    writeFileSync(path, await exampleBytes(f));
    return path;
  }));
}

async function serveExample(page) {
  if (!local) return;
  for (const file of example.files) await page.route(file.url, (route) => route.fulfill({ body: readFileSync(join(local, file.name)) }));
}

async function loadExample(page) {
  await serveExample(page);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText("3 echoes", { timeout: 180000 });
  await expect(page.locator("#echoTimes")).toHaveValue("15.2 35.32 55.42");
  await expect(page.locator("#runButton")).toBeEnabled();
}

async function downloaded(page, click) {
  const promise = page.waitForEvent("download");
  await click();
  const download = await promise;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

test("app boots cross-origin isolated with the shared app bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
});

test("the example denoises to tedana's result, byte-identical to the native CLI", async ({ page }) => {
  test.setTimeout(600000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("13 components, 7 accepted, 6 rejected", { timeout: 300000 });
  const list = page.locator("#resultList");
  for (const [label, name] of [["Denoised series", "desc-denoised_bold.nii.gz"], ["Optimally combined series", "desc-optcom_bold.nii.gz"], ["T2* map (s)", "T2starmap.nii.gz"], ["Component metrics (table)", "desc-tedana_metrics.tsv"]]) {
    const row = list.locator(".nd-volume-toggle", { hasText: label });
    const file = await downloaded(page, () => row.getByRole("button", { name: "Download", exact: true }).click());
    expect(file.name).toBe(name);
    expect(sha(file.bytes), name).toBe(expected.sha256[name]);
  }
  await page.locator('[data-view="components"]').click();
  const rows = page.locator("#componentReport tbody tr");
  await expect(rows).toHaveCount(13);
  await rows.nth(2).click();
  await expect(page.locator("#imageLabel")).toContainText("ICA_02 map");
  await expect(page.locator("#componentReport")).toBeHidden();
  const zip = await downloaded(page, () => page.locator("#zipButton").click());
  expect(zip.name).toBe("me-ica_outputs.zip");
  expect(zip.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(zip.bytes.includes(Buffer.from("desc-tedana_registry.json"))).toBe(true);
});

test("the motion-corrected example with its confounds runs the motion_aroma tree as tedana does", async ({ page }) => {
  test.setTimeout(600000);
  const want = expected.motion_aroma;
  const moco = examples.find((e) => e.id === want.example);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(moco.id);
  await expect(page.locator("#fileInfo")).toContainText("regressors sub-01_task-motor_desc-confounds_timeseries.tsv", { timeout: 180000 });
  await page.locator("#tree").selectOption("motion_aroma");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("13 components, 1 accepted, 12 rejected", { timeout: 300000 });
  const list = page.locator("#resultList");
  for (const [label, name] of [["Denoised series", "desc-denoised_bold.nii.gz"], ["Component metrics (table)", "desc-tedana_metrics.tsv"]]) {
    const file = await downloaded(page, () => list.locator(".nd-volume-toggle", { hasText: label }).getByRole("button", { name: "Download", exact: true }).click());
    expect(sha(file.bytes), name).toBe(want.sha256[name]);
  }
});

test("a regressor tree without a confounds TSV explains what is missing", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await page.locator("#tree").selectOption("motion_f");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("needs a regressors TSV");
});

test("cancelling a run stops the worker and allows a new run", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#outputSection")).not.toHaveAttribute("open", "");
});

test("a failed example download can retry", async ({ page }) => {
  let attempts = 0;
  for (const file of example.files) {
    await page.route(file.url, (route) => {
      if (file === example.files[0]) attempts++;
      if (file === example.files[0] && attempts === 1) return route.fulfill({ status: 503, body: "" });
      return local ? route.fulfill({ body: readFileSync(join(local, file.name)) }) : route.continue();
    });
  }
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling an example download leaves no inputs and permits retry", async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route(example.files[0].url, async (route) => {
    await gate;
    return local ? route.fulfill({ body: readFileSync(join(local, example.files[0].name)) }) : route.continue();
  });
  for (const file of example.files.slice(1)) await page.route(file.url, (route) => (local ? route.fulfill({ body: readFileSync(join(local, file.name)) }) : route.continue()));
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  release();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
});

test("automation denoises declared echoes and sidecars", async ({ page }) => {
  test.setTimeout(600000);
  await page.goto("/");
  for (const [role, files] of [["echoes", await examplePaths("echo")], ["sidecars", await examplePaths("metadata")]]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles(files);
    await page.evaluate((r) => globalThis.neurodeskAutomation.dispatch("adopt", { role: r }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", {}));
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 300000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.measurements).toMatchObject(expected.summary);
  expect(report.artifacts.denoised.sha256).toBe(expected.sha256["desc-denoised_bold.nii.gz"]);
  expect(report.artifacts.metrics.sha256).toBe(expected.sha256["desc-tedana_metrics.tsv"]);
});

function syntheticEcho(name) {
  const bytes = Buffer.alloc(352 + 2 * 2 * 2 * 4 * 4);
  bytes.writeInt32LE(348, 0);
  [4, 2, 2, 2, 4, 1, 1, 1].forEach((value, i) => bytes.writeInt16LE(value, 40 + 2 * i));
  bytes.writeInt16LE(16, 70);
  bytes.writeInt16LE(32, 72);
  for (let i = 0; i < 8; i++) bytes.writeFloatLE(1, 76 + 4 * i);
  bytes.writeFloatLE(352, 108);
  bytes.writeInt16LE(1, 254);
  [0, 5, 10].forEach(i => bytes.writeFloatLE(1, 280 + 4 * i));
  bytes.write('n+1', 344);
  for (let i = 0; i < 32; i++) bytes.writeFloatLE(1 + i % 8, 352 + 4 * i);
  return { name, mimeType: 'application/octet-stream', buffer: bytes };
}
const syntheticBundle = prefix => [1, 2, 3].flatMap(i => [
  syntheticEcho(`${prefix}${i}.nii`),
  { name: `${prefix}${i}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ EchoTime: i * 0.015 })) },
]);

test('replacement echoes without sidecars require fresh echo times', async ({ page }) => {
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('first'));
  await expect(page.locator('#fileInfo')).toContainText('first1.nii');
  await expect(page.locator('#echoTimes')).toHaveValue('15 30 45');
  await page.locator('#imageInput').setInputFiles([1, 2, 3].map(i => syntheticEcho(`second${i}.nii`)));
  await expect(page.locator('#fileInfo')).toContainText('second1.nii');
  await expect(page.locator('#echoTimes')).toHaveValue('');
});

test('a delayed old import cannot replace newer echoes', async ({ page }) => {
  await page.addInitScript(() => {
    const text = File.prototype.text;
    File.prototype.text = function () {
      if (this.name === 'old1.json') {
        return new Promise(resolve => {
          globalThis.releaseOld = () => resolve('{"EchoTime":0.015}');
        });
      }
      return text.call(this);
    };
  });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('old'));
  await expect.poll(() => page.evaluate(() => typeof globalThis.releaseOld)).toBe('function');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('new'));
  await expect(page.locator('#fileInfo')).toContainText('new1.nii');
  await page.evaluate(() => globalThis.releaseOld());
  await page.waitForTimeout(500);
  await expect(page.locator('#fileInfo')).toContainText('new1.nii');
});

test('automation cancellation terminates its processing worker', async ({ page }) => {
  test.setTimeout(300000);
  await page.addInitScript(() => {
    const Native = Worker;
    globalThis.jobs = 0;
    globalThis.terminatedJobs = 0;
    globalThis.Worker = class extends Native {
      postMessage(data, ...rest) {
        if (data?.echoes) {
          this.isProcessingJob = true;
          globalThis.jobs++;
        }
        return super.postMessage(data, ...rest);
      }
      terminate() {
        if (this.isProcessingJob) globalThis.terminatedJobs++;
        return super.terminate();
      }
    };
  });
  await page.goto('/');
  for (const [role, files] of [['echoes', await examplePaths('echo')], ['sidecars', await examplePaths('metadata')]]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(files);
    await page.evaluate(r => globalThis.neurodeskAutomation.dispatch('adopt', { role: r }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', {}));
  await expect.poll(() => page.evaluate(() => globalThis.jobs), { timeout: 60000 }).toBe(1);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('cancel', {}));
  await expect.poll(() => page.evaluate(() => globalThis.terminatedJobs), { timeout: 3000 }).toBe(1);
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('a superseded native viewer load settles before the replacement renders', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = Worker;
    const text = File.prototype.text;
    globalThis.latestNativeLoads = 0;
    File.prototype.text = function () {
      return text.call(this).then(value => {
        if (this.name === 'latest3.json') globalThis.latestPrepared = true;
        return value;
      });
    };
    globalThis.Worker = class extends Native {
      postMessage(data, ...rest) {
        if (data?.url instanceof File && data.url.name === 'slow1.nii' && !globalThis.releaseNative) {
          globalThis.releaseNative = () => super.postMessage(data, ...rest);
          return;
        }
        if (data?.url instanceof File && data.url.name === 'latest1.nii') globalThis.latestNativeLoads++;
        return super.postMessage(data, ...rest);
      }
    };
  });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('base'));
  await expect(page.locator('#imageLabel')).toContainText('base1.nii');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('slow'));
  await expect.poll(() => page.evaluate(() => typeof globalThis.releaseNative)).toBe('function');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('latest'));
  await expect.poll(() => page.evaluate(() => globalThis.latestPrepared)).toBe(true);
  expect(await page.evaluate(() => globalThis.latestNativeLoads)).toBe(0);
  await page.evaluate(() => globalThis.releaseNative());
  await expect(page.locator('#fileInfo')).toContainText('latest1.nii');
  await expect(page.locator('#imageLabel')).toContainText('latest1.nii');
  expect(await page.evaluate(() => globalThis.latestNativeLoads)).toBe(1);
});

test('a failed echo preview preserves the previous inputs and display', async ({ page }) => {
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('prior'));
  await expect(page.locator('#imageLabel')).toContainText('prior1.nii');
  const invalid = syntheticBundle('broken').map(file => file.name.endsWith('.nii')
    ? { ...file, buffer: Buffer.from('not a NIfTI image') }
    : file);
  await page.locator('#imageInput').setInputFiles(invalid);
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#fileInfo')).toHaveText('3 echoes: prior1.nii, prior2.nii, prior3.nii');
  await expect(page.locator('#imageLabel')).toContainText('prior1.nii');
  await expect(page.locator('#echoTimes')).toHaveValue('15 30 45');
});

test('cancelling while echo bytes are read prevents a processing worker', async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    const Native = Worker;
    globalThis.processingWorkers = 0;
    File.prototype.arrayBuffer = function () {
      if (this.name === 'read1.nii') {
        return new Promise(resolve => {
          globalThis.releaseRead = () => read.call(this).then(resolve);
        });
      }
      return read.call(this);
    };
    globalThis.Worker = class extends Native {
      postMessage(data, ...rest) {
        if (data?.echoes) globalThis.processingWorkers++;
        return super.postMessage(data, ...rest);
      }
    };
  });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(syntheticBundle('read'));
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => typeof globalThis.releaseRead)).toBe('function');
  await page.locator('#cancelButton').click();
  await page.evaluate(() => globalThis.releaseRead());
  await expect(page.locator('#statusText')).toHaveText('Cancelled');
  await expect(page.locator('#runButton')).toBeEnabled();
  expect(await page.evaluate(() => globalThis.processingWorkers)).toBe(0);
});
