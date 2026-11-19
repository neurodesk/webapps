import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as z from 'zod/v4';
import { registerAppAutomation } from '../src/automation/index.js';
import { operationParametersSchema } from '../src/automation/parameters.js';
import { fetchApproved, registerWebMcpTools, webMcpTools } from '../src/webmcp/tools.js';
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

// Events the test dispatches as the person's own; JSDOM cannot make a trusted event.
const people = new WeakSet();
const isPerson = event => people.has(event);
function asPerson(target, event) {
  people.add(event);
  target.dispatchEvent(event);
}
const hold = (inputs, role, files) => inputs.hold(inputs.examination(), role, files);
const WORKSPACE = '<body><header class="nd-app-bar"><button id="privacy">Privacy</button></header><main><input type="file" id="t1" data-neurodesk-input="image" aria-label="T1 image"><button id="remove">Remove</button><canvas id="viewer"></canvas></main></body>';

function page(t, operation, options = {}) {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const downloads = [];
  const registration = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: operation },
    document: dom.window.document, target: dom.window, download: file => downloads.push(file) });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation, isPerson });
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
  if (field.multipleOf !== undefined) {
    const step = field.multipleOf;
    const base = (field.minimum ?? 0) + 3 * step;
    values.push(base, base + 1e-9, base - 1e-12, base + step / 2, 3 * step + Number.EPSILON);
  }
  values.push(2 ** 53, -(2 ** 53), 2 ** 53 - 1, 1e300);
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
      const required = Object.keys(operation.parameters).filter(key => operation.parameters[key].required);
      assert.equal(json.safeParse({}).success, required.length === 0, `${app}: ${name} runs with every optional parameter left out`);
      assert.equal((run.inputSchema.required ?? []).includes('parameters'), required.length > 0, `${app}: ${name} requires parameters when the contract does`);
      assert.deepEqual(run.inputSchema.properties.parameters.required ?? [], required, `${app}: ${name} publishes its required parameters`);
      assert.equal(json.safeParse({ unknownParameter: 1 }).success, false, `${app}: ${name} refuses unknown parameters`);
      for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        const parameters = JSON.parse(`{"${inherited}": 1}`);
        assert.ok(schemaIssues(run.inputSchema, { parameters }).length > 0, `${app}: ${name} refuses an inherited name ${inherited}`);
        assert.equal(contractSchema.safeParse(parameters).success, false, `${app}: ${name}: the page refuses ${inherited} too`);
      }
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
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
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
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
  const controller = new AbortController();
  const pending = call('run_run', { waitSeconds: 60 }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const cancelled = await pending;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(operationSignal.aborted, true);
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
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
  assert.equal(describe.examples[0].tool, 'run_run', 'each example names the run tool that takes it');
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
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
  assert.equal((await call('run_run')).state, 'succeeded');
  const { runId } = (await call('app_describe')).run;
  assert.deepEqual(await call('outputs_download', { runId, artifactId: 'labels' }), { runId, artifactId: 'labels' });
  assert.deepEqual(downloads.map(file => file.name), ['labels.nii']);
});

test('outputs_download saves only an output of the run the agent names', async t => {
  const { call, inputs, downloads, dispatch } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
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
  let finish;
  const { call, inputs } = page(t, () => (finish ? labels() : new Promise(resolve => { finish = () => resolve(labels()); })));
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
  const first = await call('run_run', { waitSeconds: 0 });
  const waiting = call('runs_get', { runId: first.runId, waitSeconds: 5 });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  finish();
  assert.equal((await waiting).state, 'succeeded');
  const second = await call('run_run');
  const result = await call('runs_get', { runId: first.runId });
  assert.equal(result.error.code, 'RUN_REPLACED');
  assert.equal(result.error.runId, first.runId);
  assert.equal(result.error.replacedBy, second.runId);
});

