import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import { SLICE_TYPE } from '@niivue/niivue';
import { mountViewer } from './freebrowse-viewer.js';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { createElement } from '@neurodesk/webapp-components/core';
import { downloadArrayBuffer, downloadFile } from '@neurodesk/webapp-components/file-io';
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import manifest from '@neurodesk/topofit/manifest';

const $ = (id) => document.getElementById(id);
const assetBase = import.meta.env.VITE_TOPOFIT_ASSET_BASE || manifest.base_url;
mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'TopoFit',
  subtitle: 'Cortical surfaces, locally in your browser',
  mark: 'T',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});
const log = createConsole({ id: 'technicalLog' });
$('viewer').append(log);
const info = createInfoDialog({ id: 'infoDialog' });
$('aboutBtn').onclick = () => info.open('About TopoFit', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

let viewer;
let viewerReady;
let embeddedViewer;
let source;
let worker;
let busy = false;
let outputs = new Map();
let importedImages = [];
let timer;
let started;
let surfaceAnalysis;
let selectedPatch;
let displayedResult;
let reconstruction;
let operation = 'Reconstruction';
let preparation;
let meshSceneReady = false;
let anatomyIn3D = false;
let viewerBusy = false;
let normalArrowWorker;
let normalArrowKey = '';
const visibleMeshes = new Set();
const surfaceStages = new Set(['lh-white', 'rh-white', 'lh-mid', 'rh-mid', 'lh-pial', 'rh-pial']);
const stageLabels = {
  qc: 'Source-grid QC overlay',
  'lh-white': 'Left white surface',
  'rh-white': 'Right white surface',
  'lh-mid': 'Left mid-surface',
  'rh-mid': 'Right mid-surface',
  'lh-pial': 'Left pial surface',
  'rh-pial': 'Right pial surface',
  'lh-normals': 'Left mid-surface normals',
  'rh-normals': 'Right mid-surface normals',
  'patch-qc': 'Cortical patches and normals',
  'patch-coordinates': 'Patch coordinates and normals (RAS)',
  'patch-geometry': 'Paired patch geometry and local normals',
};
const meshColors = {
  'lh-white': [0.35, 0.7, 1, 1],
  'rh-white': [1, 0.7, 0.3, 1],
  'lh-mid': [0.2, 0.85, 0.75, 1],
  'rh-mid': [1, 0.55, 0.65, 1],
  'lh-pial': [0.15, 0.35, 1, 1],
  'rh-pial': [1, 0.25, 0.15, 1],
};
const xrayValue = createElement('span', { id: 'meshXRayValue', text: '0%' });
const xrayInput = createElement('input', {
  id: 'meshXRay',
  type: 'range',
  min: 0,
  max: 1,
  step: 0.05,
  value: 0,
  'aria-label': 'Mesh X-ray',
  oninput: (event) => {
    const value = Number(event.currentTarget.value);
    xrayValue.textContent = `${Math.round(value * 100)}%`;
    if (viewer) viewer.meshXRay = value;
  },
});
const xrayControl = createElement('label', { className: 'nd-opacity-control', hidden: true }, [
  'X-ray',
  xrayInput,
  xrayValue,
]);

const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [],
  actions: [xrayControl],
});
$('viewer').prepend(toolbar);
toolbar.hidden = true;

const results = createResultList({
  element: $('resultList'),
  stageLabels,
  onView: (stage) => void showResult(stage),
  onVisibilityChange: (stage, visible, _result, input) => void setMeshVisible(stage, visible, input),
  onDownload: (stage) => {
    const file = outputs.get(stage);
    if (file) downloadFile(file);
  },
});

for (const id of ['showNormalArrows', 'normalArrowDensity', 'normalArrowLength']) {
  $(id).onchange = () => {
    if ($('normalArrowLength').reportValidity()) void refreshNormalArrows();
  };
}

const arrowName = (hemisphere) => `${hemisphere}.normals-arrows.mz3`;
const isNormalArrow = (mesh) => ['lh', 'rh'].some((hemisphere) => mesh.name === arrowName(hemisphere));

