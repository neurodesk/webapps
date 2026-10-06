import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import { createElement } from '@neurodesk/webapp-components/core';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import { bindInfoTooltips, createInfoDialog, createConsole, createFileField, createMaskEditor, createViewerToolbar } from '@neurodesk/webapp-components/ui';
import { readImageFiles, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import { registerAppAutomation, registerViewer, createNiivueAdapter } from '@neurodesk/webapp-components/automation';
import { readVolume } from '@neurodesk/synthsr';
import { zip } from 'fflate';
import { templateAsset } from '../../../packages/syncro/src/assets.js';
import { configureNativeDownloads } from './native-release.js';
import './styles.css';

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'SYNcro',
  subtitle: 'Normalize brain scans and aligned lesion maps to MNI space',
  mark: 'S',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn', standalone: '#standaloneBtn' },
});

const $ = (id) => document.getElementById(id);
const base = new URL(import.meta.env.BASE_URL, location.href);
const viewerRegion = $('viewer');
configureNativeDownloads($('standaloneContent').content);

let viewer;
let maskEditor;
const layouts = {
  multiplanar() {
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.showRender = SHOW_RENDER.ALWAYS;
  },
  axial() {
    viewer.sliceType = SLICE_TYPE.AXIAL;
  },
  coronal() {
    viewer.sliceType = SLICE_TYPE.CORONAL;
  },
  sagittal() {
    viewer.sliceType = SLICE_TYPE.SAGITTAL;
  },
  render() {
    viewer.sliceType = SLICE_TYPE.RENDER;
  },
};
const opacityControl = createElement('label', { className: 'nd-opacity-control', id: 'opacityControl', hidden: true }, [
  'Lesion',
  createElement('input', { id: 'opacity', type: 'range', min: 0, max: 100, step: 5, value: 50, disabled: true, 'aria-label': 'Lesion opacity' }),
  createElement('span', { id: 'opacityValue', text: '50%' }),
]);
const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [opacityControl],
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map((view) => ({
    ...view,
    onClick() {
      if (!viewer) return;
      layouts[view.id]();
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
viewerRegion.prepend(toolbar);
const technicalLog = createConsole({ id: 'technicalLog', outputId: 'log', copyId: 'copyLog', clearId: 'clearLog' });
viewerRegion.append(technicalLog);
bindInfoTooltips(document);

const info = createInfoDialog({ id: 'info', titleId: 'infoTitle', bodyId: 'infoBody' });
$('aboutBtn').onclick = () => info.open('About SYNcro', $('aboutContent'));
$('standaloneBtn').onclick = () => {
  info.open('Standalone', $('standaloneContent'), { wide: true });
  for (const node of info.body.querySelectorAll('code, a#packageLink')) {
    node.textContent = node.textContent.replaceAll('__PACKAGE_VERSION__', __SYNCRO_PACKAGE_VERSION__);
    if (node.href !== undefined) node.setAttribute('href', node.getAttribute('href').replaceAll('__PACKAGE_VERSION__', __SYNCRO_PACKAGE_VERSION__));
  }
};
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
info.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  const text = info.body.querySelector(`#${button.dataset.copyTarget}`)?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    const live = info.body.querySelector('#copyStatus');
    if (live) live.textContent = 'Copied to clipboard';
  } catch {
    setStatus('Could not copy automatically. Select the text and copy it manually.');
  }
  setTimeout(() => {
    button.textContent = 'Copy';
  }, 1200);
});

const fileFields = {
  primary: createFileField({ id: 'input', rootId: 'dropZone', text: 'Drop primary NIfTI or DICOM files', label: 'Choose the required primary scan' }),
  lesion: createFileField({ id: 'lesion', rootId: 'lesionDropZone', text: 'Drop a binary lesion map', label: 'Choose an optional binary lesion map' }),
  pathological: createFileField({ id: 'pathological', rootId: 'pathologicalDropZone', text: 'Drop pathological modality files', label: 'Choose an optional pathological modality scan' }),
};
$('primaryField').append(fileFields.primary);
$('lesionField').append(fileFields.lesion);
$('pathologicalField').append(fileFields.pathological);

let inputs = { primary: null, lesion: null, pathological: null };
let outputs = null;
let viewItems = new Map();
let worker;
let viewerReady;
let busy = false;
let timer;
let started;
let importAbort;
let processingAbort;
let viewRevision = 0;
let viewTask = Promise.resolve();
let zipTask;
let lesionEdited = false;

function setStatus(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  technicalLog.log(message, error ? 'error' : 'info');
}

function setBusy(value) {
  busy = value;
  exampleControl.setDisabled(value);
  for (const field of Object.values(fileFields)) field.disabled = value;
  for (const id of ['ct', 'keepSynth', 'synthsrBackend', 'brainExtractor', 'normalization']) $(id).disabled = value;
  $('clearLesion').disabled = value;
  $('clearPathological').disabled = value;
  $('runButton').disabled = value || !inputs.primary;
  $('cancel').hidden = !value;
  $('download').disabled = value || !outputs;
  updateResultActions();
  if (!value) {
    clearInterval(timer);
    worker?.terminate();
    worker = null;
  }
}

async function getViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
      await viewer.attachTo('gl1');
      layouts.multiplanar();
      viewer.isLegendVisible = false;
      maskEditor = createMaskEditor({
        nv: viewer,
        onApply: async (name, file) => {
          const current = outputs;
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (outputs !== current || !current) return;
          outputs[name] = bytes;
          lesionEdited = true;
          rebuildViewItems();
          setStatus('Normalized lesion updated · downloads include the edit');
        },
        onCancel: () => {
          updateResultActions();
          if (outputs) setStatus('Lesion edit discarded');
        },
        onError: (name, error) => {
          updateResultActions();
          setStatus(`Could not edit the lesion: ${error.message}`, true);
        },
      });
      maskEditor.addEventListener('nd-mask-edit-end', updateResultActions);
      maskEditor.addEventListener('nd-mask-edit-start', (event) => {
        updateResultActions();
        setStatus(event.detail.message);
      });
      toolbar.after(maskEditor);
      registerViewer('image', createNiivueAdapter(viewer, {
        tabs: {
          list: () => [...viewItems].map(([id, item]) => ({ id, label: item.label, active: id === $('viewSelect').value })),
          select: (id) => {
            $('viewSelect').value = id;
            updateResultActions();
            return show(viewItems.get(id));
          },
        },
      }));
      return viewer;
    })();
  }
  return viewerReady;
}