test('the automation acts on a named run only while it is the current one, so a cancel cannot reach the next run', async t => {
  const pending = [];
  const { dispatch, window } = page(t, ({ signal }) => new Promise((resolve, reject) => {
    pending.push(resolve);
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const transfer = file => {
    Object.defineProperty(window.document.getElementById('neurodesk-input-transfer'), 'files', { configurable: true, value: [file] });
    return dispatch('adopt', { role: 'image' });
  };
  await transfer(new File(['a'], 'a.nii'));
  const { runId: first } = await dispatch('start', {});
  while (!pending.length) await new Promise(resolve => setTimeout(resolve, 5));
  pending[0](labels());
  while ((await dispatch('snapshot')).state === 'running') await new Promise(resolve => setTimeout(resolve, 5));
  await transfer(new File(['b'], 'b.nii'));
  const { runId: second } = await dispatch('start', {});
  const refused = await dispatch('cancel', { runId: first }).catch(error => error);
  assert.equal(refused.code, 'RUN_NOT_CURRENT');
  assert.equal(refused.current, second);
  assert.equal((await dispatch('snapshot')).state, 'running', 'the second run goes on');
  assert.equal((await dispatch('snapshot', { runId: first }).catch(error => error)).code, 'RUN_NOT_CURRENT');
  assert.equal((await dispatch('snapshot', { runId: second })).runId, second);
  assert.deepEqual(await dispatch('cancel', { runId: second }), { cancelled: true });
  assert.deepEqual(await dispatch('cancel'), { cancelled: false }, 'a desktop cancel without a run ID still works');
});

test('the tools remember a bounded number of runs', async t => {
  const { call, inputs } = page(t, async () => labels());
  const runs = [];
  for (let index = 0; index < 66; index += 1) {
    hold(inputs, 'image', [new File(['input'], 'input.nii')]);
    runs.push((await call('run_run')).runId);
  }
  assert.equal((await call('runs_get', { runId: runs[0] })).error.code, 'UNKNOWN_RUN', 'the oldest run is forgotten');
  assert.equal((await call('runs_get', { runId: runs[2] })).error.code, 'RUN_REPLACED');
  assert.equal((await call('runs_get', { runId: runs.at(-1) })).state, 'succeeded');
});

test('a run tool refuses to start while another run is going, and names it', async t => {
  let finish;
  const { call, inputs } = page(t, () => (finish ? labels() : new Promise(resolve => { finish = () => resolve(labels()); })));
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
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

// The person loads files through the page's own input, as a file chooser delivers them.
function personLoads(window, files) {
  const input = window.document.getElementById('t1');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  asPerson(input, new window.Event('change', { bubbles: true }));
}

// The app or the shell filling the page's input itself, as a page drop or a run does.
function appLoads(window, files) {
  const input = window.document.getElementById('t1');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const click = (window, selector) => asPerson(window.document.querySelector(selector), new window.Event('pointerup', { bubbles: true, composed: true }));

test('held files serve every rerun until the person uses the page', async t => {
  const seen = [];
  let window;
  const { call, inputs, window: pageWindow } = page(t, async ({ inputs: files, parameters }) => {
    seen.push([files.image[0].name, parameters.threshold]);
    if (parameters.threshold === 0.9) appLoads(window, [new File(['fed'], 'fed-by-the-run.nii')]);
    return labels();
  });
  window = pageWindow;
  hold(inputs, 'image', [new File(['input'], 'input.nii')]);
  for (const threshold of [0.2, 0.8, 0.9]) assert.equal((await call('run_run', { parameters: { threshold } })).state, 'succeeded');
  assert.deepEqual(seen, [['input.nii', 0.2], ['input.nii', 0.8], ['input.nii', 0.9]]);
  const described = await call('app_describe');
  assert.deepEqual(described.inputs, { image: [{ name: 'input.nii', bytes: 5 }] }, 'a load the run itself made keeps the held files');
  assert.deepEqual(described.pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'fed-by-the-run.nii', bytes: 3 }], current: true }], 'the page lists what the run loaded into it');

  personLoads(window, [new File(['mine'], 'mine.nii')]);
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'the person moved on, so the tools release the files they held');
  assert.equal(describe.run.stale, true, 'and the run before is stale');
  assert.deepEqual(describe.pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'mine.nii', bytes: 4 }], current: true }]);
  assert.equal(describe.pageMayHoldOtherInputs, false);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'mine.nii', bytes: 4 }] });
  assert.equal((await call('run_run')).report.inputs.image[0].filename, 'mine.nii');
  assert.match((await call('inputs_use_page_files', { role: 'image', input: 'nowhere' })).error.message, /No files are loaded/);
});

