import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { createResultList, createInfoDialog, createConsole, createFileField, createViewerToolbar, createMaskEditor } from '@neurodesk/webapp-components/ui';
import { downloadBlob, downloadFile } from '@neurodesk/webapp-components/file-io';
import { readImageFiles, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import { readVolume } from '@neurodesk/synthsr';
import examples from '../examples.json';
import { editedResult, extractionOutputs } from './outputs.js';
import appPackage from '../package.json';
import { createRunState, registerAppAutomation, createNiivueAdapter } from '@neurodesk/webapp-components/automation';

const $ = id => document.getElementById(id);
mountImagingWorkspace({
  controls: '#controls', viewer: '#viewer', status: '#status', title: 'Brain extraction',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});
const info = createInfoDialog({ id: 'infoDialog' });
$('aboutBtn').onclick = () => info.open('About Brain extraction', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
const log = createConsole({ id: 'technicalLog' });
$('viewer').append(log);
const runs = createRunState({ app: 'brain-extraction', appVersion: appPackage.version });
let viewer;
let viewerReady;
let viewQueue = Promise.resolve();
let viewRevision = 0;
let displayedStage = null;
let editor = null;
// { previous }: the stage shown before the open edit, restored when it closes.
let editing = null;
const layouts = {
  multiplanar: () => {
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.showRender = SHOW_RENDER.ALWAYS;
  },
  axial: () => { viewer.sliceType = SLICE_TYPE.AXIAL; },
  coronal: () => { viewer.sliceType = SLICE_TYPE.CORONAL; },
  sagittal: () => { viewer.sliceType = SLICE_TYPE.SAGITTAL; },
  render: () => { viewer.sliceType = SLICE_TYPE.RENDER; },
};
const toolbar = createViewerToolbar({
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map(view => ({ ...view, onClick: () => {
    if (!viewer) return;
    layouts[view.id]();
    viewer.drawScene();
    toolbar.setActive(view.id);
  } })),
});
$('viewer').prepend(toolbar);
const picker = createFileField({ id: 'imageInput', rootId: 'dropZone', text: 'Drop NIfTI or DICOM files or folder' });
$('filePicker').append(picker);
const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    if (!await importImages(fetchFiles, signal)) throw new Error('The example image could not be loaded.');
    assertCurrent();
  },
  onStatus: status,
});
exampleControl.select.id = 'example';
exampleControl.querySelector('label').htmlFor = 'example';
$('exampleControl').replaceWith(exampleControl);

