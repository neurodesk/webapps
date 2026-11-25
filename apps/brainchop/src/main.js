import '@neurodesk/webapp-components/styles/imaging-workspace.css';
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
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { readImageFiles, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import { createNiivueAdapter, registerAppAutomation } from '@neurodesk/webapp-components/automation';
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import { APP } from './config.js';
import { findModel, labelColormap, labelNamesMap, MODELS, TISSUE_STAGES } from './models.js';
import { runModel } from './inference.js';
import examples from '../examples.json';

const $ = id => document.getElementById(id);

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: APP.title,
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);

const progress = new ProgressManager();
const info = createInfoDialog();
$('aboutBtn').onclick = () => info.open('About Brainchop', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

const picker = createFileField({ id: 'imageInput', rootId: 'dropZone', text: 'Drop NIfTI or DICOM files or folder' });
$('filePicker').append(picker);

let viewer = null;
let viewerReady = null;
let editor = null;
let editing = null;
let viewQueue = Promise.resolve();
let viewRevision = 0;
let displayedStage = null;
let source = null;
let active = null;
let outputs = {};
let activeLut = null;
let activeModelId = null;

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

$('method').replaceChildren(...MODELS.map(model => new Option(model.label, model.id)));
function syncMethodHint() {
  const model = findModel($('method').value);
  $('methodHint').textContent = model?.hint ?? '';
}
$('method').addEventListener('change', syncMethodHint);
syncMethodHint();

const results = createResultList({
  element: $('resultList'),
  onView: (stage, result) => {
    if (editing) return;
    void show(stage, result);
  },
  onDownload: (_stage, result) => downloadFile(result.file),
  onEdit: (stage, result) => void editResult(stage, result),
});

function status(message, error = false) {
  if (!message) return;
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function syncControls() {
  const busy = Boolean(active);
  picker.disabled = busy;
  $('method').disabled = busy;
  $('backend').disabled = busy;
  $('saveConform').disabled = busy;
  $('runButton').disabled = busy || !source;
  exampleControl.setDisabled(busy);
  results.setEditingEnabled(!busy && (!editor || editor.session.state === 'idle'));
}

function closeEdit() {
  const previous = editing?.previous;
  editing = null;
  syncControls();
  if (previous && outputs[previous]) void show(previous, outputs[previous]);
}

async function editResult(stage, result) {
  if (active || editing || !source || !activeLut) return;
  const session = { previous: displayedStage ?? 'original' };
  editing = session;
  results.setEditingEnabled(false);
  try {
    await show('original', outputs.original, { throwOnError: true });
    if (editing !== session) return;
    const colormap = viewer.addColormap(`Brainchop_${activeModelId}`, activeLut);
    const labelNames = labelNamesMap(activeModelId);
    const started = await editor.start({
      stage,
      file: result.file,
      label: result.description,
      overlayIndex: null,
      colormap,
      labelNames,
    });
    if (!started) closeEdit();
  } catch (error) {
    if (editing !== session) return;
    status(error.message, true);
    closeEdit();
  }
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
      editor.addEventListener('nd-mask-edit-end', () => syncControls());
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
          select: id => show(id, outputs[id], { throwOnError: true }),
        },
      }));
      return viewer;
    })();
  }
  return viewerReady;
}

function show(stage, entry, { throwOnError = false } = {}) {
  const revision = ++viewRevision;
  viewQueue = viewQueue.catch(() => {}).then(async () => {
    if (revision !== viewRevision || !source) return;
    const nv = await ensureViewer();
    if (revision !== viewRevision) return;
    const layers = [{ url: source, name: source.name }];
    let applyLut = false;
    if (stage === 'segmentation' && entry?.file) {
      layers.push({ url: entry.file, name: entry.file.name, opacity: 0.5 });
      applyLut = Boolean(activeLut);
    } else if (entry?.colormap && entry?.file) {
      layers.push({
        url: entry.file,
        name: entry.file.name,
        colormap: entry.colormap,
        calMin: 0.1,
        calMax: 1,
        isTransparentBelowCalMin: true,
        opacity: 0.6,
      });
    }
    await nv.loadVolumes(layers);
    if (revision !== viewRevision) return;
    if (applyLut && activeLut) {
      await nv.setColormapLabel(1, activeLut);
    }
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

function resetOutputs() {
  editing = null;
  const cancelled = editor?.cancel();
  activeLut = null;
  activeModelId = null;
  outputs = source ? { original: { description: 'Original', file: source } } : {};
  results.render(outputs);
  $('outputSection').open = false;
  syncControls();
  return cancelled;
}

async function task(message, signal, action) {
  if (active) throw new Error('Wait for the current operation or cancel it.');
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  active = controller;
  syncControls();
  progress.begin(message);
  try {
    const result = await action(controller.signal);
    controller.signal.throwIfAborted();
    progress.end(null);
    return result;
  } catch (error) {
    const cancelled = error.name === 'AbortError';
    progress.end(cancelled ? 'Cancelled' : error.message, { success: false });
    status(cancelled ? 'Cancelled' : error.message, !cancelled);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    active = null;
    syncControls();
  }
}

async function load(filesOrPromise, signal) {
  return task('Loading image…', signal, async current => {
    source = null;
    const cancelled = resetOutputs();
    await cancelled;
    current.throwIfAborted();
    const files = await filesOrPromise;
    current.throwIfAborted();
    const images = await readImageFiles(files, { signal: current });
    current.throwIfAborted();
    if (images.length !== 1) throw new Error('Choose one T1-weighted NIfTI image or one DICOM series.');
    source = images[0];
    picker.setHasFiles(true);
    resetOutputs();
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = source.name;
    await show('original', outputs.original);
    current.throwIfAborted();
    if (viewer?.volumes?.[0]?.hdr?.dims?.[4] > 1) {
      source = null;
      picker.setHasFiles(false);
      resetOutputs();
      throw new Error('Choose a single 3D T1-weighted image.');
    }
    status('Image loaded · ready to segment');
  });
}

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, signal, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    await load(files, signal);
    assertCurrent();
  },
});
$('exampleControl').replaceWith(exampleControl);

