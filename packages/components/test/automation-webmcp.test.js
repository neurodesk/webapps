import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as z from 'zod/v4';
import { registerAppAutomation } from '../src/automation/index.js';
import { operationParametersSchema } from '../src/automation/parameters.js';
import { registerWebMcpTools, webMcpTools } from '../src/automation/webmcp.js';

const appsDir = new URL('../../../apps/', import.meta.url);
const contract = () => ({ schemaVersion: 2, app: 'test', title: 'Test', description: 'Segments a test image.', appVersion: '0.1.20260928', defaultOperation: 'run', operations: {
  run: { title: 'Run', description: 'Segment the image.', mode: 'batch',
    inputs: { image: { source: 'files', type: 'neuro:volume', formats: ['nifti'], description: 'One head image', minimum: 1, maximum: 1 } },
    parameters: { threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 }, method: { type: 'string', enum: ['a', 'b'], default: 'a' } },
    artifacts: { labels: { type: 'neuro:label-map', mediaType: 'application/x-nifti', minimum: 1, maximum: 1 } }, engines: ['browser'] },
} });
const examples = [
  { id: 'head', label: 'Head', description: 'A head.', expectedResult: 'Labels.', files: [{ role: 'image', name: 'head.nii', url: 'https://example.test/head.nii', sha256: 'a'.repeat(64), bytes: 4 }] },
  { id: 'other', label: 'Other', description: 'Wrong role.', expectedResult: 'None.', files: [{ role: 'scan', name: 'scan.nii', url: 'https://example.test/scan.nii' }] },
];

function page(t, operation, options = {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const downloads = [];
  const { dispatch } = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: operation },
    document: dom.window.document, target: dom.window, download: file => downloads.push(file) });
  const transfer = dom.window.document.getElementById('neurodesk-input-transfer');
  const held = {};
  const inputs = {
    held: () => held,
    async adopt(role, files) {
      Object.defineProperty(transfer, 'files', { configurable: true, value: files });
      await dispatch('adopt', { role });
      held[role] = files.map(file => ({ name: file.name, bytes: file.size }));
    },
  };
  const tools = webMcpTools({ contract: contract(), dispatch, inputs, examples: () => examples, ...options });
  const call = (name, input = {}, signal = new AbortController().signal) => tools.find(tool => tool.name === name).execute(input, { signal });
  return { tools, call, dispatch, downloads, inputs };
}

const labels = () => ({ artifacts: [{ role: 'labels', file: new File(['labels'], 'labels.nii') }] });

function samples(field) {
  const values = [null, 'text', true, 7, -1e9, 1e9, [], [1], [1, 2, 3], 0.5, 0.25];
  if (field.default !== undefined) values.push(field.default);
  if (field.enum) values.push(...field.enum);
  if (field.items?.enum) values.push(field.items.enum.slice(0, 1), [field.items.enum[0], 999]);
  for (const bound of [field.minimum, field.maximum]) if (typeof bound === 'number') values.push(bound, bound - 1, bound + 1, bound - 0.5);
  return values;
}

test('every app contract builds spec-valid tools whose run schemas accept what the contract accepts', async () => {
  const apps = (await readdir(appsDir)).sort();
  assert.ok(apps.length >= 60);
  for (const app of apps) {
    const appContract = JSON.parse(await readFile(new URL(`${app}/automation.json`, appsDir), 'utf8'));
    const tools = webMcpTools({ contract: appContract, dispatch: async () => ({}), inputs: { held: () => ({}), adopt() {} } });
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length, `${app}: tool names are unique`);
    for (const tool of tools) {
      assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/, `${app}: ${tool.name} is a valid WebMCP name`);
      assert.ok(tool.description.length > 0, `${app}: ${tool.name} has a description`);
      assert.equal(typeof tool.execute, 'function');
      assert.doesNotThrow(() => z.fromJSONSchema(tool.inputSchema), `${app}: ${tool.name} has a valid JSON Schema`);
      JSON.stringify(tool.inputSchema);
    }
    for (const [name, operation] of Object.entries(appContract.operations)) {
      const run = tools.find(tool => tool.name === `run_${name.replaceAll('-', '_')}`);
      assert.ok(run, `${app}: ${name} has a run tool`);
      const json = z.fromJSONSchema(run.inputSchema.properties.parameters);
      const contractSchema = operationParametersSchema(operation.parameters);
      assert.equal(json.safeParse({}).success, true, `${app}: ${name} runs with every parameter left out`);
      assert.equal(json.safeParse({ unknownParameter: 1 }).success, false, `${app}: ${name} refuses unknown parameters`);
      for (const [key, field] of Object.entries(operation.parameters)) {
        for (const value of samples(field)) {
          if (value === null) continue;
          assert.equal(json.safeParse({ [key]: value }).success, contractSchema.safeParse({ [key]: value }).success,
            `${app}: ${name}.${key} = ${JSON.stringify(value)} is judged as the contract judges it`);
        }
      }
    }
  }
});

