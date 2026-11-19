#!/usr/bin/env node
// What an agent runs on and what the person sees never part silently, and the WebMCP tools stay inside
// what the person allowed. Drives the built site (dist/) in Chromium with Chrome's own WebMCP
// (--enable-features=WebMCPTesting), as the person would: real file pickers, drops and selectors.
//
//   pnpm build && node test/webmcp-examination.smoke.mjs
//   WEBMCP_CHECKS='ZARRo|frame' node test/webmcp-examination.smoke.mjs   (only the checks whose label matches)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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

const CHECK_SECONDS = Number(process.env.WEBMCP_CHECK_SECONDS ?? 300);
const ONLY = process.env.WEBMCP_CHECKS ? new RegExp(process.env.WEBMCP_CHECKS) : null;
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
  if (ONLY && !ONLY.test(label)) return;
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  await context.route(/googletagmanager\.com|google-analytics\.com|cloudflareinsights\.com/, route => route.abort());
  if (cache) await context.route(url => existsSync(exampleCachePath(cache, url.href)), async route => route.fulfill({ body: await readFile(exampleCachePath(cache, route.request().url())) }));
  let timer;
  // A check that stops answering (a dialog nobody answers, a hold that never resolves) fails instead of stalling the run.
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${CHECK_SECONDS} s`)), CHECK_SECONDS * 1000); });
  try {
    await Promise.race([body(context), deadline]);
    results.push(true);
    console.log(`PASS ${label}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${label}: ${error.stack}`);
  } finally {
    clearTimeout(timer);
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
  const dialog = page.locator('dialog#neurodeskAgentPrompt');
  // A call that shows the person a dialog; `answer` is the button they press.
  const answered = async (name, input, answer) => {
    const asked = await start(name, input);
    await dialog.getByRole('button', { name: answer }).waitFor();
    const text = await dialog.textContent();
    const listed = await dialog.locator('li').allTextContents();
    await dialog.getByRole('button', { name: answer }).click();
    return { text, listed, ...await result(asked) };
  };
  // inputs_use_page_files always shows the person the files.
  const usePageFiles = (role, input, answer = 'Allow') => answered('inputs_use_page_files', { role, input }, answer);
  return { page, call, start, result, answered, usePageFiles, dialog };
}

// The viewer's volumes once the image the person opened is shown in it.
async function shownVolumes(page, call, name) {
  let volumes = [];
  await until(page, () => globalThis.neurodeskAutomation.dispatch('viewers.list').then(viewers => viewers.some(viewer => viewer.capabilities.niivue)));
  for (const deadline = Date.now() + 60000; !volumes.some(volume => volume.name === name); await page.waitForTimeout(250)) {
    if (Date.now() > deadline) throw new Error(`the viewer never showed ${name}: ${JSON.stringify(volumes)}`);
    volumes = (await call('viewers_volumes', { viewerId: 'main' })).volumes ?? [];
  }
  return volumes;
}

// A server on its own port, as a remote host is, that answers CORS and records what it is asked.
async function remoteHost(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    return handler(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

const NO_CURRENT = entries => entries.every(entry => !Object.hasOwn(entry, 'current'));

try {
  await check('NiiMath: picking an example in the page releases the scan the agent held', async context => {
    const { page, call, usePageFiles } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('new-exam.nii.gz'));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'new-exam.nii.gz');
    const used = await usePageFiles('image', 'niftiInput');
    assert.deepEqual(used.listed, ['new-exam.nii.gz'], 'the person sees the files before the agent gets them');
    assert.equal(used.files?.[0].name, 'new-exam.nii.gz', JSON.stringify(used));
    await page.locator('nd-example-selector select').selectOption('t1-head');
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'T1_head.nii.gz', undefined, { timeout: 120000 });
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, 'the agent holds nothing from the scan the person replaced');
    assert.ok(NO_CURRENT(described.pageFiles), JSON.stringify(described.pageFiles));
    assert.equal(described.pageExample, 't1-head');
    const rerun = await call('run_binarize', { waitSeconds: 60 });
    assert.equal(rerun.state, 'failed');
    assert.match(rerun.error.message, /Missing input: image/, 'the rerun refuses instead of using the old scan');
  });

  await check('NiiMath: a file the person opens while an agent run is going releases the agent\'s files', async context => {
    const { page, call, start, result, usePageFiles } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('agent-exam.nii.gz', 160));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'agent-exam.nii.gz');
    await usePageFiles('image', 'niftiInput');
    const first = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(first.state, 'succeeded', JSON.stringify(first.error));
    assert.deepEqual(Object.keys((await call('app_describe')).inputs), ['image'], 'a run that feeds the app\'s own input keeps the agent\'s files');
    const running = await start('run_process', { parameters: { command: '-s 12 -s 12 -s 12' }, waitSeconds: 300 });
    await page.waitForFunction(() => globalThis.neurodeskAutomation.running(), undefined, { polling: 20 });
    await personPicks(context, page, '#niftiInput', 'person-exam.nii.gz');
    assert.equal(await page.evaluate(() => globalThis.neurodeskAutomation.running()), true, 'the person opened the file while the run was going');
    await result(running);
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, JSON.stringify(described.inputs));
    assert.equal(described.run.stale, true, 'the run the person interrupted is withheld');
    assert.ok(NO_CURRENT(described.pageFiles), `pageFiles never claims what the page shows: ${JSON.stringify(described.pageFiles)}`);
    assert.equal(described.pageMayHoldOtherInputs, true);
  });

  await check('NiiMath: a new examination withholds the previous examination\'s report', async context => {
    const { page, call, usePageFiles } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('exam-a.nii.gz'));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'exam-a.nii.gz');
    await usePageFiles('image', 'niftiInput');
    const run = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    await personPicks(context, page, '#niftiInput', 'exam-b.nii.gz');
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'exam-b.nii.gz');
    const described = await call('app_describe');
    assert.equal(described.run.stale, true, JSON.stringify(described.run));
    assert.equal(described.run.report, undefined, 'exam A\'s report is withheld');
    assert.deepEqual(described.pageFiles.map(entry => entry.files[0].name), ['exam-b.nii.gz']);
    for (const [name, input] of [['outputs_download', { runId: run.runId, artifactId: 'report' }], ['runs_get', { runId: run.runId }], ['runs_cancel', {}]]) {
      assert.equal((await call(name, input)).error?.code, 'RUN_STALE', name);
    }
  });

  await check('QSMbly: a mask removed with its own button is neither held nor listed', async context => {
    const { page, call, usePageFiles } = await open(context, 'qsmbly');
    await personPicks(context, page, '#maskFiles', 'old-mask.nii.gz');
    await page.locator('#maskList .file-remove').waitFor({ state: 'attached', timeout: 60000 });
    // The masking section starts collapsed; open it as the person would before reaching the button.
    await page.locator('#maskList').evaluate(list => {
      for (let node = list; node; node = node.parentElement) {
        node.classList.remove('collapsed');
        if (node.style.display === 'none') node.style.display = '';
      }
    });
    const used = await usePageFiles('mask', 'maskFiles');
    assert.equal(used.files?.[0].name, 'old-mask.nii.gz', JSON.stringify(used));
    await page.locator('#maskList .file-remove').click();
    await page.locator('#maskList .file-remove').waitFor({ state: 'detached' });
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, JSON.stringify(described.inputs));
    assert.ok(!described.pageFiles.some(entry => entry.files.some(file => file.name === 'old-mask.nii.gz')), JSON.stringify(described.pageFiles));
  });

  await check('dcm2niix: editing a setting keeps the files listed, to confirm; Clear empties the list', async context => {
    const { page, call, usePageFiles } = await open(context, 'dcm2niix');
    await page.locator('#imageInput').setInputFiles(dicomSeries());
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent.includes('4 DICOM files'), undefined, { timeout: 60000 });
    await page.locator('#subject').fill('07');
    const described = await call('app_describe');
    assert.deepEqual(described.pageFiles.map(entry => [entry.input, entry.files.length]), [['imageInput', 4]], JSON.stringify(described.pageFiles));
    const confirmed = await usePageFiles('dicom', 'imageInput');
    assert.equal(confirmed.files?.length, 4, JSON.stringify(confirmed));
    await page.locator('#clearButton').click();
    assert.deepEqual((await call('app_describe')).pageFiles, [], 'the cleared examination lists no files');
  });

  await check('DWI2TRX: a drop the app refused stays listed as received, and the person decides before the agent gets it', async context => {
    const { page, call, usePageFiles } = await open(context, 'dwi2trx');
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
    assert.deepEqual(described.pageFiles.map(entry => [entry.input, entry.files.map(file => file.name)]), [['received:drop', ['viewer-drop.nii.gz']]], JSON.stringify(described.pageFiles));
    assert.ok(NO_CURRENT(described.pageFiles), 'the entry does not claim the page shows the drop');
    assert.match(await page.locator('#status').textContent(), /Missing: bval, bvec/, 'the app refused the NIfTI without its gradient files');
    const declined = await usePageFiles('image', 'received:drop', 'Decline');
    assert.deepEqual(declined.listed, ['viewer-drop.nii.gz'], 'the dialog names the refused file');
    assert.equal(declined.declined, true);
    assert.deepEqual((await call('app_describe')).inputs, {});
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
    assert.match(text, /ZARRo reads the addresses under it/);
    assert.match(text, /The server at https:\/\/store\.invalid sees every request/);
    await dialog.getByRole('button', { name: 'Decline' }).click();
    assert.deepEqual(await result(asked), { declined: true, addresses: [store] });
    assert.deepEqual(requests, []);
  });

  await check('NiiMath: a file dropped on the page releases the agent\'s files', async context => {
    const { page, call, usePageFiles } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('agent-exam.nii.gz'));
    await usePageFiles('image', 'niftiInput');
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
    const { page, call, usePageFiles } = await open(context, 'dcm2niix');
    await page.locator('#imageInput').setInputFiles(dicomSeries());
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent.includes('4 DICOM files'), undefined, { timeout: 60000 });
    const described = await call('app_describe');
    assert.equal(described.pageFiles[0]?.files.length, 4, JSON.stringify(described.pageFiles));
    const used = await usePageFiles('dicom', 'imageInput');
    assert.equal(used.files?.length, 4, JSON.stringify(used));
  });

  await check('Brain Extraction: viewers_niivue exports no pixels and fetches only what the person allows', async context => {
    const { page, call, start, result } = await open(context, 'brain-extraction');
    await page.locator('input[type=file][data-neurodesk-input]:not(#neurodesk-input-transfer):not([webkitdirectory])').first().setInputFiles(join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz'));
    await shownVolumes(page, call, 'small.nii.gz');
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
    assert.match(await dialog.textContent(), /It replaces the images the viewer shows now\./, 'load_volume says it replaces what the person sees');
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
    const replacing = await call('viewers_niivue', { viewerId: 'main', method: 'load_mesh', params: { url: `${origin}/test-only/mesh.obj`, replace: true } });
    assert.equal(replacing.error?.code, 'INVALID_INPUT', `load_mesh may not remove the meshes already loaded: ${JSON.stringify(replacing)}`);
    const document = await call('viewers_niivue', { viewerId: 'main', method: 'load_document', params: { url: `${origin}/test-only/scene.nvd` } });
    assert.equal(document.error?.code, 'INVALID_INPUT', 'a document can name further addresses, so it is not offered');
    const scene = await call('viewers_niivue', { viewerId: 'main' });
    assert.ok(!JSON.stringify(scene).includes(`${origin}/test-only`), `no address the agent named reached the viewer: ${JSON.stringify(scene).slice(0, 400)}`);
    await page.waitForTimeout(500);
    assert.deepEqual(downloads, [], 'nothing was saved');
  });

  await check('NiiMath: a run the agent starts on its own scan clears the record of the scan the person picked', async context => {
    const { page, call, usePageFiles } = await open(context, 'niimath');
    await page.locator('#niftiInput').setInputFiles(scan('person-A.nii.gz'));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'person-A.nii.gz');
    await page.evaluate(() => {
      globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'image' })).then(JSON.parse);
    });
    await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').setInputFiles(scan('agent-B.nii.gz'));
    assert.equal((await page.evaluate(() => globalThis.agentHold)).files?.[0].name, 'agent-B.nii.gz');
    const run = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(run.report?.inputs.image[0].filename, 'agent-B.nii.gz', JSON.stringify(run.error));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'agent-B.nii.gz');
    const described = await call('app_describe');
    const listed = described.pageFiles.flatMap(entry => entry.files.map(file => file.name));
    assert.ok(!listed.includes('person-A.nii.gz'), `the page shows agent-B.nii.gz, so person-A.nii.gz is not offered: ${JSON.stringify(described.pageFiles)}`);
    if (described.pageFiles.some(entry => entry.input === 'niftiInput')) {
      const reused = await usePageFiles('image', 'niftiInput', 'Decline');
      assert.equal(reused.declined, true, 'any entry still needs the person');
    } else {
      assert.match((await call('inputs_use_page_files', { role: 'image', input: 'niftiInput' })).error?.message ?? '', /No files are loaded/);
    }
  });

  await check('NiiMath: a press, a drag, a wheel over the viewer and a click in a same-origin frame, navigated or inside a shadow root, each touch the examination; a shadow-root pick ends it', async context => {
    const { page, call, answered } = await open(context, 'niimath');
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'probe-shadow-host';
      host.attachShadow({ mode: 'open' }).innerHTML = '<input id="probe-shadow-file" type="file" data-neurodesk-input="image" aria-label="Shadow image">';
      document.querySelector('main').append(host);
      const frame = document.createElement('iframe');
      frame.id = 'probe-frame';
      frame.srcdoc = '<button id="probe-frame-button">Frame action</button>';
      frame.style.cssText = 'position:fixed;z-index:99999;right:16px;bottom:64px;width:200px;height:80px;background:white';
      document.body.append(frame);
    });
    await page.frameLocator('#probe-frame').locator('#probe-frame-button').waitFor();
    // Each action starts from an examination the person has not touched, in which the agent holds a file.
    const hold = async () => {
      if ((await call('app_describe')).touched) {
        const declined = await answered('run_binarize', { waitSeconds: 0 }, 'Decline');
        assert.equal(declined.declined, true, JSON.stringify(declined));
      }
      await page.evaluate(() => {
        globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'image' })).then(JSON.parse);
      });
      await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').setInputFiles(scan('agent-held.nii.gz'));
      assert.ok((await page.evaluate(() => globalThis.agentHold)).files, 'the agent holds a file');
    };
    const state = async () => {
      const described = await call('app_describe');
      if (!Object.keys(described.inputs).length) return 'ended';
      return described.touched ? 'touched' : 'kept';
    };
    const viewer = await page.locator('canvas').first().boundingBox();
    const centre = { x: viewer.x + viewer.width / 2, y: viewer.y + viewer.height / 2 };
    await hold();
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, 120);
    assert.equal(await state(), 'touched', 'a wheel over the viewer');
    await hold();
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 20, centre.y + 20);
    assert.equal(await state(), 'touched', 'a drag on the viewer, before release');
    await page.mouse.up();
    await hold();
    const heading = await page.locator('#controls .nd-section-title').first().boundingBox();
    await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
    await page.mouse.wheel(0, 120);
    assert.equal(await state(), 'kept', 'a wheel over a sidebar section title scrolls the page and does not count');
    await page.frameLocator('#probe-frame').locator('#probe-frame-button').click();
    assert.equal(await state(), 'touched', 'a click in a same-origin frame');
    await hold();
    await page.evaluate(() => { document.querySelector('#probe-frame').srcdoc = '<button id="probe-frame-button">Navigated</button>'; });
    await page.frameLocator('#probe-frame').getByRole('button', { name: 'Navigated' }).waitFor();
    await page.frameLocator('#probe-frame').getByRole('button', { name: 'Navigated' }).click();
    assert.equal(await state(), 'touched', 'a click in the frame after it navigated');
    await hold();
    await page.evaluate(() => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'open' });
      document.body.append(host);
      const frame = document.createElement('iframe');
      frame.id = 'probe-shadow-frame';
      frame.srcdoc = '<button>Shadow frame action</button>';
      frame.style.cssText = 'position:fixed;z-index:99999;left:16px;bottom:64px;width:200px;height:80px;background:white';
      root.append(frame);
    });
    const shadowFrame = page.frameLocator('#probe-shadow-frame');
    await shadowFrame.getByRole('button', { name: 'Shadow frame action' }).waitFor();
    await shadowFrame.getByRole('button', { name: 'Shadow frame action' }).click();
    assert.equal(await state(), 'touched', 'a click in a frame added later inside an open shadow root');
    await hold();
    const shadowPick = join(scratch, 'shadow-pick.nii.gz');
    await writeFile(shadowPick, scan('shadow-pick.nii.gz').buffer);
    const cdp = await context.newCDPSession(page);
    const { result: shadowInput } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#probe-shadow-host").shadowRoot.querySelector("#probe-shadow-file")' });
    await cdp.send('DOM.setFileInputFiles', { objectId: shadowInput.objectId, files: [shadowPick] });
    assert.equal(await state(), 'ended', 'a pick in a shadow-root input replaces the inputs');
    const described = await call('app_describe');
    assert.deepEqual(described.pageFiles.find(entry => entry.input === 'probe-shadow-file')?.files.map(file => file.name), ['shadow-pick.nii.gz'], `and it is listed: ${JSON.stringify(described.pageFiles)}`);
  });

  await check('NiiMath: after the person browses the agent\'s result, its report and download serve the agent once they allow it, and Decline releases them', async context => {
    const { page, call, answered, dialog } = await open(context, 'niimath');
    const downloads = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    const loaded = await call('inputs_load_example', { exampleId: 't1-head' });
    assert.deepEqual(loaded.inputs?.image?.map(file => file.name), ['T1_head.nii.gz'], JSON.stringify(loaded));
    const run = await call('run_binarize', { waitSeconds: 300 });
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    const viewer = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2);
    await page.mouse.wheel(0, 120);
    await page.mouse.click(viewer.x + viewer.width / 2, viewer.y + viewer.height / 3);
    const described = await call('app_describe');
    assert.equal(described.touched, true);
    assert.deepEqual(described.inputs.image?.map(file => file.name), ['T1_head.nii.gz'], 'the agent still holds the example');
    assert.equal(described.run.report, undefined, 'the report waits for the person');
    assert.equal(described.run.touched, true);
    const allowed = await answered('runs_get', { runId: run.runId }, 'Allow');
    assert.deepEqual(allowed.listed, ['image: T1_head.nii.gz', 'image: T1_head.nii.gz'], 'the dialog names the file the run ran on and the file the agent keeps');
    assert.match(allowed.text, /report and outputs of its binarize run from /, 'and the run by operation and start');
    assert.equal(allowed.report?.runId, run.runId, JSON.stringify(allowed).slice(0, 400));
    const saved = await call('outputs_download', { runId: run.runId, artifactId: 'report' });
    assert.deepEqual(saved, { runId: run.runId, artifactId: 'report' }, 'once allowed, the download asks nothing more');
    for (const deadline = Date.now() + 10000; !downloads.length && Date.now() < deadline;) await page.waitForTimeout(100);
    assert.deepEqual(downloads, ['report.json']);
    await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2);
    await page.mouse.wheel(0, -120);
    const declined = await answered('outputs_download', { runId: run.runId, artifactId: 'report' }, 'Decline');
    assert.equal(declined.declined, true, 'a further interaction asks again, and the person declines');
    assert.equal(await dialog.evaluate(element => element.open), false);
    assert.deepEqual(downloads, ['report.json'], 'nothing more is saved');
    const after = await call('app_describe');
    assert.deepEqual(after.inputs, {});
    assert.equal(after.run.stale, true);
    for (const [name, input] of [['runs_get', { runId: run.runId }], ['outputs_download', { runId: run.runId, artifactId: 'report' }]]) {
      assert.equal((await call(name, input)).error?.code, 'RUN_STALE', name);
    }
  });

  // The agent holds a file the person chose for it in its own dialog, and runs binarize on it.
  async function agentRun(page, call, name = 'agent-scan.nii.gz') {
    await page.evaluate(() => {
      globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'image' })).then(JSON.parse);
    });
    await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').setInputFiles(scan(name));
    assert.ok((await page.evaluate(() => globalThis.agentHold)).files, 'the agent holds a file');
    const run = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    return run;
  }

  // A file dropped through Chrome's own drag and drop at a point of the page.
  async function personDrops(context, page, name, [x, y]) {
    const path = join(scratch, name);
    await writeFile(path, scan(name).buffer);
    const cdp = await context.newCDPSession(page);
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
    await cdp.detach();
  }

  async function centreOf(page, selector) {
    const box = await page.locator(selector).boundingBox();
    return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
  }

  async function sha256(path) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(await readFile(path)).digest('hex');
  }

  await check('NiiMath: a scan dropped on the viewer, which the shell takes at window, ends the examination', async context => {
    const { page, call, dialog } = await open(context, 'niimath');
    const run = await agentRun(page, call);
    await page.locator('#gl').scrollIntoViewIfNeeded();
    const centre = await centreOf(page, '#gl');
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, centre), 'gl', 'the drop lands on the canvas');
    await personDrops(context, page, 'person-canvas.nii.gz', centre);
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'person-canvas.nii.gz');
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, JSON.stringify(described));
    assert.equal(described.run.stale, true);
    for (const [name, input] of [['runs_get', { runId: run.runId }], ['outputs_download', { runId: run.runId, artifactId: 'mask' }]]) {
      assert.equal((await call(name, input)).error?.code, 'RUN_STALE', name);
    }
    assert.equal(await dialog.evaluate(element => element.open), false, 'no dialog offers the earlier run');
  });

  await check('NiiMath: Undo in the status bar, which puts the earlier scan back, ends the examination', async context => {
    const { page, call, usePageFiles, dialog } = await open(context, 'niimath');
    await personPicks(context, page, '#niftiInput', 'person-before.nii.gz');
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'person-before.nii.gz');
    await personDrops(context, page, 'person-after.nii.gz', await centreOf(page, '#statusText'));
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'person-after.nii.gz');
    // Undo is offered for 8 s after the drop; the agent takes the dropped scan in that time.
    const used = await usePageFiles('image', 'niftiInput');
    assert.deepEqual(used.files?.map(file => file.name), ['person-after.nii.gz'], JSON.stringify(used));
    await page.locator('button.nd-status-undo').click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'person-before.nii.gz');
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {}, `the agent no longer holds the scan Undo took away: ${JSON.stringify(described.inputs)}`);
    assert.equal(described.touched, false);
    const rerun = await call('run_binarize', { waitSeconds: 0 });
    assert.match(rerun.error?.message ?? JSON.stringify(rerun), /Missing input: image/);
    assert.equal(await dialog.evaluate(element => element.open), false, 'no dialog offers anything');
  });

  await check('NiiMath: after the person runs their own command, the agent gets only its own run\'s report and bytes, after Allow', async context => {
    const { page, call, answered } = await open(context, 'niimath');
    const run = await agentRun(page, call);
    await page.locator('#command').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('-mul 2');
    await page.locator('#processButton').click();
    await page.waitForFunction(() => !document.querySelector('#processButton').disabled && /ready/i.test(document.querySelector('#statusText').textContent));
    const allowed = await answered('runs_get', { runId: run.runId }, 'Allow');
    assert.deepEqual(allowed.listed, ['image: agent-scan.nii.gz', 'image: agent-scan.nii.gz'], 'the run\'s file, then the file the agent keeps');
    assert.match(allowed.text, /results that run ended with, even if the page shows others now/);
    assert.deepEqual(allowed.report, run.report, 'the report the agent\'s run ended with');
    const download = page.waitForEvent('download');
    assert.deepEqual(await call('outputs_download', { runId: run.runId, artifactId: 'mask' }), { runId: run.runId, artifactId: 'mask' });
    const path = join(scratch, 'downloaded-mask');
    await (await download).saveAs(path);
    assert.equal(await sha256(path), run.report.artifacts.mask.sha256, 'the saved bytes are the run\'s recorded output');
  });

  await check('NiiMath: the resume dialog names the file the run ran on apart from a file the agent took since', async context => {
    const { page, call, answered } = await open(context, 'niimath');
    const run = await agentRun(page, call, 'first-agent.nii.gz');
    await page.evaluate(() => {
      globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'image' })).then(JSON.parse);
    });
    await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').setInputFiles(scan('second-agent.nii.gz'));
    assert.ok((await page.evaluate(() => globalThis.agentHold)).files);
    const [x, y] = await centreOf(page, '#gl');
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    const allowed = await answered('runs_get', { runId: run.runId }, 'Allow');
    assert.deepEqual(allowed.listed, ['image: first-agent.nii.gz', 'image: second-agent.nii.gz'], allowed.text);
    assert.equal(allowed.report.inputs.image[0].filename, 'first-agent.nii.gz', 'the report is of the run the dialog named');
  });

  await check('NiiMath: a report and a download asked for together after one touch share one dialog', async context => {
    const { page, call, start, result, dialog } = await open(context, 'niimath');
    const run = await agentRun(page, call);
    const [x, y] = await centreOf(page, '#gl');
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    await page.evaluate(() => {
      globalThis.dialogsShown = 0;
      const prompt = () => document.querySelector('dialog#neurodeskAgentPrompt');
      let open = false;
      setInterval(() => {
        const now = Boolean(prompt()?.open);
        if (now && !open) globalThis.dialogsShown += 1;
        open = now;
      }, 10);
    });
    const report = await start('runs_get', { runId: run.runId });
    const saved = await start('outputs_download', { runId: run.runId, artifactId: 'report' });
    await dialog.getByRole('button', { name: 'Allow' }).waitFor();
    await page.waitForTimeout(500);
    await dialog.getByRole('button', { name: 'Allow' }).click();
    assert.equal((await result(report)).report?.runId, run.runId);
    assert.deepEqual(await result(saved), { runId: run.runId, artifactId: 'report' });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => globalThis.dialogsShown), 1, 'one dialog for one touch');
    assert.equal(await dialog.evaluate(element => element.open), false);
  });

  await check('NeSVoR: a stack the person removes leaves pageFiles, and the agent\'s own stack waits for the dialog', async context => {
    const { page, call, answered } = await open(context, 'nesvor');
    await personPicks(context, page, '#imageInput', 'person-stack.nii.gz');
    const remove = page.getByRole('button', { name: 'Remove person-stack.nii.gz', exact: true });
    await remove.waitFor({ timeout: 60000 });
    assert.deepEqual((await call('app_describe')).pageFiles.map(entry => entry.files.map(file => file.name)), [['person-stack.nii.gz']]);
    await page.evaluate(() => {
      globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'stacks' })).then(JSON.parse);
    });
    await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').first().setInputFiles(scan('agent-stack.nii.gz'));
    assert.ok((await page.evaluate(() => globalThis.agentHold)).files);
    await remove.click();
    await remove.waitFor({ state: 'detached' });
    const described = await call('app_describe');
    assert.deepEqual(described.pageFiles, [], `the removed stack is not listed: ${JSON.stringify(described.pageFiles)}`);
    assert.deepEqual(described.inputs, {}, 'the removal the app reports after the press ends the examination');
  });

  await check('a same-origin frame is watched from its new document on, before it loads', async context => {
    let releaseImage;
    let imageRequested;
    const requested = new Promise(resolve => { imageRequested = resolve; });
    const released = new Promise(resolve => { releaseImage = resolve; });
    // The page is cross-origin isolated, so its frame's document must embed under the same policy.
    const isolated = { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
    await context.route('**/frame-probe-content', route => route.fulfill({ contentType: 'text/html', headers: isolated, body: '<button>Use frame</button><img src="/frame-probe-image">' }));
    await context.route('**/frame-probe-image', async route => {
      imageRequested();
      await released;
      await route.fulfill({ status: 404, headers: isolated, body: '' });
    });
    const { page, call, answered } = await open(context, 'niimath');
    try {
      await page.evaluate(() => {
        globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'image' })).then(JSON.parse);
      });
      await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').setInputFiles(scan('held.nii.gz'));
      assert.ok((await page.evaluate(() => globalThis.agentHold)).files);
      await page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.id = 'probe-load-frame';
        frame.style.cssText = 'position:fixed;bottom:60px;left:0;z-index:99999;background:white';
        frame.srcdoc = '<button>Initial frame</button>';
        frame.addEventListener('load', () => { frame.dataset.loaded = 'yes'; });
        document.body.append(frame);
      });
      await page.waitForFunction(() => document.querySelector('#probe-load-frame').dataset.loaded === 'yes');
      await page.evaluate(() => {
        const frame = document.querySelector('#probe-load-frame');
        delete frame.dataset.loaded;
        // srcdoc wins over src, so it goes first.
        frame.removeAttribute('srcdoc');
        frame.src = '/frame-probe-content';
      });
      await requested;
      assert.equal((await call('app_describe')).touched, true, 'the navigation itself touches the examination');
      const allowed = await answered('run_binarize', { waitSeconds: 60 }, 'Allow');
      assert.equal(allowed.state, 'succeeded', JSON.stringify(allowed).slice(0, 300));
      assert.equal((await call('app_describe')).touched, false);
      await page.frameLocator('#probe-load-frame').getByRole('button', { name: 'Use frame' }).click();
      assert.equal(await page.locator('#probe-load-frame').getAttribute('data-loaded'), null, 'the frame has not loaded');
      assert.equal((await call('app_describe')).touched, true, 'a click in the new document before it loads');
    } finally {
      releaseImage();
    }
  });

  await check('NiiMath: after the person opens their own file over the agent\'s, nothing can be resumed', async context => {
    const { page, call, dialog } = await open(context, 'niimath');
    await page.evaluate(() => {
      globalThis.agentHold = document.modelContext.getTools().then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role: 'image' })).then(JSON.parse);
    });
    await page.locator('dialog#neurodeskAgentPrompt input[type="file"]:not([webkitdirectory])').setInputFiles(scan('agent-scan.nii.gz'));
    assert.ok((await page.evaluate(() => globalThis.agentHold)).files);
    const run = await call('run_binarize', { waitSeconds: 120 });
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    await personPicks(context, page, '#niftiInput', 'person-scan.nii.gz');
    await page.waitForFunction(() => document.querySelector('#fileInfo')?.textContent === 'person-scan.nii.gz');
    const described = await call('app_describe');
    assert.deepEqual(described.inputs, {});
    assert.equal(described.touched, false);
    assert.equal(described.run.stale, true);
    for (const [name, input] of [['runs_get', { runId: run.runId }], ['outputs_download', { runId: run.runId, artifactId: 'report' }], ['runs_cancel', { runId: run.runId }]]) {
      assert.equal((await call(name, input)).error?.code, 'RUN_STALE', name);
    }
    assert.equal(await dialog.evaluate(element => element.open), false, 'no dialog offers to resume');
  });

  await check('ZARRo: the consent names the store root the app reads under, not the metadata file the agent named', async context => {
    const { page, start, result } = await open(context, 'zarro');
    const requests = [];
    await context.route('https://store.invalid/**', route => {
      requests.push(route.request().url());
      return route.abort();
    });
    const root = 'https://store.invalid/review/store.ome.zarr';
    const dialog = page.locator('dialog#neurodeskAgentPrompt');
    const declined = await start('run_open_url', { inputs: { store: { url: `${root}/.zattrs` } }, waitSeconds: 1 });
    await dialog.getByRole('button', { name: 'Decline' }).waitFor();
    assert.deepEqual(await dialog.locator('li').allTextContents(), [root], 'the dialog names the root');
    assert.match(await dialog.textContent(), /Let ZARRo read the data stored under this address\?/);
    await dialog.getByRole('button', { name: 'Decline' }).click();
    assert.deepEqual(await result(declined), { declined: true, addresses: [root] });
    assert.deepEqual(requests, [], 'a declined store is never read');
    const allowed = await start('run_open_url', { inputs: { store: { url: `${root}/.zattrs` } }, waitSeconds: 20 });
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await result(allowed);
    assert.ok(requests.length > 0, 'the allowed store is read');
    assert.deepEqual(requests.filter(url => !url.startsWith(`${root}/`)), [], `every read stays under the root the person allowed: ${JSON.stringify(requests)}`);
  });

  await check('ZARRo: a store the agent opened is read only under its root, and a redirect to another server is never followed', async context => {
    const { page, start, result } = await open(context, 'zarro');
    const elsewhere = await remoteHost((request, response) => response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'));
    const store = await remoteHost((request, response) => response.writeHead(302, { location: `${elsewhere.origin}/synthetic-metadata.json` }).end());
    try {
      const root = `${store.origin}/review/fixture.ome.zarr`;
      const dialog = page.locator('dialog#neurodeskAgentPrompt');
      const opened = await start('run_open_url', { inputs: { store: { url: `${root}/.zattrs` } }, waitSeconds: 60 });
      await dialog.getByRole('button', { name: 'Allow' }).waitFor();
      assert.deepEqual(await dialog.locator('li').allTextContents(), [root]);
      await dialog.getByRole('button', { name: 'Allow' }).click();
      const run = await result(opened);
      assert.equal(run.state, 'failed', JSON.stringify(run));
      assert.ok(store.requests.length > 0, 'the allowed store was asked');
      assert.deepEqual(store.requests.filter(url => !url.startsWith('/review/fixture.ome.zarr')), [], `every read stayed under the root: ${JSON.stringify(store.requests)}`);
      assert.deepEqual(elsewhere.requests, [], 'no request reached the server the store redirects to');
      // The person loads the same store by hand in the same tab: the agent's confinement is not theirs.
      const before = store.requests.length;
      await page.locator('#source').selectOption('custom');
      await page.locator('#zarrUrl').fill(root);
      await page.locator('#reload').click();
      for (const deadline = Date.now() + 15000; !elsewhere.requests.length && Date.now() < deadline;) await page.waitForTimeout(100);
      assert.ok(store.requests.length > before, 'the person\'s load asked the store');
      assert.ok(elsewhere.requests.length > 0, `the person's own load follows the redirect as a browser does: ${JSON.stringify(elsewhere.requests)}`);
    } finally {
      await store.close();
      await elsewhere.close();
    }
  });

  await check('Brain Extraction: set_volume refuses v1 and unknown parameters, load_signal is not offered, and a fetch answered after the person used the page loads nothing', async context => {
    const { page, call, start, result } = await open(context, 'brain-extraction');
    await page.locator('input[type=file][data-neurodesk-input]:not(#neurodesk-input-transfer):not([webkitdirectory])').first().setInputFiles(join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz'));
    await shownVolumes(page, call, 'small.nii.gz');
    const before = await call('viewers_volumes', { viewerId: 'main' });
    for (const params of [{ volume: 0, v1: true }, { volume: 0, v1: { flip: [true, false, false] } }, { volume: 0, unknown_display: 1 }]) {
      const refused = await call('viewers_niivue', { viewerId: 'main', method: 'set_volume', params });
      assert.equal(refused.error?.code, 'INVALID_INPUT', JSON.stringify(refused));
    }
    assert.deepEqual(await call('viewers_volumes', { viewerId: 'main' }), before, 'the volume is unchanged');
    const offered = await page.evaluate(async () => (await document.modelContext.getTools()).find(tool => tool.name === 'viewers_niivue').inputSchema);
    assert.ok(!JSON.parse(typeof offered === 'string' ? offered : JSON.stringify(offered)).properties.method.enum.includes('load_signal'), 'load_signal is not offered');
    const signal = await call('viewers_niivue', { viewerId: 'main', method: 'load_signal', params: { url: `${origin}/test-only/trace.tsv` } });
    assert.equal(signal.error?.code, 'INVALID_INPUT', JSON.stringify(signal));

    const url = `${origin}/test-only/late-fixture.nii.gz`;
    const arrived = Promise.withResolvers();
    const answer = Promise.withResolvers();
    await context.route(url, async route => {
      arrived.resolve();
      await answer.promise;
      return route.fulfill({ path: join(repoRoot, 'exes/synthseg/test/fixtures/small.nii.gz') });
    });
    const shown = (await call('viewers_volumes', { viewerId: 'main' })).volumes.map(volume => volume.name);
    const dialog = page.locator('dialog#neurodeskAgentPrompt');
    const late = await start('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } });
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await arrived.promise;
    await page.locator('canvas').first().click({ position: { x: 20, y: 20 } });
    answer.resolve();
    assert.equal((await result(late)).error?.code, 'EXAMINATION_CHANGED');
    assert.deepEqual((await call('viewers_volumes', { viewerId: 'main' })).volumes.map(volume => volume.name), shown, 'the viewer still shows what it showed');
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