async function show(item) {
  const revision = ++viewRevision;
  const display = async () => {
    if (revision !== viewRevision) return;
    if (!item) {
      $('empty').hidden = false;
      $('viewLabel').textContent = '';
      $('opacityControl').hidden = true;
      $('opacity').disabled = true;
      $('viewerError').hidden = true;
      if (viewer) await viewer.loadVolumes([]);
      return;
    }
    const file = item.file || new File([outputs[item.outputName]], item.outputName);
    const lesion = item.lesion || (item.lesionOutputName ? new File([outputs[item.lesionOutputName]], item.lesionOutputName) : null);
    $('empty').hidden = true;
    const edited = lesionEdited && item.lesionOutputName ? ' (edited)' : '';
    $('viewLabel').textContent = lesion ? `${file.name} + ${lesion.name}${edited}` : file.name;
    $('opacityControl').hidden = !lesion;
    $('opacity').disabled = !lesion;
    try {
      const nv = await getViewer();
      if (revision !== viewRevision) return;
      const volumes = [{ url: file, name: file.name }];
      if (lesion) {
        volumes.push({
          url: lesion,
          name: lesion.name,
          colormap: 'red',
          opacity: Number($('opacity').value) / 100,
        });
      }
      await nv.loadVolumes(volumes);
      if (revision === viewRevision) $('viewerError').hidden = true;
    } catch (error) {
      if (revision !== viewRevision) return;
      $('viewerError').hidden = false;
      $('viewerError').textContent = `Viewer unavailable: ${error.message}`;
    }
  };
  viewTask = viewTask.then(display, display);
  return viewTask;
}

