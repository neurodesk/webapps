import examples from '../examples.json';
import { renderExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  StageResultList,
  bindFileDrop,
  createInfoDialog,
  renderConsole,
  renderViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import { downloadBlob, downloadFile, readNifti } from '@neurodesk/webapp-components/file-io';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import manifest from '@neurodesk/synthseg/manifest';
import { looksLikeCt, outputStem } from './logic.js';
import freesurferLut from './freesurfer-lut.json';
import './styles.css';

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'SynthSeg',
  subtitle: 'FreeSurfer brain labels, in your browser',
  mark: 'S',
  controlsContract: { privacy: '#privacyBtn', standalone: '#standaloneBtn' },
});
const $ = (id) => document.getElementById(id);
const technicalLog = renderConsole({ id: 'technicalLog' });
$('viewer').append(technicalLog.root);
const info = createInfoDialog({ id: 'infoDialog' });
const layouts = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const toolbar = renderViewerToolbar({
  window: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map((view) => ({
    ...view,
    onClick: () => {
      if (!viewer) return;
      viewer.sliceType = layouts[view.id];
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
$('viewer').prepend(toolbar.root);
$('overlayOpacity').id = 'opacity';
$('opacity').value = '0.6';
$('opacity').disabled = true;
$('overlayOpacityValue').textContent = '60%';
const results = new StageResultList({
  element: $('resultList'),
  onView: () => {
    if (output && !busy) void show();
  },
  onDownload: () => {
    if (output && !busy) downloadFile(output);
  },
});
results.render({ labels: { description: 'FreeSurfer labels' } });
$('resultList').querySelector('.nd-download-btn').id = 'saveBtn';
$('resultList').querySelector('.nd-view-btn').id = 'viewResultBtn';
$('saveBtn').disabled = true;
$('viewResultBtn').disabled = true;
const assetBase = import.meta.env.VITE_SYNTHSEG_ASSET_BASE || manifest.base_url;

const webgpu = Boolean(navigator.gpu);
let source,
  output,
  provenance,
  worker,
  viewer,
  viewerReady,
  busy = false,
  timer,
  started;
let importAbort,
  importedImages = [];

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  technicalLog.log(message, error ? 'error' : 'info');
}
function setBusy(value, cancellable = false) {
  busy = value;
  exampleControl.setDisabled(value);
  for (const id of ['imageInput', 'seriesSelect', 'mode', 'ct'])
    $(id).disabled = value;
  $('processButton').disabled = value || !source || !webgpu;
  $('cancelBtn').hidden = !value || !cancellable;
  $('opacity').disabled = value || !output;
  $('saveBtn').disabled = value || !output;
  $('viewResultBtn').disabled = value || !output;
  $('reportBtn').disabled = value || !provenance;
  if (!value) {
    clearInterval(timer);
    worker?.terminate();
    worker = null;
  }
}
async function ensureViewer() {
  if (viewerReady) return viewerReady;
  viewerReady = (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0.04, 0.06, 0.08, 1] });
    await viewer.attachTo('gl1');
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.showRender = SHOW_RENDER.ALWAYS;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on('locationChange', (e) => {
      $('location').textContent = e.detail.string;
    });
    return viewer;
  })();
  return viewerReady;
}
async function show() {
  $('emptyState').hidden = true;
  $('imageLabel').textContent = output ? 'ORIGINAL IMAGE · FREESURFER LABELS' : 'ORIGINAL IMAGE';
  const volumes = [{ url: source, name: source.name }];
  if (output) volumes.push({ url: output, name: output.name, opacity: Number($('opacity').value) });
  try {
    const nv = await ensureViewer();
    await nv.loadVolumes(volumes);
    // Label names too, so the location bar reads e.g. "Left-Hippocampus".
    if (output) await nv.setColormapLabel(1, freesurferLut);
    $('viewerError').hidden = true;
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent =
      `Visualization unavailable: ${error.message}. Processing and NIfTI download remain available.`;
  }
}
async function load(file, signal) {
  if (busy || !file) return false;
  setBusy(true);
  try {
    if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error('Choose a .nii or .nii.gz image.');
    status('Reading image…');
    const { data, dims } = await readNifti(await file.arrayBuffer());
    signal?.throwIfAborted();
    source = file;
    output = null;
    provenance = null;
    $('outputSection').open = false;
    $('ct').checked = looksLikeCt(data);
    $('progress').value = 0;
    $('elapsed').textContent = '';
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${file.name} · ${dims.join(' × ')} voxels`;
    await show();
    status(
      webgpu
        ? 'Image loaded · ready to segment'
        : 'Image loaded · this browser cannot run SynthSeg',
      !webgpu,
    );
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
  setBusy(true, true);
  status('Reading images · converting DICOM if needed…');
  try {
    const files = await filesPromise;
    const images = await readImageFiles(files, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!images.length) throw new Error('Choose NIfTI files or a complete DICOM series.');
    setBusy(false);
    if (!(await load(images[0]))) return;
    importedImages = images;
    $('seriesSelect').replaceChildren(
      ...images.map((file, index) => new Option(file.name, String(index))),
    );
    $('seriesSelect').hidden = images.length < 2;
  } catch (error) {
    if (!controller.signal.aborted) {
      setBusy(false);
      status(error.message, true);
    }
  } finally {
    if (importAbort === controller) importAbort = null;
  }
}
$('imageInput').onchange = () => {
  const files = Array.from($('imageInput').files);
  $('imageInput').value = '';
  if (files.length) void importImages(Promise.resolve(files));
};
$('seriesSelect').onchange = async () => {
  if (!(await load(importedImages[Number($('seriesSelect').value)])))
    $('seriesSelect').value = String(importedImages.indexOf(source));
};
bindFileDrop($('dropZone'), (files) => {
  if (!busy) void importImages(files);
});
const exampleControl = renderExampleSelector({
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
exampleControl.root.querySelector('label').htmlFor = 'exampleSelect';
$('exampleControl').replaceWith(exampleControl.root);

$('opacity').oninput = () => {
  const value = Number($('opacity').value);
  $('overlayOpacityValue').textContent = `${Math.round(value * 100)}%`;
  if (output && viewer) viewer.setOpacity(1, value);
};
$('processButton').onclick = async () => {
  if (!source || busy || !webgpu) return;
  output = null;
  provenance = null;
  $('outputSection').open = false;
  setBusy(true);
  await show();
  const options = { fast: $('mode').value === 'fast', ct: $('ct').checked };
  setBusy(true, true);
  $('progress').value = 0;
  started = performance.now();
  timer = setInterval(() => {
    $('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`;
  }, 1000);
  worker = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
  const jobWorker = worker;
  worker.onmessage = async ({ data }) => {
    if (worker !== jobWorker) return;
    if (data.type === 'progress') {
      status(data.message);
      $('progress').value = data.value;
    }
    if (data.type === 'error') {
      setBusy(false);
      status(data.message, true);
    }
    if (data.type === 'result') {
      $('cancelBtn').hidden = true;
      provenance = data.provenance;
      output = new File([data.buffer], `${outputStem(source.name)}_synthseg.nii.gz`, {
        type: 'application/gzip',
      });
      $('outputSection').open = true;
      $('progress').value = 1;
      try {
        await show();
        status(
          `Labels ready · ${provenance.outputShape.join(' × ')} · ${Math.round(provenance.seconds)} s`,
        );
      } finally {
        setBusy(false);
      }
    }
  };
  worker.onerror = (e) => {
    if (worker !== jobWorker) return;
    setBusy(false);
    status(
      `Processing stopped: ${e.message || 'The inference worker could not run. Reload the app and try again.'}`,
      true,
    );
  };
  const asset = manifest.assets.find((entry) => entry.filename === 'synthseg-2.0.onnx');
  worker.postMessage({
    file: source,
    options,
    model: { ...asset, url: `${assetBase}${asset.filename}?sha256=${asset.sha256}` },
  });
};
$('cancelBtn').onclick = () => {
  exampleControl.cancel();
  importAbort?.abort();
  setBusy(false);
  $('progress').value = 0;
  status('Processing cancelled. Your original image is unchanged.');
};
$('saveBtn').onclick = () => output && downloadFile(output);
$('reportBtn').onclick = () =>
  provenance &&
  downloadBlob(
    new Blob([JSON.stringify(provenance, null, 2)], { type: 'application/json' }),
    output.name.replace(/\.nii\.gz$/, '.json'),
  );
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
$('standaloneBtn').onclick = () => info.open('Standalone', $('standaloneContent'), { wide: true });
if (!webgpu)
  status(
    'This browser does not support WebGPU. SynthSeg needs WebGPU; try Chrome, Edge, or Safari 26 on a desktop.',
    true,
  );
window.addEventListener('pagehide', () => {
  exampleControl.cancel();
  importAbort?.abort();
  worker?.terminate();
  clearInterval(timer);
});
