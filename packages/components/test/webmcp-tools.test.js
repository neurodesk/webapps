import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as z from 'zod/v4';
import { registerAppAutomation } from '../src/automation/index.js';
import { operationParametersSchema } from '../src/automation/parameters.js';
import { fetchApproved, registerWebMcpTools, webMcpTools } from '../src/webmcp/tools.js';
import { exposeWebMcp } from '../src/webmcp/page.js';
import { createAgentPrompts } from '../src/ui/agentPrompt.js';
import { createToolInputs, INTERACTIONS, PERSON_INPUT } from '../src/webmcp/tool-inputs.js';
import { schemaIssues, unsupportedKeywords } from '../src/webmcp/schema.js';
import { NIIVUE_METHODS, NIIVUE_PARAMETERS } from '../src/webmcp/niivue-methods.js';
import { coreHandlers } from '@niivue/nv-mcp/browser';
import { CORE_SCHEMAS } from '@niivue/nv-mcp/server';

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
const hold = (inputs, role, files) => inputs.hold(inputs.turn(), role, files);
// A consent prompt allowed as it shows: it resolves to the request it named.
const allowing = request => (typeof request === 'function' ? request() : request);
// What a consent dialog names, without the revision it carries to tell it is still current.
const named = ({ revision, ...request }) => request;
const WORKSPACE = '<body><header class="nd-app-bar"><button id="privacy">Privacy</button></header><main><input type="file" id="t1" data-neurodesk-input="image" aria-label="T1 image"><button id="remove">Remove</button><canvas id="viewer"></canvas></main></body>';

function page(t, operation, options = {}) {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const downloads = [];
  const registration = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: operation },
    document: dom.window.document, target: dom.window, download: file => downloads.push(file) });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation, isPerson });
  const confirmations = [];
  const confirmFiles = async request => {
    const shown = allowing(request);
    confirmations.push(named(shown));
    return shown;
  };
  const resumes = [];
  let resumeAnswer = true;
  const confirmResume = async (request, { signal } = {}) => {
    const shown = allowing(request);
    const { startedAt, ...run } = shown.run ?? {};
    resumes.push({ ...named(shown), run: shown.run && { ...run, started: typeof startedAt === 'number' }, signal: Boolean(signal) });
    return resumeAnswer ? shown : null;
  };
  const tools = webMcpTools({ contract: contract(), dispatch: automation.dispatch, inputs, examples: () => examples, confirmFiles, confirmResume, ...options });
  const call = (name, input = {}, signal = new AbortController().signal) => tools.find(tool => tool.name === name).execute(input, { signal });
  return { tools, call, dispatch: automation.dispatch, downloads, inputs, registration, confirmations, resumes, answerResume: value => { resumeAnswer = value; }, window: dom.window };
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

test('user_ask returns the injected answer or the dismissal and passes a signal that follows the call\'s', async t => {
  const asked = [];
  const answers = [{ answer: 'T2' }, { dismissed: true }];
  const { call } = page(t, async () => labels(), { askUser: async (request, { signal }) => {
    asked.push({ ...request, signal });
    return answers.shift();
  } });
  const controller = new AbortController();
  assert.deepEqual(await call('user_ask', { question: 'Which?', options: ['T1', 'T2'] }, controller.signal), { answer: 'T2' });
  assert.deepEqual(await call('user_ask', { question: 'Why?' }), { dismissed: true });
  const { signal, ...request } = asked[0];
  assert.deepEqual(request, { question: 'Which?', options: ['T1', 'T2'], allowText: undefined });
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true, 'the prompt closes when the agent aborts the call');
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
  const { call, inputs, confirmations, window: pageWindow } = page(t, async ({ inputs: files, parameters }) => {
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
  assert.deepEqual(described.pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'fed-by-the-run.nii', bytes: 3 }] }], 'the page lists what the run loaded into it');

  personLoads(window, [new File(['mine'], 'mine.nii')]);
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'the person moved on, so the tools release the files they held');
  assert.equal(describe.run.stale, true, 'and the run before is stale');
  assert.deepEqual(describe.pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'mine.nii', bytes: 4 }] }]);
  assert.equal(describe.pageMayHoldOtherInputs, false);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 't1' }), { role: 'image', files: [{ name: 'mine.nii', bytes: 4 }] });
  assert.deepEqual(confirmations, [{ app: 'Test', label: 'T1 image', files: [{ name: 'mine.nii', bytes: 4 }] }], 'the person confirms even a file they have just loaded');
  assert.equal((await call('run_run')).report.inputs.image[0].filename, 'mine.nii');
  assert.match((await call('inputs_use_page_files', { role: 'image', input: 'nowhere' })).error.message, /No files are loaded/);
});

