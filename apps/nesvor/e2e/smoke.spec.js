// Real browser test against the built app and the Node reference compute server
// (simulated nesvor). Proves the deployed contract: shell, isolation, the example,
// connection explanations, a reconstruction round trip, cancellation and failure.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { COMPUTE_PORT, COMPUTE_TOKEN } from "../playwright.config.js";
import { gpuBrowser } from "../../../test-utils/hardware-gpu.mjs";

test.use(gpuBrowser);

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const example = examples[0];
const COMPUTE_URL = `http://127.0.0.1:${COMPUTE_PORT}`;

async function loadExample(page) {
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
  await expect(page.locator("#stackRows [data-stack]")).toHaveCount(example.files.filter(file => file.role === "stack").length);
}

async function connect(page, { address = COMPUTE_URL, token = COMPUTE_TOKEN } = {}) {
  await page.locator("#executionMode").selectOption("remote");
  const panel = page.locator("#computeConnection");
  await panel.locator('input[type="text"]').fill(address);
  await panel.locator('input[type="password"]').fill(token);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel).not.toHaveAttribute("data-state", "connecting", { timeout: 30000 });
  return panel;
}

async function download(page, name) {
  const downloadPromise = page.waitForEvent("download");
  await page.locator(`#resultList button:has-text("Download")`).nth(name).click();
  const item = await downloadPromise;
  const stream = await item.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { filename: item.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

test("app boots with the shared bar, isolation and the compute section open", async ({ page }) => {
  const probes = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/v1/info") probes.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  await expect(page.locator("#executionMode")).toHaveValue("browser-webgpu");
  await expect(page.locator("#remoteControls")).toBeHidden();
  await expect(page.locator("#computeSection")).toHaveAttribute("open", "");
  await expect(page.locator("#computeConnection")).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#runButton")).toBeDisabled();
  expect(probes).toEqual([]);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("compute server");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("inside your own network");
});

test("automation opens stacks in the real viewer and replaces previous inputs", async ({ page }) => {
  const { syntheticNifti } = await import('../../../test-utils/nifti-fixture.mjs');
  const dispatch = (command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
  await page.goto('/');
  for (const name of ['first.nii.gz', 'second.nii.gz']) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name, mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [5, 5, 5] }) });
    await dispatch('adopt', { role: 'stacks' });
    await dispatch('start');
    await expect.poll(async () => (await dispatch('snapshot')).state, { timeout: 60000 }).toBe('succeeded');
    const { report } = await dispatch('snapshot');
    expect(report.summary.stacks).toHaveLength(1);
    expect(report.summary.stacks[0].name).toBe(name);
    await expect(page.locator('#stackRows [data-stack]')).toHaveCount(1);
    await expect(page.locator('#emptyState')).toBeHidden();
  }
  expect(await dispatch('viewers.list')).toEqual([expect.objectContaining({ id: 'main' })]);
});

test("the example loads every stack with its thickness and uses segmentation masks", async ({ page }) => {
  test.setTimeout(240000);
  await loadExample(page);
  await expect(page.locator("#fileInfo")).toContainText("6 stacks loaded");
  await expect(page.locator("#thickness-0")).toHaveValue("1.25");
  await expect(page.locator("#mask-2")).toHaveValue("");
  await expect(page.locator("#mask-0")).toHaveValue("");
  await expect(page.locator("#stackRows [data-stack]").nth(0)).toContainText("90 slices");
  await expect(page.locator("#protocol")).toHaveValue("fetal-brain");
  await expect(page.locator("#segmentation")).toBeChecked();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#executionMode").selectOption("remote");
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(page.locator("#runButton")).toHaveAttribute("title", /Connect to a compute server/);
  await expect(page.locator("#emptyState")).toBeHidden();
});

