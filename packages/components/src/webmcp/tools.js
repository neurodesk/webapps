import { fetchModel } from '../worker/fetchModel.js';
import { convertsDicom } from '../automation/files.js';
import { exampleInputs } from './examples.js';
import { schemaIssues } from './schema.js';
import { NIIVUE_METHODS, niivueAddresses, niivueParameterIssues, offeredNiivueMethods, withLocalAddresses } from './niivue-methods.js';

const terminal = new Set(['idle', 'succeeded', 'failed', 'cancelled']);
const POLL_MS = 250;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 600;
const readOnly = { readOnlyHint: true };
// Results hold file names, report text, the person's answers, tab labels or region names unless the
// tool is listed here: these return only what the app's author wrote or what the agent sent.
const TRUSTED_CONTENT = new Set(['inputs_load_example', 'outputs_download', 'viewers_list']);
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length && { required }), additionalProperties: false });
const viewerId = { type: 'string', description: 'A viewer ID from viewers_list' };
const toolName = operation => `run_${operation.replaceAll('-', '_')}`;
// The error codes the tools return in { error: { code, message } }:
//   INVALID_INPUT        the input does not match the tool's published schema; nothing ran
//   EXAMINATION_CHANGED  the person used the page while this call was going; its result is withheld
//                        and nothing more was done. The next call that needs the held files or the
//                        run asks the person whether the agent may continue with them.
//   RUN_STALE            the run belongs to an examination that had ended before this call began, or
//                        the page no longer holds the outputs the run ended with
//   RUN_REPLACED         another run, or a reset of the page, replaced the run; its outputs are gone
//   UNKNOWN_RUN          the tools did not start this run
//   RUN_ACTIVE           a run is still going
//   ADDRESS_REFUSED, REDIRECT_REFUSED, FETCH_FAILED   an approved fetch that could not be made
// The person refusing a prompt is not an error: the result is { declined: true }.
const STALE = 'The examination this run belongs to has ended: the person loaded other data, picked an example or declined to let the agent continue. Its report and outputs are withheld. Run it again if they still want it.';
const CHANGED = 'The person used the page while this call was going, so its result is withheld and nothing more was done. Call again if they still want it; the person is then asked whether you may continue.';
const TOUCHED = 'The person has used the page since your last step. The next call that uses the held files or this run asks them whether you may continue.';
const OTHER_RESULTS = 'The page now holds other results than the ones this run ended with, so nothing was saved. Run it again if they still want it.';
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const describeFiles = files => files.map(file => ({ name: file.name, bytes: file.size }));

/** The JSON Schema of one contract parameter, accepting what operationParameterSchema accepts. */
export function parameterJsonSchema(field) {
  const schema = field.type === 'array'
    ? { type: 'array', items: parameterJsonSchema(field.items) }
    : { type: field.type === 'boolean' || field.type === 'number' || field.type === 'integer' ? field.type : 'string' };
  const bounds = field.type === 'array' ? ['minItems', 'maxItems'] : ['minimum', 'maximum'];
  if (field.type !== 'boolean' && field.minimum !== undefined) schema[bounds[0]] = field.minimum;
  if (field.type !== 'boolean' && field.maximum !== undefined) schema[bounds[1]] = field.maximum;
  if (field.multipleOf !== undefined) schema.multipleOf = field.multipleOf;
  if (field.enum) schema.enum = structuredClone(field.enum);
  if (field.description !== undefined) schema.description = field.description;
  if (field.default !== undefined) schema.default = structuredClone(field.default);
  return schema;
}

function waitSeconds(fallback) {
  return { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, default: fallback, description: 'How long to wait for the run to finish before returning' };
}

