// Serves the built Brain Extraction app at its hosted address in Chromium, gives the page a stand-in
// document.modelContext that records the tools the app registers (no browser ships WebMCP without an
// origin trial or flag), and drives a whole analysis through those tools the way a browser agent would.
// The person's side goes through the real dialogs: a button press and the real file chooser.
//   pnpm --filter brain-extraction build && pnpm --filter @neurodesk/agent-server validate:webmcp
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../../..');
const dist = join(root, 'apps/brain-extraction/dist');
const fixture = join(root, 'exes/synthseg/test/fixtures/small.nii.gz');
const origin = 'https://webapps.neurodesk.org';
const shots = process.env.WEBMCP_SHOTS;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
assert.ok(existsSync(join(dist, 'index.html')), 'Build Brain Extraction first: pnpm --filter brain-extraction build');

function standInModelContext() {
  const tools = new Map();
  const modelContext = {
    async registerTool(tool, { signal } = {}) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || !tool.description) throw new DOMException(`Invalid tool: ${tool.name}`, 'InvalidStateError');
      if (tools.has(tool.name)) throw new DOMException(`Duplicate tool: ${tool.name}`, 'InvalidStateError');
      tools.set(tool.name, tool);
      signal?.addEventListener('abort', () => tools.delete(tool.name));
    },
  };
  Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get: () => modelContext });
  const pending = new Map();
  window.webMcpStandIn = {
    names: () => [...tools.keys()],
    tool: name => {
      const { title, description, inputSchema, annotations } = tools.get(name);
      return { title, description, inputSchema, annotations };
    },
    start(id, name, input) {
      const controller = new AbortController();
      pending.set(id, Promise.resolve(tools.get(name).execute(input, { signal: controller.signal })).then(value => JSON.stringify(value)));
    },
    finish: id => pending.get(id),
  };
}