test("connection problems are explained and a good token connects", async ({ page }) => {
  await page.goto("/");
  const panel = await connect(page, { address: "", token: "" });
  await expect(panel).toHaveAttribute("data-state", "error");
  await expect(panel.locator(".nd-message")).toContainText("Enter the address");
  await connect(page, { address: "http://127.0.0.1:1" });
  await expect(panel).toHaveAttribute("data-state", "error", { timeout: 30000 });
  await expect(panel.locator(".nd-message")).toContainText("Could not reach 127.0.0.1:1");
  await connect(page, { token: "wrong" });
  await expect(panel.locator(".nd-message")).toContainText("rejected the access token");
  await connect(page);
  await expect(panel).toHaveAttribute("data-state", "simulated");
  await expect(panel.locator(".nd-message")).toContainText("nesvor 0.5.0");
  await expect(page.locator("#computeSection")).not.toHaveAttribute("open", "");
  await expect(page.locator("#computeBadge")).toHaveText("simulated");
  await page.reload();
  await expect(page.locator("#computeConnection input[type=\"text\"]")).toHaveValue(COMPUTE_URL);
});

test("the example reconstructs on the compute server and downloads a NIfTI volume", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await connect(page);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/Simulated result ready/, { timeout: 120000 });
  await expect(page.locator("#outputSection")).toHaveAttribute("open", "");
  await expect(page.locator("#progress")).toHaveAttribute("value", "1");
  await expect(page.locator("#resultList")).toContainText("Simulated placeholder");
  const volume = await download(page, 0);
  expect(volume.filename).toMatch(/_nesvor\.nii\.gz$/);
  const raw = gunzipSync(volume.bytes);
  expect(raw.readInt32LE(0)).toBe(348);
  expect(raw.toString("latin1", 344, 347)).toBe("n+1");
  expect(raw.length).toBeGreaterThan(352);
  const record = await download(page, 1);
  expect(JSON.parse(record.bytes.toString()).simulated).toBe(true);
  const logFile = await download(page, 2);
  expect(logFile.bytes.toString()).toContain("--registration svort");
  expect(logFile.bytes.toString()).toContain("--segmentation");
  await expect(page.locator("#technicalLog")).toContainText("Registration starts");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("a running reconstruction can be cancelled and then retried", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await connect(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toContainText(/Running|Queued|Loading stacks|Motion correction/, { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Reconstruction cancelled", { timeout: 30000 });
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText(/Simulated result ready/, { timeout: 120000 });
});

test("a failed job is reported with the server's reason and the app stays usable", async ({ page, request }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await connect(page);
  await request.post(`${COMPUTE_URL}/__test/fail-next`);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Reconstruction interrupted: nesvor exited with status 1", { timeout: 120000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#technicalLog")).toContainText("CUDA out of memory");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList button:has-text(\"Download\")")).toHaveCount(0);
});

test("changing a setting switches the protocol to custom and presets restore it", async ({ page }) => {
  await page.goto("/");
  await page.locator("#advancedSettings").evaluate(element => { element.open = true; });
  await page.locator("#protocol").selectOption("neonatal-brain");
  await expect(page.locator("#registration")).toHaveValue("stack");
  await expect(page.locator("#otsuThresholding")).toBeChecked();
  await page.locator("#iterations").fill("2000");
  await page.locator("#iterations").dispatchEvent("change");
  await expect(page.locator("#protocol")).toHaveValue("custom");
  await page.locator("#protocol").selectOption("fetal-body");
  await expect(page.locator("#deformable")).toBeChecked();
  await expect(page.locator("#outputResolution")).toHaveValue("1");
});

