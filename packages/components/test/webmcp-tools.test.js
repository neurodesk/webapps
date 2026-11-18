import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as z from 'zod/v4';
import { registerAppAutomation } from '../src/automation/index.js';
import { operationParametersSchema } from '../src/automation/parameters.js';
import { registerWebMcpTools, webMcpTools } from '../src/webmcp/tools.js';
import { exposeWebMcp } from '../src/webmcp/page.js';
import { createToolInputs } from '../src/webmcp/tool-inputs.js';
import { schemaIssues, unsupportedKeywords } from '../src/webmcp/schema.js';
import { NIIVUE_METHODS } from '../src/webmcp/niivue-methods.js';
import { coreHandlers } from '@niivue/nv-mcp/browser';

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
  { id: 'mapped', label: 'Mapped', description: 'Its own role names.', expectedResult: 'Labels.', parameters: { threshold: 0.2, pageOnly: true },
    automation: { roles: { scan: 'image', notes: null }, reason: 'The notes are for people.', parameters: { method: 'b' } },
    files: [{ role: 'scan', name: 'scan.nii', url: 'https://example.test/scan.nii', bytes: 4 }, { role: 'notes', name: 'notes.txt', url: 'https://example.test/notes.txt' }] },
  { id: 'remote', label: 'Remote', description: 'On a server.', expectedResult: 'None.', automation: { unavailable: 'Its data stay on the compute server.' }, files: [{ role: 'image', name: 'x.nii', url: 'https://example.test/x.nii' }] },
];

function page(t, operation, options = {}) {
  const dom = new JSDOM('<body><input type="file" id="t1" data-neurodesk-input="image" aria-label="T1 image"></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const downloads = [];
  const registration = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: operation },
    document: dom.window.document, target: dom.window, download: file => downloads.push(file) });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation });
  const tools = webMcpTools({ contract: contract(), dispatch: automation.dispatch, inputs, examples: () => examples, ...options });
  const call = (name, input = {}, signal = new AbortController().signal) => tools.find(tool => tool.name === name).execute(input, { signal });
  return { tools, call, dispatch: automation.dispatch, downloads, inputs, registration, window: dom.window };
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
    const tools = webMcpTools({ contract: appContract, dispatch: async () => ({}), inputs: {} });
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length, `${app}: tool names are unique`);
    for (const tool of tools) {
      assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/, `${app}: ${tool.name} is a valid WebMCP name`);
      assert.ok(tool.description.length > 0, `${app}: ${tool.name} has a description`);
      assert.equal(typeof tool.execute, 'function');
      assert.doesNotThrow(() => z.fromJSONSchema(tool.inputSchema), `${app}: ${tool.name} has a valid JSON Schema`);
      assert.deepEqual(unsupportedKeywords(tool.inputSchema), [], `${app}: ${tool.name} uses only keywords the input check enforces`);
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
          const accepted = contractSchema.safeParse({ [key]: value }).success;
          assert.equal(json.safeParse({ [key]: value }).success, accepted,
            `${app}: ${name}.${key} = ${JSON.stringify(value)} is judged as the contract judges it`);
          assert.equal(schemaIssues(run.inputSchema, { parameters: { [key]: value } }).length === 0, accepted,
            `${app}: ${name}.${key} = ${JSON.stringify(value)} passes the tools' own input check as the contract judges it`);
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
  await inputs.hold('image', [new File(['input'], 'input.nii')]);
  const started = Date.now();
  const running = await call('run_run', { waitSeconds: 0.1 });
  assert.equal(running.state, 'running');
  assert.ok(Date.now() - started < 1000);
  assert.equal((await call('runs_get', { runId: 'another' })).error.code, 'UNKNOWN_RUN');
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
  await inputs.hold('image', [new File(['input'], 'input.nii')]);
  const controller = new AbortController();
  const pending = call('run_run', { waitSeconds: 60 }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const cancelled = await pending;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(operationSignal.aborted, true);
  await inputs.hold('image', [new File(['input'], 'input.nii')]);
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
  assert.equal((await call('inputs_request_files', { role: 'mask' })).error.code, 'INVALID_INPUT');
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
  assert.deepEqual(describe.examples.map(example => example.id), ['head', 'mapped'], 'an example whose roles the contract lacks is not offered');
  assert.deepEqual(describe.examples[1].roles, ['image']);
  assert.equal(describe.examples[1].omitted, 'The notes are for people.');
  assert.deepEqual(describe.examples[1].parameters, { threshold: 0.2, method: 'b' }, 'the run parameters an example needs, without the page-only ones');
  assert.equal(describe.examples[0].parameters, undefined);
  assert.deepEqual(describe.unavailableExamples, [
    { id: 'other', label: 'Other', reason: 'Its scan file scan.nii matches no input of this application.' },
    { id: 'remote', label: 'Remote', reason: 'Its data stay on the compute server.' },
  ]);
  assert.equal(describe.operations.run.tool, 'run_run');
  assert.equal(describe.run.state, 'idle');
  assert.deepEqual(describe.viewers, []);
  assert.deepEqual(await call('inputs_load_example', { exampleId: 'head' }), { exampleId: 'head', inputs: { image: [{ name: 'head.nii', bytes: 4 }] } });
  assert.deepEqual(fetched, [{ asset: { url: 'https://example.test/head.nii', integrity: { bytes: 4, sha256: 'a'.repeat(64) } }, retries: 4 }]);
  assert.match((await call('inputs_load_example', { exampleId: 'remote' })).error.message, /cannot be loaded here: Its data stay on the compute server/);
  assert.deepEqual((await call('inputs_load_example', { exampleId: 'mapped' })).inputs, { image: [{ name: 'scan.nii', bytes: 4 }] });
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
  await inputs.hold('image', [new File(['input'], 'input.nii')]);
  assert.equal((await call('run_run')).state, 'succeeded');
  const { runId } = (await call('app_describe')).run;
  assert.deepEqual(await call('outputs_download', { runId, artifactId: 'labels' }), { runId, artifactId: 'labels' });
  assert.deepEqual(downloads.map(file => file.name), ['labels.nii']);
});