async function removeNormalArrows() {
  for (let index = viewer.meshes.length - 1; index >= 0; index -= 1) {
    if (isNormalArrow(viewer.meshes[index])) await viewer.removeMesh(index);
  }
}

async function refreshNormalArrows() {
  if (!viewer || viewerBusy || busy || !$('normalArrowLength').checkValidity()) return;
  const hemispheres = ['lh', 'rh'].filter((side) => visibleMeshes.has(`${side}-mid`));
  const spacing = Number($('normalArrowDensity').value);
  const length = Number($('normalArrowLength').value);
  const key = $('showNormalArrows').checked && hemispheres.length ? `${hemispheres}:${spacing}:${length}` : '';
  if (key === normalArrowKey) return;
  normalArrowKey = key;
  setViewerBusy(true);
  try {
    await removeNormalArrows();
    if (!key) {
      $('normalArrowStatus').textContent = hemispheres.length ? 'Normal arrows hidden.' : 'Select a mid-surface to plot its normals.';
      return;
    }
    $('normalArrowStatus').textContent = 'Preparing normal arrows…';
    const initialize = !normalArrowWorker;
    normalArrowWorker ||= new Worker(new URL('./normal-arrows-worker.js', import.meta.url), { type: 'module' });
    const arrows = await new Promise((resolve, reject) => {
      normalArrowWorker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.arrows);
      normalArrowWorker.onerror = (event) => reject(new Error(event.message || 'Normal arrow worker failed.'));
      normalArrowWorker.postMessage({ hemispheres, spacing, length, ...(initialize ? { surfaces: reconstruction.surfaces } : {}) });
    });
    for (const { hemisphere, bytes } of arrows) {
      const name = arrowName(hemisphere);
      await viewer.addMesh({ url: new File([bytes], name), name, color: [1, 0.85, 0.15, 1], sliceShaderType: 'crosscut' });
    }
    const count = arrows.reduce((sum, arrow) => sum + arrow.count, 0);
    $('normalArrowStatus').textContent = `${count.toLocaleString()} outward ${count === 1 ? 'arrow' : 'arrows'} · ${spacing} mm spacing · ${length} mm length`;
  } catch (error) {
    normalArrowWorker?.terminate();
    normalArrowWorker = null;
    await removeNormalArrows();
    normalArrowKey = '';
    $('showNormalArrows').checked = false;
    $('normalArrowStatus').textContent = `Normal arrows unavailable: ${error.message}`;
  } finally {
    setViewerBusy(false);
  }
}

// Printable STL: niimath simplifies and smooths each surface, TopoFit writes the STL.
function stlStages() {
  const available = [...surfaceStages].filter((stage) => reconstruction?.surfaces?.vertices[stage.replace('-', '.')]);
  const ticked = available.filter((stage) => visibleMeshes.has(stage));
  return ticked.length ? ticked : available;
}

function exportStl(stages, reduce, smooth) {
  if (busy || viewerBusy) return;
  operation = 'STL export';
  setBusy(true);
  status(`Preparing ${stages.length} printable ${stages.length === 1 ? 'surface' : 'surfaces'}…`);
  try {
    const active = new Worker(new URL('./stl-worker.js', import.meta.url), { type: 'module' });
    worker = active;
    const finish = () => {
      active.terminate();
      worker = null;
      setBusy(false);
    };
    active.onmessage = ({ data }) => {
      if (worker !== active) return;
      if (data.type === 'progress') status(`Simplifying surface ${data.done} of ${data.total}…`);
      if (data.type === 'result') {
        for (const file of data.files) downloadArrayBuffer(file.bytes, file.name, 'model/stl');
        status(`Saved ${data.files.map((file) => `${file.name} · ${file.triangles.toLocaleString()} triangles`).join(', ')}`);
        finish();
      }
      if (data.type === 'error') {
        status(`STL export failed: ${data.message}`, true);
        finish();
      }
    };
    active.onerror = (event) => {
      if (worker !== active) return;
      status(`STL export failed: ${event.message || 'The STL worker could not run.'}`, true);
      finish();
    };
    active.postMessage({
      reduce,
      smooth,
      surfaces: stages.map((stage) => ({
        name: `${stage.replace('-', '.')}.stl`,
        vertices: reconstruction.surfaces.vertices[stage.replace('-', '.')],
        faces: reconstruction.surfaces.faces[stage.slice(0, 2)],
      })),
    });
  } catch (error) {
    worker?.terminate();
    worker = null;
    status(`STL export failed: ${error.message}`, true);
    setBusy(false);
  }
}