function runSchema(operation) {
  const roles = Object.entries(operation.inputs);
  const sources = roles.filter(([, field]) => field.source !== 'files');
  const dicom = roles.filter(([, field]) => field.source === 'files' && convertsDicom(field));
  const required = Object.keys(operation.parameters).filter(name => operation.parameters[name].required);
  const neededSources = sources.filter(([, field]) => field.minimum > 0).map(([role]) => role);
  return object({
    parameters: object(Object.fromEntries(Object.entries(operation.parameters).map(([name, field]) => [name, parameterJsonSchema(field)])), required),
    ...(sources.length && { inputs: object(Object.fromEntries(sources.map(([role, field]) => [role, {
      ...object({ url: { type: 'string', format: 'uri' } }, ['url']), description: field.description,
    }])), neededSources) }),
    ...(dicom.length && { selections: object(Object.fromEntries(dicom.map(([role]) => [role, {
      type: 'string', pattern: '^[a-f0-9]{64}$', description: 'The sha256 of one converted series, from the candidates of a SERIES_SELECTION_REQUIRED error',
    }]))) }),
    waitSeconds: waitSeconds(DEFAULT_WAIT_SECONDS),
  }, [...(required.length ? ['parameters'] : []), ...(neededSources.length ? ['inputs'] : [])]);
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function toolError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

/** Fetches exactly the address the person approved, without cookies, and refuses a redirect to another. */
export async function fetchApproved(address, { signal } = {}) {
  const url = new URL(address, globalThis.document?.baseURI);
  if (!['http:', 'https:'].includes(url.protocol)) throw toolError('ADDRESS_REFUSED', `Only http and https addresses can be loaded, not ${url.protocol}`, { address: url.href });
  const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw toolError('REDIRECT_REFUSED', `${url.href} redirects to another address. The viewer loads only the address the user allowed; ask again with the address it redirects to.`, { address: url.href });
  }
  if (!response.ok) throw toolError('FETCH_FAILED', `${url.href} answered ${response.status} ${response.statusText}`.trim(), { address: url.href, status: response.status });
  return { blob: await response.blob(), href: url.href };
}

// The file roles an agent can fill, merged across operations: the widest count any operation accepts.
function fileRoles(contract) {
  const roles = new Map();
  for (const operation of Object.values(contract.operations)) {
    for (const [role, field] of Object.entries(operation.inputs)) {
      if (field.source !== 'files') continue;
      const known = roles.get(role);
      roles.set(role, known ? {
        ...known,
        minimum: Math.min(known.minimum, field.minimum),
        maximum: Math.max(known.maximum, field.maximum ?? Infinity),
        folder: known.folder || convertsDicom(field),
      } : { description: field.description, formats: field.formats, minimum: field.minimum, maximum: field.maximum ?? Infinity, folder: convertsDicom(field) });
    }
  }
  return roles;
}

// The file roles one operation reads.
const fileRolesOf = operation => Object.keys(operation.inputs).filter(role => operation.inputs[role].source === 'files');

// WebMCP reports a rejected tool call to the agent without its message, so failures travel in the result.
function failure(error) {
  return { error: {
    message: error?.message || String(error),
    ...(error?.code && { code: error.code }),
    ...(error?.candidates && { candidates: error.candidates }),
    ...error?.details,
  } };
}

/**
 * Every tool call belongs to the turn it began in (webmcp/tool-inputs.js): any use of the workspace
 * starts a new one. A call reaches the page, the prompts and the fetchers only through the functions
 * this returns, which check the turn before each request and after each answer, so nothing a call
 * awaited is acted on or returned once the person has used the page; the tool wrapper checks once more
 * before the call returns. `waits` aborts when the turn ends or the agent aborts the call, so a prompt
 * still queued is never shown and a fetch or a wait stops; `signal` is the agent's alone, since a run
 * the agent started must not be cancelled by the person looking at the viewer.
 */
function examinedCall(io, inputs, signal) {
  let from = inputs.turn();
  const call = {
    signal,
    get from() {
      return from;
    },
    get waits() {
      return signal ? AbortSignal.any([signal, from.controller.signal]) : from.controller.signal;
    },
    check() {
      if (inputs.turn() !== from) throw toolError('EXAMINATION_CHANGED', CHANGED);
    },
    /** Follows the turn this call itself started, when the person declined to let the agent continue. */
    rebind() {
      from = inputs.turn();
    },
  };
  for (const [name, request] of Object.entries(io)) {
    call[name] = async (...args) => {
      call.check();
      try {
        return await request(...args);
      } finally {
        call.check();
      }
    };
  }
  return call;
}

