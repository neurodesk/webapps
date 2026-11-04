import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { createResultList, createInfoDialog, createConsole, createViewerToolbar, createExampleSelector, ProgressManager } from '@neurodesk/webapp-components/ui';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { registerAppAutomation } from '@neurodesk/webapp-components/automation';
import { Niivue } from '@niivue/niivue';
import { APP } from './config.js';
import { MODELS, MODEL_ROOT, REVISION } from './models.js';
import { infer } from './inference.js';
import examples from '../examples.json';

const $ = id => document.getElementById(id);
mountImagingWorkspace({ controls: '#controls', viewer: '#viewer', status: '#status', title: APP.title, controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' } });
const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);
const progress = new ProgressManager();
const info = createInfoDialog();
$('aboutBtn').onclick = () => info.open('About Brainchop', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
const nv = new Niivue({ isDragAndDropEnabled: false });
const ready = nv.attachTo('gl1');
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false, views: [
  { id: 'slices', label: 'Slices', active: true, onClick: () => { nv.setSliceType(nv.sliceTypeMultiplanar); toolbar.setActive('slices'); } },
  { id: 'render', label: '3D', onClick: () => { nv.setSliceType(nv.sliceTypeRender); toolbar.setActive('render'); } },
] });
$('viewer').prepend(toolbar);
$('method').replaceChildren(...MODELS.map(model => new Option(model.label, model.id)));
let source = null;
let active = null;
let output = null;
const results = createResultList({
  element: $('resultList'),
  onView: () => { if (output) { nv.setOpacity(1, 0.5); nv.drawScene(); } },
  onDownload: (_stage, result) => downloadFile(result.file),
});
function status(message, error = false) {
  if (!message) return;
  $('statusText').textContent = message;
  log.log(message, error ? 'error' : 'info');
}
function controls() {
  $('imageInput').disabled = !!active;
  $('method').disabled = !!active;
  $('runButton').disabled = !!active || !source;
  exampleControl.setDisabled(!!active);
}
async function task(message, signal, action) {
  if (active) throw new Error('Wait for the current operation or cancel it.');
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  active = controller;
  controls();
  progress.begin(message);
  try {
    const result = await action(controller.signal);
    controller.signal.throwIfAborted();
    progress.end('Ready');
    return result;
  } catch (error) {
    progress.end(error.name === 'AbortError' ? 'Cancelled' : error.message);
    status(error.name === 'AbortError' ? 'Cancelled' : error.message, error.name !== 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    active = null;
    controls();
  }
}
async function load(files, signal) {
  return task('Loading image…', signal, async current => {
    source = null;
    output = null;
    results.render();
    $('outputSection').open = false;
    await ready;
    const images = await readImageFiles(files, { directVolume: /\.nii(\.gz)?$/i });
    current.throwIfAborted();
    if (images.length !== 1) throw new Error('Choose one T1-weighted NIfTI image or one DICOM series.');
    const url = URL.createObjectURL(images[0]);
    try { await nv.loadVolumes([{ url, name: images[0].name }]); }
    finally { URL.revokeObjectURL(url); }
    current.throwIfAborted();
    if (nv.volumes[0].hdr.dims[4] > 1) throw new Error('Choose a single 3D T1-weighted image.');
    source = images[0];
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = source.name;
    $('emptyState').hidden = true;
  });
}
const exampleControl = createExampleSelector({ examples, onStatus: status, onLoad: async (_example, { fetchFiles, signal, assertCurrent }) => {
  const files = await fetchFiles();
  assertCurrent();
  await load(files, signal);
  assertCurrent();
} });
$('exampleControl').append(exampleControl);
$('imageInput').addEventListener('change', event => {
  exampleControl.cancel();
  void load(Array.from(event.target.files)).catch(() => {});
});
$('cancelButton').onclick = () => { exampleControl.cancel(); active?.abort(); };
async function segment(signal) {
  if (!source) throw new Error('Load a T1-weighted image first.');
  const model = MODELS.find(item => item.id === $('method').value);
  return task('Conforming image…', signal, async current => {
    output = null;
    results.render();
    $('outputSection').open = false;
    const conformed = await nv.conform(nv.volumes[0], false);
    current.throwIfAborted();
    const labels = await infer(conformed, model, { signal: current, onProgress: (message, fraction) => {
      status(message);
      if (fraction >= 0 && fraction <= 1) progress.setProgress(fraction);
    } });
    current.throwIfAborted();
    if (labels.length !== 256 ** 3) throw new Error('Unexpected segmentation dimensions.');
    const overlay = conformed.clone();
    overlay.img = labels;
    overlay.hdr.datatypeCode = 2;
    overlay.hdr.numBitsPerVoxel = 8;
    overlay.hdr.scl_slope = 1;
    overlay.hdr.scl_inter = 0;
    overlay.hdr.intent_code = 1002;
    const response = await fetch(`${MODEL_ROOT}/${model.entry.colormapPath.replace(/^\.\//, '')}`, { signal: current });
    if (!response.ok) throw new Error(`Label colors could not load (${response.status}). Retry segmentation.`);
    overlay.setColormapLabel(await response.json());
    overlay.opacity = 0.5;
    current.throwIfAborted();
    while (nv.volumes.length) nv.removeVolume(nv.volumes[0]);
    await nv.addVolume(conformed);
    await nv.addVolume(overlay);
    const bytes = await nv.saveImage({ filename: '', volumeByIndex: 1 });
    if (!(bytes instanceof Uint8Array)) throw new Error('Could not export the segmentation.');
    current.throwIfAborted();
    output = new File([bytes], `${model.id}-segmentation.nii`, { type: 'application/octet-stream' });
    results.render({ segmentation: { description: model.label, file: output } });
    $('outputSection').open = true;
    return { artifacts: [{ role: 'segmentation', file: output }], provenance: { model: model.id, upstreamRevision: REVISION, grid: '256³ 1 mm conformed' } };
  });
}
$('runButton').onclick = () => void segment().catch(() => {});
registerAppAutomation({ app: APP.id, operations: { segment: async ({ inputs, parameters, signal }) => {
  if (!MODELS.some(model => model.id === parameters.model)) throw new Error('Unknown segmentation model.');
  $('method').value = parameters.model;
  await load(inputs.image, signal);
  return segment(signal);
} } });
window.addEventListener('pagehide', () => { exampleControl.destroy(); active?.abort(); });
ready.catch(error => status(`Viewer unavailable: ${error.message}`, true));