$('stlButton').onclick = () => {
  const stages = stlStages();
  if (!stages.length) return;
  info.open('Save printable STL', $('stlContent'));
  info.body.querySelector('#stlSurfaceList').textContent = stages.map((stage) => stageLabels[stage].toLowerCase()).join(', ');
  info.body.querySelector('#stlSaveButton').onclick = () => {
    const reduce = info.body.querySelector('#stlReduce');
    const smooth = info.body.querySelector('#stlSmooth');
    if (!reduce.reportValidity() || !smooth.reportValidity()) return;
    info.close();
    void exportStl(stages, Number(reduce.value) / 100, Number(smooth.value));
  };
};

function resultLabel(stage) {
  const patch = /^(LH|RH)(\d+)$/.exec(stage);
  return patch ? `${patch[1] === 'LH' ? 'Left' : 'Right'} flat patch ${Number(patch[2])}` : stageLabels[stage] || stage;
}

function showPatchMeasurements(patch) {
  selectedPatch = patch;
  $('patchMeasurements').hidden = !patch;
  $('patchCopyStatus').textContent = '';
  $('patchMeasurementTitle').textContent = patch ? resultLabel(patch.patch_id) : '';
  const format = (values, decimals) => values.map((value, axis) => `${'RAS'[axis]} ${value.toFixed(decimals)}`).join(' · ');
  $('patchCenter').value = patch ? format(patch.center_ras_mm, 3) : '';
  $('patchNormal').value = patch ? format(patch.normal_ras, 6) : '';
}

$('copyPatchCoordinates').onclick = async () => {
  if (!selectedPatch) return;
  const patch = selectedPatch;
  try {
    await navigator.clipboard.writeText(JSON.stringify({
      coordinate_system: 'Scanner RAS',
      normal_method: 'Unit fitted-plane normal, oriented white-to-pial',
      ...patch,
    }, null, 2));
    if (selectedPatch === patch) $('patchCopyStatus').textContent = 'Copied full-precision patch measurements.';
  } catch {
    if (selectedPatch === patch) $('patchCopyStatus').textContent = 'Clipboard unavailable. Download Patch coordinates and normals (RAS) instead.';
  }
};

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function setBusy(value) {
  busy = value;
  $('freebrowseViewer').inert = value || viewerBusy;
  exampleControl.setDisabled(value);
  for (const input of $('controls').querySelectorAll('input, select')) input.disabled = value || viewerBusy;
  for (const control of $('resultList').querySelectorAll('button, input')) control.disabled = value || viewerBusy;
  $('copyPatchCoordinates').disabled = value;
  $('runButton').disabled = value || viewerBusy || !source;
  $('analyzeButton').disabled = value || viewerBusy || !reconstruction;
  $('stlButton').disabled = value || viewerBusy;
  $('cancelButton').hidden = !value;
  if (!value) clearInterval(timer);
}

function setViewerBusy(value) {
  viewerBusy = value;
  if (!value && viewer) syncMeshControls();
  $('freebrowseViewer').inert = value || busy;
  exampleControl.setDisabled(value || busy);
  for (const input of $('controls').querySelectorAll('input, select')) input.disabled = value || busy;
  for (const control of $('resultList').querySelectorAll('button, input')) control.disabled = value || busy;
  $('runButton').disabled = value || busy || !source;
  $('analyzeButton').disabled = value || busy || !reconstruction;
  $('stlButton').disabled = value || busy;
}