const browser = await chromium.launch();
const log = [];
try {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await context.addInitScript(standInModelContext);
  await context.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/brain-extraction/')) return route.abort();
    const path = join(dist, url.pathname.slice('/brain-extraction/'.length) || 'index.html');
    if (!existsSync(path)) return route.fulfill({ status: 404 });
    await route.fulfill({
      body: await readFile(path),
      contentType: types[extname(path)] ?? 'application/octet-stream',
      headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' },
    });
  });
  const page = await context.newPage();
  page.on('pageerror', error => log.push(`pageerror: ${error.message}`));
  await page.goto(`${origin}/brain-extraction/`);
  await page.waitForFunction(() => window.webMcpStandIn.names().includes('viewers_niivue'), null, { timeout: 30000 });
  const names = await page.evaluate(() => window.webMcpStandIn.names());
  log.push(`registered ${names.length} tools: ${names.join(', ')}`);
  let calls = 0;
  const start = async (name, input = {}) => {
    const id = ++calls;
    await page.evaluate(([id, name, input]) => window.webMcpStandIn.start(id, name, input), [id, name, input]);
    return async () => JSON.parse(await page.evaluate(id => window.webMcpStandIn.finish(id), id));
  };
  const call = async (name, input) => (await start(name, input))();

  const describe = await call('app_describe');
  assert.equal(describe.app, 'brain-extraction');
  assert.equal(describe.operations.extract.tool, 'run_extract');
  assert.ok(describe.examples.some(example => example.id === 't1-head'), 'the page\'s examples are offered');
  const runSchema = await page.evaluate(() => window.webMcpStandIn.tool('run_extract').inputSchema);
  assert.deepEqual(runSchema.properties.parameters.properties.method.enum, ['mindgrab', 'bet', 'synthstrip']);
  log.push(`app_describe: ${describe.title}, ${Object.keys(describe.operations).length} operation(s), examples ${describe.examples.map(example => example.id).join(', ')}`);

  const loaded = await call('inputs_load_example', { exampleId: 't1-head' });
  assert.deepEqual(loaded.inputs.image, [{ name: 'T1_head.nii.gz', bytes: 5176902 }], JSON.stringify(loaded));
  log.push(`inputs_load_example: ${JSON.stringify(loaded.inputs)}`);

  const started = Date.now();
  const run = await call('run_extract', { parameters: { method: 'bet' }, waitSeconds: 300 });
  assert.equal(run.state, 'succeeded', JSON.stringify(run.error ?? run));
  assert.equal(run.report.parameters.method, 'bet');
  assert.deepEqual(Object.keys(run.report.artifacts).sort(), ['brain', 'mask']);
  log.push(`run_extract (bet): ${run.state} in ${((Date.now() - started) / 1000).toFixed(1)} s; artifacts ${Object.values(run.report.artifacts).map(artifact => artifact.filename).join(', ')}`);

  const { viewers } = await call('viewers_list');
  assert.ok(viewers.length > 0, 'a viewer is registered');
  const { volumes } = await call('viewers_volumes', { viewerId: viewers[0].id });
  assert.ok(volumes.some(volume => volume.name === run.report.artifacts.brain.filename && volume.visible), `the viewer shows the result: ${JSON.stringify(volumes)}`);
  const display = await call('viewers_display', { viewerId: viewers[0].id, sliceType: 'axial' });
  assert.equal(display.sliceType, 'axial', JSON.stringify(display));
  log.push(`viewers: ${viewers.map(viewer => viewer.id).join(', ')}; volumes ${volumes.map(volume => volume.name).join(', ')}; display set to ${display.sliceType}`);

  const question = await start('user_ask', { question: 'Keep the BET result?', options: ['Keep', 'Discard'] });
  const dialog = page.locator('dialog#neurodeskAgentPrompt');
  await dialog.getByRole('button', { name: 'Keep' }).waitFor();
  assert.match(await dialog.textContent(), /AI agent you started/);
  if (shots) await page.screenshot({ path: join(shots, 'webmcp-question.png') });
  await dialog.getByRole('button', { name: 'Keep' }).click();
  assert.deepEqual(await question(), { answer: 'Keep' });
  assert.equal(await dialog.evaluate(element => element.open), false, 'the dialog closes after an answer');
  const dismissed = await start('user_ask', { question: 'Anything else?' });
  await dialog.locator('textarea').waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(await dismissed(), { dismissed: true });
  log.push('user_ask: answered Keep by clicking the dialog; Escape dismissed a second question');

  const request = await start('inputs_request_files', { role: 'image', message: 'Choose a head image to extract.' });
  await dialog.getByLabel('Choose files').waitFor();
  if (shots) await page.screenshot({ path: join(shots, 'webmcp-files.png') });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByLabel('Choose files').click();
  await (await chooser).setFiles(fixture);
  const requested = await request();
  assert.equal(requested.role, 'image', JSON.stringify(requested));
  assert.equal(requested.files[0].name, 'small.nii.gz');
  assert.deepEqual((await call('app_describe')).inputs.image, requested.files);
  log.push(`inputs_request_files: the file chooser gave ${JSON.stringify(requested.files)}`);

  const second = await call('run_extract', { parameters: { method: 'bet' }, waitSeconds: 300 });
  assert.equal(second.state, 'succeeded', JSON.stringify(second.error ?? second));
  assert.equal(second.report.inputs.image[0].filename, 'small.nii.gz');
  log.push(`run_extract on the chosen file: ${second.state}`);

  const download = page.waitForEvent('download');
  assert.deepEqual(await call('outputs_download', { artifactId: 'mask' }), { artifactId: 'mask' });
  const saved = await download;
  assert.equal(saved.suggestedFilename(), second.report.artifacts.mask.filename);
  log.push(`outputs_download: the browser saved ${saved.suggestedFilename()}`);
  assert.deepEqual(log.filter(line => line.startsWith('pageerror')), []);
} finally {
  await browser.close();
  console.log(log.join('\n'));
}