test('outputs_download saves only an output of the run the agent names', async t => {
  const { call, inputs, downloads, dispatch } = page(t, async () => labels());
  inputs.hold('image', [new File(['input'], 'input.nii')]);
  const first = await call('run_run');
  const second = await call('run_run');
  assert.equal(second.state, 'succeeded');
  assert.equal((await call('outputs_download', { artifactId: 'labels' })).error.code, 'INVALID_INPUT', 'runId is required');
  const stale = await call('outputs_download', { runId: first.runId, artifactId: 'labels' });
  assert.equal(stale.error.code, 'RUN_REPLACED');
  assert.equal(stale.error.replacedBy, second.runId);
  assert.deepEqual(downloads, [], 'a replaced run saves nothing');
  assert.deepEqual(await dispatch('download', { artifactId: 'labels' }), { artifactId: 'labels' }, 'the desktop dispatch still takes an artifact ID alone');
  await assert.rejects(dispatch('download', { artifactId: 'labels', runId: first.runId }), /is not the current run/);
});

test('a wait on a run that another run replaced says so instead of returning the other run', async t => {
  let reads = 0;
  const { tools } = page(t, async () => labels());
  const runsGet = webMcpTools({ contract: contract(), inputs: {}, dispatch: async command => {
    assert.equal(command, 'snapshot');
    return ++reads < 3 ? { runId: 'A', state: 'running' } : { runId: 'B', state: 'running' };
  } }).find(tool => tool.name === 'runs_get');
  assert.ok(tools.length);
  const result = await runsGet.execute({ runId: 'A', waitSeconds: 2 });
  assert.equal(result.error.code, 'RUN_REPLACED');
  assert.equal(result.error.runId, 'A');
  assert.equal(result.error.replacedBy, 'B');
});

