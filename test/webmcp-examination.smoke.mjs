#!/usr/bin/env node
// What an agent runs on and what the person sees never part silently, and the WebMCP tools stay inside
// what the person allowed. Drives the built site (dist/) in Chromium with Chrome's own WebMCP
// (--enable-features=WebMCPTesting), as the person would: real file pickers, drops and selectors.
//
//   pnpm build && node test/webmcp-examination.smoke.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { exampleCachePath } from '../scripts/lib/example-asset-cache.mjs';
import { dicomSeries } from '../test-utils/dicom-fixture.mjs';
import { syntheticNifti } from '../test-utils/nifti-fixture.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const GPU_ARGS = process.platform === 'linux' ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--disable-vulkan-surface'] : [];
const FEATURES = `--enable-features=${[...(process.platform === 'linux' ? ['Vulkan'] : []), 'WebMCPTesting'].join(',')}`;
const cache = process.env.EXAMPLE_ASSET_CACHE;
const scan = (name, size = 16) => ({ name, mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [size, size, size], value: index => index % 7 }) });

const scratch = await mkdtemp(join(tmpdir(), 'webmcp-examination-'));

// The person's own pick, as Chrome reports a file chooser: a trusted change event. Playwright's
// setInputFiles dispatches an untrusted one, which the tools attribute to a run while one is going.
async function personPicks(context, page, selector, name) {
  const path = join(scratch, name);
  await writeFile(path, scan(name).buffer);
  const cdp = await context.newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path] });
}

const { origin, close } = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args: [...GPU_ARGS, FEATURES] });
const results = [];

async function check(label, body) {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  await context.route(/googletagmanager\.com|google-analytics\.com|cloudflareinsights\.com/, route => route.abort());
  if (cache) await context.route(url => existsSync(exampleCachePath(cache, url.href)), async route => route.fulfill({ body: await readFile(exampleCachePath(cache, route.request().url())) }));
  try {
    await body(context);
    results.push(true);
    console.log(`PASS ${label}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${label}: ${error.stack}`);
  } finally {
    await context.close();
  }
}

// waitForFunction takes a promise as a truthy answer, so an asynchronous condition is polled here.
async function until(page, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!(await page.evaluate(predicate))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${predicate}`);
    await page.waitForTimeout(250);
  }
}

async function open(context, app) {
  const page = await context.newPage();
  await page.goto(`${origin}/${app}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => Boolean(document.modelContext)), true, 'this Chromium exposes WebMCP');
  await until(page, async () => (await document.modelContext.getTools()).some(tool => tool.name === 'viewers_niivue'));
  const start = (name, input = {}) => page.evaluate(([name, input]) => {
    const calls = (globalThis.examinationCalls ??= []);
    calls.push(document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === name), input)).then(JSON.parse));
    return calls.length - 1;
  }, [name, input]);
  const result = index => page.evaluate(index => globalThis.examinationCalls[index], index);
  const call = async (name, input) => result(await start(name, input));
  return { page, call, start, result };
}