async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      embeddedViewer = mountViewer($('freebrowseViewer'), {
        isDragDropEnabled: false,
        backgroundColor: [0.04, 0.06, 0.08, 1],
        meshXRay: Number(xrayInput.value),
        backend: 'webgl2',
      });
      viewer = await embeddedViewer.ready;
      toolbar.hidden = false;
      viewer.addEventListener('change', (event) => {
        if (event.detail.property === 'meshXRay') {
          xrayInput.value = String(viewer.meshXRay);
          xrayValue.textContent = `${Math.round(viewer.meshXRay * 100)}%`;
        }
      });
      viewer.addEventListener('volumeRemoved', () => { meshSceneReady = false; });
      viewer.addEventListener('documentLoaded', () => { meshSceneReady = false; });
      for (const event of ['meshRemoved', 'meshUpdated']) {
        viewer.addEventListener(event, ({ detail }) => {
          if (!viewerBusy && isNormalArrow(detail.mesh) && (event === 'meshRemoved' || detail.mesh.opacity === 0)) $('showNormalArrows').checked = false;
        });
      }
      viewer.addEventListener('volumeUpdated', ({ detail: { volume, changes } }) => {
        if (viewerBusy || busy || !viewer.meshes.length || volume.name !== source?.name || changes.opacity === undefined) return;
        anatomyIn3D = changes.opacity > 0;
        viewer.setClipPlane([anatomyIn3D ? 2 : -1, 0, 0]);
      });
      viewer.addEventListener('locationChange', (event) => {
        $('location').textContent = event.detail.string;
      });
      for (const event of ['meshLoaded', 'meshRemoved', 'meshUpdated', 'volumeLoaded', 'volumeRemoved', 'volumeUpdated']) {
        viewer.addEventListener(event, () => queueMicrotask(syncMeshControls));
      }
      return viewer;
    })().catch((error) => {
      embeddedViewer?.destroy();
      viewerReady = null;
      viewer = null;
      throw error;
    });
  }
  return viewerReady;
}

function syncMeshControls() {
  if (viewerBusy) return;
  visibleMeshes.clear();
  for (const stage of surfaceStages) {
    const mesh = viewer.meshes.find((mesh) => mesh.name === outputs.get(stage)?.name);
    const visible = !!mesh && mesh.opacity > 0;
    if (visible) visibleMeshes.add(stage);
    const input = $('resultList').querySelector(`input[aria-label="Show ${stageLabels[stage]}"]`);
    if (input) input.checked = visible;
  }
  xrayControl.hidden = visibleMeshes.size === 0;
  if (!displayedResult) {
    $('imageLabel').textContent = visibleMeshes.size
      ? Object.keys(meshColors).filter((id) => visibleMeshes.has(id)).map((id) => stageLabels[id]).join(' · ').toUpperCase()
      : viewer.volumes.some((volume) => volume.name === source?.name) ? 'ORIGINAL IMAGE' : 'VIEWER SCENE';
  }
  if (displayedResult) {
    const files = displayedResult === 'qc' || displayedResult === 'patch-qc' ? viewer.volumes : viewer.meshes;
    const displayed = files.find((file) => file.name === outputs.get(displayedResult)?.name);
    if (!displayed || displayed.opacity === 0) {
      showPatchMeasurements(null);
      displayedResult = null;
      $('imageLabel').textContent = 'VIEWER SCENE';
    }
  }
  queueMicrotask(() => void refreshNormalArrows());
}

async function resetMeshes(nv) {
  displayedResult = null;
  showPatchMeasurements(null);
  await nv.removeAllMeshes();
  normalArrowKey = '';
  $('normalArrowStatus').textContent = 'Select a mid-surface to plot its normals.';
  visibleMeshes.clear();
  meshSceneReady = false;
  xrayControl.hidden = true;
  for (const input of $('resultList').querySelectorAll('.nd-result-visibility input')) input.checked = false;
}

async function showSource() {
  const nv = await ensureViewer();
  anatomyIn3D = false;
  await resetMeshes(nv);
  nv.setClipPlane([2, 0, 0]);
  await nv.loadVolumes([{ url: source, name: source.name }]);
  nv.drawScene();
  $('emptyState').hidden = true;
  $('imageLabel').textContent = 'ORIGINAL IMAGE';
}