test('a run tool refuses to start while another run is going, and names it', async t => {
  let finish;
  const { call, inputs } = page(t, () => (finish ? labels() : new Promise(resolve => { finish = () => resolve(labels()); })));
  inputs.hold('image', [new File(['input'], 'input.nii')]);
  const running = await call('run_run', { waitSeconds: 0 });
  assert.equal(running.state, 'running');
  const refused = await call('run_run', { waitSeconds: 0 });
  assert.equal(refused.error.code, 'RUN_ACTIVE');
  assert.equal(refused.error.runId, running.runId);
  assert.match(refused.error.message, /runs_cancel/);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  finish();
  assert.equal((await call('runs_get', { runId: running.runId, waitSeconds: 5 })).state, 'succeeded');
  const replaced = await call('run_run');
  assert.equal(replaced.state, 'succeeded');
  assert.equal((await call('runs_get', { runId: running.runId })).error.code, 'RUN_REPLACED');
  assert.equal((await call('runs_cancel', { runId: running.runId })).error.code, 'RUN_REPLACED');
  assert.equal((await call('runs_get', { runId: 'never' })).error.code, 'UNKNOWN_RUN');
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

test('the page module registers the tools for an app that registers before or after it, and answers through its own dialogs', async t => {
  for (const order of ['app first', 'tools first']) {
    const dom = new JSDOM('<body><nd-example-selector></nd-example-selector></body>', { url: 'https://example.test/test/' });
    t.after(() => dom.window.close());
    const { document } = dom.window;
    dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
    document.querySelector('nd-example-selector').examples = examples.slice(0, 1);
    dom.window.fetch = async url => ({ ok: String(url) === 'https://example.test/test/examples.json', json: async () => examples });
    const registered = new Map();
    const modelContext = { async registerTool(tool) { registered.set(tool.name, tool); } };
    const register = () => registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() }, document, target: dom.window });
    if (order === 'app first') register();
    const exposed = exposeWebMcp(modelContext, document);
    if (order === 'tools first') register();
    assert.equal((await exposed).failed.length, 0, order);
    const call = (name, input = {}) => registered.get(name).execute(input, { signal: new AbortController().signal });
    assert.deepEqual((await call('app_describe')).examples.map(example => example.id), ['head', 'mapped'], 'the page\'s example selector and the published examples.json supply the examples');
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
  }
});

// The person loads files through the page's own input, as a picker or a page drop delivers them.
function personLoads(window, files) {
  const input = window.document.getElementById('t1');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

// The release waits for the app's run state, so poll until the page answers as asserted next.
async function settled(check) {
  if (!check) return new Promise(resolve => setTimeout(resolve, 100));
  for (let attempt = 0; attempt < 200 && !(await check()); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
}

test('held files serve every rerun until the person loads their own files or the app resets', async t => {
  const seen = [];
  let window;
  const { call, inputs, registration, window: pageWindow } = page(t, async ({ inputs: files, parameters }) => {
    seen.push([files.image[0].name, parameters.threshold]);
    if (parameters.threshold === 0.9) personLoads(window, [new File(['fed'], 'fed-by-the-run.nii')]);
    return labels();
  });
  window = pageWindow;
  inputs.hold('image', [new File(['input'], 'input.nii')]);
  for (const threshold of [0.2, 0.8, 0.9]) assert.equal((await call('run_run', { parameters: { threshold } })).state, 'succeeded');
  await settled();
  assert.deepEqual(seen, [['input.nii', 0.2], ['input.nii', 0.8], ['input.nii', 0.9]]);
  assert.deepEqual((await call('app_describe')).inputs, { image: [{ name: 'input.nii', bytes: 5 }] }, 'a load the run itself made keeps the held files');

  personLoads(window, [new File(['mine'], 'mine.nii')]);
  await settled(async () => Object.keys((await call('app_describe')).inputs).length === 0);
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'the person moved on, so the tools release the files they held');
  assert.deepEqual(describe.pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'mine.nii', bytes: 4 }] }]);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'mine.nii', bytes: 4 }] });
  assert.equal((await call('run_run')).report.inputs.image[0].filename, 'mine.nii');
  assert.match((await call('inputs_use_page_files', { role: 'image', input: 'nowhere' })).error.message, /No files are loaded/);

  personLoads(window, [new File(['newer'], 'newer.nii')]);
  await settled(async () => (await call('app_describe')).pageFiles[0].files[0].name === 'newer.nii');
  assert.deepEqual((await call('app_describe')).pageFiles[0].files, [{ name: 'newer.nii', bytes: 5 }], 'an input\'s earlier files are forgotten');
  inputs.hold('image', [new File(['input'], 'input.nii')]);
  registration.reset();
  assert.deepEqual((await call('app_describe')).inputs, {}, 'a reset releases the held files');
});

test('every tool checks its input against the schema it publishes before it runs', async t => {
  const asked = [];
  const { call } = page(t, async () => labels(), { askUser: async request => {
    asked.push(request);
    return { answer: 'OK' };
  } });
  const invalid = [
    ['user_ask', { question: 'Sample', options: 'not-an-array' }, /input.options must be an array/],
    ['user_ask', { question: '' }, /input.question needs at least 1 character/],
    ['runs_get', { waitSeconds: 'invalid' }, /input.waitSeconds must be a number/],
    ['runs_get', { waitSeconds: 601 }, /input.waitSeconds must be at most 600/],
    ['run_run', { parameters: { threshold: 2 } }, /input.parameters.threshold must be at most 1/],
    ['run_run', { parameters: { method: 'c' } }, /input.parameters.method must be one of "a", "b"/],
    ['inputs_load_example', {}, /input.exampleId is required/],
    ['app_describe', { extra: true }, /input.extra is not a known field/],
  ];
  for (const [name, input, message] of invalid) {
    const result = await call(name, input);
    assert.equal(result.error?.code, 'INVALID_INPUT', `${name} ${JSON.stringify(input)}`);
    assert.match(result.error.message, message);
  }
  assert.deepEqual(asked, [], 'no malformed question reached the person');
  assert.deepEqual(await call('user_ask', { question: 'Valid', options: ['OK'] }), { answer: 'OK' });
});