test('any use of the workspace ends the examination: held files go, the last run is withheld, page files need confirming', async t => {
  const confirmations = [];
  let answer = false;
  const { call, inputs, window, downloads } = page(t, async () => labels(), { confirmFiles: async request => {
    confirmations.push(request);
    return answer;
  } });
  personLoads(window, [new File(['scan'], 'scan.nii')]);
  await call('inputs_use_page_files', { role: 'image', input: 't1' });
  const run = await call('run_run');
  assert.equal(run.state, 'succeeded');

  click(window, '#privacy');
  asPerson(window.document.body, new window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  asPerson(window.document.body, new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  assert.deepEqual(Object.keys((await call('app_describe')).inputs), ['image'], 'the shared bar, scrolling and modifier keys are not the workspace');

  click(window, '#remove');
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {});
  assert.deepEqual(describe.run, { runId: run.runId, state: 'succeeded', stale: true, message: describe.run.message });
  assert.match(describe.run.message, /used the page since this run started/);
  assert.equal(describe.pageFiles[0].current, false, 'the remove button may have removed the scan');
  assert.equal(describe.pageMayHoldOtherInputs, true);
  for (const [name, input] of [['runs_get', { runId: run.runId }], ['runs_get', {}], ['runs_cancel', { runId: run.runId }], ['outputs_download', { runId: run.runId, artifactId: 'labels' }]]) {
    assert.equal((await call(name, input)).error?.code, 'RUN_STALE', `${name} ${JSON.stringify(input)}`);
  }
  assert.deepEqual(downloads, [], 'nothing of the stale run is saved');

  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { declined: true });
  assert.deepEqual(confirmations, [{ app: 'Test', label: 'T1 image', files: [{ name: 'scan.nii', bytes: 4 }] }]);
  assert.deepEqual((await call('app_describe')).inputs, {});
  answer = true;
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'scan.nii', bytes: 4 }] });
});

test('a prompt or download that answers after the person used the page commits nothing', async t => {
  let answer;
  const { call, window, registration } = page(t, async () => labels(), {
    requestFiles: () => new Promise(resolve => { answer = resolve; }),
  });
  const request = call('inputs_request_files', { role: 'image' });
  while (!answer) await new Promise(resolve => setTimeout(resolve, 5));
  click(window, '#viewer');
  answer([new File(['late'], 'late.nii')]);
  assert.equal((await request).error.code, 'EXAMINATION_CHANGED');
  answer = undefined;
  const second = call('inputs_request_files', { role: 'image' });
  while (!answer) await new Promise(resolve => setTimeout(resolve, 5));
  registration.reset();
  answer([new File(['late'], 'late.nii')]);
  assert.equal((await second).error.code, 'EXAMINATION_CHANGED', 'an app reset ends the examination too');
  assert.deepEqual((await call('app_describe')).inputs, {});
});

test('a pick made while a run is going is not taken as what the page shows', async t => {
  let finish;
  const { call, inputs, window } = page(t, () => new Promise(resolve => { finish = () => resolve(labels()); }));
  appLoads(window, [new File(['a'], 'exam-a.nii')]);
  hold(inputs, 'image', [new File(['a'], 'exam-a.nii')]);
  const running = await call('run_run', { waitSeconds: 0 });
  personLoads(window, [new File(['b'], 'exam-b.nii')]);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  finish();
  const describe = await call('app_describe');
  assert.equal(describe.run.stale, true);
  assert.equal(describe.run.report, undefined, 'the report of exam A is withheld');
  assert.deepEqual(describe.pageFiles.map(entry => [entry.files[0].name, entry.current]), [['exam-a.nii', false]], 'the busy app may have ignored exam B');
  assert.equal(describe.pageMayHoldOtherInputs, true);
  assert.equal((await call('outputs_download', { runId: running.runId, artifactId: 'report' })).error.code, 'RUN_STALE');
});