async function setMeshVisible(stage, visible, input) {
  const file = outputs.get(stage);
  if (!file || !surfaceStages.has(stage) || viewerBusy || busy) {
    input.checked = !visible;
    return;
  }
  setViewerBusy(true);
  try {
    const nv = await ensureViewer();
    if (visible && !meshSceneReady) {
      displayedResult = null;
      showPatchMeasurements(null);
      nv.meshThicknessOn2D = 1;
      nv.setClipPlane([anatomyIn3D ? 2 : -1, 0, 0]);
      await nv.removeAllMeshes();
      normalArrowKey = '';
      await nv.loadVolumes([{ url: source, name: source.name }]);
      visibleMeshes.clear();
      meshSceneReady = true;
    }
    const index = nv.meshes.findIndex((mesh) => mesh.name === file.name);
    if (index < 0) {
      if (visible) await nv.addMesh({ url: file, name: file.name, color: meshColors[stage], sliceShaderType: 'crosscut' });
    } else {
      await nv.setMesh(index, { opacity: visible ? 1 : 0 });
    }
    nv.drawScene();
    $('emptyState').hidden = true;
    $('viewerError').hidden = true;
  } catch (error) {
    input.checked = !visible;
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Visualization unavailable: ${error.message}. Downloads remain available.`;
  } finally {
    setViewerBusy(false);
  }
}

async function showResult(stage) {
  const file = outputs.get(stage);
  if (!file || busy) return;
  if (file.type === 'application/json' || file.type === 'text/csv') {
    const content = document.createElement('pre');
    content.className = 'nd-console-output';
    const text = await file.text();
    content.textContent = text.length > 16000 ? `${text.slice(0, 16000)}\n\nPreview truncated. Download the complete file.` : file.type === 'application/json' ? JSON.stringify(JSON.parse(text), null, 2) : text;
    info.open(resultLabel(stage), content, { wide: true });
    return;
  }
  if (viewerBusy) return;
  setViewerBusy(true);
  try {
    const nv = await ensureViewer();
    await resetMeshes(nv);
    if (stage === 'qc' || stage === 'patch-qc') {
      nv.setClipPlane([2, 0, 0]);
      const overlay = stage === 'patch-qc' ? { colormap: 'hot', calMin: 1, calMax: 4095, isTransparentBelowCalMin: true } : {};
      await nv.loadVolumes([{ url: source, name: source.name }, { url: file, name: file.name, opacity: 0.75, ...overlay }]);
      nv.sliceType = SLICE_TYPE.MULTIPLANAR;
      $('imageLabel').textContent = stage === 'patch-qc' ? 'PATCHES · WHITE 2400 · PIAL 2700 · MID 3000 · NORMAL 4095' : 'ORIGINAL IMAGE · TOPOFIT QC';
      displayedResult = stage;
      const firstPatch = stage === 'patch-qc' && Object.values(surfaceAnalysis?.flat_patches || {})[0];
      if (firstPatch) {
        nv.setCrosshairPos(firstPatch.center_ras_mm);
        showPatchMeasurements(firstPatch);
      }
    } else {
      const patch = surfaceAnalysis?.flat_patches?.[stage];
      nv.meshThicknessOn2D = 1;
      // Hide the MRI in 3D until the user explicitly shows it in FreeBrowse.
      nv.setClipPlane([anatomyIn3D ? 2 : -1, 0, 0]);
      await nv.loadVolumes([{ url: source, name: source.name }]);
      await nv.loadMeshes([{
        url: file,
        name: file.name,
        sliceShaderType: 'crosscut',
        ...(meshColors[stage] ? { color: meshColors[stage] } : {}),
        ...(patch ? { color: [1, 0.85, 0, 1] } : {}),
      }]);
      meshSceneReady = surfaceStages.has(stage);
      displayedResult = surfaceStages.has(stage) ? null : stage;
      if (surfaceStages.has(stage)) {
        const mesh = nv.meshes[0];
        nv.setCrosshairPos([0, 1, 2].map((axis) => (mesh.extentsMin[axis] + mesh.extentsMax[axis]) / 2));
      }
      $('imageLabel').textContent = resultLabel(stage);
      if (patch) {
        showPatchMeasurements(patch);
        nv.setCrosshairPos(patch.center_ras_mm);
        $('imageLabel').textContent = `${resultLabel(stage)} · ${patch.area_mm2.toFixed(1)} mm² · RMS ${patch.rms_distance_mm.toFixed(3)} mm`;
      }
    }
    nv.drawScene();
    $('viewerError').hidden = true;
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Visualization unavailable: ${error.message}. Downloads remain available.`;
  } finally {
    setViewerBusy(false);
  }
}

