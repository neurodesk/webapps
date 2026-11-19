import { fetchModel } from '../worker/fetchModel.js';
import { convertsDicom } from '../automation/files.js';
import { exampleInputs } from './examples.js';
import { schemaIssues } from './schema.js';
import { niivueAddresses, offeredNiivueMethods, REFUSED_PARAMETERS, withLocalAddresses } from './niivue-methods.js';

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
const STALE = 'The person has used the page since this run started, so its report and outputs are withheld from the agent. Run it again if they still want it.';
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
 * The WebMCP tools for one application page, built from its automation contract. `inputs` holds the
 * examination: the files per role, the runs the tools started and the page's own loads
 * (webmcp/tool-inputs.js); `examples` lists the page's examples; `askUser`, `requestFiles`,
 * `confirmFiles` and `confirmFetch` are the shared agent prompts.
 */
export function webMcpTools({ contract, dispatch, inputs, examples = () => [], fetchAsset = fetchModel, fetchAddress = fetchApproved, askUser, requestFiles, confirmFiles, confirmFetch }) {
  const roles = fileRoles(contract);
  // A rotation entry cycles through examples that are offered on their own.
  const catalog = async () => (await examples()).filter(example => !example.rotation)
    .map(example => ({ example, ...exampleInputs(example, contract.operations, contract.defaultOperation) }));
  // A command bound to a run, which the page's automation refuses once another run replaced it.
  async function bound(command, runId, request = {}) {
    try {
      return await dispatch(command, { ...request, runId });
    } catch (error) {
      if (error?.code !== 'RUN_NOT_CURRENT') throw error;
      throw toolError('RUN_REPLACED', `Run ${runId} was replaced by ${error.current ? `run ${error.current}` : 'a reset of the page'}; its report and outputs are gone.`, { runId, replacedBy: error.current ?? null });
    }
  }
  // The named run's snapshot, while the tools may report it.
  async function runSnapshot(runId) {
    const known = inputs.runOf(runId);
    if (known === 'unknown') throw toolError('UNKNOWN_RUN', `Unknown run: ${runId}`, { runId });
    if (known === 'stale') throw toolError('RUN_STALE', `Run ${runId}: ${STALE}`, { runId });
    return bound('snapshot', runId);
  }
  // The named run's snapshot once it ends or the wait passes. It never returns another run's snapshot.
  async function settle(runId, seconds, signal) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const current = await runSnapshot(runId);
      const remaining = deadline - Date.now();
      if (terminal.has(current.state) || remaining <= 0 || signal?.aborted) return current;
      await sleep(Math.min(POLL_MS, remaining), signal);
    }
  }
  const approved = async (addresses, signal, options = {}) => !addresses.length || await confirmFetch({ app: contract.title, addresses, ...options }, { signal });
  const runTools = Object.fromEntries(Object.keys(contract.operations).map(name => [name, toolName(name)]));
  const tools = [];
  const tool = (name, title, description, inputSchema, annotations, execute) => tools.push({
    name, title, description, inputSchema,
    annotations: { ...annotations, ...(!TRUSTED_CONTENT.has(name) && { untrustedContentHint: true }) },
    async execute(input = {}, options = {}) {
      const issues = schemaIssues(inputSchema, input);
      if (issues.length) return { error: { code: 'INVALID_INPUT', message: issues.join('; ') } };
      try {
        return await execute(input, options);
      } catch (error) {
        return failure(error);
      }
    },
  });

  // The current run as the tools may report it: one they did not start in this examination is withheld.
  async function currentRun() {
    const current = await dispatch('snapshot');
    if (!current.runId || inputs.runOf(current.runId) === 'current') return current;
    return { runId: current.runId, state: current.state, stale: true, message: STALE };
  }

  tool('app_describe', 'Describe this application',
    `Read what ${contract.title} does: its operations with their inputs, parameters and outputs, its examples (and why any cannot be loaded), its viewers, the current run, the files each input role holds (inputs), the files the user has loaded into the page (pageFiles), whether the page may hold inputs the tools cannot list (pageMayHoldOtherInputs; then ask the user) and the example the user loaded in the page (pageExample). A pageFiles entry is current when the user has not used the page since loading it; inputs_use_page_files asks the user to confirm one that is not. Whenever the user uses the page, the held files are released and earlier runs become stale.`,
    object({}), readOnly,
    async () => {
      const entries = await catalog();
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
        viewers: await dispatch('viewers.list'),
        run: await currentRun(),
        inputs: inputs.held(),
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
    async ({ role, message }, { signal }) => {
      const from = inputs.examination();
      const field = roles.get(role);
      const files = await requestFiles({ label: field.description, formats: field.formats, message, minimum: field.minimum, maximum: field.maximum, folder: field.folder }, { signal });
      if (!files) return { declined: true };
      inputs.hold(from, role, files);
      return { role, files: describeFiles(files) };
    });

  tool('inputs_use_page_files', 'Use files the user loaded',
    'Hold the files the user already loaded into the page (an entry of pageFiles in app_describe) as the input for a role. A current entry needs no question; for one that is not current, the user confirms the files in a dialog first, and the result is declined if they refuse.',
    object({
      role: { type: 'string', enum: [...roles.keys()], description: 'The input role to fill' },
      input: { type: 'string', description: 'The input key from pageFiles' },
    }, ['role', 'input']), {},
    async ({ role, input }, { signal }) => {
      const from = inputs.examination();
      const entry = inputs.pageEntry(input);
      if (!entry.current && !await confirmFiles({ app: contract.title, label: entry.label, files: describeFiles(entry.files) }, { signal })) return { declined: true };
      inputs.hold(from, role, entry.files);
      return { role, files: describeFiles(entry.files) };
    });

  tool('inputs_load_example', 'Load an example',
    'Download one of the application\'s examples, verify its checksums and hold its files as the input for the next run, replacing every file held before. Run it with the example\'s tool and parameters from app_describe.',
    object({ exampleId: { type: 'string', description: 'An example ID from app_describe' } }, ['exampleId']), {},
    async ({ exampleId }, { signal }) => {
      const entry = (await catalog()).find(item => item.example.id === exampleId);
      if (!entry) throw new Error(`Unknown example: ${exampleId}`);
      if (entry.unavailable) throw new Error(`Example ${exampleId} cannot be loaded here: ${entry.unavailable}`);
      const from = inputs.examination();
      const files = new Map();
      for (const asset of entry.files) {
        const bytes = await fetchAsset({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, { signal, retries: 4 });
        files.set(asset.role, [...(files.get(asset.role) ?? []), new File([bytes], asset.name)]);
      }
      signal?.throwIfAborted();
      inputs.replace(from, files);
      return { exampleId, inputs: Object.fromEntries([...files].map(([role, held]) => [role, describeFiles(held)])) };
    });

  for (const [name, operation] of Object.entries(contract.operations)) {
    tool(runTools[name], operation.title,
      `${operation.description} Runs on the files the input roles hold (see inputs_request_files, inputs_use_page_files and inputs_load_example) and shows the result in the page. The files stay held, so run again with other parameters without asking for them again. Waits up to waitSeconds, then returns the run; call runs_get to keep waiting. A failed run with code SERIES_SELECTION_REQUIRED lists candidates: ask the user with user_ask and run again with selections.`,
      runSchema(operation), Object.values(operation.inputs).some(field => field.source !== 'files') ? { consequentialHint: true } : {},
      async ({ parameters, inputs: sources = {}, selections, waitSeconds: seconds = DEFAULT_WAIT_SECONDS }, { signal }) => {
        const from = inputs.examination();
        const addresses = Object.values(sources).map(source => source.url);
        if (!await approved(addresses, signal, { readsUnder: true })) return { declined: true, addresses };
        const active = await dispatch('snapshot');
        if (!terminal.has(active.state)) {
          throw toolError('RUN_ACTIVE', inputs.runOf(active.runId) === 'current'
            ? `Run ${active.runId} is still going. Wait for it with runs_get, or cancel it with runs_cancel, before starting another.`
            : 'A run is still going in the page. Wait for it to finish, or ask the user to cancel it with the × in the status bar.', { runId: active.runId });
        }
        await inputs.stage(from);
        const { runId } = await dispatch('start', { operation: name, parameters, inputs: sources, selections });
        inputs.claim(from, runId);
        const settled = await settle(runId, seconds, signal);
        if (!signal?.aborted || terminal.has(settled.state)) return settled;
        await bound('cancel', runId);
        return runSnapshot(runId);
      });
  }

  tool('runs_get', 'Read the current run',
    'Read the current run: its state, progress, report or error. Waits up to waitSeconds for a running run to finish.',
    object({ runId: { type: 'string' }, waitSeconds: waitSeconds(0) }), readOnly,
    async ({ runId, waitSeconds: seconds = 0 }, { signal }) => {
      const target = runId ?? (await dispatch('snapshot')).runId;
      return target ? settle(target, seconds, signal) : currentRun();
    });

  tool('runs_cancel', 'Cancel the current run',
    'Cancel the current run. A finished run stays as it is.',
    object({ runId: { type: 'string' } }), {},
    async ({ runId }) => {
      const target = runId ?? (await dispatch('snapshot')).runId;
      if (!target) return { cancelled: false, run: await currentRun() };
      await runSnapshot(target);
      const { cancelled } = await bound('cancel', target);
      return { cancelled, run: await runSnapshot(target) };
    });

  tool('outputs_download', 'Save an output file',
    'Save a file from a successful run to the user\'s downloads. runId names the run; artifactId is a key of its report\'s artifacts, or report for the report itself. Only the current run\'s files can be saved.',
    object({ runId: { type: 'string' }, artifactId: { type: 'string' } }, ['runId', 'artifactId']), { consequentialHint: true },
    async ({ runId, artifactId }) => {
      await runSnapshot(runId);
      return { runId, ...await bound('download', runId, { artifactId }) };
    });

  tool('user_ask', 'Ask the user',
    'Ask the user a question in a dialog on this page and wait for the answer. Give options for a choice; allowText adds a typed answer and is the default without options.',
    object({
      question: { type: 'string', minLength: 1 },
      options: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8 },
      allowText: { type: 'boolean' },
    }, ['question']), {},
    ({ question, options, allowText }, { signal }) => askUser({ question, options, allowText }, { signal }));

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
    ['niivue', 'Call an nv-mcp NiiVue tool on a viewer by method name and params; without a method, read the scene. Only tools that read the scene, change what it shows or load one file are offered. A call that loads from an address asks the user first and returns declined if they refuse; the page then fetches exactly that address, refuses a redirect, and gives the viewer the bytes. set_volume refuses affine, reset_affine, transform and load_all_frames.', {
      viewerId,
      method: { type: 'string', enum: offeredNiivueMethods() },
      params: { type: 'object' },
    }, ['viewerId'], { consequentialHint: true }],
  ]) {
    tool(`viewers_${name}`, `Viewer ${name}`, description, object(properties, required), annotations, async (args, { signal }) => {
      if (name !== 'niivue') {
        const value = await dispatch(`viewers.${name}`, args);
        return wrap ? { [wrap]: value } : value;
      }
      const refused = (REFUSED_PARAMETERS[args.method] ?? []).filter(key => Object.hasOwn(args.params ?? {}, key));
      if (refused.length) return { error: { code: 'INVALID_INPUT', message: `${args.method} over WebMCP does not take ${refused.join(', ')}: they move, edit or load data` } };
      const addresses = niivueAddresses(args.params);
      if (!await approved(addresses, signal)) return { declined: true, addresses };
      if (!addresses.length) return dispatch('viewers.niivue', args);
      const local = await withLocalAddresses(args.params, address => fetchAddress(address, { signal }));
      try {
        return await dispatch('viewers.niivue', { ...args, params: local.params });
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