test('a run tool starts the operation, waits for it and returns the report', async t => {
  const { call } = page(t, async ({ parameters }) => {
    assert.deepEqual(parameters, { threshold: 0.5, method: 'b' });
    await new Promise(resolve => setTimeout(resolve, 30));
    return labels();
  });
  assert.equal((await call('run_run', { parameters: { method: 'b' } })).error.message, 'Missing input: image');
  const { call: callWithFiles, inputs } = page(t, async () => labels(), { requestFiles: async () => [new File(['input'], 'input.nii')] });
  assert.deepEqual(await callWithFiles('inputs_request_files', { role: 'image' }), { role: 'image', files: [{ name: 'input.nii', bytes: 5 }] });
  assert.deepEqual(inputs.held(), { image: [{ name: 'input.nii', bytes: 5 }] });
  const run = await callWithFiles('run_run', { parameters: { method: 'b' } });
  assert.equal(run.state, 'succeeded');
  assert.equal(run.report.artifacts.labels.filename, 'labels.nii');
  assert.equal(run.report.inputs.image[0].filename, 'input.nii');
});

test('a run that outlasts waitSeconds returns running, and runs_get waits for the rest', async t => {
  let finish;
  const { call, inputs } = page(t, () => new Promise(resolve => { finish = () => resolve(labels()); }));
  await inputs.adopt('image', [new File(['input'], 'input.nii')]);
  const started = Date.now();
  const running = await call('run_run', { waitSeconds: 0.1 });
  assert.equal(running.state, 'running');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await call('runs_get', { runId: 'another' }), { error: { message: 'Unknown run: another' } });
  setTimeout(() => finish(), 50);
  const done = await call('runs_get', { runId: running.runId, waitSeconds: 5 });
  assert.equal(done.state, 'succeeded');
  assert.equal(done.runId, running.runId);
});