/**
 * The WebMCP tools for one application page, built from its automation contract. `inputs` holds the
 * examination: the files per role, the runs the tools started and the page's own loads
 * (webmcp/tool-inputs.js). Everything else is how a call reaches the page: `dispatch` (the page's
 * automation), `examples` (the page's examples), the shared agent prompts `askUser`, `requestFiles`,
 * `confirmFiles`, `confirmFetch` and `confirmResume`, and the fetchers. A tool reaches them only
 * through examinedCall.
 */
export function webMcpTools({ contract, inputs, ...pageIo }) {
  const roles = fileRoles(contract);
  const io = {
    examples: () => [],
    fetchAsset: fetchModel,
    fetchAddress: fetchApproved,
    ...pageIo,
    stage: from => inputs.stage(from, [...roles.keys()]),
  };
  // A rotation entry cycles through examples that are offered on their own.
  const catalog = async call => (await call.examples()).filter(example => !example.rotation)
    .map(example => ({ example, ...exampleInputs(example, contract.operations, contract.defaultOperation) }));
  // A command bound to a run, which the page's automation refuses once another run replaced it.
  async function bound(call, command, runId, request = {}) {
    try {
      return await call.dispatch(command, { ...request, runId });
    } catch (error) {
      if (error?.code !== 'RUN_NOT_CURRENT') throw error;
      if (error.current === runId) throw toolError('RUN_STALE', `Run ${runId}: ${OTHER_RESULTS}`, { runId });
      throw toolError('RUN_REPLACED', `Run ${runId} was replaced by ${error.current ? `run ${error.current}` : 'a reset of the page'}; its report and outputs are gone.`, { runId, replacedBy: error.current ?? null });
    }
  }
  // The named run's snapshot as the page answers now, while the tools may report the run.
  async function liveSnapshot(call, runId) {
    call.check();
    const known = inputs.runOf(runId);
    if (known === 'unknown') throw toolError('UNKNOWN_RUN', `Unknown run: ${runId}`, { runId });
    if (known === 'stale') throw toolError('RUN_STALE', `Run ${runId}: ${STALE}`, { runId });
    const snapshot = await bound(call, 'snapshot', runId);
    if (terminal.has(snapshot.state)) inputs.settle(snapshot);
    return snapshot;
  }
  // The named run's snapshot: once it has ended, the one it ended with, whatever the page answers later.
  async function runSnapshot(call, runId) {
    const snapshot = await liveSnapshot(call, runId);
    return inputs.settled(runId) ?? snapshot;
  }
  // The named run's snapshot once it ends or the wait passes. It never returns another run's snapshot.
  async function settle(call, runId, seconds) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const current = await runSnapshot(call, runId);
      const remaining = deadline - Date.now();
      if (terminal.has(current.state) || remaining <= 0 || call.signal?.aborted) return current;
      await sleep(Math.min(POLL_MS, remaining), call.waits);
    }
  }
  const approved = async (call, addresses, options = {}) => !addresses.length || Boolean(await call.confirmFetch({ app: contract.title, addresses, ...options }, { signal: call.waits }));
  // After the person used the page, the held files and the examination's latest run serve a call only
  // once they let the agent continue; declining ends the examination. Calls waiting on the same touch
  // share one dialog and its answer, which is shown until the person answers or uses the page again.
  // The dialog names what `resumable` gives when it shows; Allow applies only while that is still what
  // it gives, else the person is asked again. True when the call may go on.
  let pending = null;
  async function resumed(call) {
    if (!inputs.touched()) return true;
    const from = call.from;
    if (pending?.from !== from) {
      const request = () => ({ app: contract.title, ...inputs.resumable() });
      const decide = async () => {
        for (;;) {
          const { files, run } = inputs.resumable();
          if (!files.length && !run) break;
          const allowed = await call.confirmResume(request, { signal: from.controller.signal });
          if (!allowed) {
            inputs.release(from);
            return { allowed: false, turn: inputs.turn() };
          }
          if (sameJson(allowed, request())) break;
        }
        inputs.resume(from);
        return { allowed: true };
      };
      pending = { from, decision: decide() };
    }
    const outcome = await (call.signal ? Promise.race([pending.decision, new Promise((_, reject) => {
      call.signal.throwIfAborted();
      call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
    })]) : pending.decision);
    if (outcome.allowed) {
      call.check();
      return true;
    }
    // The examination the Decline started, unless the person used the page after it.
    if (inputs.turn() !== outcome.turn) call.check();
    call.rebind();
    return false;
  }
  const declined = { declined: true, message: 'The person declined: the held files are released and the earlier runs are withheld.' };
  const runTools = Object.fromEntries(Object.keys(contract.operations).map(name => [name, toolName(name)]));
  const tools = [];
  const tool = (name, title, description, inputSchema, annotations, execute) => tools.push({
    name, title, description, inputSchema,
    annotations: { ...annotations, ...(!TRUSTED_CONTENT.has(name) && { untrustedContentHint: true }) },
    async execute(input = {}, options = {}) {
      const issues = schemaIssues(inputSchema, input);
      if (issues.length) return { error: { code: 'INVALID_INPUT', message: issues.join('; ') } };
      try {
        const call = examinedCall(io, inputs, options.signal);
        const result = await execute(input, call);
        call.check();
        return result;
      } catch (error) {
        return failure(error);
      }
    },
  });

  // The current run as the tools may report it: one they did not start in this examination is
  // withheld, and so is this examination's run while the person has not let the agent continue.
  async function currentRun(call) {
    const current = await call.dispatch('snapshot');
    if (!current.runId) return current;
    if (inputs.runOf(current.runId) !== 'current') return { runId: current.runId, state: current.state, stale: true, message: STALE };
    if (inputs.touched()) return { runId: current.runId, state: current.state, touched: true, message: TOUCHED };
    if (terminal.has(current.state)) inputs.settle(current);
    return inputs.settled(current.runId) ?? current;
  }

  tool('app_describe', 'Describe this application',
    `Read what ${contract.title} does: its operations with their inputs, parameters and outputs, its examples (and why any cannot be loaded), its viewers, the current run, the files each input role holds (inputs), the files the page's inputs, drops and handoffs received (pageFiles), whether the page may hold inputs the tools cannot list (pageMayHoldOtherInputs; then ask the user) and the example the user last picked in the page (pageExample). pageFiles is what the page was given, not necessarily what it shows: inputs_use_page_files shows the user the files and asks before the agent gets them. A run or viewer load the tools start clears pageFiles and pageExample. touched says the user has used the page since your last step: the next call that uses the held files or the run asks them whether you may continue, and declining releases them. When the user loads other files, picks an example or the page resets, the held files are released and earlier runs become stale.`,
    object({}), readOnly,
    async (_, call) => {
      const entries = await catalog(call);
      return {
        app: contract.app,
        title: contract.title,
        description: contract.description,
        appVersion: contract.appVersion,
        defaultOperation: contract.defaultOperation,
        operations: Object.fromEntries(Object.entries(contract.operations).map(([name, operation]) => [name, { tool: runTools[name], ...structuredClone(operation) }])),
        examples: entries.filter(entry => entry.files).map(({ example: { id, label, description, expectedResult }, files, operation, parameters, omitted }) => ({
          id, label, description, expectedResult, roles: [...new Set(files.map(file => file.role))], tool: runTools[operation], ...(parameters && { parameters }), ...(omitted && { omitted }),
        })),
        unavailableExamples: entries.filter(entry => entry.unavailable).map(({ example: { id, label }, unavailable }) => ({ id, label, reason: unavailable })),
        viewers: await call.dispatch('viewers.list'),
        run: await currentRun(call),
        inputs: inputs.held(),
        touched: inputs.touched(),
        pageFiles: inputs.page(),
        pageMayHoldOtherInputs: inputs.pageMayHoldOtherInputs(),
        pageExample: inputs.pageExample(),
      };
    });

  tool('inputs_request_files', 'Ask the user for input files',
    'Ask the user to choose files for an input role in a dialog on this page. The page cannot read file paths, so this is how local data reaches it. Returns the chosen file names and sizes, or declined.',
    object({
      role: { type: 'string', enum: [...roles.keys()], description: 'The input role to fill' },
      message: { type: 'string', description: 'Why these files are needed, shown to the user' },
    }, ['role']), {},
    async ({ role, message }, call) => {
      const field = roles.get(role);
      const files = await call.requestFiles({ label: field.description, formats: field.formats, message, minimum: field.minimum, maximum: field.maximum, folder: field.folder }, { signal: call.waits });
      if (!files) return { declined: true };
      inputs.hold(call.from, role, files);
      return { role, files: describeFiles(files) };
    });

  tool('inputs_use_page_files', 'Use files the page received',
    'Hold the files of one pageFiles entry from app_describe as the input for a role. The user sees the files in a dialog and confirms them first; the result is declined if they refuse.',
    object({
      role: { type: 'string', enum: [...roles.keys()], description: 'The input role to fill' },
      input: { type: 'string', description: 'The input key from pageFiles' },
    }, ['role', 'input']), {},
    async ({ role, input }, call) => {
      // The dialog names the entry as it is when it shows; the files held are the ones it named.
      const request = () => {
        const entry = inputs.pageEntry(input);
        return { app: contract.title, label: entry.label, files: describeFiles(entry.files), revision: entry.revision };
      };
      for (;;) {
        const allowed = await call.confirmFiles(request, { signal: call.waits });
        if (!allowed) return { declined: true };
        const entry = inputs.pageEntry(input);
        if (entry.revision !== allowed.revision) continue;
        inputs.hold(call.from, role, entry.files);
        return { role, files: describeFiles(entry.files) };
      }
    });

  tool('inputs_load_example', 'Load an example',
    'Download one of the application\'s examples, verify its checksums and hold its files as the input for the next run, replacing every file held before. Run it with the example\'s tool and parameters from app_describe.',
    object({ exampleId: { type: 'string', description: 'An example ID from app_describe' } }, ['exampleId']), {},
    async ({ exampleId }, call) => {
      const entry = (await catalog(call)).find(item => item.example.id === exampleId);
      if (!entry) throw new Error(`Unknown example: ${exampleId}`);
      if (entry.unavailable) throw new Error(`Example ${exampleId} cannot be loaded here: ${entry.unavailable}`);
      const files = new Map();
      for (const asset of entry.files) {
        const bytes = await call.fetchAsset({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, { signal: call.waits, retries: 4 });
        files.set(asset.role, [...(files.get(asset.role) ?? []), new File([bytes], asset.name)]);
      }
      call.signal?.throwIfAborted();
      inputs.replace(call.from, files);
      return { exampleId, inputs: Object.fromEntries([...files].map(([role, held]) => [role, describeFiles(held)])) };
    });

  for (const [name, operation] of Object.entries(contract.operations)) {
    const takesAddresses = Object.values(operation.inputs).some(field => field.source !== 'files');
    tool(runTools[name], operation.title,
      `${operation.description} Runs on the files the input roles hold (see inputs_request_files, inputs_use_page_files and inputs_load_example) and shows the result in the page. The files stay held, so run again with other parameters without asking for them again. Waits up to waitSeconds, then returns the run; call runs_get to keep waiting. A failed run with code SERIES_SELECTION_REQUIRED lists candidates: ask the user with user_ask and run again with selections.${takesAddresses ? ' The user is asked first whether the app may read under the address it will use for each url input.' : ''}`,
      runSchema(operation), takesAddresses ? { consequentialHint: true } : {},
      async ({ parameters, inputs: sources = {}, selections, waitSeconds: seconds = DEFAULT_WAIT_SECONDS }, call) => {
        if (!await resumed(call)) return declined;
        // The app names the address it reads under for each url (a store's root), so the person allows that.
        const addressed = Object.keys(sources).length ? Object.entries(await call.dispatch('sources', { operation: name, inputs: sources })).map(([role, source]) => ({ role, url: source.root })) : [];
        const roots = addressed.map(source => source.url);
        if (!await approved(call, roots, { readsUnder: true })) return { declined: true, addresses: roots };
        const active = await call.dispatch('snapshot');
        if (!terminal.has(active.state)) {
          throw toolError('RUN_ACTIVE', inputs.runOf(active.runId) === 'current'
            ? `Run ${active.runId} is still going. Wait for it with runs_get, or cancel it with runs_cancel, before starting another.`
            : 'A run is still going in the page. Wait for it to finish, or ask the user to cancel it with the × in the status bar.', { runId: active.runId });
        }
        await call.stage(call.from);
        call.check();
        inputs.toolLoaded();
        const { runId } = await call.dispatch('start', { operation: name, parameters, inputs: sources, selections });
        inputs.claim(call.from, runId, name, { roles: fileRolesOf(operation), addresses: addressed });
        const settled = await settle(call, runId, seconds);
        if (!call.signal?.aborted || terminal.has(settled.state)) return settled;
        await bound(call, 'cancel', runId);
        return runSnapshot(call, runId);
      });
  }

  tool('runs_get', 'Read the current run',
    'Read the current run: its state, progress, report or error. Waits up to waitSeconds for a running run to finish.',
    object({ runId: { type: 'string' }, waitSeconds: waitSeconds(0) }), readOnly,
    async ({ runId, waitSeconds: seconds = 0 }, call) => {
      const target = runId ?? (await call.dispatch('snapshot')).runId;
      if (!target) return currentRun(call);
      if (inputs.runOf(target) === 'current' && !await resumed(call)) return declined;
      return settle(call, target, seconds);
    });

  tool('runs_cancel', 'Cancel the current run',
    'Cancel the current run. A finished run stays as it is.',
    object({ runId: { type: 'string' } }), {},
    async ({ runId }, call) => {
      const target = runId ?? (await call.dispatch('snapshot')).runId;
      if (!target) return { cancelled: false, run: await currentRun(call) };
      await runSnapshot(call, target);
      if (!await resumed(call)) return declined;
      const { cancelled } = await bound(call, 'cancel', target);
      return { cancelled, run: await runSnapshot(call, target) };
    });

  tool('outputs_download', 'Save an output file',
    'Save a file from a successful run to the user\'s downloads. runId names the run; artifactId is a key of its report\'s artifacts, or report for the report itself. Only the current run\'s files can be saved.',
    object({ runId: { type: 'string' }, artifactId: { type: 'string' } }, ['runId', 'artifactId']), { consequentialHint: true },
    async ({ runId, artifactId }, call) => {
      await runSnapshot(call, runId);
      if (!await resumed(call)) return declined;
      // The outputs the run ended with, compared with what the page holds for it now.
      const live = await liveSnapshot(call, runId);
      const ended = inputs.settled(runId);
      const recorded = artifactId === 'report' ? ended?.report : ended?.report?.artifacts?.[artifactId];
      const current = artifactId === 'report' ? live.report : live.report?.artifacts?.[artifactId];
      if (ended?.state === 'succeeded' && (live.state !== 'succeeded' || !sameJson(recorded, current))) throw toolError('RUN_STALE', `Run ${runId}: ${OTHER_RESULTS}`, { runId });
      return { runId, ...await bound(call, 'download', runId, { artifactId, ...(recorded?.sha256 && { sha256: recorded.sha256 }) }) };
    });

  tool('user_ask', 'Ask the user',
    'Ask the user a question in a dialog on this page and wait for the answer. Give options for a choice; allowText adds a typed answer and is the default without options.',
    object({
      question: { type: 'string', minLength: 1 },
      options: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8 },
      allowText: { type: 'boolean' },
    }, ['question']), {},
    ({ question, options, allowText }, call) => call.askUser({ question, options, allowText }, { signal: call.waits }));

  const position = object({
    frame: { type: 'string', enum: ['mm'] },
    value: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
  }, ['frame', 'value']);
  const volumeDisplay = object({
    index: { type: 'integer', minimum: 0 },
    colormap: { type: 'string', minLength: 1 },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
    calMin: { type: 'number' },
    calMax: { type: 'number' },
    visible: { type: 'boolean' },
  }, ['index']);
  for (const [name, description, properties, required, annotations, wrap] of [
    ['list', 'List the page\'s viewers and the controls each supports. Viewers appear once a run or the user loads an image.', {}, [], readOnly, 'viewers'],
    ['state', 'Read a viewer\'s crosshair, tabs and image location.', { viewerId }, ['viewerId'], readOnly],
    ['crosshair', 'Move a viewer\'s crosshair to three world coordinates in millimetres. Returns the snapped position.', { viewerId, position }, ['viewerId', 'position'], {}],
    ['tab', 'Select a viewer tab by its reported ID.', { viewerId, tabId: { type: 'string' } }, ['viewerId', 'tabId'], {}],
    ['regions', 'Read the regions a viewer exposes.', { viewerId }, ['viewerId'], readOnly, 'regions'],
    ['volumes', 'List the volumes loaded in a viewer with their colormap, display range, opacity and dimensions.', { viewerId }, ['viewerId'], readOnly, 'volumes'],
    ['display', 'Set a viewer\'s slice type and per-volume colormap, display range (calMin, calMax), opacity or visibility.', {
      viewerId,
      sliceType: { type: 'string', enum: ['axial', 'coronal', 'sagittal', 'multiplanar', 'render'] },
      volumes: { type: 'array', items: volumeDisplay },
    }, ['viewerId'], {}],
    ['niivue', 'Call an nv-mcp NiiVue tool on a viewer by method name and params; without a method, read the scene. Only tools that read the scene, change what it shows or load one file are offered. Each method takes only the parameters that change what the viewer shows; any other is refused. A call that loads from an address asks the user first, saying when it replaces what the viewer shows, and returns declined if they refuse; the page then fetches exactly that address, refuses a redirect, and gives the viewer the bytes.', {
      viewerId,
      method: { type: 'string', enum: offeredNiivueMethods() },
      params: { type: 'object' },
    }, ['viewerId'], { consequentialHint: true }],
  ]) {
    tool(`viewers_${name}`, `Viewer ${name}`, description, object(properties, required), annotations, async (args, call) => {
      if (name !== 'niivue') {
        const value = await call.dispatch(`viewers.${name}`, args);
        return wrap ? { [wrap]: value } : value;
      }
      const issues = niivueParameterIssues(args.method, args.params);
      if (issues.length) return { error: { code: 'INVALID_INPUT', message: issues.join('; ') } };
      const addresses = niivueAddresses(args.params);
      if (!await approved(call, addresses, NIIVUE_METHODS[args.method] === 'replace' ? { replaces: true } : {})) return { declined: true, addresses };
      if (!addresses.length) return call.dispatch('viewers.niivue', args);
      const local = await withLocalAddresses(args.params, address => call.fetchAddress(address, { signal: call.waits }));
      try {
        call.check();
        inputs.toolLoaded();
        return await call.dispatch('viewers.niivue', { ...args, params: local.params });
      } finally {
        local.release();
      }
    });
  }
  return tools;
}

/** Registers each tool with the page's model context; a tool the browser refuses leaves the others registered. */
export async function registerWebMcpTools(modelContext, tools, { signal } = {}) {
  const results = await Promise.allSettled(tools.map(tool => Promise.resolve().then(() => modelContext.registerTool(tool, { signal }))));
  const failed = tools.filter((_, index) => results[index].status === 'rejected').map(tool => tool.name);
  if (failed.length) console.warn(`WebMCP refused ${failed.length} tool(s): ${failed.join(', ')}`, results.find(result => result.status === 'rejected').reason);
  return { registered: tools.length - failed.length, failed };
}
