import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { bindFileDrop, createInfoDialog, createConsole, createViewerToolbar } from '@neurodesk/webapp-components/ui';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { readVolume } from './volume.js';
import { configureNativeDownloads, nativeDownloads } from './native-release.js';
import manifest from '../../../models/synthsr.manifest.json';
import './styles.css';

const PACKAGE_VERSION = __SYNTHSR_NATIVE_VERSION__;

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'SynthSR',
  subtitle: 'Brain image synthesis, in your browser',
  mark: 'S',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn', standalone: '#standaloneBtn' },
});

const $ = (id) => document.getElementById(id);
const viewerRegion = $('viewer');

// ---- Shared chrome: layout tabs, technical log, information dialog ----
const layouts = {
  multiplanar: () => { viewer.sliceType = SLICE_TYPE.MULTIPLANAR; viewer.multiplanarType = MULTIPLANAR_TYPE.GRID; viewer.showRender = SHOW_RENDER.ALWAYS; },
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
  ].map((view) => ({ ...view, onClick: () => { if (!viewer) return; layouts[view.id](); viewer.drawScene(); toolbar.setActive(view.id); } })),
});
viewerRegion.prepend(toolbar);
const log = createConsole({ id: 'technicalLog' });
viewerRegion.append(log);
const info = createInfoDialog({ id: 'infoDialog' });
const dialogContent = (kind) => $(`${kind}Content`);
$('aboutBtn').onclick = () => info.open('About SynthSR', dialogContent('about'));
$('privacyBtn').onclick = () => info.open('Privacy', dialogContent('privacy'));
$('standaloneBtn').onclick = () => {
  info.open('Standalone', dialogContent('standalone'), { wide: true });
  configureNativeDownloads(nativeDownloads(PACKAGE_VERSION), info.body);
  info.body.querySelector('#standalonePackage').href = `${import.meta.env.BASE_URL}downloads/neurodesk-synthsr-${PACKAGE_VERSION}.tgz`;
  const node = info.body.querySelector('#nodeCommands');
  node.textContent = node.textContent.replace('__PACKAGE_VERSION__', PACKAGE_VERSION);
};
info.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  const text = info.body.querySelector(`#${button.dataset.copyTarget}`)?.textContent ?? '';
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch { copied = false; }
  button.textContent = copied ? 'Copied' : 'Select and copy';
  setTimeout(() => { button.textContent = 'Copy'; }, 1200);
});

// ---- Workflow state ----
let source, output, provenance, worker, viewer, viewerReady, busy = false, timer, started;
let importAbort, importedImages = [];
const assetBase = import.meta.env.VITE_SYNTHSR_ASSET_BASE || manifest.base_url || `${import.meta.env.BASE_URL}model-assets/`;


function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function setBusy(value) {
  busy = value;
  exampleControl.setDisabled(value);
  for (const id of ['imageInput', 'seriesSelect', 'modality', 'backend', 'mode', 'flip', 'sharpen', 'modelInput']) $(id).disabled = value;
  $('processButton').disabled = value || !source;
  $('cancelBtn').hidden = !value;
  $('saveBtn').disabled = value || !output;
  $('reportBtn').disabled = value || !provenance;
  if (!value) { clearInterval(timer); worker?.terminate(); worker = null; }
}

async function ensureViewer() {
  if (viewerReady) return viewerReady;
  viewerReady = (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
    await viewer.attachTo('gl1');
    layouts.multiplanar();
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on('locationChange', (event) => { $('location').textContent = event.detail.string; });
    return viewer;
  })();
  return viewerReady;
}

function setDisplayed(isOutput) {
  $('inputTab').classList.toggle('active', !isOutput);
  $('outputTab').classList.toggle('active', isOutput);
  $('imageLabel').textContent = isOutput ? 'Synthetic T1 · 1 mm' : (source?.name ?? '');
}