test('aborting a run tool call cancels the run, and runs_cancel cancels a running one', async t => {
  let operationSignal;
  const { call, inputs } = page(t, ({ signal }) => {
    operationSignal = signal;
    return new Promise(() => {});
  });
  await inputs.adopt('image', [new File(['input'], 'input.nii')]);
  const controller = new AbortController();
  const pending = call('run_run', { waitSeconds: 60 }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const cancelled = await pending;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(operationSignal.aborted, true);
  await inputs.adopt('image', [new File(['input'], 'input.nii')]);
  const running = await call('run_run', { waitSeconds: 0 });
  assert.equal(running.state, 'running');
  const result = await call('runs_cancel', { runId: running.runId });
  assert.equal(result.cancelled, true);
  assert.equal(result.run.state, 'cancelled');
});

test('user_ask returns the injected answer or the dismissal and passes the call signal', async t => {
  const asked = [];
  const answers = [{ answer: 'T2' }, { dismissed: true }];
  const { call } = page(t, async () => labels(), { askUser: async (request, { signal }) => {
    asked.push({ ...request, signal });
    return answers.shift();
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await call('user_ask', { question: 'Which?', options: ['T1', 'T2'] }, signal), { answer: 'T2' });
  assert.deepEqual(await call('user_ask', { question: 'Why?' }), { dismissed: true });
  assert.deepEqual(asked[0], { question: 'Which?', options: ['T1', 'T2'], allowText: undefined, signal });
});

test('inputs_request_files tells the prompt the role and returns declined when the user declines', async t => {
  const requests = [];
  const { call, inputs } = page(t, async () => labels(), { requestFiles: async request => {
    requests.push(request);
    return null;
  } });
  assert.deepEqual(await call('inputs_request_files', { role: 'image', message: 'Your T1, please.' }), { declined: true });
  assert.deepEqual(requests, [{ label: 'One head image', formats: ['nifti'], message: 'Your T1, please.', minimum: 1, maximum: 1, folder: false }]);
  assert.deepEqual(inputs.held(), {});
  assert.equal((await call('inputs_request_files', { role: 'mask' })).error.message, 'Unknown file input role: mask');
});

test('inputs_load_example verifies each file through the fetcher and holds it for its role', async t => {
  const fetched = [];
  const { call, tools } = page(t, async ({ inputs: files }) => {
    assert.equal(await files.image[0].text(), 'head');
    return labels();
  }, { fetchAsset: async (asset, options) => {
    fetched.push({ asset, retries: options.retries });
    return new TextEncoder().encode('head').buffer;
  } });
  const describe = await call('app_describe');
  assert.deepEqual(describe.examples.map(example => example.id), ['head'], 'an example whose roles the contract lacks is not offered');
  assert.equal(describe.operations.run.tool, 'run_run');
  assert.equal(describe.run.state, 'idle');
  assert.deepEqual(describe.viewers, []);
  assert.deepEqual(await call('inputs_load_example', { exampleId: 'head' }), { exampleId: 'head', inputs: { image: [{ name: 'head.nii', bytes: 4 }] } });
  assert.deepEqual(fetched, [{ asset: { url: 'https://example.test/head.nii', integrity: { bytes: 4, sha256: 'a'.repeat(64) } }, retries: 4 }]);
  assert.match((await call('inputs_load_example', { exampleId: 'other' })).error.message, /unloadable example/);
  assert.equal((await call('run_run')).state, 'succeeded');
  assert.equal((await call('viewers_state', { viewerId: 'main' })).error.message, 'Unknown viewer: main');
  assert.deepEqual(await call('viewers_list'), { viewers: [] });
  const annotations = Object.fromEntries(tools.map(tool => [tool.name, tool.annotations]));
  assert.equal(annotations.app_describe.readOnlyHint, true);
  assert.equal(annotations.user_ask.untrustedContentHint, true);
  assert.equal(annotations.run_run.readOnlyHint, undefined);
});

test('outputs_download saves a completed artifact through the page download', async t => {
  const { call, inputs, downloads } = page(t, async () => labels());
  await inputs.adopt('image', [new File(['input'], 'input.nii')]);
  assert.equal((await call('run_run')).state, 'succeeded');
  assert.deepEqual(await call('outputs_download', { artifactId: 'labels' }), { artifactId: 'labels' });
  assert.deepEqual(downloads.map(file => file.name), ['labels.nii']);
});

test('registration survives a refused tool and the registration signal unregisters the rest', async t => {
  const registered = new Map();
  const modelContext = {
    async registerTool(tool, { signal }) {
      if (tool.name === 'user_ask') throw new DOMException('Duplicate', 'InvalidStateError');
      registered.set(tool.name, tool);
      signal.addEventListener('abort', () => registered.delete(tool.name));
    },
  };
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const { tools } = page(t, async () => labels());
  const controller = new AbortController();
  const result = await registerWebMcpTools(modelContext, tools, { signal: controller.signal });
  assert.deepEqual(result, { registered: tools.length - 1, failed: ['user_ask'] });
  assert.equal(registered.size, tools.length - 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /user_ask/);
  controller.abort();
  assert.equal(registered.size, 0);
});

test('a page whose browser exposes a model context registers the tools and answers them through its own dialogs', async t => {
  const dom = new JSDOM('<body><nd-example-selector></nd-example-selector></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
  document.querySelector('nd-example-selector').examples = examples;
  const registered = new Map();
  document.modelContext = { async registerTool(tool) { registered.set(tool.name, tool); } };
  registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() }, document, target: dom.window });
  while (!registered.has('viewers_niivue')) await new Promise(resolve => setTimeout(resolve, 5));
  const call = (name, input = {}) => registered.get(name).execute(input, { signal: new AbortController().signal });
  assert.deepEqual((await call('app_describe')).examples.map(example => example.id), ['head'], 'the page\'s example selector supplies the examples');
  const request = call('inputs_request_files', { role: 'image' });
  let field;
  while (!(field = document.querySelector('#neurodeskAgentPrompt nd-file-field'))) await new Promise(resolve => setTimeout(resolve, 5));
  Object.defineProperty(field.input, 'files', { configurable: true, value: [new File(['input'], 'input.nii')] });
  field.input.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(await request, { role: 'image', files: [{ name: 'input.nii', bytes: 5 }] });
  assert.deepEqual((await call('app_describe')).inputs, { image: [{ name: 'input.nii', bytes: 5 }] });
  const run = await call('run_run');
  assert.equal(run.state, 'succeeded');
  assert.equal(run.report.inputs.image[0].filename, 'input.nii');
  assert.deepEqual((await call('app_describe')).inputs, {}, 'a run uses up the held files');
});

test('a page without a model context registers nothing', async t => {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const registration = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() }, document: dom.window.document, target: dom.window });
  await registration.ready;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.document.getElementById('neurodeskAgentPrompt'), null);
});
