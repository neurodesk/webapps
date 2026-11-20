// NeSVoR webapp entry. The interface is the shared workspace vocabulary; the
// app owns the stack table, the reconstruction settings and the job it sends to
// the compute server (docs/architecture/nesvor-remote-compute.md).
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  bindInfoTooltips,
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  createComputeConnection,
} from '@neurodesk/webapp-components/ui';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { ComputeError } from '@neurodesk/webapp-components/compute';
import { registerAppAutomation, createNiivueAdapter } from '@neurodesk/webapp-components/automation';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { runBrowserReference, runBrowserReconstruction } from '@neurodesk/nesvor/browser';
import { APP } from './config.js';
import { PRESETS, DEFAULT_OPTIONS, presetOptions, validateNesvorSpec } from './spec.js';
import { assembleJob, describeStack, formatDims, isNiftiName, matchMasks } from './stacks.js';
import examples from '../examples.json';
import { createProgressReporter } from './progress.js';

const $ = id => document.getElementById(id);
bindInfoTooltips();

// 1. Shell: shared app bar, sidebar, viewer and status regions.
const workspace = mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'NeSVoR',
  subtitle: 'Slice-to-volume reconstruction',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

// 2. Viewer chrome: layout tabs above the canvas, technical log below it.
let viewer = null;
let viewerReady = null;
const layouts = {
  multiplanar: () => { viewer.sliceType = SLICE_TYPE.MULTIPLANAR; viewer.multiplanarType = MULTIPLANAR_TYPE.GRID; viewer.showRender = SHOW_RENDER.ALWAYS; },
  axial: () => { viewer.sliceType = SLICE_TYPE.AXIAL; },
  coronal: () => { viewer.sliceType = SLICE_TYPE.CORONAL; },
  sagittal: () => { viewer.sliceType = SLICE_TYPE.SAGITTAL; },
  render: () => { viewer.sliceType = SLICE_TYPE.RENDER; },
};
const toolbar = createViewerToolbar({
  views: [
    { id: 'multiplanar', label: 'Multiplanar', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map(view => ({ ...view, onClick: () => { if (!viewer) return; layouts[view.id](); viewer.drawScene(); toolbar.setActive(view.id); } })),
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
});
$('viewer').prepend(toolbar);
const log = createConsole({ id: 'technicalLog', title: 'Compute log' });
$('viewer').append(log);

// 3. Information dialogs: About and Privacy are app-owned; Cite comes from the registry.
const info = createInfoDialog();
$('aboutBtn').onclick = () => info.open('About NeSVoR', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
$('standaloneLink').onclick = () => document.querySelector('[data-neurodesk-shell-control="standalone"]')?.click();

// 4. State.
const rows = [];
const masks = [];
let job = null;
let loading = null;
let timer = null;
let started = 0;

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function elapsed() {
  const seconds = Math.round((Date.now() - started) / 1000);
  $('elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function ensureViewer() {
  if (viewerReady) return viewerReady;
  viewerReady = (async () => {
    // Keep visualization alive when the worker's WebGPU device is destroyed.
    viewer = new NiiVue({ backend: 'webgl2', isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
    await viewer.attachTo('gl1');
    layouts.multiplanar();
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on('locationChange', event => { $('location').textContent = event.detail.string; });
    automation.registerViewer('main', createNiivueAdapter(viewer));
    return viewer;
  })();
  return viewerReady;
}

let viewerSequence = 0;
let viewerQueue = Promise.resolve();
function show(file, label) {
  const sequence = ++viewerSequence;
  $('emptyState').hidden = true;
  $('gl1').hidden = true;
  $('imageLabel').textContent = `Loading ${file.name}…`;
  viewerQueue = viewerQueue.then(async () => {
    if (sequence !== viewerSequence) return;
    try {
      const nv = await ensureViewer();
      await nv.loadVolumes([{ url: file, name: file.name }]);
      if (sequence !== viewerSequence) return;
      $('imageLabel').textContent = label;
      $('gl1').hidden = false;
      $('viewerError').hidden = true;
    } catch (error) {
      if (sequence !== viewerSequence) return;
      $('viewerError').hidden = false;
      $('viewerError').textContent = `Visualization unavailable: ${error.message}. Reconstruction and download remain available.`;
    }
  });
  return viewerQueue;
}

// 5. Compute server connection.
const connection = createComputeConnection({ id: 'computeConnection', storageKey: 'nesvor.compute', autodetect: false });
$('computeControl').append(connection);
connection.addEventListener('nd-compute-change', ({ detail }) => {
  const badge = $('computeBadge');
  const labels = { connected: 'connected', simulated: 'simulated', connecting: 'connecting', error: 'not connected' };
  badge.textContent = labels[detail.state] || '';
  badge.hidden = !badge.textContent;
  if (detail.state === 'connected' || detail.state === 'simulated') {
    $('computeSection').open = false;
    log.log(`Compute server ready: ${connection.message.textContent}`, detail.state === 'simulated' ? 'warning' : 'success');
  } else if (detail.state === 'idle') {
    $('computeSection').open = true;
  }
  syncRun();
  void refreshJobs();
});

// 6. Reconstruction settings.
const OPTION_IDS = Object.keys(DEFAULT_OPTIONS);
const protocolSelect = $('protocol');
for (const preset of PRESETS) {
  const option = document.createElement('option');
  option.value = preset.id;
  option.textContent = preset.label;
  protocolSelect.append(option);
}

function readOptions() {
  const options = {};
  for (const id of OPTION_IDS) {
    const input = $(id);
    if (input.type === 'checkbox') options[id] = input.checked;
    else if (input.tagName === 'SELECT') options[id] = input.value;
    else options[id] = Number(input.value);
  }
  return options;
}

function writeOptions(options) {
  for (const id of OPTION_IDS) {
    const input = $(id);
    if (input.type === 'checkbox') input.checked = Boolean(options[id]);
    else input.value = String(options[id]);
  }
}

function applyProtocol(id) {
  const preset = PRESETS.find(item => item.id === id);
  $('protocolHint').textContent = preset.description;
  const options = presetOptions(id);
  if (options) writeOptions(options);
}
protocolSelect.addEventListener('change', () => applyProtocol(protocolSelect.value));
for (const id of OPTION_IDS) {
  $(id).addEventListener('change', () => {
    if (protocolSelect.value === 'custom') return;
    protocolSelect.value = 'custom';
    $('protocolHint').textContent = PRESETS.find(item => item.id === 'custom').description;
  });
}
protocolSelect.value = 'fetal-brain';
applyProtocol('fetal-brain');

// 7. Stack table.
const results = createResultList({
  element: $('resultList'),
  stageLabels: { result: 'Run record (JSON)', log: 'Compute log' },
  onView: (stage, result) => {
    if (stage === 'volume') void show(result.file, `${result.file.name} · reconstructed`);
    else status(`${result.file.name} · ${result.description}`);
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function renderRows() {
  const body = $('stackRows');
  body.replaceChildren();
  rows.forEach((row, index) => {
    const item = document.createElement('div');
    item.dataset.stack = String(index);
    const head = document.createElement('div');
    head.className = 'nd-volume-toggle';
    const label = document.createElement('span');
    label.className = 'nd-stage-label';
    label.textContent = `${row.file.name} · ${row.slices} slices`;
    label.title = `${formatDims(row.dims)} voxels`;
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'nd-view-btn';
    view.textContent = 'View';
    view.addEventListener('click', () => void show(row.file, `${row.file.name} · stack ${index + 1} of ${rows.length}`));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'nd-download-btn';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${row.file.name}`);
    remove.addEventListener('click', () => { rows.splice(index, 1); renderRows(); syncRun(); });
    head.append(label, view, remove);
    const fields = document.createElement('div');
    fields.className = 'nd-row';
    const thickness = document.createElement('div');
    thickness.className = 'nd-field';
    const thicknessLabel = document.createElement('label');
    thicknessLabel.htmlFor = `thickness-${index}`;
    thicknessLabel.textContent = 'Thickness';
    const small = document.createElement('small');
    small.textContent = 'mm';
    thicknessLabel.append(' ', small);
    const input = document.createElement('input');
    input.type = 'number';
    input.id = `thickness-${index}`;
    input.min = '0.1';
    input.max = '20';
    input.step = '0.1';
    input.value = String(row.thickness);
    input.addEventListener('change', () => {
      row.thickness = Number(input.value);
      row.thicknessSource = 'manual';
      syncThicknessHint();
      syncRun();
    });
    thickness.append(thicknessLabel, input);
    const mask = document.createElement('div');
    mask.className = 'nd-field';
    mask.hidden = masks.length === 0;
    const maskLabel = document.createElement('label');
    maskLabel.htmlFor = `mask-${index}`;
    maskLabel.textContent = 'Mask';
    const select = document.createElement('select');
    select.id = `mask-${index}`;
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None';
    select.append(none);
    masks.forEach((maskFile, maskIndex) => {
      const option = document.createElement('option');
      option.value = String(maskIndex);
      option.textContent = maskFile.name;
      option.selected = row.mask === maskFile;
      select.append(option);
    });
    select.addEventListener('change', () => { row.mask = select.value === '' ? null : masks[Number(select.value)]; syncRun(); });
    mask.append(maskLabel, select);
    fields.append(thickness, mask);
    item.append(head, fields);
    body.append(item);
  });
  $('stackRows').hidden = !rows.length;
  syncThicknessHint();
  $('fileInfo').hidden = !rows.length;
  $('fileInfo').textContent = rows.length ? `${rows.length} stack${rows.length === 1 ? '' : 's'} loaded` : '';
  $('dropZone').classList.toggle('has-files', rows.length > 0);
}

function isBrowser() {
  return $('executionMode').value !== 'remote';
}

function isBrowserReference() {
  return $('executionMode').value === 'browser-reference';
}

function syncThicknessHint() {
  $('stackHint').hidden = !rows.some(row => row.thicknessSource === 'spacing');
}

function syncRun() {
  const busy = Boolean(job || loading);
  connection.setDisabled(busy);
  $('executionMode').disabled = busy;
  $('referenceAcknowledged').disabled = busy;
  $('refreshJobs').disabled = busy;
  $('deleteJob').disabled = busy || !$('previousJob').value;
  $('resumeJob').disabled = busy || !$('previousJob').value;
  $('previousJob').disabled = busy;
  exampleControl.setDisabled(busy);
  for (const input of document.querySelectorAll('#inputSection input, #inputSection select, #stackRows button, #taskSection input, #taskSection select')) input.disabled = busy;
  const complete = rows.length > 0 && rows.every(row => Number.isFinite(row.thickness) && row.thickness > 0);
  const available = isBrowserReference() ? $('referenceAcknowledged').checked && rows.every(row => row.mask) : isBrowser() ? Boolean(navigator.gpu) : Boolean(connection.client);
  $('runButton').disabled = busy || !complete || !available;
  $('runButton').title = !rows.length ? 'Load stacks first' : !complete ? 'Enter a positive slice thickness for every stack' : !available ? (isBrowserReference() ? 'Assign all masks and acknowledge the reference limits' : isBrowser() ? 'A WebGPU-capable browser is required' : 'Connect to a compute server first') : '';
}

function assignMasks() {
  const indices = matchMasks(rows.map(row => row.file.name), masks.map(mask => mask.name));
  for (const row of rows) row.mask = null;
  indices.forEach((stackIndex, maskIndex) => {
    if (stackIndex >= 0) rows[stackIndex].mask = masks[maskIndex];
  });
}

async function loadFiles(filesPromise, signal, { replace = false, asMasks = false } = {}) {
  if (job || loading) throw new Error('Wait for the current operation to finish, or cancel it first.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  loading = controller;
  $('imageInput').disabled = true;
  $('maskInput').disabled = true;
  exampleControl.setDisabled(true);
  $('cancelButton').hidden = false;
  syncRun();
  status('Reading stacks…');
  try {
    const files = await readImageFiles(await filesPromise, { signal: controller.signal });
    controller.signal.throwIfAborted();
    const stacks = asMasks ? [] : files.filter(file => isNiftiName(file.name) && !/mask/i.test(file.name));
    const maskFiles = asMasks ? files : files.filter(file => isNiftiName(file.name) && /mask/i.test(file.name));
    if (!stacks.length && !maskFiles.length) throw new Error('Choose NIfTI stacks (.nii or .nii.gz).');
    const prepared = [];
    for (const file of stacks) {
      const description = await describeStack(file);
      controller.signal.throwIfAborted();
      prepared.push({ file, ...description, mask: null });
    }
    for (const file of maskFiles) await describeStack(file);
    controller.signal.throwIfAborted();
    if (replace) {
      rows.length = 0;
      masks.length = 0;
    }
    rows.push(...prepared);
    masks.push(...maskFiles);
    if (maskFiles.length || replace) assignMasks();
    results.render();
    $('outputSection').open = false;
    $('progress').value = 0;
    renderRows();
    if (stacks.length) await show(stacks[0], `${stacks[0].name} · stack ${rows.length - stacks.length + 1} of ${rows.length}`);
    status(`${rows.length} stack${rows.length === 1 ? '' : 's'} loaded${masks.length ? `, ${masks.length} mask${masks.length === 1 ? '' : 's'}` : ''}`);
  } finally {
    signal?.removeEventListener('abort', abort);
    loading = null;
    $('imageInput').disabled = false;
    $('maskInput').disabled = false;
    exampleControl.setDisabled(false);
    $('cancelButton').hidden = !job;
    syncRun();
  }
}

function importFiles(files, options) {
  exampleControl.cancel();
  return loadFiles(files, undefined, options).catch(error => status(
    error.name === 'AbortError' ? 'Loading cancelled' : error.message,
    error.name !== 'AbortError',
  ));
}

const automation = registerAppAutomation({
  app: 'nesvor',
  operations: {
    'open-stacks': async ({ inputs, signal }) => {
      await loadFiles(inputs.stacks, signal, { replace: true });
      signal.throwIfAborted();
      if (!rows.length) throw new Error('Choose acquisition stacks, not only mask files.');
      return { artifacts: [], summary: { stacks: rows.map(row => ({ name: row.file.name, thickness: row.thickness })) } };
    },
  },
});

function importMasks(filesPromise) {
  return importFiles(filesPromise, { asMasks: true });
}

$('imageInput').addEventListener('change', event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length) void importFiles(Promise.resolve(files));
});
$('maskInput').addEventListener('change', event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length) void importMasks(Promise.resolve(files));
});
bindFileDrop($('dropZone'), files => importFiles(files));
bindFileDrop($('maskDropZone'), files => importMasks(files).catch(error => status(error.message, true)));

const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(exampleControl.dataset.exampleState === 'ready' ? `Example ready · ${rows.length} stacks. Ready to reconstruct.` : message, error),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal, { replace: true });
    assertCurrent();
    protocolSelect.value = example.protocol || 'fetal-brain';
    applyProtocol(protocolSelect.value);
  },
});
$('exampleControl').append(exampleControl);

// 8. Reconstruction on the compute server.
function finishJob() {
  clearInterval(timer);
  timer = null;
  job = null;
  $('cancelButton').hidden = true;
  syncRun();
  void refreshJobs();
}

async function reconstruct() {
  if (isBrowser()) return reconstructLocally();
  const client = connection.client;
  if (!client || job || loading || !rows.length) return;
  let spec, files;
  const stamp = rows[0].file.name.replace(/\.nii(\.gz)?$/i, '');
  try {
    ({ spec, files } = assembleJob(rows, readOptions()));
    validateNesvorSpec(spec, Object.keys(files));
  } catch (error) {
    return status(`Check the settings: ${error.message}`, true);
  }
  const controller = new AbortController();
  job = { controller, client, id: null, cancelling: false, key: crypto.randomUUID() };
  started = Date.now();
  elapsed();
  timer = setInterval(elapsed, 1000);
  $('progress').value = 0;
  $('cancelButton').hidden = false;
  results.render();
  $('outputSection').open = false;
  syncRun();
  status(`Uploading ${rows.length} stack${rows.length === 1 ? '' : 's'} to ${new URL(client.baseUrl).host}…`);
  log.log(`Job spec: ${JSON.stringify(spec)}`);
  try {
    const submitted = await client.submit(spec, files, { signal: controller.signal, idempotencyKey: job.key });
    job.id = submitted.id;
    if (job.cancelling) await client.cancel(submitted.id);
    status(submitted.position > 0 ? `Queued behind ${submitted.position} job${submitted.position === 1 ? '' : 's'}` : 'Queued on the compute server');
    await collectJob(client, submitted.id, controller, stamp, spec);
  } catch (error) {
    if (error?.name === 'AbortError' || (error instanceof ComputeError && error.code === 'cancelled')) {
      status('Reconstruction cancelled');
    } else {
      status(`Reconstruction interrupted: ${error.message}. Check Previous jobs before starting another run.`, true);
      void refreshJobs();
      if (error instanceof ComputeError && error.job?.error) log.log(JSON.stringify(error.job.error), 'error');
    }
  } finally {
    finishJob();
  }
  return null;
}

async function collectJob(client, id, controller, stamp, spec) {
    const done = await client.watch(id, {
      onStatus: event => {
        if (event.status === 'queued') status(event.position > 0 ? `Queued behind ${event.position} job${event.position === 1 ? '' : 's'}` : 'Queued on the compute server');
        else if (event.status === 'running') status('Running on the compute server');
      },
      onProgress: event => {
        $('progress').value = event.fraction;
        $('statusText').textContent = `${event.stage} · ${Math.round(event.fraction * 100)}%`;
      },
      onLog: event => log.log(event.line, event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'info'),
    }, { signal: controller.signal });
    status('Downloading the reconstructed volume…');
    const volume = new File([await client.output(done.id, 'volume.nii.gz', { signal: controller.signal })], `${stamp}_nesvor.nii.gz`, { type: 'application/gzip' });
    const record = new File([await client.output(done.id, 'result.json', { signal: controller.signal })], `${stamp}_nesvor.json`, { type: 'application/json' });
    const logFile = new File([await client.output(done.id, 'log.txt', { signal: controller.signal })], `${stamp}_nesvor.log`, { type: 'text/plain' });
    results.render({
      volume: { description: done.simulated ? 'Simulated placeholder (mean of the stacks), not a reconstruction' : `Reconstructed volume, ${spec?.options.outputResolution ?? "recorded"} mm isotropic`, file: volume },
      result: { description: 'Inputs and results recorded by nesvor', file: record, viewable: false },
      log: { description: 'Complete output of the compute server', file: logFile, viewable: false },
    }, ['volume', 'result', 'log']);
    $('outputSection').open = true;
    $('progress').value = 1;
    await show(volume, `${volume.name} · reconstructed`);
    status(done.simulated ? 'Simulated result ready · the server did not run NeSVoR' : 'Reconstructed volume ready');
}

async function refreshJobs() {
  const client = connection.client;
  $('previousJobs').hidden = !client;
  if (!client) return;
  try {
    const { jobs } = await client.jobs();
    if (client !== connection.client) return;
    $('previousJob').replaceChildren(...jobs.map(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.createdAt} · ${item.status} · ${item.id.slice(0, 8)}`;
      return option;
    }));
    $('resumeJob').disabled = !jobs.length || Boolean(job);
    $('deleteJob').disabled = !jobs.length || Boolean(job);
  } catch (error) {
    log.log(`Could not list previous jobs: ${error.message}`, 'warning');
  }
}

$('refreshJobs').onclick = () => void refreshJobs();
$('deleteJob').onclick = async () => {
  const client = connection.client;
  const id = $('previousJob').value;
  if (!client || !id || job || loading) return;
  try {
    await client.remove(id);
    status('Server job and files deleted');
    await refreshJobs();
  } catch (error) {
    status(`Server job was not deleted: ${error.message}`, true);
  }
};
$('resumeJob').onclick = async () => {
  const client = connection.client;
  const id = $('previousJob').value;
  if (!client || !id || job || loading) return;
  const controller = new AbortController();
  job = { client, id, controller, cancelling: false };
  started = Date.now();
  timer = setInterval(elapsed, 1000);
  $('cancelButton').hidden = false;
  syncRun();
  try {
    await collectJob(client, id, controller, `job-${id.slice(0, 8)}`);
  } catch (error) {
    status(`Job ${id.slice(0, 8)}: ${error.message}`, true);
  } finally {
    finishJob();
    void refreshJobs();
  }
};

function syncExecutionMode() {
  const browser = isBrowser();
  const reference = isBrowserReference();
  $('browserReferenceInfo').hidden = !reference;
  $('browserGpuInfo').hidden = !browser || reference;
  $('remoteControls').hidden = browser;
  connection.configure({ autodetect: !browser });
  if (!browser) void connection.detect();
  for (const id of ['protocol', 'registration']) $(id).closest('.nd-field').hidden = reference;
  $('advancedSettings').hidden = reference;
  $('singlePrecision').closest('label').hidden = browser && !reference;
  for (const [id, remoteMinimum] of [['iterations', 100], ['batchSize', 256], ['log2HashmapSize', 15]]) {
    $(id).min = String(browser && !reference ? id === 'log2HashmapSize' ? 3 : 1 : remoteMinimum);
    $(id).step = String(browser && !reference || id === 'log2HashmapSize' ? 1 : remoteMinimum);
  }
  $('runButton').textContent = reference ? 'Run browser reference' : browser ? 'Reconstruct in browser' : 'Reconstruct volume';
  syncRun();
}
$('executionMode').addEventListener('change', syncExecutionMode);
syncExecutionMode();
$('referenceAcknowledged').addEventListener('change', syncRun);

async function reconstructLocally() {
  if (job || loading || !rows.length) return;
  const controller = new AbortController();
  const snapshot = rows.map(row => ({ ...row }));
  const resolution = Number($('outputResolution').value);
  const acknowledged = $('referenceAcknowledged').checked;
  const reference = isBrowserReference();
  const options = reference ? { registration: 'none', outputResolution: resolution } : { ...readOptions(), singlePrecision: true };
  const runner = reference ? runBrowserReference : runBrowserReconstruction;
  const suffix = reference ? 'reference' : 'webgpu';
  const stamp = snapshot[0].file.name.replace(/\.nii(\.gz)?$/i, '');
  job = { controller, mode: reference ? 'browser-reference' : 'browser-webgpu' };
  started = Date.now();
  const reporter = createProgressReporter({
    display: (message, fraction) => {
      $('statusText').textContent = message;
      if (fraction === undefined) $('progress').removeAttribute('value');
      else $('progress').value = fraction;
    },
    log: message => log.log(message, 'info'),
  });
  timer = setInterval(() => { elapsed(); reporter.checkQuiet(); }, 1000);
  $('cancelButton').hidden = false;
  results.render();
  syncRun();
  status('Preparing the experimental browser reconstruction…');
  try {
    const stacks = await Promise.all(snapshot.map(async row => ({
      image: await row.file.arrayBuffer(),
      mask: await row.mask?.arrayBuffer(),
      thickness: row.thickness,
    })));
    const output = await runner({
      stacks,
      options,
      runtime: { modelBaseUrl: import.meta.env.NESVOR_LOCAL_MODELS ? new URL('svort/', document.baseURI).href : undefined, wasmBaseUrl: new URL('ort/', document.baseURI).href, n4BaseUrl: new URL('n4/', document.baseURI).href },
      reference: { acknowledged },
    }, {
      signal: controller.signal,
      onProgress: reporter.update,
    });
    const volume = new File([output.volume], `${stamp}_nesvor_${suffix}.nii`, { type: 'application/octet-stream' });
    const record = new File([JSON.stringify(output.provenance, null, 2)], `${stamp}_nesvor_${suffix}.json`, { type: 'application/json' });
    const logFile = new File([reporter.text(), '\n', output.log], `${stamp}_nesvor_${suffix}.log`, { type: 'text/plain' });
    results.render({
      volume: { description: reference ? 'Experimental CPU reference output; not validated for clinical use' : 'Experimental WebGPU reconstruction; full acquisition validation outstanding', file: volume },
      result: { description: 'Reconstruction settings and limitations', file: record, viewable: false },
      log: { description: 'Browser reconstruction log', file: logFile, viewable: false },
    }, ['volume', 'result', 'log']);
    $('outputSection').open = true;
    $('progress').value = 1;
    await show(volume, `${volume.name} · experimental ${suffix}`);
    status(reference ? 'Browser reference output ready · full NeSVoR parity is not established' : 'Browser WebGPU output ready · full acquisition validation is outstanding');
  } catch (error) {
    status(error.name === 'AbortError' ? 'Browser reconstruction cancelled' : error.message, error.name !== 'AbortError');
  } finally {
    finishJob();
  }
}

$('runButton').addEventListener('click', () => void reconstruct());
$('cancelButton').onclick = async () => {
  exampleControl.cancel();
  loading?.abort();
  if (job?.mode === 'browser-reference' || job?.mode === 'browser-webgpu') {
    job.controller.abort();
    return;
  }
  if (job) {
    const currentJob = job;
    currentJob.cancelling = true;
    $('cancelButton').disabled = true;
    status('Requesting cancellation; waiting for the server to stop processing…');
    try {
      if (currentJob.id) await currentJob.client.cancel(currentJob.id);
    } catch (error) {
      if (job !== currentJob) return;
      currentJob.cancelling = false;
      status(`Cancellation was not confirmed: ${error.message}. The job may still be running.`, true);
    } finally {
      if (job === currentJob || !job) $('cancelButton').disabled = false;
    }
  }
};
window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  loading?.abort();
  job?.controller.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, connection, version: APP.version });