test('files handed over or dropped on the page that reach no input are listed as received', async t => {
  const { call, inputs, window } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['old'], 'old.nii')]);
  window.document.dispatchEvent(new window.CustomEvent('nd-handoff', { detail: { source: { app: 'dicomview', title: 'DICOM View' }, files: [new File(['sent'], 'sent.nii')] } }));
  let describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'a handoff ends the examination');
  assert.deepEqual(describe.pageFiles, [{ input: 'received:handoff', label: 'Sent from DICOM View', files: [{ name: 'sent.nii', bytes: 4 }], current: true }]);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 'received:handoff' }), { role: 'image', files: [{ name: 'sent.nii', bytes: 4 }] });
  appLoads(window, [new File(['sent'], 'sent.nii')]);
  assert.deepEqual((await call('app_describe')).pageFiles.map(entry => entry.input), ['t1'], 'a handoff delivered into an input is listed once');

  const drop = new window.Event('drop', { bubbles: true, composed: true });
  drop.dataTransfer = { types: ['Files'], items: [{ getAsFile: () => new File(['dropped'], 'dropped.nii') }] };
  asPerson(window.document.getElementById('viewer'), drop);
  await new Promise(resolve => setTimeout(resolve, 10));
  describe = await call('app_describe');
  assert.deepEqual(describe.pageFiles.map(entry => [entry.input, entry.current]), [['t1', false], ['received:drop', true]]);
  assert.deepEqual(describe.pageFiles[1].files, [{ name: 'dropped.nii', bytes: 7 }]);
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

// What each method viewers_niivue offers does, read from nv-mcp's dist/browser.js at the version below.
// A bump of nv-mcp fails this test until each entry is checked again against the new source.
const AUDITED_NV_MCP = '1.0.0-rc.7';
const NIIVUE_AUDIT = {
  capabilities: ['read', 'Lists features, settings, colormaps, shaders and data sources.'],
  describe_volume: ['read', 'Returns a volume\'s header, statistics (getDescriptives) and, on request, its affine.'],
  get_options: ['read', 'Returns the values of named NiiVue settings.'],
  list_annotations: ['read', 'Returns the annotations, and on request their JSON or an SVG trace; writes nothing.'],
  list_measurements: ['read', 'Returns the measurements.'],
  list_meshes: ['read', 'Returns the meshes and shaders.'],
  list_regions: ['read', 'Lists the host atlas\'s regions; a page without an atlas refuses.'],
  list_signals: ['read', 'Returns the signals and the graph range.'],
  map_point: ['read', 'Converts between canvas, millimetre and voxel coordinates.'],
  where_am_i: ['read', 'Returns the crosshair, plane, camera and volumes.'],
  animate: ['display', 'animateTo on the camera, crosshair, clip planes and volume display properties.'],
  go_to_point: ['display', 'Moves the crosshair and cut plane.'],
  go_to_region: ['display', 'Moves the crosshair to an atlas region\'s centroid.'],
  nudge_crosshair: ['display', 'moveCrosshairInVox.'],
  set_boxes: ['display', 'Sets focusBox and lodBoxes, outlines drawn on the render.'],
  set_camera: ['display', 'Sets azimuth, elevation, zoom and render pan.'],
  set_clip_plane: ['display', 'Sets clip planes.'],
  set_custom_layout: ['display', 'Sets or clears customLayout tiles.'],
  set_graph: ['display', 'Moves, zooms, pans or resets the signal graph cursor and range.'],
  set_instances: ['display', 'Lays out volume instances and the global camera.'],
  set_labels: ['display', 'Draws text labels through the host\'s labels callback; a page without one refuses.'],
  set_mesh: ['display', 'setMesh display fields (opacity, colour, shader, visibility, name), tract and connectome drawing options.'],
  set_mesh_layer: ['display', 'setMeshLayerProperty display fields and the layer\'s frame.'],
  set_view: ['display', 'Slice type, layout, mosaic, render visibility, radiological convention, colorbar.'],
  set_viewport: ['display', 'Pan, zoom and drawing bounds of the canvas.'],
  set_volume: ['display', 'setVolume display fields, label tables, modulation, chunk grid and spread. affine, reset_affine and transform move the volume and load_all_frames fetches from its address: refused.'],
  add_mesh_layer: ['fetch', 'addMeshLayer from url.'],
  add_overlay: ['fetch', 'addVolume from url, and a label table from labels.'],
  load_mesh: ['fetch', 'addMesh from url and each layer url; replace removes the meshes before it.'],
  load_signal: ['fetch', 'addSignal or loadSignals from url; NiiVue looks for a sibling .json sidecar beside it.'],
  load_volume: ['fetch', 'loadVolumes from url, replacing the volumes.'],
};