test('a press in the workspace touches the examination: its files and run serve a call again only once the person allows it', async t => {
  const { call, inputs, window, downloads, resumes, answerResume } = page(t, async () => labels());
  personLoads(window, [new File(['scan'], 'scan.nii')]);
  await call('inputs_use_page_files', { role: 'image', input: 't1' });
  const run = await call('run_run');
  assert.equal(run.state, 'succeeded');

  click(window, '#privacy');
  asPerson(window.document.body, new window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  asPerson(window.document.body, new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  assert.equal((await call('app_describe')).touched, false, 'the shared bar, scrolling and modifier keys are not the workspace');

  click(window, '#viewer');
  const describe = await call('app_describe');
  assert.equal(describe.touched, true);
  assert.deepEqual(describe.inputs, { image: [{ name: 'scan.nii', bytes: 4 }] }, 'the agent still holds its files, by name');
  assert.deepEqual(describe.run, { runId: run.runId, state: 'succeeded', touched: true, message: describe.run.message }, 'the report waits for the person');
  assert.match(describe.run.message, /asks them whether you may continue/);
  assert.equal(describe.pageMayHoldOtherInputs, true);
  assert.deepEqual(resumes, [], 'reading the page asks nothing');

  const report = await call('runs_get', { runId: run.runId });
  assert.equal(report.report.artifacts.labels.filename, 'labels.nii', 'the person allowed it, so the run serves the call');
  assert.deepEqual(resumes, [{ app: 'Test', files: [{ role: 'image', name: 'scan.nii', bytes: 4 }], run: { runId: run.runId, operation: 'run', inputs: [{ role: 'image', name: 'scan.nii', bytes: 4 }], started: true }, signal: true }], 'the dialog names the files it keeps by role, and the run by operation, start and the files it ran on');
  assert.deepEqual(await call('outputs_download', { runId: run.runId, artifactId: 'labels' }), { runId: run.runId, artifactId: 'labels' });
  assert.equal((await call('run_run')).state, 'succeeded', 'a rerun on the held files');
  assert.equal(resumes.length, 1, 'once allowed, no call asks again');
  assert.equal(downloads.length, 1);

  const latest = (await call('app_describe')).run.runId;
  asPerson(window.document.getElementById('viewer'), new window.WheelEvent('wheel', { bubbles: true, composed: true }));
  answerResume(false);
  assert.deepEqual(await call('outputs_download', { runId: latest, artifactId: 'labels' }), { declined: true, message: 'The person declined: the held files are released and the earlier runs are withheld.' });
  assert.equal(resumes.length, 2, 'a further interaction asks again');
  assert.equal(downloads.length, 1, 'nothing is saved after Decline');
  const released = await call('app_describe');
  assert.deepEqual(released.inputs, {});
  assert.equal(released.touched, false);
  assert.equal(released.run.stale, true);
  for (const [name, input] of [['runs_get', { runId: latest }], ['runs_cancel', { runId: latest }], ['outputs_download', { runId: latest, artifactId: 'labels' }]]) {
    assert.equal((await call(name, input)).error?.code, 'RUN_STALE', `${name} after Decline`);
  }
  assert.equal(resumes.length, 2, 'nothing is left to resume, so nothing asks');
});

test('a load that replaces the inputs ends the examination: nothing can be resumed', async t => {
  const { call, inputs, window, resumes } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['a'], 'agent.nii')]);
  const run = await call('run_run');
  click(window, '#viewer');
  personLoads(window, [new File(['mine'], 'mine.nii')]);
  const describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {});
  assert.equal(describe.touched, false);
  assert.equal(describe.run.stale, true);
  for (const [name, input] of [['runs_get', { runId: run.runId }], ['outputs_download', { runId: run.runId, artifactId: 'labels' }]]) {
    assert.equal((await call(name, input)).error?.code, 'RUN_STALE', name);
  }
  assert.equal((await call('run_run')).error?.message ?? (await call('runs_get')).error?.message, 'Missing input: image');
  assert.deepEqual(resumes, []);
});

test('a remove the app reports with nd-files after the person pressed it ends the examination; the app filling its list alone does not', async t => {
  const { call, inputs, window } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['a'], 'agent.nii')]);
  const input = window.document.getElementById('t1');
  input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [new File(['x'], 'own.nii')] } }));
  assert.deepEqual(Object.keys((await call('app_describe')).inputs), ['image'], 'an nd-files the person did not cause changes nothing held');
  click(window, '#remove');
  input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [] } }));
  const described = await call('app_describe');
  assert.deepEqual(described.inputs, {});
  assert.equal(described.touched, false);
});

test('a run the person starts in the page leaves the agent\'s run to the resume dialog, which hands over only what that run ended with', async t => {
  const { call, inputs, window, resumes, downloads } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['a'], 'agent.nii')]);
  const run = await call('run_run');
  // The person presses the app's own Run; its result never reaches the automation.
  click(window, '#viewer');
  const reported = await call('runs_get', { runId: run.runId });
  assert.equal(resumes.length, 1, 'the press asks the person first');
  assert.deepEqual(resumes[0].run.inputs, [{ role: 'image', name: 'agent.nii', bytes: 1 }]);
  assert.deepEqual(reported.report, run.report, 'the report the agent\'s run ended with');
  assert.deepEqual(await call('outputs_download', { runId: run.runId, artifactId: 'labels' }), { runId: run.runId, artifactId: 'labels' });
  assert.equal(downloads[0].name, 'labels.nii');
  assert.equal(await sha256Hex(downloads[0]), run.report.artifacts.labels.sha256, 'the bytes the run ended with');
});

async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

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

test('a pick made while a run is going is not recorded, and the run the tools started clears the record', async t => {
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
  assert.deepEqual(describe.pageFiles, [], 'the busy app may have ignored exam B, and the run may have replaced exam A');
  assert.equal(describe.pageMayHoldOtherInputs, true);
  assert.equal((await call('outputs_download', { runId: running.runId, artifactId: 'report' })).error.code, 'RUN_STALE');
});

test('files handed over or dropped on the page that reach no input are listed as received', async t => {
  const { call, inputs, window } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['old'], 'old.nii')]);
  window.document.dispatchEvent(new window.CustomEvent('nd-handoff', { detail: { source: { app: 'dicomview', title: 'DICOM View' }, files: [new File(['sent'], 'sent.nii')] } }));
  let describe = await call('app_describe');
  assert.deepEqual(describe.inputs, {}, 'a handoff ends the examination');
  assert.deepEqual(describe.pageFiles, [{ input: 'received:handoff', label: 'Sent from DICOM View', files: [{ name: 'sent.nii', bytes: 4 }] }]);
  assert.deepEqual(await call('inputs_use_page_files', { role: 'image', input: 'received:handoff' }), { role: 'image', files: [{ name: 'sent.nii', bytes: 4 }] });
  appLoads(window, [new File(['sent'], 'sent.nii')]);
  assert.deepEqual((await call('app_describe')).pageFiles.map(entry => entry.input), ['t1'], 'a handoff delivered into an input is listed once');

  const drop = new window.Event('drop', { bubbles: true, composed: true });
  drop.dataTransfer = { types: ['Files'], items: [{ getAsFile: () => new File(['dropped'], 'dropped.nii') }] };
  asPerson(window.document.getElementById('viewer'), drop);
  await new Promise(resolve => setTimeout(resolve, 10));
  describe = await call('app_describe');
  assert.deepEqual(describe.pageFiles.map(entry => entry.input), ['t1', 'received:drop']);
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
  assert.ok(Object.values(NIIVUE_METHODS).every(kind => ['read', 'display', 'fetch', 'replace', 'denied'].includes(kind)));
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
  set_volume: ['display', 'setVolume display fields, label tables, modulation, chunk grid and spread. affine, reset_affine and transform move the volume, load_all_frames fetches from its address and v1 turns a vector volume into a one-frame colour image for good: refused.'],
  add_mesh_layer: ['fetch', 'addMeshLayer from url.'],
  add_overlay: ['fetch', 'addVolume from url, and a label table from labels.'],
  load_mesh: ['fetch', 'addMesh from url and each layer url; replace removes the meshes before it, so it is refused.'],
  load_volume: ['replace', 'loadVolumes from url, replacing the volumes: the consent says so.'],
};