test('browser reference fits a small masked stack locally and downloads provenance', async ({ page }, testInfo) => {
  const { writeVolume, readVolume } = await import('../../../packages/synthsr/src/volume.js');
  const affine = [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 2, 30], [0, 0, 0, 1]];
  const volume = { dims: [3, 3, 3], affine, data: Float32Array.from({ length: 27 }, (_, i) => 1 + i / 27) };
  const uploads = [];
  page.on('request', request => {
    if (request.method() === 'POST' && !new URL(request.url()).hostname.endsWith('google-analytics.com')) uploads.push(request.url());
  });
  await page.goto('/');
  await page.locator('#executionMode').selectOption('browser-reference');
  await page.locator('#imageInput').setInputFiles([
    { name: 'reference.nii', mimeType: 'application/octet-stream', buffer: Buffer.from(writeVolume(volume)) },
    { name: 'reference_mask.nii', mimeType: 'application/octet-stream', buffer: Buffer.from(writeVolume({ ...volume, data: new Uint8Array(27).fill(1) })) },
  ]);
  await expect(page.locator('#fileInfo')).toContainText('1 stack loaded');
  await expect(page.locator('#runButton')).toBeDisabled();
  await page.locator('#referenceAcknowledged').check();
  await page.locator('#outputResolution').fill('2');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Browser reference output ready', { timeout: 60000 });
  expect(uploads).toEqual([]);
  const output = await download(page, 0);
  const reconstructed = readVolume(output.bytes.buffer.slice(output.bytes.byteOffset, output.bytes.byteOffset + output.bytes.byteLength));
  expect(reconstructed.dims).toEqual([2, 2, 3]);
  expect(reconstructed.data.every(Number.isFinite)).toBe(true);
  const record = JSON.parse((await download(page, 1)).bytes.toString());
  expect(record.validated).toBe(false);
  expect(record.preset.iterations).toBe(100);
  await page.screenshot({ path: testInfo.outputPath('browser-reference-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('browser-reference-phone.png'), fullPage: true });
});

test('remote run locks patient inputs and a reload can recover the owned job', async ({ page }) => {
  const { syntheticNifti } = await import('../../../test-utils/nifti-fixture.mjs');
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles({ name: 'patient-a.nii.gz', mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [5, 5, 5] }) });
  await expect(page.locator('#fileInfo')).toContainText('1 stack loaded');
  await connect(page);
  await page.locator('#runButton').click();
  await expect(page.locator('#imageInput')).toBeDisabled();
  await expect(page.locator('#stackRows button:has-text("Remove")')).toBeDisabled();
  await expect(page.locator('#executionMode')).toBeDisabled();
  await expect(page.locator('#statusText')).toContainText(/Running|Queued|Loading stacks|Motion correction/);
  await page.reload();
  await page.locator('#executionMode').selectOption('remote');
  const panel = page.locator('#computeConnection');
  await expect(panel.locator('input[type="password"]')).toHaveValue('');
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel).toHaveAttribute('data-state', 'simulated');
  await page.locator('#computeSection').evaluate(element => { element.open = true; });
  await page.locator('#previousJobs').evaluate(element => { element.open = true; });
  await expect(page.locator('#previousJob option')).toHaveCount(1);
  await page.locator('#resumeJob').click();
  // The simulated job runs its remaining stages in real time; slow runners need more than 5 s.
  await expect(page.locator('#statusText')).toContainText('Simulated result ready', { timeout: 30000 });
  expect((await download(page, 0)).filename).toMatch(/^job-[a-f0-9]+_nesvor\.nii\.gz$/);
});

test('failed imports leave the current examination unchanged', async ({ page }) => {
  const { syntheticNifti } = await import('../../../test-utils/nifti-fixture.mjs');
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles({ name: 'patient-a.nii.gz', mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [5, 5, 5] }) });
  await expect(page.locator('#fileInfo')).toContainText('1 stack loaded');
  await expect(page.locator('#imageInput')).toBeEnabled();
  await page.locator('#imageInput').setInputFiles([
    { name: 'patient-b.nii.gz', mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [5, 5, 5] }) },
    { name: 'broken.nii', mimeType: 'application/octet-stream', buffer: Buffer.alloc(400) },
  ]);
  await expect(page.locator('#statusText')).toContainText('not a NIfTI');
  await expect(page.locator('#stackRows [data-stack]')).toHaveCount(1);
  await expect(page.locator('#stackRows')).toContainText('patient-a.nii.gz');
  await expect(page.locator('#stackRows')).not.toContainText('patient-b.nii.gz');
});