async function load(file) {
  if (!file || busy || viewerBusy) return;
  setBusy(true);
  try {
    if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error('Choose a .nii or .nii.gz image.');
    showPatchMeasurements(null);
    source = file;
    reconstruction = null;
    normalArrowWorker?.terminate();
    normalArrowWorker = null;
    $('showNormalArrows').checked = false;
    $('normalArrowStatus').textContent = 'Select a mid-surface to plot its normals.';
    outputs = new Map();
    results.render();
    $('stlButton').hidden = true;
    $('outputSection').open = false;
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = file.name;
    $('dropZone').classList.add('has-files');
    $('progress').value = 0;
    await showSource();
    status('Image loaded · ready to reconstruct');
    return true;
  } catch (error) {
    status(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function importFiles(filesPromise) {
  exampleControl.cancel();
  if (busy) return;
  setBusy(true);
  status('Reading images · converting DICOM if needed…');
  try {
    const images = await readImageFiles(await filesPromise);
    if (!images.length) throw new Error('Choose a NIfTI image or complete DICOM series.');
    importedImages = images;
    $('seriesSelect').replaceChildren(...images.map((file, index) => new Option(file.name, String(index))));
    $('seriesSelect').hidden = images.length < 2;
    setBusy(false);
    await load(images[0]);
  } catch (error) {
    status(error.message, true);
    setBusy(false);
  }
}

$('imageInput').onchange = () => {
  const files = Array.from($('imageInput').files);
  $('imageInput').value = '';
  if (files.length) void importFiles(Promise.resolve(files));
};
$('seriesSelect').onchange = () => void load(importedImages[Number($('seriesSelect').value)]);
bindFileDrop($('dropZone'), (files) => void importFiles(files));
const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    if (!await load(files[0])) throw new Error('The example image could not be loaded.');
    assertCurrent();
  },
  onStatus: status,
});
$('exampleControl').replaceWith(exampleControl);


$('findPatches').onchange = () => { $('patchSettings').hidden = !$('findPatches').checked; };
$('patchRegion').onchange = () => { $('patchRoiField').hidden = $('patchRegion').value !== 'roi'; };