// What each parameter a method takes over WebMCP does, read from the same source:
//   read     chooses what a read returns
//   display  changes only how what is loaded is shown: camera, crosshair, colours, layout, labels drawn
//            over the scene, or how the file a fetch adds is named and shown
//   address  names a file the call adds, which the person approves before the tool fetches it
// No taken parameter removes, moves or converts what is loaded; those are refused below.
const NIIVUE_PARAMETER_EFFECTS = {
  capabilities: {},
  describe_volume: { read: 'volume stats mask mask_labels drawing affine' },
  get_options: { read: 'names describe' },
  list_annotations: { read: 'polygons json svg slice slice_position' },
  list_measurements: {},
  list_meshes: {},
  list_regions: { read: 'query' },
  list_signals: {},
  map_point: { read: 'canvas mm vox' },
  where_am_i: {},
  animate: { display: 'azimuth elevation zoom render_pan pan_2d crosshair_mm clip_planes volumes meshes duration_ms easing angles interrupt_on_input wait stop' },
  go_to_point: { display: 'mm vox plane label' },
  go_to_region: { display: 'region plane' },
  nudge_crosshair: { display: 'vox' },
  set_boxes: { display: 'focus boxes' },
  set_camera: { display: 'azimuth elevation pan_2d render_pan pivot center_on global' },
  set_clip_plane: { display: 'plane azimuth elevation index planes depth face' },
  set_custom_layout: { display: 'tiles clear' },
  set_graph: { display: 'cursor step zoom pan range reset' },
  set_instances: { display: 'instances camera clear' },
  set_labels: { display: 'labels dim_others clear' },
  set_mesh: { display: 'mesh name opacity color shader slice_shader visible colorbar legend tract connectome' },
  set_mesh_layer: { display: 'mesh layer colormap colormap_negative cal_min cal_max cal_min_neg cal_max_neg opacity colorbar invert transparent_below_cal_min additive outline_width frame' },
  set_view: { display: 'slice layout mosaic show_render radiological colorbar' },
  set_viewport: { display: 'pan zoom bounds reset' },
  set_volume: { display: 'volume colormap colormap_negative opacity cal_min cal_max cal_min_neg cal_max_neg colormap_type transparent_below_cal_min frame invert colorbar nearest atlas_outline modulate_alpha modulate auto_window chunk_grid spread', address: 'labels' },
  add_mesh_layer: { address: 'url', display: 'mesh name colormap colormap_negative cal_min cal_max cal_min_neg cal_max_neg opacity colorbar invert transparent_below_cal_min additive outline_width' },
  add_overlay: { address: 'url labels', display: 'name colormap opacity cal_min cal_max colormap_negative cal_min_neg cal_max_neg colorbar' },
  load_mesh: { address: 'url layers', display: 'name opacity color shader slice_shader visible colorbar legend' },
  load_volume: { address: 'url', display: 'name colormap mni' },
};

test('every method viewers_niivue offers is audited against the pinned nv-mcp source', async () => {
  const { devDependencies, dependencies } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = dependencies?.['@niivue/nv-mcp'] ?? devDependencies['@niivue/nv-mcp'];
  assert.equal(pinned, AUDITED_NV_MCP, 'nv-mcp changed: audit each offered method again, then update AUDITED_NV_MCP');
  const offered = Object.entries(NIIVUE_METHODS).filter(([, kind]) => kind !== 'denied');
  assert.deepEqual(Object.fromEntries(offered), Object.fromEntries(Object.entries(NIIVUE_AUDIT).map(([method, [kind]]) => [method, kind])));
  for (const method of ['set_slide', 'set_signal', 'load_document']) assert.equal(NIIVUE_METHODS[method], 'denied', `${method} edits annotations or loads a document that names further addresses`);
  assert.equal(NIIVUE_METHODS.load_signal, 'denied', 'NiiVue reads a signal\'s format from its address, so it cannot take the approved bytes');
});

// The parameters of each offered method that viewers_niivue refuses, with why; every other parameter
// nv-mcp's schema lists is in NIIVUE_PARAMETERS. A parameter nv-mcp adds fails this test until it is
// classified in one or the other.
const REFUSED_NIIVUE_PARAMETERS = {
  '*': { tab: ['desktop', 'chooses a tab of the desktop server; a page answers for itself'] },
  set_volume: {
    affine: ['moves', 'sets the voxel-to-world matrix: moves the volume'],
    reset_affine: ['moves', 'puts the file\'s matrix back: moves the volume'],
    transform: ['moves', 'moves, turns or scales the volume'],
    load_all_frames: ['fetches', 'fetches the remaining frames from the volume\'s own address'],
    v1: ['converts', 'turns a three-frame vector volume into a one-frame colour image, which only a reload undoes'],
  },
  load_mesh: {
    replace: ['removes', 'removes every mesh loaded before, which the consent for the new mesh does not name'],
  },
};

test('every parameter of an offered NiiVue method is either taken or refused with a reason, against nv-mcp\'s schemas', () => {
  assert.deepEqual(Object.keys(NIIVUE_PARAMETERS).sort(), Object.keys(NIIVUE_AUDIT).sort());
  for (const [method, allowed] of Object.entries(NIIVUE_PARAMETERS)) {
    const refused = Object.keys({ ...REFUSED_NIIVUE_PARAMETERS['*'], ...REFUSED_NIIVUE_PARAMETERS[method] });
    assert.deepEqual([...allowed, ...refused].sort(), Object.keys(CORE_SCHEMAS[method]).sort(), `${method}: nv-mcp's parameters are each classified`);
    assert.deepEqual(allowed.filter(name => refused.includes(name)), [], `${method}: no parameter is both taken and refused`);
  }
});

test('every parameter viewers_niivue takes was audited as reading, changing the display or naming the approved file, and none removes or alters what is loaded', () => {
  assert.deepEqual(Object.keys(NIIVUE_PARAMETER_EFFECTS).sort(), Object.keys(NIIVUE_PARAMETERS).sort());
  for (const [method, effects] of Object.entries(NIIVUE_PARAMETER_EFFECTS)) {
    assert.ok(Object.keys(effects).every(effect => ['read', 'display', 'address'].includes(effect)), `${method}: only read, display and address are taken`);
    const audited = Object.values(effects).flatMap(names => names.split(' '));
    assert.deepEqual(audited.sort(), [...NIIVUE_PARAMETERS[method]].sort(), `${method}: each taken parameter records the effect it was audited as`);
    const kind = NIIVUE_METHODS[method];
    if (kind === 'read') assert.deepEqual(Object.keys(effects).filter(effect => effect !== 'read'), [], `${method} only reads`);
    if (kind === 'fetch' || kind === 'replace') assert.ok(effects.address, `${method} names the file it adds`);
  }
  for (const reasons of Object.values(REFUSED_NIIVUE_PARAMETERS)) {
    for (const [name, [effect, reason]] of Object.entries(reasons)) assert.ok(['desktop', 'moves', 'fetches', 'converts', 'removes'].includes(effect) && reason, `${name} is refused for its effect`);
  }
});

