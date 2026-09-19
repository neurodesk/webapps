import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { createElement } from '@neurodesk/webapp-components/core';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
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
let source;
let worker;
let busy = false;
let outputs = new Map();
let importedImages = [];
let timer;
let started;
let surfaceAnalysis;
let reconstruction;
let operation = 'Reconstruction';
let preparation;
let meshSceneReady = false;
let viewerBusy = false;
const loadedMeshes = new Map();
const visibleMeshes = new Set();
const surfaceStages = new Set(['lh-white', 'rh-white', 'lh-pial', 'rh-pial']);
const stageLabels = {
  qc: 'Source-grid QC overlay',
  'lh-white': 'Left white surface',
  'rh-white': 'Right white surface',
  'lh-pial': 'Left pial surface',
  'rh-pial': 'Right pial surface',
  provenance: 'Processing manifest',
  'lh-normals': 'Left mid-surface normals',
  'rh-normals': 'Right mid-surface normals',
  'patch-qc': 'Cortical patches and normals',
  'patch-geometry': 'Paired patch geometry and local normals',
  'surface-analysis': 'Surface analysis measurements',
};
const meshColors = {
  'lh-white': [0.35, 0.7, 1, 1],
  'rh-white': [1, 0.7, 0.3, 1],
  'lh-pial': [0.15, 0.35, 1, 1],
  'rh-pial': [1, 0.25, 0.15, 1],
};
const xrayValue = createElement('span', { id: 'meshXRayValue', text: '10%' });
const xrayInput = createElement('input', {
  id: 'meshXRay',
  type: 'range',
  min: 0,
  max: 1,
  step: 0.05,
  value: 0.1,
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
  actions: [xrayControl],
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'render', label: '3D' },
  ].map((view) => ({
    ...view,
    onClick: () => {
      if (!viewer) return;
      viewer.sliceType = view.id === 'render' ? SLICE_TYPE.RENDER : SLICE_TYPE.MULTIPLANAR;
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
$('viewer').prepend(toolbar);

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

function resultLabel(stage) {
  const patch = /^(LH|RH)(\d+)$/.exec(stage);
  return patch ? `${patch[1] === 'LH' ? 'Left' : 'Right'} flat patch ${Number(patch[2])}` : stageLabels[stage] || stage;
}

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function setBusy(value) {
  busy = value;
  exampleControl.setDisabled(value);
  for (const input of $('controls').querySelectorAll('input, select')) input.disabled = value;
  $('runButton').disabled = value || viewerBusy || !source;
  $('analyzeButton').disabled = value || viewerBusy || !reconstruction;
  $('cancelButton').hidden = !value;
  if (!value) clearInterval(timer);
}

function setViewerBusy(value) {
  viewerBusy = value;
  for (const control of $('resultList').querySelectorAll('button, input')) control.disabled = value;
  $('runButton').disabled = value || busy || !source;
  $('analyzeButton').disabled = value || busy || !reconstruction;
}

async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({
        isDragDropEnabled: false,
        backgroundColor: [0.04, 0.06, 0.08, 1],
        meshXRay: Number(xrayInput.value),
      });
      await viewer.attachTo('gl1');
      viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
      viewer.showRender = SHOW_RENDER.ALWAYS;
      viewer.createExtensionContext().on('locationChange', (event) => {
        $('location').textContent = event.detail.string;
      });
      return viewer;
    })();
  }
  return viewerReady;
}

async function resetMeshes(nv) {
  await nv.removeAllMeshes();
  loadedMeshes.clear();
  visibleMeshes.clear();
  meshSceneReady = false;
  xrayControl.hidden = true;
  for (const input of $('resultList').querySelectorAll('.nd-result-visibility input')) input.checked = false;
}

async function showSource() {
  const nv = await ensureViewer();
  await resetMeshes(nv);
  await nv.loadVolumes([{ url: source, name: source.name }]);
  nv.drawScene();
  $('emptyState').hidden = true;
  $('imageLabel').textContent = 'ORIGINAL IMAGE';
}