test('every tool marks its result untrusted except the few whose results only the app author writes', async t => {
  const { tools } = page(t, async () => labels());
  const trusted = tools.filter(tool => !tool.annotations.untrustedContentHint).map(tool => tool.name).sort();
  assert.deepEqual(trusted, ['inputs_load_example', 'outputs_download', 'viewers_list']);
  for (const name of ['viewers_state', 'viewers_tab', 'viewers_regions', 'viewers_crosshair']) {
    assert.equal(tools.find(tool => tool.name === name).annotations.untrustedContentHint, true, `${name} returns tab labels and region names the person controls`);
  }
});

test('every nv-mcp method is classified, so a method nv-mcp adds stays out of WebMCP until it is', () => {
  assert.deepEqual(Object.keys(NIIVUE_METHODS).sort(), Object.keys(coreHandlers({ view: {} })).sort());
  assert.ok(Object.values(NIIVUE_METHODS).every(kind => ['read', 'display', 'fetch', 'denied'].includes(kind)));
});

function viewerPage(t, options = {}) {
  const sent = [];
  const confirmations = [];
  let approve = false;
  const urlContract = contract();
  urlContract.operations.run.inputs.store = { source: 'url', type: 'neuro:volume', description: 'A remote store', minimum: 0, maximum: 1 };
  const tools = webMcpTools({ contract: urlContract, inputs: { stage: async () => {}, held: () => ({}), page: () => [] },
    dispatch: async (command, request) => {
      sent.push([command, request]);
      if (command === 'snapshot') return { runId: 'R', state: 'succeeded' };
      if (command === 'start') return { runId: 'R', state: 'running' };
      return { ok: true };
    },
    confirmFetch: async (request, { signal } = {}) => {
      confirmations.push({ ...request, signal: Boolean(signal) });
      return approve;
    }, ...options });
  const call = (name, input) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  return { tools, call, sent, confirmations, allow: value => { approve = value; } };
}