function viewerPage(t, options = {}) {
  const sent = [];
  const confirmations = [];
  const fetched = [];
  let approve = false;
  const urlContract = contract();
  urlContract.operations.run.inputs.store = { source: 'url', type: 'neuro:volume', description: 'A remote store', minimum: 0, maximum: 1 };
  const turn = { controller: new AbortController() };
  const tools = webMcpTools({ contract: urlContract, inputs: { turn: () => turn, touched: () => false, stage: async () => {}, claim() {}, settle() {}, settled: () => null, runOf: () => 'current', held: () => ({}), page: () => [], toolLoaded() {} },
    dispatch: async (command, request) => {
      if (command === 'sources') return Object.fromEntries(Object.entries(request.inputs).map(([role, { url }]) => [role, { address: url, root: url.replace(/\/\.zattrs$/, '') }]));
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
      confirmations.push({ ...allowing(request), signal: Boolean(signal) });
      return approve && allowing(request);
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
  for (const [method, key] of [...Object.keys(REFUSED_NIIVUE_PARAMETERS.set_volume).map(key => ['set_volume', key]), ['load_mesh', 'replace'], ['set_volume', 'tab'], ['set_volume', 'not_a_parameter'], ['where_am_i', 'volume'], ['load_volume', 'headers']]) {
    const refused = await call('viewers_niivue', { viewerId: 'main', method, params: { [key]: true } });
    assert.equal(refused.error?.code, 'INVALID_INPUT', `${method} ${key}`);
    assert.match(refused.error.message, new RegExp(`does not take ${key}`));
  }
  assert.equal((await call('viewers_niivue', { viewerId: 'main', params: { slice: 'axial' } })).error?.code, 'INVALID_INPUT', 'params need a method');
  assert.deepEqual(sent, [], 'no pixel export, save, document or data change reached the viewer');

  const url = 'https://elsewhere.test/scan.nii.gz';
  assert.deepEqual(await call('viewers_niivue', { viewerId: 'main', method: 'load_volume', params: { url } }), { declined: true, addresses: [url] });
  assert.deepEqual(confirmations, [{ app: 'Test', addresses: [url], replaces: true, signal: true }], 'load_volume replaces what the viewer shows, and the consent says so');
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
  assert.deepEqual(await call('run_run', { inputs: { store: { url: `${store}/.zattrs` } }, waitSeconds: 0 }), { declined: true, addresses: [store] });
  assert.deepEqual(confirmations.map(request => [request.addresses, request.readsUnder]), [[[store], true]], 'the person allows the root the app reads under, as the app computes it, not the metadata file the agent named');
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
    fetchAsset: async () => new TextEncoder().encode('head').buffer, confirmFiles: async request => allowing(request), ...options });
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
  assert.deepEqual(describe.pageFiles.map(entry => entry.files[0].name), ['new-exam.nii'], 'it stays listed as what the page received, to confirm');
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
  assert.deepEqual((await call('app_describe')).pageFiles, [{ input: 't1', kind: 'image', label: 'T1 image', files: [{ name: 'picked.nii', bytes: 4 }] }]);
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

// A page whose every request to the app, the prompts and the fetchers can be held after it settles, so a
// test can change the examination at exactly that point. The requests reach the real automation.
function racePage(t) {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const downloads = [];
  const registration = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() },
    document: dom.window.document, target: dom.window, download: file => downloads.push(file) });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation, isPerson });
  const requests = [];
  let holdAt = -1;
  let held;
  const gate = (name, request) => async (...args) => {
    const index = requests.push(name) - 1;
    const answer = Promise.resolve().then(() => request(...args));
    if (index !== holdAt) return answer;
    const [settled] = await Promise.allSettled([answer]);
    const release = Promise.withResolvers();
    held.resolve({ index, release: release.resolve });
    await release.promise;
    if (settled.status === 'rejected') throw settled.reason;
    return settled.value;
  };
  const tools = webMcpTools({ contract: contract(), inputs,
    dispatch: gate('dispatch', automation.dispatch),
    examples: gate('examples', () => examples),
    fetchAsset: gate('fetchAsset', async () => new TextEncoder().encode('head').buffer),
    fetchAddress: gate('fetchAddress', async address => ({ blob: new Blob(['volume']), href: address })),
    askUser: gate('askUser', async () => ({ answer: 'yes' })),
    requestFiles: gate('requestFiles', async () => [new File(['input'], 'input.nii')]),
    confirmFiles: gate('confirmFiles', async request => allowing(request)),
    confirmFetch: gate('confirmFetch', async request => allowing(request)),
    confirmResume: gate('confirmResume', async request => allowing(request)) });
  const call = (name, input = {}) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  return {
    tools, call, inputs, downloads, registration, requests, window: dom.window,
    holdAt(index) {
      holdAt = index;
      held = Promise.withResolvers();
      return held.promise;
    },
  };
}

// One valid call per tool, on a page where the person loaded a scan and the tools hold a file and ran once.
const RACE_CALLS = {
  app_describe: () => ({}),
  inputs_request_files: () => ({ role: 'image' }),
  inputs_use_page_files: () => ({ role: 'image', input: 't1' }),
  inputs_load_example: () => ({ exampleId: 'head' }),
  run_run: () => ({ waitSeconds: 5 }),
  runs_get: () => ({}),
  runs_cancel: () => ({}),
  outputs_download: runId => ({ runId, artifactId: 'labels' }),
  user_ask: () => ({ question: 'Which?' }),
  viewers_list: () => ({}),
  viewers_state: () => ({ viewerId: 'main' }),
  viewers_crosshair: () => ({ viewerId: 'main', position: { frame: 'mm', value: [0, 0, 0] } }),
  viewers_tab: () => ({ viewerId: 'main', tabId: 'a' }),
  viewers_regions: () => ({ viewerId: 'main' }),
  viewers_volumes: () => ({ viewerId: 'main' }),
  viewers_display: () => ({ viewerId: 'main', sliceType: 'axial' }),
  viewers_niivue: () => ({ viewerId: 'main', method: 'load_volume', params: { url: 'https://example.test/scan.nii.gz' } }),
};