async function run(analysisOnly = false) {
  if (!source || busy || viewerBusy || (analysisOnly && !reconstruction)) return;
  if (analysisOnly && !$('estimateNormals').checked && !$('findPatches').checked) {
    status('Choose normals, flat patches, or both.', true);
    return;
  }
  if ($('findPatches').checked) {
    const invalid = [...$('surfaceAnalysisSettings').querySelectorAll('input[type="number"]')].find((input) => !input.checkValidity());
    if (invalid) {
      for (let section = invalid.closest('details'); section; section = section.parentElement.closest('details')) section.open = true;
      invalid.reportValidity();
      return;
    }
  }
  const currentPreparation = {};
  preparation = currentPreparation;
  operation = analysisOnly ? 'Surface analysis' : 'Reconstruction';
  let roiBuffer;
  if ($('findPatches').checked && $('patchRegion').value === 'roi') {
    setBusy(true);
    try {
      const images = await readImageFiles(Array.from($('patchRoi').files));
      if (images.length !== 1) throw new Error('Choose one ROI mask on the input image grid.');
      roiBuffer = await images[0].arrayBuffer();
    } catch (error) {
      if (preparation !== currentPreparation) return;
      $('patchQuality').open = true;
      status(error.message, true);
      setBusy(false);
      return;
    }
  }
  if (preparation !== currentPreparation) return;
  if (!analysisOnly) {
    reconstruction = null;
    outputs = new Map();
    results.render();
    $('stlButton').hidden = true;
  }
  setBusy(true);
  $('progress').value = 0;
  $('elapsed').textContent = '0 s';
  started = performance.now();
  timer = setInterval(() => {
    $('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`;
  }, 1000);
  try {
    if (!analysisOnly) await showSource();
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Visualization unavailable: ${error.message}. Reconstruction can continue.`;
  }
  if (!busy || preparation !== currentPreparation) return;
  worker = analysisOnly
    ? new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' })
    : new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
  const active = worker;
  worker.onmessage = async ({ data }) => {
    if (worker !== active) return;
    if (data.type === 'progress') {
      $('progress').value = data.value;
      status(data.message);
    }
    if (data.type === 'error') {
      active.terminate();
      worker = null;
      setBusy(false);
      status(data.message, true);
    }
    if (data.type === 'result') {
      showPatchMeasurements(null);
      surfaceAnalysis = data.provenance.surfaceAnalysis;
      if (analysisOnly) outputs = new Map(reconstruction.files);
      for (const output of data.files) {
        if (output.id.endsWith('-registration')) continue;
        if (output.id === 'surface-analysis' || output.id === 'provenance') {
          const title = output.id === 'surface-analysis' ? 'Surface analysis measurements' : 'Processing manifest';
          log.log(`${title}\n${new TextDecoder().decode(output.bytes)}`);
          continue;
        }
        outputs.set(output.id, new File([output.bytes], output.name, { type: output.mediaType }));
      }
      if (!analysisOnly && data.surfaces) {
        normalArrowWorker?.terminate();
        normalArrowWorker = null;
        reconstruction = {
          surfaces: data.surfaces,
          provenance: data.provenance,
          files: new Map([...outputs].filter(([id]) => surfaceStages.has(id) || id === 'qc')),
        };
      }
      results.render(Object.fromEntries([...outputs].map(([id]) => [
        id,
        surfaceStages.has(id) ? { visible: false, viewable: true } : { description: resultLabel(id) },
      ])));
      $('stlButton').hidden = !reconstruction;
      $('outputSection').open = true;
      $('progress').value = 1;
      active.terminate();
      worker = null;
      setBusy(false);
      status(analysisOnly ? `Surface analysis ready · ${Math.round(data.elapsedSeconds)} s` : `Surfaces ready · ${data.provenance.surfaceVertices.toLocaleString()} vertices per hemisphere · ${Math.round(data.elapsedSeconds)} s`);
      if (surfaceAnalysis?.flat_patch_status === 'NO_PATCH_MEETS_CRITERIA') status('Surfaces ready · no cortical patch meets the selected criteria');
      await showResult(outputs.has('patch-qc') ? 'patch-qc' : 'qc');
    }
  };
  worker.onerror = (event) => {
    if (worker !== active) return;
    active.terminate();
    worker = null;
    setBusy(false);
    status(`${operation} stopped: ${event.message || 'worker failure'}`, true);
  };
  worker.postMessage({
    file: source,
    ...(analysisOnly ? { surfaces: reconstruction.surfaces, provenance: reconstruction.provenance } : {}),
    model: $('model').value,
    conform: $('conform').checked,
    overlayThickness: Number($('thickness').value),
    estimateNormals: $('estimateNormals').checked,
    patches: $('findPatches').checked ? {
      count: Number($('patchCount').value),
      radius: Number($('patchRadius').value),
      hemisphere: $('patchHemisphere').value,
      maxRms: Number($('patchMaxRms').value),
      minAreaFraction: Number($('patchMinArea').value),
    } : null,
    roiBuffer,
    assetBase,
  });
}

$('runButton').onclick = () => void run();
$('analyzeButton').onclick = () => void run(true);

$('cancelButton').onclick = () => {
  exampleControl.cancel();
  preparation = null;
  worker?.terminate();
  worker = null;
  setBusy(false);
  $('progress').value = 0;
  status(`${operation} cancelled. ${reconstruction ? 'Your reconstructed surfaces remain available.' : 'Your original image is unchanged.'}`);
};
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  normalArrowWorker?.terminate();
  exampleControl.destroy();
  worker?.terminate();
  embeddedViewer?.destroy();
});
