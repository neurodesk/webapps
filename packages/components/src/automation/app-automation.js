import { downloadFile } from '../file-io/download.js';
import { convertsDicom, describeFile, prepareImageInput } from './files.js';
import { createViewerRegistry } from './viewers.js';
import { operationParametersSchema } from './parameters.js';

let pageRegistration;
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const terminal = new Set(['idle', 'succeeded', 'failed', 'cancelled']);

function validateRegistration(contract, app, operations, convertDicom) {
  if (contract.schemaVersion !== 2 || contract.app !== app || !object(contract.operations)) throw new Error('Invalid application automation contract');
  if (!/^\d+\.\d+\.\d{8}$/.test(contract.appVersion)) throw new Error('The published contract needs an application version');
  if (Object.keys(contract.operations).sort().join('\0') !== Object.keys(operations).sort().join('\0')) throw new Error('Registered operation keys must match the contract exactly');
  for (const [name, operation] of Object.entries(contract.operations)) {
    if (typeof operations[name] !== 'function') throw new Error(`Missing operation callback: ${name}`);
    for (const input of Object.values(operation.inputs)) {
      if (convertsDicom(input) && typeof convertDicom !== 'function') throw new Error(`Operation ${name} declares DICOM conversion without a converter`);
    }
  }
}

async function makeArtifacts(result, operation, signal) {
  if (!Array.isArray(result.artifacts)) throw new Error('The operation must return an artifacts array');
  const files = new Map();
  const records = {};
  const names = new Set(['report.json']);
  const counts = new Map();
  for (const artifact of result.artifacts) {
    if (!Object.hasOwn(operation.artifacts, artifact.role)) throw new Error(`Undeclared artifact role: ${artifact.role}`);
    counts.set(artifact.role, (counts.get(artifact.role) ?? 0) + 1);
  }
  for (const [role, field] of Object.entries(operation.artifacts)) {
    const count = counts.get(role) ?? 0;
    if (count < (field.minimum ?? 1) || count > (field.maximum ?? Infinity)) throw new Error(`Artifact cardinality mismatch: ${role}`);
  }
  const indices = new Map();
  for (const artifact of result.artifacts) {
    const { role, file } = artifact;
    const field = operation.artifacts[role];
    const index = indices.get(role) ?? 0;
    indices.set(role, index + 1);
    const id = artifact.id ?? (counts.get(role) === 1 ? role : `${role}-${index + 1}`);
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(id) || id === 'report' || files.has(id)) throw new Error(`Invalid or duplicate artifact ID: ${id}`);
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size || !file.name || /[\\/]/.test(file.name)) throw new Error(`The ${role} output is empty or invalid`);
    if (names.has(file.name)) throw new Error(`Duplicate or reserved output filename: ${file.name}`);
    names.add(file.name);
    const allowedTypes = Array.isArray(field.type) ? field.type : [field.type];
    const type = artifact.type ?? (allowedTypes.length === 1 ? allowedTypes[0] : undefined);
    if (!allowedTypes.includes(type)) throw new Error(`The ${role} output needs a declared semantic type`);
    const metadata = { role, type };
    for (const key of ['mediaType', 'space', 'labelSystem']) {
      if (artifact[key] !== undefined && artifact[key] !== field[key]) throw new Error(`The ${role} output cannot override ${key}`);
      if (field[key] !== undefined) metadata[key] = field[key];
    }
    records[id] = { ...metadata, ...await describeFile(file, signal) };
    files.set(id, file);
  }
  return { files, records };
}