async function racePrepared(t, touched = false) {
  const race = racePage(t);
  personLoads(race.window, [new File(['scan'], 'scan.nii')]);
  await race.call('inputs_request_files', { role: 'image' });
  const { runId } = await race.call('run_run');
  personLoads(race.window, [new File(['scan'], 'scan.nii')]);
  await race.call('inputs_request_files', { role: 'image' });
  const current = await race.call('run_run');
  appLoads(race.window, [new File(['scan'], 'scan.nii')]);
  if (touched) click(race.window, '#viewer');
  race.requests.length = 0;
  return { race, runId: current.runId ?? runId };
}

test('every tool call that the person interrupts after any answer it awaited withholds its result and does nothing more', async t => {
  const { tools } = racePage(t);
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(RACE_CALLS).sort(), 'every tool has a call in RACE_CALLS');
  const resuming = new Set();
  for (const [name, touched] of Object.keys(RACE_CALLS).flatMap(tool => [[tool, false], [tool, true]])) {
    const { race, runId } = await racePrepared(t, touched);
    const result = await race.call(name, RACE_CALLS[name](runId));
    const steps = race.requests.length;
    assert.ok(steps > 0, `${name} awaits at least one answer (${JSON.stringify(result)})`);
    if (race.requests.includes('confirmResume')) resuming.add(name);
    for (let index = 0; index < steps; index += 1) {
      const { race: interrupted, runId: run } = await racePrepared(t, touched);
      const reached = interrupted.holdAt(index);
      const pending = interrupted.call(name, RACE_CALLS[name](run));
      const { release } = await reached;
      click(interrupted.window, '#viewer');
      const issued = interrupted.requests.length;
      const saved = interrupted.downloads.length;
      const held = interrupted.inputs.held();
      release();
      const outcome = await pending;
      assert.equal(outcome.error?.code, 'EXAMINATION_CHANGED', `${name}, interrupted after ${interrupted.requests[index]} (step ${index + 1} of ${steps}): ${JSON.stringify(outcome)}`);
      assert.deepEqual(interrupted.requests.slice(issued), [], `${name} asks nothing more after step ${index + 1}`);
      assert.equal(interrupted.downloads.length, saved, `${name} saves nothing more`);
      assert.deepEqual(interrupted.inputs.held(), held, `${name} holds nothing more`);
      assert.equal(interrupted.inputs.touched(), true, `${name}: the person's press leaves the examination touched, to resume on the next call`);
    }
  }
  assert.deepEqual([...resuming].sort(), ['outputs_download', 'run_run', 'runs_cancel', 'runs_get'], 'on a touched examination, exactly the calls that use the held files or the run ask to resume');
});

test('a call interrupted between two polls of a run returns EXAMINATION_CHANGED, as any interrupted call does', async t => {
  let finish;
  const { call, inputs, registration, window } = page(t, () => new Promise(resolve => { finish = () => resolve(labels()); }));
  hold(inputs, 'image', [new File(['a'], 'agent.nii')]);
  const { runId } = await call('run_run', { waitSeconds: 0 });
  for (const interrupt of [() => click(window, '#viewer'), () => registration.reset()]) {
    const waiting = call('runs_get', { runId, waitSeconds: 5 });
    await new Promise(resolve => setTimeout(resolve, 60));
    interrupt();
    const outcome = await waiting;
    assert.equal(outcome.error?.code, 'EXAMINATION_CHANGED', JSON.stringify(outcome));
  }
  finish();
});

test('a question queued behind another is dropped, never shown, once the person resets the page', async t => {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };
  dom.window.fetch = async () => ({ ok: false, json: async () => [] });
  const registered = new Map();
  const registration = registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() }, document, target: dom.window });
  await exposeWebMcp({ async registerTool(tool) { registered.set(tool.name, tool); } }, document);
  const ask = question => registered.get('user_ask').execute({ question, options: ['Yes'] }, { signal: new AbortController().signal });
  const shown = [];
  new dom.window.MutationObserver(() => {
    const text = document.querySelector('#neurodeskAgentPrompt[open]')?.textContent ?? '';
    for (const question of ['First question', 'Queued question']) if (text.includes(question) && !shown.includes(question)) shown.push(question);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const first = ask('First question');
  const queued = ask('Queued question');
  while (!shown.length) await new Promise(resolve => setTimeout(resolve, 5));
  registration.reset();
  // A question that the reset does not close or drop stays open for an answer that never comes.
  const pending = new Promise(resolve => { setTimeout(() => resolve({ error: { code: 'STILL OPEN OR QUEUED' } }), 2000); });
  assert.equal((await Promise.race([first, pending])).error?.code, 'EXAMINATION_CHANGED');
  assert.equal((await Promise.race([queued, pending])).error?.code, 'EXAMINATION_CHANGED');
  assert.deepEqual(shown, ['First question'], 'the queued question never reached the person');
});

test('a runs_get that the page answers after a reset returns no report of the run before', async t => {
  const { race, runId } = await racePrepared(t);
  const reached = race.holdAt(0);
  const pending = race.call('runs_get', { runId });
  const { release } = await reached;
  race.registration.reset();
  release();
  const outcome = await pending;
  assert.equal(outcome.error?.code, 'EXAMINATION_CHANGED');
  assert.equal(JSON.stringify(outcome).includes('labels.nii'), false, 'nothing of the old report');
});

test('an outputs_download whose run check answers after the person picks an example in the page saves nothing', async t => {
  const { race, runId } = await racePrepared(t);
  const reached = race.holdAt(0);
  const pending = race.call('outputs_download', { runId, artifactId: 'labels' });
  const { release } = await reached;
  race.window.document.body.dispatchEvent(new race.window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'loading' } }));
  release();
  assert.equal((await pending).error?.code, 'EXAMINATION_CHANGED');
  assert.deepEqual(race.downloads, []);
});

test('an approved viewer fetch that finishes after the person used the workspace loads nothing', async t => {
  const { race } = await racePrepared(t);
  const reached = race.holdAt(1);
  const pending = race.call('viewers_niivue', RACE_CALLS.viewers_niivue());
  const { index, release } = await reached;
  assert.equal(race.requests[index], 'fetchAddress');
  click(race.window, '#viewer');
  release();
  assert.equal((await pending).error?.code, 'EXAMINATION_CHANGED');
  assert.deepEqual(race.requests, ['confirmFetch', 'fetchAddress'], 'the viewer is never asked to load');
});

