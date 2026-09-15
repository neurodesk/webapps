import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { StageResultList, createInfoDialog, renderConsole, renderFileField, renderViewerToolbar } from '@neurodesk/webapp-components/ui';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { readVolume } from '@neurodesk/synthsr';
import examples from '../examples.json';

const $ = id => document.getElementById(id);
mountImagingWorkspace({
  controls: '#controls', viewer: '#viewer', status: '#status', title: 'Brain extraction',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});
const info = createInfoDialog({ id: 'infoDialog' });
$('aboutBtn').onclick = () => info.open('About Brain extraction', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
const log = renderConsole({ id: 'technicalLog' });
$('viewer').append(log.root);
let viewer;
let viewerReady;
let viewQueue = Promise.resolve();
let viewRevision = 0;
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
const toolbar = renderViewerToolbar({
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
$('viewer').prepend(toolbar.root);
const picker = renderFileField({ id: 'imageInput', rootId: 'dropZone', text: 'Drop NIfTI or DICOM files or folder' });
$('filePicker').append(picker.root);
for (const example of examples) $('example').add(new Option(example.label, example.id));
$('example').onchange = () => {
  const example = examples.find(item => item.id === $('example').value);
  $('example').value = '';
  if (!example) return;
  importImages(async signal => {
    status(`Downloading ${example.label}…`);
    const response = await fetch(example.url, { signal });
    if (!response.ok) throw new Error(`Could not load example (HTTP ${response.status}). Choose it again to retry.`);
    return [new File([await response.blob()], new URL(example.url).pathname.split('/').pop())];
  });
};
const results = new StageResultList({
  element: $('resultList'),
  onView: (stage, result) => show(result.file, stage),
  onDownload: (_stage, result) => downloadFile(result.file),
});
let source = null;
let outputs = {};
let state = { phase: 'idle' };
const methodHints = {
  mindgrab: 'Brainchop neural network. Runs on the GPU when available, with a CPU fallback.',
  synthstrip: 'SynthStrip neural network. This browser implementation uses the CPU and can require several GB of memory.',
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
}
function refreshControls() {
  const busy = state.phase !== 'idle';
  for (const id of ['example', 'imageInput', 'folderInput', 'folderButton', 'method', 'threshold', 'mindgrabBackend']) $(id).disabled = busy;
  $('runButton').disabled = busy || !source;
  $('cancelButton').hidden = !busy;
}
function start(phase) {
  const job = { phase, controller: new AbortController(), worker: null, started: performance.now() };
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
function resetOutputs() {
  outputs = source ? { original: { description: 'Original', file: source } } : {};
  results.render(outputs);
  $('outputSection').open = false;
}
async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({ isDragDropEnabled: false });
      await viewer.attachTo('gl1');
      layouts.multiplanar();
      viewer.isLegendVisible = false;
      viewer.createExtensionContext().on('locationChange', event => { $('location').textContent = event.detail.string; });
      return viewer;
    })();
  }
  return viewerReady;
}
function show(file, stage) {
  const revision = ++viewRevision;
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision) return;
    const nv = await ensureViewer();
    if (revision !== viewRevision) return;
    await nv.loadVolumes([{ url: file, name: file.name }]);
    if (revision !== viewRevision) return;
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
  });
  return viewQueue;
}
async function importImages(filesSource) {
  if (state.phase !== 'idle') return;
  const job = start('loading');
  source = null;
  ++viewRevision;
  $('gl1').hidden = true;
  $('emptyState').hidden = false;
  $('viewerNotice').hidden = true;
  $('location').textContent = '';
  resetOutputs();
  $('fileInfo').hidden = true;
  picker.setHasFiles(false);
  status('Reading images and converting DICOM if needed…');
  try {
    const files = await (typeof filesSource === 'function' ? filesSource(job.controller.signal) : filesSource);
    job.controller.signal.throwIfAborted();
    const images = await readImageFiles(files, { signal: job.controller.signal });
    job.controller.signal.throwIfAborted();
    if (images.length !== 1) throw new Error('Choose one NIfTI image or one DICOM series at a time.');
    const volume = readVolume(await images[0].arrayBuffer());
    job.controller.signal.throwIfAborted();
    if (state !== job) return;
    source = images[0];
    resetOutputs();
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${source.name} · ${volume.dims.join(' × ')} voxels`;
    picker.setHasFiles(true);
    show(source, 'original');
    finish(job);
    status('Image loaded · ready to extract brain');
  } catch (error) {
    if (finish(job)) status(error.message, true);
  }
}
picker.onFiles(importImages);
$('folderButton').onclick = () => $('folderInput').click();
$('folderInput').onchange = event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) importImages(Promise.resolve(files));
};
$('runButton').onclick = () => {
  if (!source || state.phase !== 'idle') return;
  if ($('method').value === 'bet' && !$('threshold').reportValidity()) return;
  resetOutputs();
  show(source, 'original');
  const job = start('running');
  const method = $('method').value;
  const stem = source.name.replace(/\.nii(\.gz)?$/i, '');
  status(`Starting ${$('method').selectedOptions[0].text}…`);
  try {
    job.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    job.worker.onmessage = ({ data }) => {
      if (state !== job) return;
      if (data.type === 'progress') {
        status(data.message);
        $('progress').value = data.value;
      } else if (data.type === 'log') {
        log.log(data.message);
      } else if (data.type === 'error') {
        finish(job);
        status(data.message, true);
      } else if (data.type === 'result') {
        outputs.brain = { description: 'Brain', file: new File([data.brain], `${stem}_${method}_brain.nii`) };
        outputs.mask = { description: 'Brain mask', file: new File([data.mask], `${stem}_${method}_mask.nii`) };
        results.render(outputs);
        $('outputSection').open = true;
        $('progress').value = 1;
        log.log(JSON.stringify(data.provenance));
        finish(job);
        show(outputs.brain.file, 'brain');
        status('Brain image and mask ready');
      }
    };
    job.worker.onerror = event => {
      if (finish(job)) status(event.message || 'The processing worker failed. Reload and try again.', true);
    };
    job.worker.postMessage({ file: source, method, backend: $('mindgrabBackend').value, fractionalIntensity: Number($('threshold').value), assetBase: new URL(import.meta.env.BASE_URL, location.href).href });
  } catch (error) {
    if (finish(job)) status(error.message, true);
  }
};
function cancel() {
  if (state.phase === 'idle') return;
  const job = state;
  job.controller.abort();
  finish(job);
  $('progress').value = 0;
  status('Cancelled');
}
$('cancelButton').onclick = cancel;
window.addEventListener('pagehide', cancel);
