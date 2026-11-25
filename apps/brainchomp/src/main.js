import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  createConsole,
  createExampleSelector,
  createFileField,
  createInfoDialog,
  createMaskEditor,
  createResultList,
  createViewerToolbar,
  ProgressManager,
} from '@neurodesk/webapp-components/ui';
import { downloadBlob, downloadFile } from '@neurodesk/webapp-components/file-io';
import { readNiftiVolumeAsync, writeNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import { readImageFiles, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import { createNiivueAdapter, createRunState, registerAppAutomation } from '@neurodesk/webapp-components/automation';
import examples from '../examples.json';
import { APP, DEFAULT_OPENING_RADIUS } from './config.js';
import { applyWorldRemap, availableDirections, buildReorientMatrix, DIR_NAMES, outputNames } from './orient.js';

const $ = id => document.getElementById(id);

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: APP.title,
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

const info = createInfoDialog({ id: 'infoDialog' });
$('aboutBtn').onclick = () => info.open('About Brainchomp', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);

const progress = new ProgressManager();
const runs = createRunState({ app: APP.id, appVersion: APP.version });

let viewer = null;
let viewerReady = null;
let editor = null;
let editing = null;
let viewQueue = Promise.resolve();
let viewRevision = 0;
let displayedStage = null;
let source = null;
let sourceVolume = null;
let outputs = {};
let state = { phase: 'idle' };

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
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map(view => ({
    ...view,
    onClick: () => {
      if (!viewer) return;
      layouts[view.id]();
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
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
$('exampleControl').replaceWith(exampleControl);

const results = createResultList({
  element: $('resultList'),
  onView: (stage, result) => {
    if (editing) return;
    void show(result.file, stage);
  },
  onDownload: (_stage, result) => downloadFile(result.file),
  onEdit: (stage, result) => void editResult(stage, result),
});

function status(message, error = false) {
  if (!message) return;
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
  runs.message(message);
}

function refreshControls() {
  const busy = state.phase !== 'idle';
  exampleControl.setDisabled(busy);
  picker.disabled = busy;
  $('backend').disabled = busy;
  $('opening').disabled = busy;
  $('reorientButton').disabled = busy || !source || Boolean(editing);
  $('runButton').disabled = busy || !source;
  $('reportBtn').disabled = busy || runs.snapshot().state !== 'succeeded';
  results.setEditingEnabled(!busy && (!editor || editor.session.state === 'idle'));
}

function start(phase, context, message) {
  const job = { phase, run: runs.begin(phase, context), worker: null };
  state = job;
  progress.begin(message);
  refreshControls();
  return job;
}

function finish(job, { success = true, message = null } = {}) {
  if (state !== job) return false;
  job.worker?.terminate();
  state = { phase: 'idle' };
  progress.end(message, { success });
  refreshControls();
  return true;
}

function closeEdit() {
  const previous = editing?.previous;
  editing = null;
  refreshControls();
  if (previous && outputs[previous]) void show(outputs[previous].file, previous);
}

async function editResult(stage, result) {
  if (state.phase !== 'idle' || editing || !source) return;
  const session = { previous: displayedStage ?? 'original' };
  editing = session;
  refreshControls();
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
  outputs = source ? { original: { description: 'Original', file: source } } : {};
  results.render(outputs);
  $('outputSection').open = false;
  refreshControls();
  return cancelled;
}

async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({ isDragDropEnabled: false, isOrientCube: true });
      await viewer.attachTo('gl1');
      layouts.multiplanar();
      viewer.isLegendVisible = false;
      editor = createMaskEditor({
        nv: viewer,
        onApply: (stage, file) => {
          const entry = outputs[stage];
          if (!entry) return;
          outputs[stage] = { ...entry, file, edited: true };
          results.render(outputs);
          status(`${entry.description} edited`);
          closeEdit();
        },
        onCancel: () => {
          if (!editing) return;
          status('Edit discarded');
          closeEdit();
        },
        onError: (_stage, error) => status(error.message, true),
      });
      editor.addEventListener('nd-mask-edit-end', () => refreshControls());
      editor.addEventListener('nd-mask-edit-start', ({ detail }) => status(detail.message));
      toolbar.after(editor);
      viewer.createExtensionContext().on('locationChange', event => {
        $('location').textContent = event.detail.string;
      });
      automation.registerViewer('main', createNiivueAdapter(viewer, {
        tabs: {
          list: () => Object.entries(outputs).map(([id, entry]) => ({
            id,
            label: entry.description,
            active: displayedStage === id,
          })),
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
      $('resultList').children[index]?.querySelector('.nd-view-btn')?.classList.toggle('active', key === stage);
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

function formatVoxelInfo(volume) {
  const spacing = [0, 1, 2].map(axis => Math.hypot(
    volume.affine[0][axis],
    volume.affine[1][axis],
    volume.affine[2][axis],
  ).toFixed(3));
  return `${volume.dims.join(' × ')} · ${spacing.join(' × ')} mm`;
}

async function importImages(filesSource, signal) {
  if (!signal) exampleControl.cancel();
  if (state.phase !== 'idle') return false;
  const job = start('loading', undefined, 'Reading rodent MRI…');
  const abort = () => {
    if (state !== job) return;
    runs.cancel();
    finish(job, { success: false, message: 'Cancelled' });
    status('Cancelled');
  };
  signal?.addEventListener('abort', abort, { once: true });
  source = null;
  sourceVolume = null;
  ++viewRevision;
  $('gl1').hidden = true;
  $('emptyState').hidden = false;
  $('viewerNotice').hidden = true;
  $('location').textContent = '';
  const cancelled = resetOutputs();
  $('fileInfo').hidden = true;
  picker.setHasFiles(false);
  try {
    await cancelled;
    signal?.throwIfAborted();
    job.run.signal.throwIfAborted();
    const files = await (typeof filesSource === 'function' ? filesSource(job.run.signal) : filesSource);
    job.run.signal.throwIfAborted();
    const images = await readImageFiles(files, { signal: job.run.signal });
    job.run.signal.throwIfAborted();
    if (images.length !== 1) throw new Error('Choose one NIfTI image or one DICOM series at a time.');
    const volume = await readNiftiVolumeAsync(await images[0].arrayBuffer());
    job.run.signal.throwIfAborted();
    if (!job.run.current) return false;
    source = images[0];
    sourceVolume = volume;
    resetOutputs();
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${source.name} · ${formatVoxelInfo(volume)}`;
    picker.setHasFiles(true);
    await show(source, 'original');
    job.run.ready('Image loaded · ready to extract rodent brain');
    finish(job, { success: true, message: 'Image loaded · ready to extract rodent brain' });
    log.log(`Loaded ${source.name} (${formatVoxelInfo(volume)})`);
    return true;
  } catch (error) {
    job.run.fail(error);
    if (finish(job, { success: false, message: error.message })) status(error.message, true);
    if (signal) throw error;
    return false;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

picker.onFiles(files => void importImages(Promise.resolve(files)));

function openReorientDialog() {
  if (!source || !sourceVolume || state.phase !== 'idle' || editing) return;
  const picks = [];
  const stepLabels = ['A', 'S', 'L'];
  const container = document.createElement('div');
  const renderStep = () => {
    container.replaceChildren();
    const label = stepLabels[picks.length];
    const prompt = document.createElement('p');
    prompt.textContent = `Step ${picks.length + 1} of 3: the on-screen ${label} label truly points toward the animal's:`;
    const actions = document.createElement('div');
    actions.className = 'nd-dialog-actions';
    for (const dir of availableDirections(picks)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nd-btn nd-btn-secondary nd-btn-sm';
      btn.dataset.dir = dir;
      btn.textContent = DIR_NAMES[dir];
      btn.onclick = () => choose(dir);
      actions.append(btn);
    }
    if (label === 'L') {
      const unsure = document.createElement('button');
      unsure.type = 'button';
      unsure.className = 'nd-btn nd-btn-secondary nd-btn-sm';
      unsure.dataset.dir = '?';
      unsure.textContent = 'Not sure (no mirroring)';
      unsure.onclick = () => choose('?');
      actions.append(unsure);
    }
    container.append(prompt, actions);
  };
  const choose = dir => {
    picks.push(dir);
    if (picks.length < 3) {
      renderStep();
      return;
    }
    info.close();
    void applyReorient(picks);
  };
  renderStep();
  info.open('Reorient quadruped scan', container);
}

async function applyReorient(picks) {
  if (!source || !sourceVolume) return;
  const remap = buildReorientMatrix(picks);
  if (!remap) {
    status('Orientation unchanged');
    return;
  }
  const nextAffine = applyWorldRemap(sourceVolume.affine, remap);
  const nextVolume = {
    data: sourceVolume.data,
    dims: sourceVolume.dims,
    affine: nextAffine,
    version: sourceVolume.version,
    transforms: null,
  };
  const bytes = writeNiftiVolume(nextVolume, 'Reoriented with Brainchomp');
  const names = outputNames(source.name);
  source = new File([bytes], names.reoriented, { type: 'application/x-nifti' });
  sourceVolume = nextVolume;
  const cancelled = resetOutputs();
  await cancelled;
  $('fileInfo').textContent = `${source.name} · ${formatVoxelInfo(nextVolume)}`;
  await show(source, 'original');
  status(`Reoriented header (${picks.join(', ')})`);
}

$('reorientButton').onclick = openReorientDialog;

async function extractBrain(parameters, { signal, progress: reportProgress = () => {} } = {}) {
  if (!source || state.phase !== 'idle') throw new Error('Load a rodent MRI image before extracting.');
  signal?.throwIfAborted();
  const cancelled = resetOutputs();
  const backend = parameters?.backend ?? 'auto';
  const opening = Number.isInteger(parameters?.opening) ? parameters.opening : DEFAULT_OPENING_RADIUS;
  const job = start('running', { inputs: { image: source }, parameters: { backend, opening } }, 'Starting Brainchomp…');
  const names = outputNames(source.name);
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
          reject(snapshot.state === 'failed'
            ? new Error(snapshot.message)
            : job.run.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        });
      }, { once: true });
      const fail = error => {
        const err = error instanceof Error ? error : new Error(String(error));
        job.run.fail(err);
        if (finish(job, { success: false, message: err.message })) status(err.message, true);
        reject(err);
      };
      try {
        job.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        job.worker.onmessage = async ({ data }) => {
          if (!job.run.current) return;
          if (data.type === 'progress') {
            job.run.progress(data);
            reportProgress(data);
            progress.setProgress(data.value, data.message);
            log.log(data.message);
          } else if (data.type === 'log') {
            log.log(data.message);
          } else if (data.type === 'error') {
            fail(new Error(data.message));
          } else if (data.type === 'result') {
            try {
              const brain = new File([data.brain], names.brain, { type: 'application/x-nifti' });
              const mask = new File([data.mask], names.mask, { type: 'application/x-nifti' });
              const succeeded = await job.run.succeed({
                artifacts: {
                  brain: { file: brain, type: 'neuro:volume', mediaType: 'application/x-nifti', space: 'input' },
                  mask: { file: mask, type: 'neuro:mask', mediaType: 'application/x-nifti', space: 'input' },
                },
                provenance: data.provenance,
              });
              if (!succeeded) throw new DOMException('Cancelled', 'AbortError');
              outputs.brain = { description: 'Brain', file: brain };
              outputs.mask = { description: 'Mask', file: mask, editable: true };
              results.render(outputs);
              $('outputSection').open = true;
              log.log(JSON.stringify(data.provenance));
              finish(job, { success: true, message: 'Brain image and mask ready' });
              await show(brain, 'brain');
              signal?.throwIfAborted();
              status('Brain image and mask ready');
              resolve({
                artifacts: [
                  { role: 'brain', file: brain },
                  { role: 'mask', file: mask },
                ],
                provenance: data.provenance,
              });
            } catch (error) { fail(error); }
          }
        };
        job.worker.onerror = event => fail(new Error(event.message || 'The Brainchomp worker failed. Reload and try again.'));
        const assetPath = new URL('brainchomp/', new URL(import.meta.env.BASE_URL, location.href)).href;
        job.worker.postMessage({ file: source, backend, opening, assetPath });
      } catch (error) { fail(error); }
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

$('runButton').onclick = () => {
  if (!$('opening').reportValidity()) {
    const message = 'Choose a mask opening radius from 0 to 10 voxels.';
    runs.fail(message);
    status(message, true);
    return;
  }
  void extractBrain({
    backend: $('backend').value,
    opening: Number.parseInt($('opening').value, 10),
  }).catch(error => {
    if (error.name !== 'AbortError') status(error.message, true);
  });
};

const automation = registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    extract: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      if (!await importImages(inputs.image, signal)) throw new Error('The input image could not be loaded.');
      if (parameters?.backend) $('backend').value = parameters.backend;
      if (parameters?.opening !== undefined) $('opening').value = String(parameters.opening);
      return extractBrain(parameters, { signal, progress: reportProgress });
    },
  },
});

function cancel() {
  exampleControl.cancel();
  if (state.phase === 'idle') return;
  const job = state;
  runs.cancel();
  finish(job, { success: false, message: 'Cancelled' });
  status('Cancelled');
}

$('cancelButton').onclick = cancel;

$('reportBtn').onclick = () => {
  const { report } = runs.snapshot();
  if (!report || state.phase !== 'idle') return;
  const filename = report.artifacts.brain.filename.replace(/\.nii$/, '.json');
  downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), filename);
};

window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  cancel();
});