const results = createResultList({
  element: $('resultList'),
  onView: (stage, result) => {
    if (editing) return;
    show(result.file, stage);
  },
  onDownload: (_stage, result) => downloadFile(result.file),
  onEdit: (stage, result) => void editResult(stage, result),
});
let source = null;
let outputs = {};
let state = { phase: 'idle' };
const methodHints = {
  mindgrab: 'Brainchop neural network. Runs on the GPU when available, with a CPU fallback.',
  synthstrip: 'SynthStrip runs on the CPU and can need several GB of memory.',
};
function methodChanged() {
  $('methodHint').textContent = methodHints[$('method').value] || '';
  $('methodHint').hidden = $('method').value === 'bet';
  $('advancedSettings').hidden = $('method').value === 'synthstrip';
  $('betSettings').hidden = $('method').value !== 'bet';
  $('mindgrabSettings').hidden = $('method').value !== 'mindgrab';
}
$('method').onchange = methodChanged;
methodChanged();

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
  runs.message(message);
}
function refreshControls() {
  const busy = state.phase !== 'idle';
  exampleControl.setDisabled(busy);
  picker.disabled = busy;
  for (const id of ['folderInput', 'folderButton', 'method', 'threshold', 'mindgrabBackend']) $(id).disabled = busy;
  $('runButton').disabled = busy || !source;
  $('cancelButton').hidden = !busy;
  $('reportBtn').disabled = busy || runs.snapshot().state !== 'succeeded';
}
function start(phase, context) {
  const job = { phase, run: runs.begin(phase, context), worker: null, started: performance.now() };
  state = job;
  $('elapsed').textContent = '';
  $('progress').value = 0;
  job.timer = setInterval(() => {
    $('elapsed').textContent = `${Math.round((performance.now() - job.started) / 1000)} s`;
  }, 1000);
  refreshControls();
  return job;
}
function finish(job) {
  if (state !== job) return false;
  clearInterval(job.timer);
  job.worker?.terminate();
  $('elapsed').textContent = `${Math.round((performance.now() - job.started) / 1000)} s`;
  state = { phase: 'idle' };
  refreshControls();
  return true;
}
// MindGrab's "auto" falls back to WebGL when WebGPU has no adapter; on a software GL stack that
// never finishes, so route adapter-less browsers to the CPU module instead.
async function resolveMindgrabBackend(requested, run) {
  if (requested !== 'auto') return requested;
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (adapter) return 'auto';
  if (run.current) status('No WebGPU adapter · using CPU processing');
  return 'cpu';
}
function closeEdit() {
  const previous = editing?.previous;
  editing = null;
  results.setEditingEnabled(!editor || editor.session.state === 'idle');
  if (outputs[previous]) show(outputs[previous].file, previous);
}
async function editResult(stage, result) {
  if (state.phase !== 'idle' || editing || !source) return;
  const session = { previous: displayedStage ?? 'original' };
  editing = session;
  results.setEditingEnabled(false);
  try {
    await show(source, stage, { overlay: result.file, throwOnError: true });
    if (editing !== session) return;
    if (!await editor.start({ stage, file: result.file, label: result.description, overlayIndex: 1 })) closeEdit();
  } catch (error) {
    if (editing !== session) return;
    status(error.message, true);
    closeEdit();
  }
}
function resetOutputs() {
  editing = null;
  const cancelled = editor?.cancel();
  results.setEditingEnabled(!editor || editor.session.state === 'idle');
  outputs = source ? { original: { description: 'Original', file: source } } : {};
  results.render(outputs);
  $('outputSection').open = false;
  $('reportBtn').disabled = true;
  return cancelled;
}
async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({ isDragDropEnabled: false });
      await viewer.attachTo('gl1');
      layouts.multiplanar();
      viewer.isLegendVisible = false;
      editor = createMaskEditor({
        nv: viewer,
        onApply: (stage, file, { original }) => {
          outputs[stage] = editedResult(outputs[stage], file, original);
          results.render(outputs);
          status(`${outputs[stage].description} edited`);
          closeEdit();
        },
        onCancel: () => {
          if (!editing) return;
          status('Edit discarded');
          closeEdit();
        },
        onError: (_stage, error) => status(error.message, true),
      });
      editor.addEventListener('nd-mask-edit-end', () => results.setEditingEnabled(state.phase === 'idle'));
      editor.addEventListener('nd-mask-edit-start', ({ detail }) => status(detail.message));
      toolbar.after(editor);
      viewer.createExtensionContext().on('locationChange', event => { $('location').textContent = event.detail.string; });
      automation.registerViewer('main', createNiivueAdapter(viewer, {
        tabs: {
          list: () => Object.entries(outputs).map(([id, entry]) => ({ id, label: entry.description, active: displayedStage === id })),
          select: id => show(outputs[id].file, id, { throwOnError: true }),
        },
      }));
      return viewer;
    })();
  }
  return viewerReady;
}
function show(file, stage, { throwOnError = false, overlay = null } = {}) {
  const revision = ++viewRevision;
  viewQueue = viewQueue.catch(() => {}).then(async () => {
    if (revision !== viewRevision) return;
    const nv = await ensureViewer();
    if (revision !== viewRevision) return;
    const layers = [{ url: file, name: file.name }];
    if (overlay) layers.push({ url: overlay, name: overlay.name, colormap: 'red', opacity: 0.7 });
    await nv.loadVolumes(layers);
    if (revision !== viewRevision) return;
    displayedStage = stage;
    $('gl1').hidden = false;
    $('emptyState').hidden = true;
    $('viewerNotice').hidden = true;
    for (const [index, key] of Object.keys(outputs).entries()) {
      $('resultList').children[index]?.querySelector('.nd-view-btn').classList.toggle('active', key === stage);
    }
  }).catch(error => {
    if (revision !== viewRevision) return;
    $('viewerNotice').hidden = false;
    $('viewerNotice').textContent = `Visualization unavailable. ${error.message}. NIfTI downloads remain available.`;
    log.log(error.message, 'error');
    if (throwOnError) throw error;
  });
  return viewQueue;
}
async function importImages(filesSource, signal) {
  if (!signal) exampleControl.cancel();
  if (state.phase !== 'idle') return;
  const job = start('loading');
  const abort = () => {
    if (state !== job) return;
    runs.cancel();
    finish(job);
    status('Cancelled');
  };
  signal?.addEventListener('abort', abort, { once: true });
  source = null;
  ++viewRevision;
  $('gl1').hidden = true;
  $('emptyState').hidden = false;
  $('viewerNotice').hidden = true;
  $('location').textContent = '';
  const cancelled = resetOutputs();
  $('fileInfo').hidden = true;
  picker.setHasFiles(false);
  status('Reading images and converting DICOM if needed…');
  try {
    await cancelled;
    signal?.throwIfAborted();
    job.run.signal.throwIfAborted();
    const files = await (typeof filesSource === 'function' ? filesSource(job.run.signal) : filesSource);
    job.run.signal.throwIfAborted();
    const images = await readImageFiles(files, { signal: job.run.signal });
    job.run.signal.throwIfAborted();
    if (images.length !== 1) throw new Error('Choose one NIfTI image or one DICOM series at a time.');
    const volume = readVolume(await images[0].arrayBuffer());
    job.run.signal.throwIfAborted();
    if (!job.run.current) return;
    source = images[0];
    resetOutputs();
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${source.name} · ${volume.dims.join(' × ')} voxels`;
    picker.setHasFiles(true);
    show(source, 'original');
    job.run.ready('Image loaded · ready to extract brain');
    finish(job);
    status('Image loaded · ready to extract brain');
    return true;
  } catch (error) {
    job.run.fail(error);
    if (finish(job)) status(error.message, true);
    if (signal) throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
picker.onFiles(importImages);
$('folderButton').onclick = () => $('folderInput').click();
$('folderInput').onchange = event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) importImages(Promise.resolve(files));
};
async function extractBrain(parameters, { signal, progress = () => {} } = {}) {
  if (!source || state.phase !== 'idle') throw new Error('Load an image before starting brain extraction.');
  signal?.throwIfAborted();
  const cancelled = resetOutputs();
  const { method, threshold = 0.5, backend: requestedBackend = 'auto' } = parameters;
  const effective = { method };
  if (method === 'bet') effective.threshold = threshold;
  if (method === 'mindgrab') effective.backend = requestedBackend;
  const job = start('running', { inputs: { image: source }, parameters: effective });
  const stem = source.name.replace(/\.nii(\.gz)?$/i, '');
  status(`Starting ${method}…`);
  const abort = () => cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await cancelled;
    signal?.throwIfAborted();
    job.run.signal.throwIfAborted();
    void show(source, 'original');
    return await new Promise((resolve, reject) => {
      job.run.signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          const snapshot = runs.snapshot();
          reject(snapshot.state === 'failed' ? new Error(snapshot.message) : job.run.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        });
      }, { once: true });
      const fail = error => {
        job.run.fail(error);
        if (finish(job)) status(error.message || String(error), true);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        job.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        job.worker.onmessage = async ({ data }) => {
          if (!job.run.current) return;
          if (data.type === 'progress') {
            job.run.progress(data);
            progress(data);
            status(data.message);
            $('progress').value = data.value;
          } else if (data.type === 'log') {
            log.log(data.message);
          } else if (data.type === 'error') {
            fail(new Error(data.message));
          } else if (data.type === 'result') {
            try {
              const brain = new File([data.brain], `${stem}_${method}_brain.nii`);
              const mask = new File([data.mask], `${stem}_${method}_mask.nii`);
              const succeeded = await job.run.succeed({
                artifacts: {
                  brain: { file: brain, type: 'neuro:volume', mediaType: 'application/x-nifti', space: 'input' },
                  mask: { file: mask, type: 'neuro:mask', mediaType: 'application/x-nifti', space: 'input' },
                },
                provenance: data.provenance,
              });
              if (!succeeded) throw new DOMException('Cancelled', 'AbortError');
              Object.assign(outputs, extractionOutputs(brain, mask));
              results.render(outputs);
              $('outputSection').open = true;
              $('progress').value = 1;
              log.log(JSON.stringify(data.provenance));
              finish(job);
              await show(brain, 'brain');
              signal?.throwIfAborted();
              status('Brain image and mask ready');
              resolve({ artifacts: [{ role: 'brain', file: brain }, { role: 'mask', file: mask }], provenance: data.provenance });
            } catch (error) { fail(error); }
          }
        };
        job.worker.onerror = event => fail(new Error(event.message || 'The processing worker failed. Reload and try again.'));
        void resolveMindgrabBackend(requestedBackend, job.run).then(backend => {
          if (!job.run.current) return;
          job.worker.postMessage({ file: source, method, backend, fractionalIntensity: threshold, assetBase: new URL(import.meta.env.BASE_URL, location.href).href });
        }, fail);
      } catch (error) { fail(error); }
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
$('runButton').onclick = () => {
  if ($('method').value === 'bet' && !$('threshold').reportValidity()) {
    const message = 'Choose a BET threshold from 0 to 1 in steps of 0.05.';
    runs.fail(message);
    status(message, true);
    return;
  }
  void extractBrain({ method: $('method').value, threshold: Number($('threshold').value), backend: $('mindgrabBackend').value }).catch(error => {
    if (error.name !== 'AbortError') status(error.message, true);
  });
};
const automation = registerAppAutomation({
  app: 'brain-extraction',
  convertDicom: runDcm2niix,
  operations: {
    extract: async ({ inputs, parameters, signal, progress }) => {
      exampleControl.cancel();
      if (!await importImages(inputs.image, signal)) throw new Error('The input image could not be loaded.');
      return extractBrain(parameters, { signal, progress });
    },
  },
});
function cancel() {
  exampleControl.cancel();
  if (state.phase === 'idle') return;
  const job = state;
  runs.cancel();
  finish(job);
  $('progress').value = 0;
  status('Cancelled');
}
$('cancelButton').onclick = cancel;
$('reportBtn').onclick = () => {
  const { report } = runs.snapshot();
  if (!report || state.phase !== 'idle') return;
  const filename = report.artifacts.brain.filename.replace(/\.nii$/, '.json');
  downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), filename);
};
window.addEventListener('pagehide', cancel);