picker.onFiles(files => {
  exampleControl.cancel();
  void load(files).catch(() => {});
});

$('cancelButton').onclick = () => {
  exampleControl.cancel();
  active?.abort();
};

async function segment({ modelId = $('method').value, backend = $('backend').value, saveConform = $('saveConform').checked } = {}, signal) {
  if (!source) throw new Error('Load a T1-weighted image first.');
  const model = findModel(modelId);
  if (!model) throw new Error('Unknown segmentation model.');
  return task(`Running ${model.label}…`, signal, async current => {
    const cancelled = resetOutputs();
    await cancelled;
    current.throwIfAborted();
    progress.setProgress(0.1);
    const result = await runModel(source, model.id, {
      backend,
      saveConform,
      signal: current,
      onLog: line => log.log(line),
    });
    current.throwIfAborted();
    progress.setProgress(0.95);
    if (result.kind === 'tissues') {
      for (const stage of TISSUE_STAGES) {
        outputs[stage.id] = {
          description: stage.label,
          file: result.files[stage.id],
          colormap: stage.colormap,
        };
      }
      results.render(outputs);
      $('outputSection').open = true;
      await show('gm', outputs.gm);
      status(`Tissue fraction maps ready (${result.backend}, ${(result.elapsedMs / 1000).toFixed(1)} s)`);
      return {
        artifacts: TISSUE_STAGES.map(stage => ({ role: stage.id, file: result.files[stage.id] })),
        provenance: {
          model: model.id,
          coreModel: model.coreModel,
          package: '@brainchop/core',
          version: result.coreVersion,
          backend: result.backend,
          elapsedMs: result.elapsedMs,
          grid: saveConform ? '256³ 1 mm conformed' : 'input',
        },
      };
    }
    activeModelId = model.id;
    activeLut = labelColormap(model.id);
    outputs.segmentation = {
      description: model.label,
      file: result.file,
      editable: !saveConform,
    };
    results.render(outputs);
    $('outputSection').open = true;
    await show('segmentation', outputs.segmentation);
    status(`Segmentation ready (${result.backend}, ${(result.elapsedMs / 1000).toFixed(1)} s)`);
    return {
      artifacts: [{ role: 'segmentation', file: result.file }],
      provenance: {
        model: model.id,
        coreModel: model.coreModel,
        package: '@brainchop/core',
        version: result.coreVersion,
        backend: result.backend,
        elapsedMs: result.elapsedMs,
        grid: saveConform ? '256³ 1 mm conformed' : 'input',
      },
    };
  });
}

$('runButton').onclick = () => void segment().catch(() => {});

const automation = registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    segment: async ({ inputs, parameters, signal }) => {
      const model = findModel(parameters.model);
      if (!model || model.kind !== 'labels') throw new Error('Unknown segmentation model.');
      $('method').value = model.id;
      syncMethodHint();
      if (parameters.backend) $('backend').value = parameters.backend;
      if (parameters.saveConform !== undefined) $('saveConform').checked = Boolean(parameters.saveConform);
      await load(inputs.image, signal);
      return segment({
        modelId: model.id,
        backend: parameters.backend ?? 'auto',
        saveConform: Boolean(parameters.saveConform),
      }, signal);
    },
    'tissue-fractions': async ({ inputs, parameters, signal }) => {
      $('method').value = 'tissue-fractions';
      syncMethodHint();
      if (parameters.backend) $('backend').value = parameters.backend;
      if (parameters.saveConform !== undefined) $('saveConform').checked = Boolean(parameters.saveConform);
      await load(inputs.image, signal);
      return segment({
        modelId: 'tissue-fractions',
        backend: parameters.backend ?? 'auto',
        saveConform: Boolean(parameters.saveConform),
      }, signal);
    },
  },
});

window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  active?.abort();
});