function niftiParts(name) {
  const match = name.match(/^(.*?)(\.nii(?:\.gz)?)$/i);
  return match ? { stem: match[1], extension: match[2].toLowerCase() } : null;
}

function prefixed(prefix, name) {
  const parts = niftiParts(name);
  return parts ? `${prefix}${parts.stem}${parts.extension}` : '';
}

function outputLabel(name) {
  if (name === prefixed('w', inputs.primary.name)) return 'Normalized primary scan';
  if (name === prefixed('wb', inputs.primary.name)) return 'Normalized brain-extracted primary scan';
  if (name === prefixed('wbt1', inputs.primary.name)) return 'Normalized brain-extracted synthetic T1';
  if (name === prefixed('t1', inputs.primary.name)) return 'Native-space synthetic T1';
  if (inputs.pathological && name === prefixed('w', inputs.pathological.name)) return 'Normalized pathological modality';
  return name;
}

function rebuildViewItems(preferred) {
  const selected = preferred || $('viewSelect').value;
  const items = new Map();
  if (inputs.primary) {
    items.set('input:primary', {
      label: 'Input · primary scan',
      file: inputs.primary,
      lesion: inputs.pathological ? null : inputs.lesion,
    });
  }
  if (inputs.pathological) {
    items.set('input:pathological', {
      label: 'Input · pathological modality',
      file: inputs.pathological,
      lesion: inputs.lesion,
    });
  }
  if (outputs) {
    const normalizedLesionName = lesionOutputName();
    for (const name of Object.keys(outputs)) {
      if (!/\.nii(?:\.gz)?$/i.test(name) || name === normalizedLesionName) continue;
      const nativeSynthetic = name === prefixed('t1', inputs.primary.name);
      items.set(`output:${name}`, {
        label: `Output · ${outputLabel(name)}`,
        lesion: nativeSynthetic ? (inputs.pathological ? null : inputs.lesion) : null,
        lesionOutputName: nativeSynthetic ? null : normalizedLesionName,
        outputName: name,
      });
    }
  }
  viewItems = items;
  $('viewSelect').replaceChildren(...Array.from(items, ([value, item]) => new Option(item.label, value)));
  const next = items.has(selected) ? selected : items.keys().next().value;
  if (next) $('viewSelect').value = next;
  updateResultActions();
  void show(items.get(next));
}

function lesionOutputName() {
  const name = inputs.lesion ? prefixed('w', inputs.lesion.name) : '';
  return name && outputs?.[name] ? name : null;
}

function updateResultActions() {
  const item = viewItems.get($('viewSelect').value);
  const editing = Boolean(maskEditor) && maskEditor.session.state !== 'idle';
  $('viewSelect').disabled = busy || editing || viewItems.size === 0;
  $('downloadSelected').disabled = busy || editing || !item?.outputName;
  $('editLesion').disabled = busy || editing || !lesionOutputName();
  $('opacity').disabled = editing || $('opacityControl').hidden;
}