try {
  await check('NiiMath: picking an example in the page releases the scan the agent held', async context => {
    const { page, call } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('new-exam.nii.gz'));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'new-exam.nii.gz');
    const used = await call('inputs_use_page_files', { role: 'image', input: 'niftiInput' });
    assert.equal(used.files?.[0].name, 'new-exam.nii.gz', JSON.stringify(used));
    await page.locator('nd-example-selector select').selectOption('t1-head');
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'T1_head.nii.gz', undefined, { timeout: 120000 });
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, 'the agent holds nothing from the scan the person replaced');
    assert.ok(described.pageFiles.every(entry => !entry.current || entry.files.every(file => file.name !== 'new-exam.nii.gz')), JSON.stringify(described.pageFiles));
    assert.equal(described.pageExample, 't1-head');
    const rerun = await call('run_binarize', { waitSeconds: 60 });
    assert.equal(rerun.state, 'failed');
    assert.match(rerun.error.message, /Missing input: image/, 'the rerun refuses instead of using the old scan');
  });

  await check('NiiMath: a file the person opens while an agent run is going releases the agent\'s files', async context => {
    const { page, call, start, result } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('agent-exam.nii.gz', 160));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'agent-exam.nii.gz');
    await call('inputs_use_page_files', { role: 'image', input: 'niftiInput' });
    const first = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
    assert.deepEqual(Object.keys((await call('app_describe')).inputs), ['image'], 'a run that feeds the app\'s own input keeps the agent\'s files');
    const running = await start('run_process', { parameters: { command: '-s 12 -s 12 -s 12' }, waitSeconds: 300 });
    await page.waitForFunction(() => globalThis.neurodeskAutomation.running(), undefined, { polling: 20 });
    await personPicks(context, page, '#niftiInput', 'person-exam.nii.gz');
    assert.equal(await page.evaluate(() => globalThis.neurodeskAutomation.running()), true, 'the person opened the file while the run was going');
    await result(running);
    const shown = await page.locator('#fileInfo').textContent();
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, JSON.stringify(described.inputs));
    assert.equal(described.run.stale, true, 'the run the person interrupted is withheld');
    const claimed = described.pageFiles.filter(entry => entry.current).flatMap(entry => entry.files.map(file => file.name));
    assert.ok(claimed.every(name => name === shown), `pageFiles claims only what the page shows (${shown}): ${JSON.stringify(described.pageFiles)}`);
    assert.ok(!claimed.includes('person-exam.nii.gz') || shown === 'person-exam.nii.gz', 'a pick the busy page ignored is not claimed');
    assert.equal(described.pageMayHoldOtherInputs, true);
  });

  await check('NiiMath: a new examination withholds the previous examination\'s report', async context => {
    const { page, call } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('exam-a.nii.gz'));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'exam-a.nii.gz');
    await call('inputs_use_page_files', { role: 'image', input: 'niftiInput' });
    const run = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    await personPicks(context, page, '#niftiInput', 'exam-b.nii.gz');
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'exam-b.nii.gz');
    const described = await call('app_describe');
    assert.equal(described.run.stale, true, JSON.stringify(described.run));
    assert.equal(described.run.report, undefined, 'exam A\'s report is withheld');
    assert.deepEqual(described.pageFiles.map(entry => [entry.files[0].name, entry.current]), [['exam-b.nii.gz', true]]);
    for (const [name, input] of [['outputs_download', { runId: run.runId, artifactId: 'report' }], ['runs_get', { runId: run.runId }], ['runs_cancel', {}]]) {
      assert.equal((await call(name, input)).error?.code, 'RUN_STALE', name);
    }
  });

  await check('QSMbly: a mask removed with its own button is neither held nor listed', async context => {
    const { page, call } = await open(context, 'qsmbly');
    await personPicks(context, page, '#maskFiles', 'old-mask.nii.gz');
    await page.locator('#maskList .file-remove').waitFor({ state: 'attached', timeout: 60000 });
    // The masking section starts collapsed; open it as the person would before reaching the button.
    await page.locator('#maskList').evaluate(list => {
      for (let node = list; node; node = node.parentElement) {
        node.classList.remove('collapsed');
        if (node.style.display === 'none') node.style.display = '';
      }
    });
    const used = await call('inputs_use_page_files', { role: 'mask', input: 'maskFiles' });
    assert.equal(used.files?.[0].name, 'old-mask.nii.gz', JSON.stringify(used));
    await page.locator('#maskList .file-remove').click();
    await page.locator('#maskList .file-remove').waitFor({ state: 'detached' });
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, JSON.stringify(described.inputs));
    assert.ok(!described.pageFiles.some(entry => entry.files.some(file => file.name === 'old-mask.nii.gz')), JSON.stringify(described.pageFiles));
  });

  await check('dcm2niix: editing a setting keeps the files listed, to confirm; Clear empties the list', async context => {
    const { page, call, start, result } = await open(context, 'dcm2niix');
    await page.locator('#imageInput').setInputFiles(dicomSeries());
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent.includes('4 DICOM files'), undefined, { timeout: 60000 });
    await page.locator('#subject').fill('07');
    const described = await call('app_describe');
    assert.deepEqual(described.pageFiles.map(entry => [entry.input, entry.files.length, entry.current]), [['imageInput', 4, false]], JSON.stringify(described.pageFiles));
    const asked = await start('inputs_use_page_files', { role: 'dicom', input: 'imageInput' });
    const dialog = page.locator('dialog#neurodeskAgentPrompt');
    await dialog.getByRole('button', { name: 'Allow' }).click();
    const confirmed = await result(asked);
    assert.equal(confirmed.files?.length, 4, JSON.stringify(confirmed));
    await page.locator('#clearButton').click();
    assert.deepEqual((await call('app_describe')).pageFiles, [], 'the cleared examination lists no files');
  });

  await check('DWI2TRX: files dropped on the viewer are listed as received', async context => {
    const { page, call } = await open(context, 'dwi2trx');
    const cdp = await context.newCDPSession(page);
    const path = join(scratch, 'viewer-drop.nii.gz');
    await writeFile(path, scan('viewer-drop').buffer);
    const box = await page.locator('#canvas-container').boundingBox();
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data });
    let described;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      described = await call('app_describe');
      if (described.pageFiles.length) break;
      await page.waitForTimeout(250);
    }
    assert.deepEqual(described.pageFiles.map(entry => [entry.input, entry.files.map(file => file.name), entry.current]), [['received:drop', ['viewer-drop.nii.gz'], true]], JSON.stringify(described.pageFiles));
  });

  await check('White matter lesions: an image handed over from another app is listed as received', async context => {
    const { page } = await open(context, 'dicomview');
    await page.evaluate(async ([href, bytes]) => {
      const { sendHandoff } = await import(href);
      const file = new File([new Uint8Array(bytes)], 'handed.nii.gz');
      await sendHandoff({ target: 'white-matter-lesions', source: { app: 'dicomview', title: 'DICOM View' }, files: [file] });
    }, [`${origin}/shell-adapters/components/handoff/index.js`, [...scan('handed').buffer]]);
    await page.waitForURL(/white-matter-lesions/);
    await until(page, async () => (await document.modelContext?.getTools() ?? []).some(tool => tool.name === 'app_describe'));
    let described;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      described = JSON.parse(await page.evaluate(async () => document.modelContext.executeTool((await document.modelContext.getTools()).find(tool => tool.name === 'app_describe'), {})));
      if (described.pageFiles.length) break;
      await page.waitForTimeout(250);
    }
    assert.deepEqual(described.pageFiles.map(entry => [entry.input, entry.label, entry.files.map(file => file.name)]), [['received:handoff', 'Sent from DICOM View', ['handed.nii.gz']]], JSON.stringify(described.pageFiles));
  });

  await check('ZARRo: a store address is approved with its origin and the reads under it', async context => {
    const { page, start, result } = await open(context, 'zarro');
    const requests = [];
    await context.route('https://store.invalid/**', route => {
      requests.push(route.request().url());
      return route.abort();
    });
    const store = 'https://store.invalid/brain.ome.zarr';
    const asked = await start('run_open_url', { inputs: { store: { url: store } }, waitSeconds: 1 });
    const dialog = page.locator('dialog#neurodeskAgentPrompt');
    await dialog.getByRole('button', { name: 'Decline' }).waitFor();
    const text = await dialog.textContent();
    assert.match(text, /ZARRo also reads the addresses under it/);
    assert.match(text, /The server at https:\/\/store\.invalid sees every request/);
    await dialog.getByRole('button', { name: 'Decline' }).click();
    assert.deepEqual(await result(asked), { declined: true, addresses: [store] });
    assert.deepEqual(requests, []);
  });

  await check('NiiMath: a file dropped on the page releases the agent\'s files', async context => {
    const { page, call } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('agent-exam.nii.gz'));
    await call('inputs_use_page_files', { role: 'image', input: 'niftiInput' });
    assert.deepEqual(Object.keys((await call('app_describe')).inputs), ['image']);
    const cdp = await context.newCDPSession(page);
    const path = join(scratch, `webmcp-drop-${process.pid}.nii.gz`);
    await writeFile(path, scan('drop').buffer);
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 300, y: 300, data });
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent?.startsWith('webmcp-drop-'));
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {});
    assert.match(described.pageFiles[0].files[0].name, /^webmcp-drop-/);
  });

  await check('dcm2niix: files chosen in its picker can be reused after it clears the picker', async context => {
    const { page, call } = await open(context, 'dcm2niix');
    await page.locator('#imageInput').setInputFiles(dicomSeries());
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent.includes('4 DICOM files'), undefined, { timeout: 60000 });
    const described = await call('app_describe');
    assert.equal(described.pageFiles[0]?.files.length, 4, JSON.stringify(described.pageFiles));
    const used = await call('inputs_use_page_files', { role: 'dicom', input: 'imageInput' });
    assert.equal(used.files?.length, 4, JSON.stringify(used));
  });

  await check('Brain Extraction: viewers_niivue exports no pixels and fetches only what the person allows', async context => {
    const { page, call, start, result } = await open(context, 'brain-extraction');
    await page.locator('input[type=file][data-neurodesk-input]:not(#neurodesk-input-transfer):not([webkitdirectory])').first().setInputFiles(join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz'));
    await until(page, async () => (await globalThis.neurodeskAutomation.dispatch('viewers.list')).some(viewer => viewer.capabilities.niivue));
    const downloads = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    for (const [method, params] of [['screenshot', {}], ['save', { what: 'bitmap', filename: 'agent.png' }]]) {
      const refused = await call('viewers_niivue', { viewerId: 'main', method, params });
      assert.equal(refused.error?.code, 'INVALID_INPUT', `${method}: ${JSON.stringify(refused)}`);
    }
    const url = `${origin}/test-only/remote-fixture.nii.gz`;
    const requests = [];
    await context.route(url, route => {
      requests.push(route.request().url());
      return route.fulfill({ path: join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz') });
    });
    const dialog = page.locator('dialog#neurodeskAgentPrompt');
    const declined = await start('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } });
    await dialog.getByRole('button', { name: 'Allow' }).waitFor();
    assert.match(await dialog.textContent(), /Let Brain extraction load the file at this address into the page\?/i);
    assert.match(await dialog.textContent(), /test-only\/remote-fixture\.nii\.gz/);
    await dialog.getByRole('button', { name: 'Decline' }).click();
    assert.deepEqual(await result(declined), { declined: true, addresses: [url] });
    assert.deepEqual(requests, [], 'a declined address is never requested');
    const allowed = await start('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } });
    await dialog.getByRole('button', { name: 'Allow' }).click();
    const loaded = await result(allowed);
    assert.equal(loaded.result?.name, 'remote-fixture.nii.gz', JSON.stringify(loaded));
    assert.equal(requests.length, 1);

    const moved = `${origin}/test-only/moved.nii.gz`;
    const target = `${origin}/test-only/redirect-target.nii.gz`;
    await context.route(moved, route => {
      requests.push(route.request().url());
      return route.fulfill({ status: 302, headers: { location: target } });
    });
    await context.route(target, route => {
      requests.push(route.request().url());
      return route.fulfill({ path: join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz') });
    });
    const redirected = await start('viewers_niivue', { viewerId: 'main', method: 'add_overlay', params: { url: moved } });
    await dialog.getByRole('button', { name: 'Allow' }).click();
    assert.equal((await result(redirected)).error?.code, 'REDIRECT_REFUSED');
    assert.ok(!requests.includes(target), `the redirect target is never fetched: ${JSON.stringify(requests)}`);
    const document = await call('viewers_niivue', { viewerId: 'main', method: 'load_document', params: { url: `${origin}/test-only/scene.nvd` } });
    assert.equal(document.error?.code, 'INVALID_INPUT', 'a document can name further addresses, so it is not offered');
    const scene = await call('viewers_niivue', { viewerId: 'main' });
    assert.ok(!JSON.stringify(scene).includes(`${origin}/test-only`), `no address the agent named reached the viewer: ${JSON.stringify(scene).slice(0, 400)}`);
    await page.waitForTimeout(500);
    assert.deepEqual(downloads, [], 'nothing was saved');
  });

  await check('NiiMath: a malformed call returns INVALID_INPUT and the next question still opens', async context => {
    const { page, call, start, result } = await open(context, 'niimath');
    assert.equal((await call('runs_get', { waitSeconds: 'invalid' })).error?.code, 'INVALID_INPUT');
    assert.equal((await call('user_ask', { question: 'Sample', options: 'not-an-array' })).error?.code, 'INVALID_INPUT');
    const asked = await start('user_ask', { question: 'Valid?', options: ['OK'] });
    await page.locator('dialog#neurodeskAgentPrompt').getByRole('button', { name: 'OK' }).click();
    assert.deepEqual(await result(asked), { answer: 'OK' });
  });
} finally {
  await browser.close();
  await close();
  await rm(scratch, { recursive: true, force: true });
}
const failed = results.filter(passed => !passed).length;
console.log(`webmcp examination checks: ${results.length - failed} pass, ${failed} fail`);
process.exitCode = failed ? 1 : 0;