test('a run the tools start forgets what the page received, since the app may show the run\'s files without saying so', async t => {
  let window;
  const { call, inputs, confirmations, window: pageWindow } = page(t, async () => {
    window.document.getElementById('t1').title = 'shows agent-b.nii without a change event, as NiiMath does';
    return labels();
  });
  window = pageWindow;
  personLoads(window, [new File(['a'], 'person-a.nii')]);
  assert.deepEqual((await call('app_describe')).pageFiles.map(entry => entry.files[0].name), ['person-a.nii']);
  hold(inputs, 'image', [new File(['b'], 'agent-b.nii')]);
  assert.equal((await call('run_run')).report.inputs.image[0].filename, 'agent-b.nii');
  const described = await call('app_describe');
  assert.deepEqual(described.pageFiles, [], 'person-a.nii is no longer offered as what the page has');
  assert.equal(described.pageExample, null);
  assert.match((await call('inputs_use_page_files', { role: 'image', input: 't1' })).error.message, /No files are loaded/);
  assert.deepEqual(confirmations, []);
});

test('the automation names the address an app reads under for a url input, computed by the app itself', async t => {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const urlContract = contract();
  urlContract.operations.run.inputs.store = { source: 'url', type: 'neuro:volume', formats: ['ome-zarr'], description: 'A store', minimum: 0, maximum: 1 };
  const strip = url => url.replace(/\/\.zattrs$/, '');
  registerAppAutomation({ app: 'test', contract: urlContract, operations: { run: async () => labels() }, document: dom.window.document, target: dom.window, sourceRoots: { store: strip } });
  const { dispatch } = dom.window.neurodeskAutomation;
  assert.deepEqual(await dispatch('sources', { inputs: { store: { url: 'https://store.test/a.zarr/.zattrs' } } }),
    { store: { address: 'https://store.test/a.zarr/.zattrs', root: 'https://store.test/a.zarr' } });
  await assert.rejects(dispatch('sources', { inputs: { store: { url: 's3://bucket/a.zarr' } } }), /Unsupported source URL/, 'refused before the person is asked, as the run would refuse it');
  await assert.rejects(dispatch('sources', { inputs: { image: { url: 'https://store.test/a.nii' } } }), /takes files/);
  await assert.rejects(dispatch('sources', { inputs: { mask: { url: 'https://store.test/a.nii' } } }), /Unknown input role/);
});

test('what each interaction does to the examination is decided in one place', async t => {
  const dom = new JSDOM(`${WORKSPACE.replace('</main>', '<div id="host"></div><input type="file" id="plain"><select id="choice"><option>a</option></select></main>')}`, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const host = window.document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input type="file" id="shadowed" data-neurodesk-input="image" aria-label="Shadowed image"><button id="inner">Inner</button>';
  const inputs = createToolInputs({ doc: window.document, automation: { running: () => false, adopt: async () => {} }, isPerson });
  const effect = (target, event, person = true) => {
    if (!Object.keys(inputs.held()).length || inputs.touched()) hold(inputs, 'image', [new File(['x'], 'agent.nii')]);
    if (inputs.touched()) inputs.resume(inputs.turn());
    if (person) asPerson(target, event);
    else target.dispatchEvent(event);
    if (!Object.keys(inputs.held()).length) return 'ended';
    return inputs.touched() ? 'touched' : 'kept';
  };
  const viewer = window.document.getElementById('viewer');
  const { document } = window;
  assert.equal(effect(viewer, new window.WheelEvent('wheel', { bubbles: true, composed: true })), 'touched', 'a wheel over the viewer changes what it shows');
  assert.equal(effect(document.body, new window.WheelEvent('wheel', { bubbles: true, composed: true })), 'kept', 'a wheel elsewhere scrolls the page');
  assert.equal(effect(viewer, new window.MouseEvent('pointerdown', { bubbles: true, composed: true })), 'touched', 'a drag starts on press, before release');
  assert.equal(effect(viewer, new window.MouseEvent('pointermove', { bubbles: true, composed: true })), 'kept', 'moving the pointer over the page does not count');
  assert.equal(effect(document.getElementById('privacy'), new window.MouseEvent('pointerdown', { bubbles: true, composed: true })), 'kept', 'the shared bar is not the workspace');
  assert.equal(effect(document.getElementById('choice'), new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })), 'touched', 'typing in a control');
  assert.equal(effect(shadow.getElementById('inner'), new window.MouseEvent('pointerup', { bubbles: true, composed: true })), 'touched', 'an action inside a shadow root counts');
  const plain = document.getElementById('plain');
  assert.equal(effect(plain, new window.Event('change', { bubbles: true })), 'ended', 'a pick in any file input replaces the inputs');
  const drop = new window.Event('drop', { bubbles: true, composed: true });
  drop.dataTransfer = { types: ['Files'], items: [] };
  assert.equal(effect(viewer, drop), 'ended', 'files dropped on the page');
  const textDrop = new window.Event('drop', { bubbles: true, composed: true });
  textDrop.dataTransfer = { types: ['text/plain'], items: [] };
  assert.equal(effect(viewer, textDrop), 'touched', 'a drop without files');
  const status = state => new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state } });
  assert.equal(effect(document.body, status('loading'), false), 'ended', 'the example selector starting a load');
  assert.equal(effect(document.body, status('ready'), false), 'kept');
  assert.equal(effect(document, new window.CustomEvent('nd-handoff', { detail: { files: [] } }), false), 'ended', 'a handoff');
  assert.equal(effect(window, new window.Event('neurodesk-automation-reset'), false), 'ended', 'the app resetting');
  assert.equal(effect(document.getElementById('t1'), new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [] } }), false), 'kept', 'an app reporting its list on its own');
  const touchedThen = (event, target) => {
    hold(inputs, 'image', [new File(['x'], 'agent.nii')]);
    asPerson(viewer, new window.MouseEvent('pointerup', { bubbles: true, composed: true }));
    target.dispatchEvent(event);
    return Object.keys(inputs.held()).length ? 'touched' : 'ended';
  };
  assert.equal(touchedThen(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [] } }), document.getElementById('t1')), 'ended', 'a remove the person pressed, reported with nd-files');
  assert.equal(touchedThen(new window.Event('change', { bubbles: true }), document.getElementById('t1')), 'ended', 'the page putting other files on an input after a press, as Undo does');
  assert.equal(effect(document.getElementById('t1'), new window.Event('change', { bubbles: true }), false), 'kept', 'the page or a run filling an input with nobody at the page');
  const prompt = document.createElement('dialog');
  prompt.id = 'neurodeskAgentPrompt';
  const promptField = document.createElement('div');
  prompt.append(promptField);
  document.body.append(prompt);
  assert.equal(touchedThen(new window.CustomEvent('nd-files', { bubbles: true, composed: true, detail: { files: [] } }), promptField), 'touched', 'the agent\'s own file dialog reporting its files');
  const shadowed = shadow.getElementById('shadowed');
  Object.defineProperty(shadowed, 'files', { configurable: true, value: [new File(['s'], 'shadow-pick.nii')] });
  assert.equal(effect(shadowed, new window.Event('input', { bubbles: true, composed: true })), 'ended', 'a pick in a shadow root counts');
  assert.deepEqual(inputs.page(), [{ input: 'shadowed', kind: 'image', label: 'Shadowed image', files: [{ name: 'shadow-pick.nii', bytes: 1 }] }], 'and is listed, though its change event stays inside the shadow root');
});