test('every method viewers_niivue offers is audited against the pinned nv-mcp source', async () => {
  const { devDependencies, dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = dependencies?.['@niivue/nv-mcp'] ?? devDependencies['@niivue/nv-mcp'];
  assert.equal(pinned, AUDITED_NV_MCP, 'nv-mcp changed: audit each offered method again, then update AUDITED_NV_MCP');
  const offered = Object.entries(NIIVUE_METHODS).filter(([, kind]) => kind !== 'denied');
  assert.deepEqual(Object.fromEntries(offered), Object.fromEntries(Object.entries(NIIVUE_AUDIT).map(([method, [kind]]) => [method, kind])));
  for (const method of ['set_slide', 'set_signal', 'load_document']) assert.equal(NIIVUE_METHODS[method], 'denied', `${method} edits annotations or loads a document that names further addresses`);
});

function viewerPage(t, options = {}) {
  const sent = [];
  const confirmations = [];
  const fetched = [];
  let approve = false;
  const urlContract = contract();
  urlContract.operations.run.inputs.store = { source: 'url', type: 'neuro:volume', description: 'A remote store', minimum: 0, maximum: 1 };
  const examination = {};
  const tools = webMcpTools({ contract: urlContract, inputs: { examination: () => examination, stage: async () => {}, claim() {}, runOf: () => 'current', held: () => ({}), page: () => [] },
    dispatch: async (command, request) => {
      if (command === 'viewers.niivue' && request.params) {
        const urls = Object.values(request.params).filter(value => typeof value === 'string' && value.startsWith('blob:'));
        request.bytes = await Promise.all(urls.map(async url => (await fetch(url)).text()));
      }
      sent.push([command, request]);
      if (command === 'snapshot') return { runId: 'R', state: 'succeeded' };
      if (command === 'start') return { runId: 'R', state: 'running' };
      return { ok: true };
    },
    fetchAddress: async address => {
      fetched.push(address);
      return { blob: new Blob([`bytes of ${address}`]), href: new URL(address, 'https://apps.test/test/').href };
    },
    confirmFetch: async (request, { signal } = {}) => {
      confirmations.push({ ...request, signal: Boolean(signal) });
      return approve;
    }, ...options });
  const call = (name, input) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  return { tools, call, sent, confirmations, fetched, allow: value => { approve = value; } };
}

test('viewers_niivue offers only methods that read the scene, change the display or load one file, and asks before it fetches', async t => {
  const { tools, call, sent, confirmations, fetched, allow } = viewerPage(t);
  const niivue = tools.find(tool => tool.name === 'viewers_niivue');
  const offered = niivue.inputSchema.properties.method.enum;
  for (const method of ['screenshot', 'save', 'update_volume_data', 'add_control', 'set_options', 'load_document', 'set_slide']) assert.ok(!offered.includes(method), `${method} is not offered`);
  for (const method of ['where_am_i', 'set_volume', 'go_to_region', 'load_volume']) assert.ok(offered.includes(method), `${method} is offered`);
  assert.equal(niivue.annotations.consequentialHint, true);

  for (const method of ['screenshot', 'save', 'load_document']) {
    assert.equal((await call('viewers_niivue', { viewerId: 'main', method, params: { what: 'bitmap' } })).error.code, 'INVALID_INPUT');
  }
  for (const key of ['affine', 'reset_affine', 'transform', 'load_all_frames']) {
    const refused = await call('viewers_niivue', { viewerId: 'main', method: 'set_volume', params: { volume: 0, [key]: true } });
    assert.equal(refused.error?.code, 'INVALID_INPUT', key);
    assert.match(refused.error.message, new RegExp(key));
  }
  assert.deepEqual(sent, [], 'no pixel export, save, document or data change reached the viewer');

  const url = 'https://elsewhere.test/scan.nii.gz';
  assert.deepEqual(await call('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } }), { declined: true, addresses: [url] });
  assert.deepEqual(confirmations, [{ app: 'Test', addresses: [url], signal: true }]);
  assert.deepEqual(fetched, [], 'a declined address is never fetched');
  assert.deepEqual((await call('viewers_niivue', { viewerId: 'main', method: 'set_volume', params: { volume: 0, labels: 'tables/atlas.json' } })).declined, true, 'a label table address asks too');
  assert.deepEqual(confirmations[1].addresses, ['tables/atlas.json']);

  allow(true);
  assert.deepEqual(await call('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } }), { ok: true });
  assert.deepEqual(fetched, [url]);
  const [[command, request]] = sent;
  assert.equal(command, 'viewers.niivue');
  assert.match(request.params.url, /^blob:/, 'the viewer receives local bytes, never the address');
  assert.equal(request.params.name, 'scan.nii.gz', 'named after the approved address, since the viewer reads the format from the name');
  assert.deepEqual(request.bytes, [`bytes of ${url}`]);
  await call('viewers_niivue', { viewerId: 'main', method: 'set_volume', params: { volume: 0, labels: 'freesurfer', colormap: 'gray' } });
  assert.equal(confirmations.length, 3, 'the built-in FreeSurfer table and a colormap need no approval');
  assert.equal(fetched.length, 1);
});

test('the approved fetch refuses a redirect and anything but http', async t => {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    if (request.url === '/moved.nii.gz') response.writeHead(302, { location: '/elsewhere.nii.gz' }).end();
    else response.writeHead(200).end('scan');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetchApproved(`${origin}/scan.nii.gz`)).blob.text(), 'scan');
  await assert.rejects(fetchApproved(`${origin}/moved.nii.gz`), error => error.code === 'REDIRECT_REFUSED');
  await assert.rejects(fetchApproved('data:text/plain,scan'), error => error.code === 'ADDRESS_REFUSED');
});

test('a run that would fetch an address the agent supplied asks the person first', async t => {
  const { tools, call, sent, confirmations, allow } = viewerPage(t);
  assert.equal(tools.find(tool => tool.name === 'run_run').annotations.consequentialHint, true, 'a run tool that takes addresses is consequential');
  assert.equal(tools.find(tool => tool.name === 'outputs_download').annotations.consequentialHint, true);
  const store = 'https://store.test/brain.zarr';
  assert.deepEqual(await call('run_run', { inputs: { store: { url: store } }, waitSeconds: 0 }), { declined: true, addresses: [store] });
  assert.deepEqual(confirmations.map(request => [request.addresses, request.readsUnder]), [[[store], true]], 'the person learns the app reads under the store\'s address');
  assert.ok(!sent.some(([command]) => command === 'start'), 'a declined run never starts');
  allow(true);
  assert.equal((await call('run_run', { inputs: { store: { url: store } }, waitSeconds: 0 })).runId, 'R');
  assert.equal(webMcpTools({ contract: contract(), inputs: {}, dispatch: async () => ({}) }).find(tool => tool.name === 'run_run').annotations.consequentialHint, undefined);
});

// A page whose contract has an optional mask beside the image, as QSMbly's does.
function maskPage(t, operation, options = {}) {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const maskContract = contract();
  maskContract.operations.run.inputs.mask = { source: 'files', type: 'neuro:mask', formats: ['nifti'], description: 'A brain mask', minimum: 0, maximum: 1 };
  const registration = registerAppAutomation({ app: 'test', contract: maskContract, operations: { run: operation }, document: dom.window.document, target: dom.window });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation, isPerson });
  const tools = webMcpTools({ contract: maskContract, dispatch: automation.dispatch, inputs, examples: () => examples,
    fetchAsset: async () => new TextEncoder().encode('head').buffer, ...options });
  const call = (name, input = {}) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  return { call, inputs, registration, window: dom.window };
}

test('loading an example replaces every held role, so no file from the examination before stays', async t => {
  const { call, inputs } = maskPage(t, async ({ inputs: files }) => ({ ...labels(), summary: { mask: files.mask.map(file => file.name) } }));
  hold(inputs, 'image', [new File(['old'], 'earlier-exam.nii')]);
  hold(inputs, 'mask', [new File(['mask'], 'earlier-exam-mask.nii')]);
  await call('inputs_load_example', { exampleId: 'head' });
  assert.deepEqual((await call('app_describe')).inputs, { image: [{ name: 'head.nii', bytes: 4 }] });
  const run = await call('run_run');
  assert.equal(run.report.inputs.image[0].filename, 'head.nii');
  assert.deepEqual(run.report.inputs.mask, [], 'the earlier examination\'s mask is not run with the example');
});

test('an example that finishes downloading after the examination changed is discarded', async t => {
  let finish;
  const { call, window } = maskPage(t, async () => labels(), { fetchAsset: () => new Promise(resolve => { finish = resolve; }) });
  const pending = call('inputs_load_example', { exampleId: 'head' });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  click(window, '#remove');
  finish(new TextEncoder().encode('head').buffer);
  const result = await pending;
  assert.equal(result.error.code, 'EXAMINATION_CHANGED');
  assert.deepEqual((await call('app_describe')).inputs, {}, 'nothing from the stale download is held');
});

test('the person picking an example in the page releases held files and names the example', async t => {
  const { call, inputs, window } = maskPage(t, async () => labels());
  appLoads(window, [new File(['scan'], 'new-exam.nii')]);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'new-exam.nii', bytes: 4 }] });
  hold(inputs, 'mask', [new File(['mask'], 'mask.nii')]);
  const status = detail => window.document.body.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail }));
  status({ state: 'loading' });
  status({ state: 'ready', exampleId: 't1-head' });
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'the scan the person replaced is no longer held');
  assert.deepEqual(describe.pageFiles.map(entry => entry.current), [false], 'nor offered as what the page shows');
  assert.equal(describe.pageExample, 't1-head');
  assert.equal((await call('run_run')).error?.message ?? (await call('runs_get')).error.message, 'Missing input: image');
  click(window, '#viewer');
  assert.equal((await call('app_describe')).pageExample, null, 'once the person uses the page, the example may no longer be what it shows');
});