async function setMeshVisible(stage, visible, input) {
  const file = outputs.get(stage);
  if (!file || !surfaceStages.has(stage) || viewerBusy) {
    input.checked = !visible;
    return;
  }
  setViewerBusy(true);
  try {
    const nv = await ensureViewer();
    if (!meshSceneReady) {
      nv.meshThicknessOn2D = Infinity;
      await nv.removeAllMeshes();
      await nv.loadVolumes([{ url: source, name: source.name }]);
      loadedMeshes.clear();
      visibleMeshes.clear();
      meshSceneReady = true;
      nv.sliceType = SLICE_TYPE.MULTIPLANAR;
      toolbar.setActive('multiplanar');
    }
    if (!loadedMeshes.has(stage)) {
      const index = nv.meshes.length;
      await nv.addMesh({ url: file, name: file.name, color: meshColors[stage] });
      loadedMeshes.set(stage, index);
    } else {
      await nv.setMesh(loadedMeshes.get(stage), { opacity: visible ? 1 : 0 });
    }
    if (visible) visibleMeshes.add(stage);
    else visibleMeshes.delete(stage);
    input.checked = visible;
    xrayControl.hidden = visibleMeshes.size === 0;
    $('imageLabel').textContent = visibleMeshes.size
      ? Object.keys(meshColors).filter((id) => visibleMeshes.has(id)).map((id) => stageLabels[id]).join(' · ').toUpperCase()
      : 'ORIGINAL IMAGE';
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
  if (!file) return;
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
      const overlay = stage === 'patch-qc' ? { colormap: 'hot', calMin: 1, calMax: 4095, isTransparentBelowCalMin: true } : {};
      await nv.loadVolumes([{ url: source, name: source.name }, { url: file, name: file.name, opacity: 0.75, ...overlay }]);
      nv.sliceType = SLICE_TYPE.MULTIPLANAR;
      $('imageLabel').textContent = stage === 'patch-qc' ? 'PATCHES · WHITE 2400 · PIAL 2700 · MID 3000 · NORMAL 4095' : 'ORIGINAL IMAGE · TOPOFIT QC';
      toolbar.setActive('multiplanar');
      const firstPatch = stage === 'patch-qc' && Object.values(surfaceAnalysis?.flat_patches || {})[0];
      if (firstPatch) nv.setCrosshairPos(firstPatch.center_ras_mm);
    } else {
      const patch = surfaceAnalysis?.flat_patches?.[stage];
      nv.meshThicknessOn2D = patch ? 1 : Infinity;
      await nv.loadVolumes([{ url: source, name: source.name }]);
      await nv.loadMeshes([{
        url: file,
        name: file.name,
        ...(patch ? { color: [1, 0.85, 0, 1], sliceShaderType: 'crosscut' } : {}),
      }]);
      nv.sliceType = SLICE_TYPE.MULTIPLANAR;
      $('imageLabel').textContent = resultLabel(stage);
      toolbar.setActive('multiplanar');
      if (patch) {
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
  if (!file || busy) return;
  setBusy(true);
  try {
    if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error('Choose a .nii or .nii.gz image.');
    source = file;
    reconstruction = null;
    outputs = new Map();
    results.render();
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
    $('surfaceAnalysisSettings').open = true;
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
      $('surfaceAnalysisSettings').open = true;
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
      surfaceAnalysis = data.provenance.surfaceAnalysis;
      if (analysisOnly) outputs = new Map(reconstruction.files);
      for (const output of data.files) {
        if (output.id.endsWith('-registration')) continue;
        outputs.set(output.id, new File([output.bytes], output.name, { type: output.mediaType }));
      }
      if (!analysisOnly && data.surfaces) {
        reconstruction = {
          surfaces: data.surfaces,
          provenance: data.provenance,
          files: new Map([...outputs].filter(([id]) => surfaceStages.has(id) || id === 'qc' || id === 'provenance')),
        };
      }
      results.render(Object.fromEntries([...outputs].map(([id]) => [
        id,
        surfaceStages.has(id) ? { visible: false } : { description: resultLabel(id) },
      ])));
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
window.addEventListener('pagehide', () => { exampleControl.destroy(); worker?.terminate(); });