const SITE = new URL('../../../site/', import.meta.url);

test('the shell\'s first classic script sees every action of the person before a listener of the page or the shell can stop it', async t => {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.document.modelContext = {};
  window.eval(await readFile(new URL('theme.js', SITE), 'utf8'));
  assert.deepEqual([...window[PERSON_INPUT].types], INTERACTIONS, 'the shell\'s script listens for every action the tools judge');
  // The page's own capture listener on window, as the shell's page drop has for a drop on a canvas.
  for (const type of ['drop', 'pointerdown', 'keydown']) window.addEventListener(type, event => event.stopImmediatePropagation(), true);
  registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() }, document: window.document, target: window });
  const inputs = createToolInputs({ doc: window.document, automation: window.neurodeskAutomation, isPerson });
  hold(inputs, 'image', [new File(['a'], 'agent.nii')]);
  asPerson(window.document.getElementById('viewer'), new window.MouseEvent('pointerdown', { bubbles: true, composed: true }));
  assert.equal(inputs.touched(), true, 'a press the page stops at window');
  const drop = new window.Event('drop', { bubbles: true, composed: true });
  drop.dataTransfer = { types: ['Files'], items: [] };
  asPerson(window.document.getElementById('viewer'), drop);
  assert.deepEqual(inputs.held(), {}, 'a drop of files the shell takes on the canvas ends the examination');
});

test('without the shell\'s script the tools listen on window, so a drop the page drop stops on the way down is still seen', async t => {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.addEventListener('drop', event => event.stopPropagation(), true);
  const inputs = createToolInputs({ doc: window.document, automation: { running: () => false, adopt: async () => {} }, isPerson });
  hold(inputs, 'image', [new File(['a'], 'agent.nii')]);
  for (const type of ['dragenter', 'dragover']) {
    if (inputs.touched()) inputs.resume(inputs.turn());
    const drag = new window.Event(type, { bubbles: true, composed: true });
    drag.dataTransfer = { types: ['Files'], items: [] };
    asPerson(window.document.getElementById('viewer'), drag);
    assert.equal(inputs.touched(), true, `${type} carrying files over the page`);
  }
  const drop = new window.Event('drop', { bubbles: true, composed: true });
  drop.dataTransfer = { types: ['Files'], items: [] };
  asPerson(window.document.getElementById('viewer'), drop);
  assert.deepEqual(inputs.held(), {});
});

test('the resume dialog names the files of the run it discloses apart from the files the agent holds now', async t => {
  const { call, inputs, window, resumes } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['first'], 'first.nii')]);
  const run = await call('run_run');
  hold(inputs, 'image', [new File(['second scan'], 'second.nii')]);
  click(window, '#viewer');
  const report = await call('runs_get', { runId: run.runId });
  assert.equal(report.report.inputs.image[0].filename, 'first.nii');
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].files, [{ role: 'image', name: 'second.nii', bytes: 11 }], 'the files it keeps');
  assert.deepEqual(resumes[0].run.inputs, [{ role: 'image', name: 'first.nii', bytes: 5 }], 'the files the disclosed run ran on');
});

test('calls that need the person\'s answer after one touch share one dialog and its answer', async t => {
  for (const allow of [true, false]) {
    let asked = 0;
    let answer;
    const { call, inputs, window, downloads } = page(t, async () => labels(), {
      confirmResume: request => {
        asked += 1;
        return new Promise(resolve => { answer = value => resolve(value && allowing(request)); });
      },
    });
    hold(inputs, 'image', [new File(['scan'], 'scan.nii')]);
    const run = await call('run_run');
    click(window, '#viewer');
    const report = call('runs_get', { runId: run.runId });
    const saved = call('outputs_download', { runId: run.runId, artifactId: 'labels' });
    while (!answer) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    answer(allow);
    const [reported, download] = await Promise.all([report, saved]);
    assert.equal(asked, 1, `one dialog for one touch (${allow ? 'Allow' : 'Decline'})`);
    if (allow) {
      assert.equal(reported.state, 'succeeded');
      assert.deepEqual(download, { runId: run.runId, artifactId: 'labels' });
      assert.equal(downloads.length, 1);
    } else {
      assert.equal(reported.declined, true);
      assert.equal(download.declined, true, 'the second call takes the same Decline');
      assert.equal(downloads.length, 0);
    }
  }
});

test('after Allow the tools disclose only the run the dialog named, with the report it finished with', async t => {
  let altered = null;
  const holder = {};
  const { call, inputs, window, downloads, resumes } = page(t, async () => labels(), {
    dispatch: async (command, request) => {
      const answer = await holder.dispatch(command, request);
      if (command !== 'snapshot' || !altered || answer.runId !== altered) return answer;
      return { ...answer, report: { ...answer.report, artifacts: { labels: { ...answer.report.artifacts.labels, sha256: '0'.repeat(64) } } } };
    },
  });
  holder.dispatch = window.neurodeskAutomation.dispatch;
  hold(inputs, 'image', [new File(['scan'], 'scan.nii')]);
  const earlier = await call('run_run');
  const latest = await call('run_run');
  assert.equal(latest.state, 'succeeded');
  click(window, '#viewer');
  altered = latest.runId;
  const reported = await call('runs_get', { runId: latest.runId });
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].run.runId, latest.runId, 'the dialog names the latest run');
  assert.deepEqual(reported.report, latest.report, 'the report the run finished with, not what the page answers now');
  const refused = await call('outputs_download', { runId: latest.runId, artifactId: 'labels' });
  assert.equal(refused.error?.code, 'RUN_STALE', 'the page holds other outputs for that run now');
  assert.match(refused.error.message, /other results/);
  assert.equal(downloads.length, 0);
  assert.equal((await call('runs_get', { runId: earlier.runId })).error?.code, 'RUN_STALE', 'a run the dialog did not name stays withheld');
});