function download(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearResults() {
  zipTask?.();
  zipTask = null;
  outputs = null;
  lesionEdited = false;
  if (maskEditor && maskEditor.session.state !== 'idle') {
    viewTask = viewTask.then(() => maskEditor.cancel(), () => maskEditor.cancel());
  }
  $('results').open = false;
  $('download').disabled = true;
  $('progress').value = 0;
  $('elapsed').textContent = '';
}

async function inspectInput(file) {
  if (!/\.nii(?:\.gz)?$/i.test(file.name)) throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
  const volume = readVolume(await file.arrayBuffer());
  return { file, volume };
}

function commitInput(slot, { file, volume }) {
  inputs[slot] = file;
  fileFields[slot].setHasFiles(true);
  fileFields[slot].setText(file.name);
  const information = $(`${slot}Info`);
  information.hidden = false;
  information.textContent = `${volume.dims.join(' × ')} voxels`;
  const clear = slot === 'lesion' ? $('clearLesion') : slot === 'pathological' ? $('clearPathological') : null;
  if (clear) clear.hidden = false;
  clearResults();
  rebuildViewItems(`input:${slot}`);
  $('runButton').disabled = busy || !inputs.primary;
}

async function importScans(slot, filesPromise) {
  exampleControl.cancel();
  if (busy) return;
  const controller = new AbortController();
  importAbort = controller;
  inputs[slot] = null;
  fileFields[slot].setHasFiles(false);
  fileFields[slot].setText(slot === 'primary' ? 'Drop primary NIfTI or DICOM files' : slot === 'lesion' ? 'Drop a binary lesion map' : 'Drop pathological modality files');
  $(`${slot}Info`).hidden = true;
  if (slot === 'lesion') $('clearLesion').hidden = true;
  if (slot === 'pathological') $('clearPathological').hidden = true;
  clearResults();
  rebuildViewItems();
  setBusy(true);
  setStatus('Reading images · converting DICOM if needed…');
  try {
    const files = await filesPromise;
    const images = await readImageFiles(files, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (images.length !== 1) throw new Error('Choose one NIfTI image or one complete DICOM series for this slot.');
    const inspected = await inspectInput(images[0]);
    controller.signal.throwIfAborted();
    commitInput(slot, inspected);
    setStatus(`${slot === 'primary' ? 'Primary scan' : slot === 'lesion' ? 'Lesion map' : 'Pathological modality'} loaded · ${images[0].name}`);
  } catch (error) {
    if (!controller.signal.aborted) setStatus(error.message, true);
  } finally {
    if (importAbort === controller) {
      importAbort = null;
      setBusy(false);
    }
  }
}

for (const [slot, field] of Object.entries(fileFields)) {
  field.onFiles((files) => importScans(slot, files));
}

const exampleControl = createExampleSelector({
  examples,
  onLoad: async (example, { fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    setBusy(true);
    try {
      const inspected = {};
      for (const [index, file] of files.entries()) {
        inspected[example.files[index].role] = await inspectInput(file);
        assertCurrent();
      }
      inputs = { primary: null, lesion: null, pathological: null };
      for (const [slot, field] of Object.entries(fileFields)) {
        field.setHasFiles(false);
        field.setText(slot === 'primary' ? 'Drop primary NIfTI or DICOM files' : slot === 'lesion' ? 'Drop a binary lesion map' : 'Drop pathological modality files');
        $(`${slot}Info`).hidden = true;
      }
      $('clearLesion').hidden = true;
      $('clearPathological').hidden = true;
      for (const slot of ['primary', 'lesion', 'pathological']) {
        if (inspected[slot]) commitInput(slot, inspected[slot]);
      }
      $('ct').checked = example.id === 'ct-only';
      rebuildViewItems('input:primary');
      $('progress').value = 0;
    } finally {
      setBusy(false);
    }
  },
  onStatus: setStatus,
});
exampleControl.select.id = 'tutorial';
exampleControl.querySelector('label').htmlFor = 'tutorial';
$('exampleControl').replaceWith(exampleControl);


function clearOptionalInput(slot) {
  inputs[slot] = null;
  fileFields[slot].setHasFiles(false);
  fileFields[slot].setText(slot === 'lesion' ? 'Drop a binary lesion map' : 'Drop pathological modality files');
  $(`${slot}Info`).hidden = true;
  $(slot === 'lesion' ? 'clearLesion' : 'clearPathological').hidden = true;
  $('tutorial').value = '';
  clearResults();
  rebuildViewItems('input:primary');
  setStatus(`${slot === 'lesion' ? 'Lesion map' : 'Pathological modality'} removed`);
}

$('clearLesion').onclick = () => clearOptionalInput('lesion');
$('clearPathological').onclick = () => clearOptionalInput('pathological');

$('viewSelect').onchange = () => {
  updateResultActions();
  void show(viewItems.get($('viewSelect').value));
};

async function normalize({
  scanInputs = inputs,
  settings = { ct: $('ct').checked, keepSynth: $('keepSynth').checked, synthsrBackend: $('synthsrBackend').value, brainExtractor: $('brainExtractor').value, normalization: $('normalization').value },
  signal,
  progress = () => {},
} = {}) {
  if (!scanInputs.primary) throw new Error('Choose a primary image.');
  if (busy) throw new Error('Wait for the current operation to finish.');
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  processingAbort = controller;
  clearResults();
  rebuildViewItems('input:primary');
  setBusy(true);
  technicalLog.console.clear();
  setStatus('Preparing normalization…');
  $('progress').value = 0;
  started = performance.now();
  timer = setInterval(() => {
    $('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`;
  }, 1000);
  const stageRanges = {
    'pathological-registration': [0, 0.1],
    synthsr: [0.1, 0.4],
    mindgrab: [0.5, 0.2],
    synthstrip: [0.5, 0.2],
    registration: [0.7, 0.25],
    resampling: [0.95, 0.05],
    complete: [1, 0],
  };
  const stageLabels = {
    'pathological-registration': 'Aligning pathological modality to primary scan…',
    synthsr: 'Synthesizing T1…',
    mindgrab: 'Extracting brain with MindGrab…',
    synthstrip: 'Extracting brain with SynthStrip…',
    registration: `Registering to MNI with ${settings.normalization === 'greedy' ? 'Greedy' : 'ANTs'}…`,
    resampling: 'Warping input images…',
  };
  try {
    const data = await new Promise((resolve, reject) => {
      const active = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker = active;
      let closed = false;
      const finish = (error, data) => {
        if (closed) return;
        closed = true;
        controller.signal.removeEventListener('abort', cancel);
        active.terminate();
        if (worker === active) worker = null;
        if (error) reject(error);
        else resolve(data);
      };
      const cancel = () => finish(controller.signal.reason);
      controller.signal.addEventListener('abort', cancel, { once: true });
      active.onmessage = ({ data }) => {
        if (closed) return;
        if (data.type === 'log') technicalLog.log(data.message);
        else if (data.type === 'error') finish(new Error(data.message));
        else if (data.type === 'progress') {
          const [offset, span] = stageRanges[data.stage] || [0, 0];
          const value = data.value === null ? undefined : offset + span * data.value;
          if (value !== undefined) $('progress').value = value;
          const message = data.message || stageLabels[data.stage] || data.stage;
          setStatus(message);
          progress({ message, value });
        } else if (data.type === 'result') finish(null, data);
      };
      active.onerror = (event) => finish(new Error(event.message ? `Processing failed: ${event.message}` : 'Could not load the processing worker.'));
      active.onmessageerror = () => finish(new Error('The processing worker returned unreadable data.'));
      active.postMessage({
        input: scanInputs.primary,
        lesion: scanInputs.lesion,
        pathological: scanInputs.pathological,
        ...settings,
        modelBase: import.meta.env.VITE_SYNCRO_MODEL_BASE,
        mindgrabAssetPath: new URL('mindgrab/', base).href,
        templateURL: templateAsset.url,
        greedyURL: new URL('greedy-wasm/greedy_rs_wasm.js', base).href,
        registrationURL: new URL('registration/syncro-registration.mjs', base).href,
      });
    });
    controller.signal.throwIfAborted();
    outputs = data.outputs;
    $('progress').value = 1;
    $('results').open = true;
    rebuildViewItems(`output:${prefixed('w', scanInputs.primary.name)}`);
    await viewTask;
    controller.signal.throwIfAborted();
    setStatus('Normalization complete · review the MNI-space outputs');
    const roles = new Map([
      [prefixed('w', scanInputs.primary.name), 'normalized-primary'],
      [prefixed('wb', scanInputs.primary.name), 'normalized-brain'],
      [prefixed('wbt1', scanInputs.primary.name), 'synthetic-brain'],
      [prefixed('t1', scanInputs.primary.name), 'native-synthetic'],
      ['provenance.json', 'details'],
      ...(scanInputs.lesion ? [[prefixed('w', scanInputs.lesion.name), 'lesion']] : []),
      ...(scanInputs.pathological ? [[prefixed('w', scanInputs.pathological.name), 'pathological']] : []),
    ]);
    return {
      artifacts: Object.entries(data.outputs).map(([name, bytes]) => {
        const role = roles.get(name);
        if (!role) throw new Error(`Normalization returned an unexpected output: ${name}`);
        return { role, file: new File([bytes], name) };
      }),
      provenance: data.provenance,
    };
  } catch (error) {
    clearResults();
    $('inputSection').open = true;
    setStatus(controller.signal.aborted ? 'Processing cancelled' : error.message, !controller.signal.aborted);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (processingAbort === controller) processingAbort = null;
    setBusy(false);
  }
}

$('runButton').onclick = () => {
  if (!inputs.primary || busy) return;
  void normalize().catch(() => {});
};

$('cancel').onclick = () => {
  importAbort?.abort();
  importAbort = null;
  exampleControl.cancel();
  $('tutorial').value = '';
  if (processingAbort) {
    processingAbort.abort();
    return;
  }
  setBusy(false);
  setStatus('Processing cancelled');
  $('progress').value = 0;
  $('elapsed').textContent = '';
};

$('opacity').oninput = () => {
  $('opacityValue').textContent = `${$('opacity').value}%`;
  if (viewer?.volumes.length > 1) {
    viewer.volumes[1].opacity = Number($('opacity').value) / 100;
    viewer.updateGLVolume();
  }
};

$('downloadSelected').onclick = () => {
  const item = viewItems.get($('viewSelect').value);
  if (item?.outputName) download(outputs[item.outputName], item.outputName);
};

$('editLesion').onclick = async () => {
  const name = lesionOutputName();
  if (!name || busy) return;
  const primary = `output:${prefixed('w', inputs.primary.name)}`;
  $('viewSelect').value = primary;
  $('editLesion').disabled = true;
  await show(viewItems.get(primary));
  if (lesionOutputName() !== name) return;
  try {
    await maskEditor.start({ stage: name, file: new File([outputs[name]], name), label: 'normalized lesion', overlayIndex: 1 });
  } catch (error) {
    setStatus(`Could not edit the lesion: ${error.message}`, true);
  }
  updateResultActions();
};

$('download').onclick = () => {
  if (!outputs || zipTask) return;
  $('download').disabled = true;
  setStatus('Preparing result archive…');
  const cancel = zip(outputs, { level: 1 }, (error, bytes) => {
    if (zipTask !== cancel) return;
    zipTask = null;
    $('download').disabled = busy || !outputs;
    if (error) setStatus(`Could not create result archive: ${error.message}`, true);
    else {
      download(bytes, 'syncro-results.zip', 'application/zip');
      setStatus('Result archive ready');
    }
  });
  zipTask = cancel;
};

rebuildViewItems();
window.addEventListener('pagehide', () => {
  importAbort?.abort();
  processingAbort?.abort();
  exampleControl.cancel();
  worker?.terminate();
  zipTask?.();
  clearInterval(timer);
});


registerAppAutomation({
  app: 'syncro',
  convertDicom: runDcm2niix,
  operations: {
    normalize: async ({ inputs: supplied, parameters, signal, progress }) => {
      signal.throwIfAborted();
      if (busy) throw new Error('Wait for the current operation to finish.');
      exampleControl.cancel();
      clearResults();
      setBusy(true);
      try {
        inputs = { primary: null, lesion: null, pathological: null };
        for (const slot of ['primary', 'lesion', 'pathological']) {
          if (supplied[slot][0]) commitInput(slot, await inspectInput(supplied[slot][0]));
          else {
            fileFields[slot].setHasFiles(false);
            $(`${slot}Info`).hidden = true;
            if (slot !== 'primary') $(slot === 'lesion' ? 'clearLesion' : 'clearPathological').hidden = true;
          }
          signal.throwIfAborted();
        }
        $('ct').checked = parameters.ct;
        $('keepSynth').checked = parameters.keepSynth;
        $('synthsrBackend').value = parameters.synthsrBackend;
        $('brainExtractor').value = parameters.brainExtractor;
        $('normalization').value = parameters.normalization;
      } finally {
        setBusy(false);
      }
      return normalize({ scanInputs: { ...inputs }, settings: parameters, signal, progress });
    },
  },
});