test.describe('WebGPU reconstruction', () => {
  test('fits intersecting stacks locally and downloads the supported volume', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const { writeVolume, readVolume } = await import('../../../packages/synthsr/src/volume.js');
    const dims = [8,8,8];
    const data = Float32Array.from({length:512}, (_, i) => 1+i/512);
    const affines = [[[1,0,0,10],[0,1,0,20],[0,0,3,30],[0,0,0,1]], [[0,0,3,3],[1,0,0,20],[0,1,0,37],[0,0,0,1]], [[1,0,0,10],[0,0,-3,34],[0,1,0,37],[0,0,0,1]]];
    const uploads = [];
    page.on('request', request => { if (request.method() === 'POST' && !new URL(request.url()).hostname.endsWith('google-analytics.com')) uploads.push(request.url()); });
    await page.goto('/');
    await expect(page.locator('#executionMode')).toHaveValue('browser-webgpu');
    await page.locator('#imageInput').setInputFiles(affines.map((affine,i) => ({name:`stack-${i}.nii`,mimeType:'application/octet-stream',buffer:Buffer.from(writeVolume({data,dims,affine}))})));
    await expect(page.locator('#stackRows [data-stack]')).toHaveCount(3);
    await expect(page.locator('#viewerError')).toBeHidden();
    await page.locator('#protocol').selectOption('custom');
    await page.locator('#registration').selectOption('none');
    await page.locator('#advancedSettings').evaluate(element => {element.open=true;});
    await page.locator('#segmentation').uncheck();
    await page.locator('#biasFieldCorrection').check();
    await page.locator('#deformable').check();
    await page.locator('#iterations').fill('1');
    await page.locator('#batchSize').fill('2');
    await page.locator('#log2HashmapSize').fill('3');
    await page.locator('#outputResolution').fill('3');
    await page.locator('#runButton').click();
    await expect(page.locator('#statusText')).toContainText('Browser WebGPU output ready',{timeout:150000});
    const output = await download(page,0);
    const volume = readVolume(output.bytes.buffer.slice(output.bytes.byteOffset,output.bytes.byteOffset+output.bytes.byteLength));
    expect(volume.data.every(Number.isFinite)).toBe(true);
    expect(volume.data.some(value=>value>0)).toBe(true);
    const provenance = JSON.parse((await download(page,1)).bytes.toString());
    expect(provenance.engine).toBe('browser-webgpu');
    const progressLog = (await download(page, 2)).bytes.toString();
    expect(progressLog).toContain('N4 bias correction');
    expect(progressLog).toContain('iteration 1/1');
    expect(progressLog).toContain('observations');
    expect(progressLog).toContain('Reconstruction complete');
    await expect(page.locator('#viewerError')).toBeHidden();
    await expect(page.locator('#gl1')).toBeVisible();
    expect(provenance.config.iterations).toBe(1);
    expect(provenance.config.deformable).toBe(true);
    expect(provenance.preprocessing.biasFieldCorrection).toBe(true);
    expect(provenance.outputSamples).toBe(512);
    expect(provenance.validated).toBe(false);
    expect(uploads).toEqual([]);
    await page.screenshot({path:testInfo.outputPath('browser-gpu-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:testInfo.outputPath('browser-gpu-phone.png'),fullPage:true});
  });
});

test('compute-server setup is reachable from the connection workflow', async ({ page }) => {
  await page.goto('/');
  await page.locator('#executionMode').selectOption('remote');
  await page.locator('#standaloneLink').click();
  const dialog = page.locator('#neurodeskStandaloneDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('section').first()).toContainText('Compute server · Linux with NVIDIA GPU');
  await expect(dialog.locator('#compute-doctor')).toHaveText('./neurodesk-compute doctor');
  await expect(dialog.locator('#compute-start')).toContainText(`--allow-origin '${new URL(page.url()).origin}'`);
  await expect(dialog).toContainText('Pairing code');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#computeConnection')).toBeVisible();
});

 test('help is keyboard accessible and stays inside a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const icon = page.getByLabel('About browser WebGPU', { exact: true });
  await icon.focus();
  const tip = icon.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const bounds = await tip.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await icon.press('Escape');
  await expect(tip).toBeHidden();
});

test('inferred thickness does not require acknowledgement and remains editable', async ({ page }) => {
  const { syntheticNifti } = await import('../../../test-utils/nifti-fixture.mjs');
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles({ name: 'stack.nii.gz', mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [5, 5, 5] }) });
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#stackHint')).toBeVisible();
  await expect(page.locator('#thicknessConfirmed')).toHaveCount(0);
  await page.locator('#thickness-0').fill('0');
  await page.locator('#thickness-0').blur();
  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(page.locator('#runButton')).toHaveAttribute('title', 'Enter a positive slice thickness for every stack');
  await page.locator('#thickness-0').fill('3.2');
  await page.locator('#thickness-0').blur();
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#stackHint')).toBeHidden();
  await page.locator('#inputSection > summary').click();
  await page.locator('#inputSection > summary').click();
  await expect(page.locator('#thickness-0')).toHaveValue('3.2');
});

