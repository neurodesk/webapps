import { fetchModel } from '../worker/fetchModel.js';
import { convertsDicom } from '../automation/files.js';
import { exampleInputs } from './examples.js';

const terminal = new Set(['idle', 'succeeded', 'failed', 'cancelled']);
const POLL_MS = 250;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 600;
const readOnly = { readOnlyHint: true };
const untrusted = { untrustedContentHint: true };
const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length && { required }), additionalProperties: false });
const viewerId = { type: 'string', description: 'A viewer ID from viewers_list' };
const toolName = operation => `run_${operation.replaceAll('-', '_')}`;
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
  return object({
    parameters: object(Object.fromEntries(Object.entries(operation.parameters).map(([name, field]) => [name, parameterJsonSchema(field)]))),
    ...(sources.length && { inputs: object(Object.fromEntries(sources.map(([role, field]) => [role, {
      ...object({ url: { type: 'string', format: 'uri' } }, ['url']), description: field.description,
    }])), sources.filter(([, field]) => field.minimum > 0).map(([role]) => role)) }),
    ...(dicom.length && { selections: object(Object.fromEntries(dicom.map(([role]) => [role, {
      type: 'string', pattern: '^[a-f0-9]{64}$', description: 'The sha256 of one converted series, from the candidates of a SERIES_SELECTION_REQUIRED error',
    }]))) }),
    waitSeconds: waitSeconds(DEFAULT_WAIT_SECONDS),
  });
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

async function settle(dispatch, runId, seconds, signal) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const snapshot = await dispatch('snapshot');
    const remaining = deadline - Date.now();
    if (snapshot.runId !== runId || terminal.has(snapshot.state) || remaining <= 0 || signal?.aborted) return snapshot;
    await sleep(Math.min(POLL_MS, remaining), signal);
  }
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
  } };
}

/**
 * The WebMCP tools for one application page, built from its automation contract. `inputs` holds the
 * files per role and reads the page's own inputs (webmcp/inputs.js); `examples` lists the page's
 * examples; `askUser` and `requestFiles` are the shared agent prompts.
 */