export function registerAppAutomation({ app, operations, convertDicom, contractUrl = 'automation.json', contract: providedContract, document: doc = globalThis.document, target = globalThis, download = downloadFile }) {
  const adopted = new Map();
  const viewers = createViewerRegistry();
  let contract;
  let active;
  let artifacts = new Map();
  let snapshot = { schemaVersion: 2, app, runId: null, state: 'idle' };
  const transfer = doc.createElement('input');
  transfer.type = 'file';
  transfer.multiple = true;
  transfer.hidden = true;
  transfer.id = 'neurodesk-input-transfer';
  transfer.dataset.neurodeskInput = 'dataset';
  if (doc.getElementById(transfer.id)) throw new Error('Application automation is already registered');
  doc.body.append(transfer);
  const ready = (async () => {
    if (providedContract) contract = copy(providedContract);
    else {
      const response = await fetch(new URL(contractUrl, doc.baseURI));
      if (!response.ok) throw new Error(`Automation contract could not be loaded (${response.status})`);
      contract = await response.json();
    }
    validateRegistration(contract, app, operations, convertDicom);
    snapshot.appVersion = contract.appVersion;
    return copy(contract);
  })();
  // Loading is lazy from the caller's perspective; dispatch and .ready preserve the error.
  void ready.catch(() => {});

  async function execute(run, request, operation, sourceFiles) {
    const { signal } = run.controller;
    const inputs = {};
    const inputDetails = {};
    const inputRecords = {};
    const conversions = {};
    try {
      for (const [role, field] of Object.entries(operation.inputs)) {
        signal.throwIfAborted();
        if (field.source !== 'files') {
          const source = request.inputs?.[role];
          if (!object(source) || typeof source.url !== 'string') {
            if (field.minimum > 0) throw new Error(`Missing input: ${role}`);
            inputs[role] = [];
            inputRecords[role] = [];
            continue;
          }
          const url = new URL(source.url);
          if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`Unsupported source URL: ${role}`);
          inputs[role] = { url: url.href };
          inputRecords[role] = { url: url.href };
          continue;
        }
        const files = sourceFiles.get(role) ?? [];
        if (!files.length && field.minimum > 0) throw new Error(`Missing input: ${role}`);
        inputRecords[role] = [];
        for (const file of files) inputRecords[role].push(await describeFile(file, signal));
        if (files.length && convertsDicom(field)) {
          const prepared = await prepareImageInput(files, field, { selection: request.selections?.[role], convertDicom, signal });
          inputs[role] = prepared.files;
          inputDetails[role] = prepared.details;
          conversions[role] = prepared.details.conversion;
        } else {
          if (files.length < field.minimum || files.length > (field.maximum ?? Infinity)) throw new Error(`Input cardinality mismatch: ${role}`);
          if (request.selections?.[role] !== undefined) throw new Error(`Input ${role} does not support series selection`);
          inputs[role] = files;
          inputDetails[role] = { sidecars: [] };
        }
      }
      signal.throwIfAborted();
      const result = await operations[run.operation]({ inputs, parameters: copy(run.parameters), signal, inputDetails,
        progress(update) {
          if (active !== run || signal.aborted || terminal.has(snapshot.state)) return;
          snapshot = { ...snapshot, ...(typeof update === 'string' ? { message: update } : { ...(update.message !== undefined && { message: String(update.message) }), ...(Number.isFinite(update.value) && { progress: update.value }) }) };
        },
      });
      signal.throwIfAborted();
      if (!object(result)) throw new Error('The operation did not return a result');
      const completed = await makeArtifacts(result, operation, signal);
      if (operation.mode === 'viewer' && (!object(result.summary) || Object.keys(result.summary).length === 0 || viewers.list().length === 0)) {
        throw new Error('A viewer operation must return a source summary and register its real viewer');
      }
      signal.throwIfAborted();
      if (active !== run) return;
      const report = { schemaVersion: 2, app, appVersion: contract.appVersion, runId: run.id, operation: run.operation,
        status: 'succeeded', inputs: inputRecords, parameters: copy(run.parameters), artifacts: completed.records,
        provenance: { ...copy(result.provenance ?? {}), ...(Object.keys(conversions).length && { inputConversions: conversions }) },
        ...(result.measurements !== undefined && { measurements: copy(result.measurements) }),
        ...(result.summary !== undefined && { summary: copy(result.summary) }),
      };
      artifacts = completed.files;
      artifacts.set('report', new File([JSON.stringify(report, null, 2)], 'report.json', { type: 'application/json' }));
      snapshot = { ...snapshot, state: 'succeeded', report };
    } catch (error) {
      if (active !== run || signal.aborted) return;
      artifacts.clear();
      snapshot = { ...snapshot, state: 'failed', error: { message: error.message || String(error),
        ...(error.code && { code: error.code }), ...(error.candidates && { candidates: copy(error.candidates) }),
      } };
      run.controller.abort(error);
    }
  }

  async function dispatch(command, request = {}) {
    await ready;
    if (!object(request)) throw new Error('Automation command arguments must be an object');
    if (command === 'describe') return copy(contract);
    if (command === 'snapshot') return copy(snapshot);
    if (command === 'cancel') {
      if (!active || terminal.has(snapshot.state)) return { cancelled: false };
      artifacts.clear();
      snapshot = { ...snapshot, state: 'cancelled' };
      active.controller.abort(new DOMException('Cancelled', 'AbortError'));
      return { cancelled: true };
    }
    if (command === 'adopt') {
      if (!terminal.has(snapshot.state)) throw new Error('An operation is already running');
      if (!Object.values(contract.operations).some(operation => Object.hasOwn(operation.inputs, request.role) && operation.inputs[request.role].source === 'files')) throw new Error(`Unknown file input role: ${request.role}`);
      adopted.set(request.role, Array.from(transfer.files));
      transfer.value = '';
      return { role: request.role, count: adopted.get(request.role).length };
    }
    if (command === 'start') {
      if (!terminal.has(snapshot.state)) throw new Error('An operation is already running');
      const name = request.operation ?? contract.defaultOperation;
      if (!Object.hasOwn(contract.operations, name)) throw new Error(`Unknown operation: ${name}`);
      const operation = contract.operations[name];
      for (const field of ['inputs', 'selections']) {
        if (request[field] !== undefined && !object(request[field])) throw new Error(`${field} must be an object`);
        for (const role of Object.keys(request[field] ?? {})) if (!Object.hasOwn(operation.inputs, role)) throw new Error(`Unknown input role: ${role}`);
      }
      const parameters = operationParametersSchema(operation.parameters).parse(request.parameters);
      const run = { id: crypto.randomUUID(), operation: name, controller: new AbortController(), parameters };
      active = run;
      artifacts.clear();
      snapshot = { schemaVersion: 2, app, appVersion: contract.appVersion, runId: run.id, operation: name, state: 'running' };
      const files = new Map(adopted);
      adopted.clear();
      void execute(run, copy(request), operation, files);
      return { runId: run.id, state: 'running' };
    }
    if (command === 'download') {
      if (snapshot.state !== 'succeeded' || !artifacts.has(request.artifactId)) throw new Error('The requested completed artifact is unavailable');
      await download(artifacts.get(request.artifactId));
      return { artifactId: request.artifactId };
    }
    if (command.startsWith('viewers.')) return viewers.dispatch(command, request);
    throw new Error(`Unknown automation command: ${command}`);
  }
  const handle = { ready, dispatch, registerViewer: (id, adapter) => viewers.register(id, adapter) };
  target.neurodeskAutomation = Object.freeze({ dispatch });
  pageRegistration = handle;
  return handle;
}

export function registerViewer(id, adapter) {
  if (!pageRegistration) throw new Error('Register app automation before attaching a viewer');
  return pageRegistration.registerViewer(id, adapter);
}