for (const rawGzip of [false, true]) {
  test(`production masking initializes WebGPU and can be cancelled (${rawGzip ? 'raw gzip' : 'HTTP gzip'})`, async ({ page }) => {
    test.skip(!process.env.NESVOR_MASK_FIXTURE_DIR, 'Requires the external pinned MONAIfbs export.');
    test.setTimeout(240000);
    const { join } = await import('node:path');
    const { writeVolume } = await import('../../../packages/synthsr/src/volume.js');
    const manifest = JSON.parse(readFileSync(new URL('../../../packages/nesvor/src/masking/manifest.json', import.meta.url)));
    const { createServer } = await import('node:http');
    const { createReadStream, statSync } = await import('node:fs');
    const modelPath = join(process.env.NESVOR_MASK_FIXTURE_DIR, manifest.file);
    if (rawGzip) {
      const body = readFileSync(new URL('../dist/ort/ort-wasm-simd-threaded.asyncify.wasm.gz', import.meta.url));
      await page.route('**/ort/ort-wasm-simd-threaded.asyncify.wasm.gz', route => route.fulfill({ body, contentType: 'application/octet-stream' }));
    }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(modelPath).size, 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
      createReadStream(modelPath).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await page.route(new URL(manifest.file, manifest.base_url).href, route => route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:${server.address().port}/model`, 'Access-Control-Allow-Origin': '*' } }));
      const fixture = JSON.parse(readFileSync(join(process.env.NESVOR_MASK_FIXTURE_DIR, 'stack.json')));
      const affine = [[fixture.resolution[0],0,0,0],[0,fixture.resolution[1],0,0],[0,0,fixture.resolution[2],0],[0,0,0,1]];
      await page.goto('/');
      await page.locator('#imageInput').setInputFiles({ name:'fetal.nii', mimeType:'application/octet-stream', buffer:Buffer.from(writeVolume({ data:Float32Array.from(fixture.data), dims:fixture.shape, affine })) });
      await page.locator('#registration').selectOption('none');
      await page.locator('#advancedSettings').evaluate(element => { element.open = true; });
      await page.locator('#biasFieldCorrection').uncheck();
      await page.locator('#runButton').click();
      await expect(page.locator('#technicalLog')).toContainText('Brain masking backend: webgpu', { timeout:180000 });
      await page.locator('#cancelButton').click();
      await expect(page.locator('#statusText')).toContainText('Browser reconstruction cancelled');
      await expect(page.locator('#runButton')).toBeEnabled();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