async function show(file, isOutput = false) {
  $('emptyState').hidden = true;
  setDisplayed(isOutput);
  try {
    const nv = await ensureViewer();
    await nv.loadVolumes([{ url: file, name: file.name }]);
    $('viewerError').hidden = true;
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Visualization unavailable: ${error.message}. Processing and NIfTI download remain available.`;
  }
}

function clearOutput() {
  output = null;
  provenance = null;
  $('outputSection').open = false;
  $('outputResult').hidden = true;
  $('outputTab').disabled = true;
  $('saveBtn').disabled = true;
  $('reportBtn').disabled = true;
}

async function load(file, signal) {
  if (busy || !file) return;
  setBusy(true);
  try {
    if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error('Choose a .nii or .nii.gz image.');
    status('Reading image…');
    const volume = readVolume(await file.arrayBuffer());
    signal?.throwIfAborted();
    source = file;
    clearOutput();
    $('modality').value = volume.data.some((value) => value < 0) ? 'ct' : 'mr';
    $('inputTab').disabled = false;
    $('progress').value = 0;
    $('elapsed').textContent = '';
    $('fileInfo').hidden = false;
    $('fileInfo').innerHTML = `<strong></strong> · ${volume.dims.join(' × ')} voxels`;
    $('fileInfo').querySelector('strong').textContent = file.name;
    $('dropZone').classList.add('has-files');
    await show(source);
    status('Image loaded · ready to synthesize');
    return true;
  } catch (error) {
    status(error.message, true);
    return false;
  } finally {
    setBusy(false);
  }
}

async function importImages(filesPromise) {
  exampleControl.cancel();
  if (busy) return;
  const controller = new AbortController();
  importAbort = controller;
  setBusy(true);
  status('Reading images · converting DICOM if needed…');
  try {
    const files = await filesPromise;
    const images = await readImageFiles(files, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!images.length) throw new Error('Choose NIfTI files or a complete DICOM series.');
    setBusy(false);
    if (!await load(images[0])) return;
    importedImages = images;
    $('seriesSelect').replaceChildren(...images.map((file, index) => new Option(file.name, String(index))));
    $('seriesField').hidden = images.length < 2;
  } catch (error) {
    if (!controller.signal.aborted) { setBusy(false); status(error.message, true); }
  } finally {
    if (importAbort === controller) importAbort = null;
  }
}

$('imageInput').onchange = () => {
  const files = Array.from($('imageInput').files);
  $('imageInput').value = '';
  if (files.length) void importImages(Promise.resolve(files));
};
bindFileDrop($('dropZone'), (files) => { if (!busy) void importImages(files); });
$('seriesSelect').onchange = async () => {
  if (!await load(importedImages[Number($('seriesSelect').value)])) $('seriesSelect').value = String(importedImages.indexOf(source));
};

const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    if (!await load(files[0], signal)) throw new Error('The example image could not be loaded.');
    assertCurrent();
  },
  onStatus: status,
});
exampleControl.select.id = 'exampleSelect';
exampleControl.querySelector('label').htmlFor = 'exampleSelect';
$('exampleControl').replaceWith(exampleControl);


$('mode').onchange = () => {
  $('modeHelp').textContent = $('mode').value === 'tiled'
    ? 'Approximate: overlapping 96³ tiles reduce memory. Limited context can change the output and introduce seams.'
    : 'Full-volume synthesis can require several GB of memory.';
};
$('modelInput').onchange = () => { $('modelInfo').textContent = $('modelInput').files[0]?.name || 'SynthSR v2 · downloads once and is cached'; };

$('processButton').onclick = () => {
  if (!source || busy) return;
  clearOutput();
  show(source);
  const options = { ct: $('modality').value === 'ct', backend: $('backend').value, tiled: $('mode').value === 'tiled', flip: $('flip').checked, sharpen: $('sharpen').checked };
  setBusy(true);
  $('progress').value = 0;
  started = performance.now();
  timer = setInterval(() => { $('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`; }, 1000);
  worker = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = async ({ data }) => {
    if (data.type === 'progress') { status(data.message); $('progress').value = data.value; }
    if (data.type === 'error') { setBusy(false); status(data.message, true); }
    if (data.type === 'result') {
      provenance = data.provenance;
      const stem = source.name.replace(/\.nii(\.gz)?$/i, '');
      output = new File([data.buffer], `${stem}_synthsr${options.tiled ? '_tiled' : ''}.nii`, { type: 'application/octet-stream' });
      setBusy(false);
      $('outputSection').open = true;
      $('outputResult').hidden = false;
      $('outputTab').disabled = false;
      $('progress').value = 1;
      await show(output, true);
      status(`Synthetic T1 ready · ${provenance.outputShape.join(' × ')} · ${Math.round(provenance.seconds)} s${options.tiled ? ' · approximate tiled mode' : ''}`);
    }
  };
  worker.onerror = (event) => { setBusy(false); status(`Processing stopped: ${event.message || 'The inference worker could not run. Reload the app and try again.'}`, true); };
  const asset = manifest.assets.find((item) => item.filename === 'synthsr-v2.onnx');
  worker.postMessage({ file: source, options, model: { ...asset, url: `${asset.url || `${assetBase}${asset.filename}`}?sha256=${asset.sha256}`, file: $('modelInput').files[0] } });
};

$('cancelBtn').onclick = () => {
  exampleControl.cancel();
  importAbort?.abort();
  setBusy(false);
  $('progress').value = 0;
  status('Processing cancelled. Your original image is unchanged.');
};
$('inputTab').onclick = () => source && show(source);
$('outputTab').onclick = () => output && show(output, true);

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('saveBtn').onclick = () => output && download(output, output.name);
$('reportBtn').onclick = () => provenance && download(new Blob([JSON.stringify(provenance, null, 2)], { type: 'application/json' }), output.name.replace('.nii', '.json'));

void (async () => {
  // navigator.gpu can exist without a usable adapter (headless or blocklisted GPUs); check the adapter, not the API.
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (adapter) return;
  $('backend').value = 'wasm';
  status('Ready · WebGPU unavailable; CPU processing selected');
})();
window.addEventListener('pagehide', () => { exampleControl.cancel(); importAbort?.abort(); worker?.terminate(); clearInterval(timer); });