test('an app that resets as it reads a load keeps that load listed, and the reset ends the examination', async t => {
  const { call, inputs, registration, window } = maskPage(t, async () => labels());
  const input = window.document.getElementById('t1');
  input.addEventListener('change', event => {
    Object.defineProperty(event.target, 'files', { configurable: true, value: [] });
    registration.reset();
  });
  personLoads(window, [new File(['scan'], 'picked.nii')]);
  assert.deepEqual((await call('app_describe')).pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'picked.nii', bytes: 4 }], current: true }]);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'picked.nii', bytes: 4 }] });
  registration.reset();
  assert.deepEqual((await call('app_describe')).inputs, {}, 'a later reset releases the held files');
  hold(inputs, 'mask', [new File(['mask'], 'mask.nii')]);
  input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [] } }));
  assert.deepEqual((await call('app_describe')).pageFiles, [], 'an app that reports its emptied list removes the entry');
});

test('a parameter the contract requires is published as required and refused when missing', async t => {
  const strict = contract();
  strict.operations.run.parameters.prompts = { type: 'string', description: 'Prompts', required: true };
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  registerAppAutomation({ app: 'test', contract: strict, operations: { run: async () => labels() }, document: dom.window.document, target: dom.window });
  const run = webMcpTools({ contract: strict, dispatch: dom.window.neurodeskAutomation.dispatch, inputs: {} }).find(tool => tool.name === 'run_run');
  assert.deepEqual(run.inputSchema.required, ['parameters']);
  assert.deepEqual(run.inputSchema.properties.parameters.required, ['prompts']);
  assert.match((await run.execute({ parameters: { threshold: 0.2 } })).error.message, /input.parameters.prompts is required/);
  await assert.rejects(dom.window.neurodeskAutomation.dispatch('start', { parameters: {} }), /prompts/, 'the desktop dispatch refuses it too');
});