test('the page download takes the checksum the tools recorded and saves nothing when the run\'s output differs', async t => {
  const { call, inputs, dispatch, downloads } = page(t, async () => labels());
  hold(inputs, 'image', [new File(['scan'], 'scan.nii')]);
  const run = await call('run_run');
  await assert.rejects(dispatch('download', { runId: run.runId, artifactId: 'labels', sha256: '0'.repeat(64) }), error => error.code === 'RUN_NOT_CURRENT');
  assert.equal(downloads.length, 0);
  assert.deepEqual(await dispatch('download', { runId: run.runId, artifactId: 'labels', sha256: run.report.artifacts.labels.sha256 }), { artifactId: 'labels' });
  assert.equal(downloads.length, 1);
});

test('a resume queued behind the agent\'s file request names the file chosen in it, and Allow hands back that file', async t => {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new window.Event('close')));
  };
  registerAppAutomation({ app: 'test', contract: contract(), operations: { run: async () => labels() }, document: window.document, target: window });
  const automation = window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: window.document, automation, isPerson });
  const prompts = createAgentPrompts(window.document);
  const tools = webMcpTools({ contract: contract(), dispatch: automation.dispatch, inputs, examples: () => examples,
    requestFiles: prompts.requestFiles, confirmResume: prompts.confirmResume });
  const call = (name, input = {}) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const prompt = () => window.document.getElementById('neurodeskAgentPrompt');
  hold(inputs, 'image', [new File(['original'], 'original.nii')]);
  const run = await call('run_run');
  click(window, '#viewer');
  const request = call('inputs_request_files', { role: 'image' });
  await tick();
  const report = call('runs_get', { runId: run.runId });
  await tick();
  const field = prompt().querySelector('nd-file-field');
  Object.defineProperty(field.input, 'files', { configurable: true, value: [new File(['changed scan'], 'changed.nii')] });
  field.input.dispatchEvent(new window.Event('change'));
  assert.deepEqual((await request).files, [{ name: 'changed.nii', bytes: 12 }]);
  await tick();
  const lists = [...prompt().querySelectorAll('ul')].map(list => [...list.querySelectorAll('li')].map(item => item.textContent));
  assert.deepEqual(lists, [['image: original.nii'], ['image: changed.nii']], 'the run\'s file, then the file chosen while the resume waited');
  [...prompt().querySelectorAll('button')].find(button => button.textContent === 'Allow').click();
  assert.equal((await report).report.runId, run.runId);
  assert.equal((await call('run_run')).report.inputs.image[0].filename, 'changed.nii', 'the next run uses the file the dialog named');
});

test('Allow is applied only while the held files are still the ones the resume dialog named; otherwise it asks again', async t => {
  const holder = {};
  const shown = [];
  const { call, inputs, window } = page(t, async () => labels(), {
    confirmResume: async request => {
      const state = request();
      shown.push(state.files.map(file => file.name));
      // The agent's file request answers after the dialog was read and before its answer is applied.
      if (shown.length === 1) hold(holder.inputs, 'image', [new File(['b'], 'replacement.nii')]);
      return state;
    },
  });
  holder.inputs = inputs;
  hold(inputs, 'image', [new File(['a'], 'original.nii')]);
  const run = await call('run_run');
  click(window, '#viewer');
  assert.equal((await call('runs_get', { runId: run.runId })).report.runId, run.runId);
  assert.deepEqual(shown, [['original.nii'], ['replacement.nii']], 'asked again with the files it now holds');
});

test('the resume dialog names the run by what its operation read: its own file roles and the root of each address', async t => {
  const dom = new JSDOM(WORKSPACE, { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const twoOperations = contract();
  const run = twoOperations.operations.run;
  twoOperations.operations = {
    correct: { ...structuredClone(run), inputs: { uni: { ...run.inputs.image, description: 'UNI image' } } },
    denoise: { ...structuredClone(run), inputs: { inv1: { ...run.inputs.image, description: 'INV1 image' }, store: { source: 'url', type: 'neuro:volume', formats: ['ome-zarr'], description: 'A store', minimum: 0, maximum: 1 } } },
  };
  twoOperations.defaultOperation = 'correct';
  registerAppAutomation({ app: 'test', contract: twoOperations, operations: { correct: async () => labels(), denoise: async () => labels() },
    sourceRoots: { store: address => address.replace(/\/\.zattrs$/, '') }, document: dom.window.document, target: dom.window });
  const automation = dom.window.neurodeskAutomation;
  const inputs = createToolInputs({ doc: dom.window.document, automation, isPerson });
  const resumes = [];
  const tools = webMcpTools({ contract: twoOperations, dispatch: automation.dispatch, inputs, examples: () => [],
    confirmFetch: async request => allowing(request),
    confirmResume: async request => {
      resumes.push(named(allowing(request)));
      return allowing(request);
    } });
  const call = (name, input = {}) => tools.find(tool => tool.name === name).execute(input, { signal: new AbortController().signal });
  hold(inputs, 'uni', [new File(['u'], 'uni.nii')]);
  hold(inputs, 'inv1', [new File(['i'], 'inv1.nii')]);
  const corrected = await call('run_correct');
  assert.equal(corrected.state, 'succeeded', JSON.stringify(corrected.error));
  click(dom.window, '#viewer');
  await call('runs_get', { runId: corrected.runId });
  assert.deepEqual(resumes[0].run.inputs, [{ role: 'uni', name: 'uni.nii', bytes: 1 }], 'only the role the correct operation reads');
  assert.deepEqual(resumes[0].files.map(file => file.role), ['uni', 'inv1'], 'it keeps both roles for its next run');
  const denoised = await call('run_denoise', { inputs: { store: { url: 'https://data.test/brain.ome.zarr/.zattrs' } } });
  assert.equal(denoised.state, 'succeeded', JSON.stringify(denoised.error));
  click(dom.window, '#viewer');
  await call('runs_get', { runId: denoised.runId });
  assert.deepEqual(resumes[1].run.inputs, [{ role: 'inv1', name: 'inv1.nii', bytes: 1 }, { role: 'store', url: 'https://data.test/brain.ome.zarr' }], 'its file role and the store root the person allowed');
});