export function webMcpTools({ contract, dispatch, inputs, examples = () => [], fetchAsset = fetchModel, askUser, requestFiles }) {
  const roles = fileRoles(contract);
  // A rotation entry cycles through examples that are offered on their own.
  const parameterNames = new Set(Object.values(contract.operations).flatMap(operation => Object.keys(operation.parameters)));
  const catalog = async () => (await examples()).filter(example => !example.rotation).map(example => ({ example, ...exampleInputs(example, roles, parameterNames) }));
  const runTools = Object.fromEntries(Object.keys(contract.operations).map(name => [name, toolName(name)]));
  const tools = [];
  const tool = (name, title, description, inputSchema, annotations, execute) => tools.push({
    name, title, description, inputSchema, annotations,
    async execute(input, options = {}) {
      try {
        return await execute(input ?? {}, options);
      } catch (error) {
        return failure(error);
      }
    },
  });

  tool('app_describe', 'Describe this application',
    `Read what ${contract.title} does: its operations with their inputs, parameters and outputs, its examples (and why any cannot be loaded), its viewers, the current run, the files each input role holds and the files the user has loaded into the page (pageFiles).`,
    object({}), { ...readOnly, ...untrusted },
    async () => {
      const entries = await catalog();
      return {
        app: contract.app,
        title: contract.title,
        description: contract.description,
        appVersion: contract.appVersion,
        defaultOperation: contract.defaultOperation,
        operations: Object.fromEntries(Object.entries(contract.operations).map(([name, operation]) => [name, { tool: runTools[name], ...structuredClone(operation) }])),
        examples: entries.filter(entry => entry.files).map(({ example: { id, label, description, expectedResult }, files, parameters, omitted }) => ({
          id, label, description, expectedResult, roles: [...new Set(files.map(file => file.role))], ...(parameters && { parameters }), ...(omitted && { omitted }),
        })),
        unavailableExamples: entries.filter(entry => entry.unavailable).map(({ example: { id, label }, unavailable }) => ({ id, label, reason: unavailable })),
        viewers: await dispatch('viewers.list'),
        run: await dispatch('snapshot'),
        inputs: inputs.held(),
        pageFiles: inputs.page(),
      };
    });

  tool('inputs_request_files', 'Ask the user for input files',
    'Ask the user to choose files for an input role in a dialog on this page. The page cannot read file paths, so this is how local data reaches it. Returns the chosen file names and sizes, or declined.',
    object({
      role: { type: 'string', enum: [...roles.keys()], description: 'The input role to fill' },
      message: { type: 'string', description: 'Why these files are needed, shown to the user' },
    }, ['role']), untrusted,
    async ({ role, message }, { signal }) => {
      const field = roles.get(role);
      if (!field) throw new Error(`Unknown file input role: ${role}`);
      const files = await requestFiles({ label: field.description, formats: field.formats, message, minimum: field.minimum, maximum: field.maximum, folder: field.folder }, { signal });
      if (!files) return { declined: true };
      inputs.adopt(role, files);
      return { role, files: describeFiles(files) };
    });

  tool('inputs_use_page_files', 'Use files the user loaded',
    'Hold the files the user already loaded into one of the page\'s own inputs (pageFiles in app_describe) as the input for a role, without asking for them again.',
    object({
      role: { type: 'string', enum: [...roles.keys()], description: 'The input role to fill' },
      input: { type: 'string', description: 'The input key from pageFiles' },
    }, ['role', 'input']), untrusted,
    async ({ role, input }) => {
      if (!roles.has(role)) throw new Error(`Unknown file input role: ${role}`);
      return { role, files: describeFiles(inputs.usePage(role, input)) };
    });

  tool('inputs_load_example', 'Load an example',
    'Download one of the application\'s examples, verify its checksums and hold its files as the input for the next run. Run it with the example\'s parameters from app_describe.',
    object({ exampleId: { type: 'string', description: 'An example ID from app_describe' } }, ['exampleId']), {},
    async ({ exampleId }, { signal }) => {
      const entry = (await catalog()).find(item => item.example.id === exampleId);
      if (!entry) throw new Error(`Unknown example: ${exampleId}`);
      if (entry.unavailable) throw new Error(`Example ${exampleId} cannot be loaded here: ${entry.unavailable}`);
      const files = new Map();
      for (const asset of entry.files) {
        const bytes = await fetchAsset({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, { signal, retries: 4 });
        files.set(asset.role, [...(files.get(asset.role) ?? []), new File([bytes], asset.name)]);
      }
      signal?.throwIfAborted();
      for (const [role, held] of files) inputs.adopt(role, held);
      return { exampleId, inputs: Object.fromEntries([...files].map(([role, held]) => [role, describeFiles(held)])) };
    });

  for (const [name, operation] of Object.entries(contract.operations)) {
    tool(runTools[name], operation.title,
      `${operation.description} Runs on the files the input roles hold (see inputs_request_files, inputs_use_page_files and inputs_load_example) and shows the result in the page. The files stay held, so run again with other parameters without asking for them again. Waits up to waitSeconds, then returns the run; call runs_get to keep waiting. A failed run with code SERIES_SELECTION_REQUIRED lists candidates: ask the user with user_ask and run again with selections.`,
      runSchema(operation), untrusted,
      async ({ parameters, inputs: sources, selections, waitSeconds: seconds = DEFAULT_WAIT_SECONDS }, { signal }) => {
        await inputs.stage();
        const { runId } = await dispatch('start', { operation: name, parameters, inputs: sources, selections });
        const snapshot = await settle(dispatch, runId, seconds, signal);
        if (!signal?.aborted || snapshot.runId !== runId || terminal.has(snapshot.state)) return snapshot;
        await dispatch('cancel');
        return dispatch('snapshot');
      });
  }

  tool('runs_get', 'Read the current run',
    'Read the current run: its state, progress, report or error. Waits up to waitSeconds for a running run to finish.',
    object({ runId: { type: 'string' }, waitSeconds: waitSeconds(0) }), { ...readOnly, ...untrusted },
    async ({ runId, waitSeconds: seconds = 0 }, { signal }) => {
      const snapshot = await dispatch('snapshot');
      if (runId !== undefined && snapshot.runId !== runId) throw new Error(`Unknown run: ${runId}`);
      return settle(dispatch, snapshot.runId, seconds, signal);
    });

  tool('runs_cancel', 'Cancel the current run',
    'Cancel the current run. A finished run stays as it is.',
    object({ runId: { type: 'string' } }), untrusted,
    async ({ runId }) => {
      if (runId !== undefined && (await dispatch('snapshot')).runId !== runId) throw new Error(`Unknown run: ${runId}`);
      const { cancelled } = await dispatch('cancel');
      return { cancelled, run: await dispatch('snapshot') };
    });

  tool('outputs_download', 'Save an output file',
    'Save a file from the last successful run to the user\'s downloads. artifactId is a key of the run report\'s artifacts, or report for the report itself.',
    object({ artifactId: { type: 'string' } }, ['artifactId']), { consequentialHint: true },
    ({ artifactId }) => dispatch('download', { artifactId }));

  tool('user_ask', 'Ask the user',
    'Ask the user a question in a dialog on this page and wait for the answer. Give options for a choice; allowText adds a typed answer and is the default without options.',
    object({
      question: { type: 'string', minLength: 1 },
      options: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8 },
      allowText: { type: 'boolean' },
    }, ['question']), untrusted,
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
    ['volumes', 'List the volumes loaded in a viewer with their colormap, display range, opacity and dimensions.', { viewerId }, ['viewerId'], { ...readOnly, ...untrusted }, 'volumes'],
    ['display', 'Set a viewer\'s slice type and per-volume colormap, display range (calMin, calMax), opacity or visibility.', {
      viewerId,
      sliceType: { type: 'string', enum: ['axial', 'coronal', 'sagittal', 'multiplanar', 'render'] },
      volumes: { type: 'array', items: volumeDisplay },
    }, ['viewerId'], untrusted],
    ['niivue', 'Call an nv-mcp NiiVue tool on a viewer by method name and params; without a method, read the scene.', {
      viewerId,
      method: { type: 'string', minLength: 1 },
      params: { type: 'object' },
    }, ['viewerId'], untrusted],
  ]) {
    tool(`viewers_${name}`, `Viewer ${name}`, description, object(properties, required), annotations, async args => {
      const value = await dispatch(`viewers.${name}`, args);
      return wrap ? { [wrap]: value } : value;
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