test('viewers_niivue offers only methods that read the scene or change the display, and asks before it fetches', async t => {
  const { tools, call, sent, confirmations, allow } = viewerPage(t);
  const niivue = tools.find(tool => tool.name === 'viewers_niivue');
  const offered = niivue.inputSchema.properties.method.enum;
  for (const method of ['screenshot', 'save', 'update_volume_data', 'add_control', 'set_options']) assert.ok(!offered.includes(method), `${method} is not offered`);
  for (const method of ['where_am_i', 'set_volume', 'go_to_region', 'load_volume']) assert.ok(offered.includes(method), `${method} is offered`);
  assert.equal(niivue.annotations.consequentialHint, true);

  for (const method of ['screenshot', 'save']) {
    assert.equal((await call('viewers_niivue', { viewerId: 'main', method, params: { what: 'bitmap' } })).error.code, 'INVALID_INPUT');
  }
  assert.deepEqual(sent, [], 'no pixel export or save reached the viewer');

  const url = 'https://elsewhere.test/scan.nii.gz';
  assert.deepEqual(await call('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } }), { declined: true, addresses: [url] });
  assert.deepEqual(confirmations, [{ app: 'Test', addresses: [url], signal: true }]);
  assert.deepEqual(sent, [], 'a declined address is never fetched');
  assert.deepEqual((await call('viewers_niivue', { viewerId: 'main', method: 'set_volume', params: { volume: 0, labels: 'tables/atlas.json' } })).declined, true, 'a label table address asks too');
  assert.deepEqual(confirmations[1].addresses, ['tables/atlas.json']);

  allow(true);
  assert.deepEqual(await call('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } }), { ok: true });
  assert.deepEqual(sent, [['viewers.niivue', { viewerId: 'main', method: 'load_volume', params: { url } }]]);
  await call('viewers_niivue', { viewerId: 'main', method: 'set_volume', params: { volume: 0, labels: 'freesurfer', colormap: 'gray' } });
  assert.equal(confirmations.length, 3, 'the built-in FreeSurfer table and a colormap need no approval');
});

test('a run that would fetch an address the agent supplied asks the person first', async t => {
  const { tools, call, sent, confirmations, allow } = viewerPage(t);
  assert.equal(tools.find(tool => tool.name === 'run_run').annotations.consequentialHint, true, 'a run tool that takes addresses is consequential');
  assert.equal(tools.find(tool => tool.name === 'outputs_download').annotations.consequentialHint, true);
  const store = 'https://store.test/brain.zarr';
  assert.deepEqual(await call('run_run', { inputs: { store: { url: store } }, waitSeconds: 0 }), { declined: true, addresses: [store] });
  assert.deepEqual(confirmations.map(request => request.addresses), [[store]]);
  assert.ok(!sent.some(([command]) => command === 'start'), 'a declined run never starts');
  allow(true);
  assert.equal((await call('run_run', { inputs: { store: { url: store } }, waitSeconds: 0 })).runId, 'R');
  assert.equal(webMcpTools({ contract: contract(), inputs: {}, dispatch: async () => ({}) }).find(tool => tool.name === 'run_run').annotations.consequentialHint, undefined);
});

// A page whose contract has an optional mask beside the image, as QSMbly's does.
function maskPage(t, operation, options = {}) {
  const dom = new JSDOM('<body><input type="file" id="t1" data-neurodesk-input="image"></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const maskContract = contract();
  maskContract.operations.run.inputs.mask = { source: 'files', type: 'neuro:mask', formats: ['nifti'], description: 'A brain mask', minimum: 0, maximum: 1 };
  const registration = registerAppAutomation({ app: 'test', contract: maskContract, operations: { run: operation }, document: dom.window.document, target: dom.window });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation });
  const tools = webMcpTools({ contract: maskContract, dispatch: automation.dispatch, inputs, examples: () => examples,
    fetchAsset: async () => new TextEncoder().encode('head').buffer, ...options });
  const call = (name, input = {}) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  return { call, inputs, registration, window: dom.window };
}

test('loading an example replaces every held role, so no file from the examination before stays', async t => {
  const { call, inputs } = maskPage(t, async ({ inputs: files }) => ({ ...labels(), summary: { mask: files.mask.map(file => file.name) } }));
  inputs.hold('image', [new File(['old'], 'earlier-exam.nii')]);
  inputs.hold('mask', [new File(['mask'], 'earlier-exam-mask.nii')]);
  await call('inputs_load_example', { exampleId: 'head' });
  assert.deepEqual((await call('app_describe')).inputs, { image: [{ name: 'head.nii', bytes: 4 }] });
  const run = await call('run_run');
  assert.equal(run.report.inputs.image[0].filename, 'head.nii');
  assert.deepEqual(run.report.inputs.mask, [], 'the earlier examination\'s mask is not run with the example');
});

test('an example that finishes downloading after the examination changed is discarded', async t => {
  let finish;
  const { call, registration } = maskPage(t, async () => labels(), { fetchAsset: () => new Promise(resolve => { finish = resolve; }) });
  const pending = call('inputs_load_example', { exampleId: 'head' });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  registration.reset();
  finish(new TextEncoder().encode('head').buffer);
  const result = await pending;
  assert.equal(result.error.code, 'EXAMINATION_CHANGED');
  assert.deepEqual((await call('app_describe')).inputs, {}, 'nothing from the stale download is held');
});

test('the person picking an example in the page releases held and page files and names the example', async t => {
  const { call, inputs, window } = maskPage(t, async () => labels());
  personLoads(window, [new File(['scan'], 'new-exam.nii')]);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'new-exam.nii', bytes: 4 }] });
  inputs.hold('mask', [new File(['mask'], 'mask.nii')]);
  const status = detail => window.document.body.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail }));
  status({ state: 'loading' });
  status({ state: 'ready', exampleId: 't1-head' });
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'the scan the person replaced is no longer held');
  assert.deepEqual(describe.pageFiles, [], 'nor offered as what the page shows');
  assert.equal(describe.pageExample, 't1-head');
  assert.equal((await call('run_run')).error?.message ?? (await call('runs_get')).error.message, 'Missing input: image');
});

test('a handoff from another app releases the held files', async t => {
  const { call, inputs, window } = maskPage(t, async () => labels());
  inputs.hold('image', [new File(['old'], 'old.nii')]);
  window.document.dispatchEvent(new window.CustomEvent('nd-handoff', { detail: { source: { app: 'dicomview' } } }));
  assert.deepEqual((await call('app_describe')).inputs, {});
});
