import NiiVue, { lookupColorMap, SLICE_TYPE } from '@niivue/niivue';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  bindFileDrop,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createResultList,
  createViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import {
  createFloat32Nifti,
  createUint8Nifti,
  decodeNiftiBuffer,
  downloadBlob,
  downloadFile,
  extractNiftiHeader,
  readNiftiFrames,
} from '@neurodesk/webapp-components/file-io';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { curvesCsv, detectCarotids, meanFrames, splitSeries } from './carotid.js';
import { flowChartSvg } from './chart.js';
import { APP, assignSeries, stem } from './config.js';
import examples from '../examples.json';
import './styles.css';

const $ = (id) => document.getElementById(id);

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'Carotid Flow',
  subtitle: 'Carotid flow curves from phase-contrast MRI, in your browser',
  mark: 'C',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

const toolbar = createViewerToolbar({ views: false, window: false, colormap: false, download: false, screenshot: false });
$('viewer').prepend(toolbar);
const log = createConsole({ id: 'technicalLog' });
$('viewer').append(log);
const info = createInfoDialog({ id: 'infoDialog' });
$('aboutBtn').onclick = () => info.open('About Carotid Flow', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

// Each carotid is a binary overlay windowed 0.5–1.5, so its pixels take the colour at the middle
// of the colormap. The chart and the table read that same colour, so they cannot disagree.
const SIDES = {
  left: { label: 'Left', colormap: 'cool' },
  right: { label: 'Right', colormap: 'warm' },
};
function colormapMiddle(name) {
  const map = lookupColorMap(name);
  const position = map.I.at(-1) / 2;
  const high = Math.max(1, map.I.findIndex((stop) => stop >= position));
  const low = high - 1;
  const mix = (position - map.I[low]) / (map.I[high] - map.I[low]);
  const channel = (values) => Math.round(values[low] + (values[high] - values[low]) * mix);
  return `rgb(${channel(map.R)} ${channel(map.G)} ${channel(map.B)})`;
}
for (const side of Object.values(SIDES)) side.color = colormapMiddle(side.colormap);

const viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
let ready = false;
let busy = false;
let loading = null;
let series = null;
let result = null;
let background = 'mask';
// The vessels are a few pixels each: start them strong, and keep the slider the one source.
toolbar.control('overlayOpacity').value = '0.8';
toolbar.control('overlayOpacityValue').textContent = '80%';
let overlayOpacity = 0.8;

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function refreshActions() {
  $('runButton').disabled = busy || !series || !ready;
  $('saveButton').disabled = busy || !result;
}

function setBusy(value) {
  busy = value;
  for (const id of ['imageInput', 'candidatePercentile', 'headPercentile', 'venc']) $(id).disabled = value;
  exampleControl.setDisabled(value);
  refreshActions();
}

/** One stored NIfTI, every frame, checked to be a single slice. */
async function readVolume(file) {
  const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
  const volume = readNiftiFrames(buffer);
  if (volume.dims[2] !== 1) {
    throw new Error(`${file.name} has ${volume.dims[2]} slices; Carotid Flow reads one gated slice.`);
  }
  return { ...volume, headerBytes: extractNiftiHeader(buffer) };
}

async function readSeries(chosen) {
  if (chosen.error) throw new Error(chosen.error);
  let volume;
  let split;
  if (chosen.combined) {
    volume = await readVolume(chosen.combined);
    split = splitSeries(volume.data, volume.dims[0] * volume.dims[1], volume.frames);
  } else {
    volume = await readVolume(chosen.amplitude);
    const phase = await readVolume(chosen.phase);
    if (phase.dims[0] !== volume.dims[0] || phase.dims[1] !== volume.dims[1] || phase.frames !== volume.frames) {
      throw new Error(`${chosen.amplitude.name} and ${chosen.phase.name} differ in size or frame count.`);
    }
    split = { phases: volume.frames, amplitude: volume.data, phase: phase.data };
  }
  const [nx, ny] = volume.dims;
  const name = (chosen.combined ?? chosen.amplitude).name;
  const meanAmplitude = Float32Array.from(meanFrames(split.amplitude, nx * ny, split.phases));
  return {
    ...split,
    name,
    nx,
    ny,
    affine: volume.header.affine.map((row) => Array.from(row)),
    voxelSize: volume.header.voxelSize,
    headerBytes: volume.headerBytes,
    amplitudeFile: niftiFile(createFloat32Nifti(meanAmplitude, volume.headerBytes), `${stem(name)}_mean_amplitude.nii`),
  };
}

function niftiFile(buffer, name) {
  return new File([buffer], name, { type: 'application/octet-stream' });
}

/** The chosen background under both carotids. Takes state explicitly so a failed load can
 *  redraw the previous inputs. */
async function showImages(state = { series, result, background }) {
  const base = state.result && state.background === 'variability' ? state.result.files.variability : state.series.amplitudeFile;
  const volumes = [{ url: base, name: base.name }];
  if (state.result) {
    for (const side of ['left', 'right']) {
      const file = state.result.files[side];
      volumes.push({ url: file, name: file.name, colormap: SIDES[side].colormap, calMin: 0.5, calMax: 1.5, opacity: overlayOpacity, isColorbarVisible: false });
    }
  }
  await viewer.loadVolumes(volumes);
  $('emptyState').hidden = true;
  const variability = state.result?.found.method === 'velocity' ? 'VELOCITY TEMPORAL SD' : 'PHASE TEMPORAL SD';
  $('imageLabel').textContent = state.result && state.background === 'variability' ? variability : 'MEAN AMPLITUDE';
}

function clearOutputs() {
  result = null;
  background = 'mask';
  $('flowChart').replaceChildren();
  $('metricsTable').hidden = true;
  $('metricsBody').replaceChildren();
  results.render();
  $('outputSection').open = false;
  $('progress').value = 0;
}

async function loadFiles(files, { signal, assertCurrent = () => {}, label } = {}) {
  if (loading) throw new Error('A series is still loading. Wait or cancel, then retry.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  loading = controller;
  setBusy(true);
  $('cancelButton').hidden = false;
  status('Reading the series…');
  try {
    const images = await readImageFiles(await files, { signal: controller.signal });
    controller.signal.throwIfAborted();
    assertCurrent();
    const next = await readSeries(assignSeries(images));
    controller.signal.throwIfAborted();
    assertCurrent();
    try {
      await showImages({ series: next, result: null, background: 'mask' });
      controller.signal.throwIfAborted();
      assertCurrent();
    } catch (error) {
      // NiiVue has already replaced its volumes; put the committed input back.
      if (series) await showImages().catch(() => {});
      throw error;
    }
    series = next;
    clearOutputs();
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${series.name} · ${series.nx} × ${series.ny} · ${series.phases} cardiac frames`;
    $('dropZone').classList.add('has-files');
    status(`${label ?? series.name} loaded · detect the carotids when ready`);
  } finally {
    signal?.removeEventListener('abort', abort);
    loading = null;
    $('cancelButton').hidden = true;
    setBusy(false);
  }
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch((error) => status(
    error.name === 'AbortError' ? 'Loading cancelled' : error.message,
    error.name !== 'AbortError',
  ));
}

$('imageInput').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($('dropZone'), importFiles);
$('cancelButton').onclick = () => {
  exampleControl.cancel();
  loading?.abort();
};

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (example, { signal, fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(files, { signal, assertCurrent, label: example.label });
  },
});
$('exampleControl').replaceWith(exampleControl);

const results = createResultList({
  element: $('resultList'),
  onView: (stage) => {
    if (!result || busy) return;
    background = stage;
    void showImages().catch((error) => status(error.message, true));
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

toolbar.addEventListener('nd-overlay-change', ({ detail }) => {
  overlayOpacity = detail.value;
  if (!result) return;
  for (const index of [1, 2]) void viewer.setVolume(index, { opacity: overlayOpacity });
});

function readSetting(id, low, high) {
  const value = Number($(id).value);
  if (!(value > low && value < high)) {
    $('advancedSettings').open = true;
    $(id).focus();
    throw new Error(`${$(id).labels[0].firstChild.textContent.trim()} must lie between ${low} and ${high}.`);
  }
  return value;
}

/** The VENC is optional: only raw ±4096 phase needs it. */
function readVenc() {
  if (!$('venc').value.trim()) return undefined;
  return readSetting('venc', 0, 1000);
}

// What a curve holds depends on the method the data chose.
const UNITS = {
  velocity: { axis: 'Flow (ml/min)', column: 'ml/min', digits: 0 },
  variability: { axis: 'Phase signal (a.u.)', column: 'a.u.', digits: 1 },
};

function renderOutputs() {
  const sides = ['left', 'right'];
  const unit = UNITS[result.found.method];
  $('flowChart').innerHTML = flowChartSvg(
    sides.map((side) => ({ values: result.found[side].curve, color: SIDES[side].color, label: `${SIDES[side].label} carotid` })),
    { xLabel: 'Cardiac frame', yLabel: unit.axis },
  );
  for (const [id, label] of [['meanHeader', 'Mean'], ['peakHeader', 'Peak']]) {
    $(id).replaceChildren(`${label} `, Object.assign(document.createElement('small'), { textContent: unit.column }));
  }
  $('metricsBody').replaceChildren(...sides.map((side) => {
    const vessel = result.found[side];
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const swatch = document.createElement('span');
    swatch.className = 'cf-swatch';
    swatch.style.background = SIDES[side].color;
    name.append(swatch, SIDES[side].label);
    const cells = [
      vessel.areaMm2.toFixed(1),
      vessel.mean.toFixed(unit.digits),
      `${vessel.peak.toFixed(unit.digits)} @ ${vessel.peakFrame + 1}`,
      vessel.pulsatility.toFixed(2),
    ].map((text) => Object.assign(document.createElement('td'), { textContent: text }));
    row.append(name, ...cells);
    return row;
  }));
  $('metricsTable').hidden = false;
  results.render({
    mask: { description: 'Carotid labels', file: result.files.mask },
    variability: { description: result.found.method === 'velocity' ? 'Velocity temporal SD' : 'Phase temporal SD', file: result.files.variability },
  });
}

$('runButton').onclick = async () => {
  if (!series || busy) return;
  const source = series;
  let options;
  try {
    // Validate while the fields are still enabled, so the one at fault can take focus.
    options = {
      candidatePercentile: readSetting('candidatePercentile', 50, 100),
      headPercentile: readSetting('headPercentile', 0, 100),
      venc: readVenc(),
    };
  } catch (error) {
    status(error.message, true);
    return;
  }
  setBusy(true);
  clearOutputs();
  status('Detecting carotids…');
  const started = performance.now();
  try {
    // Let the status paint before the synchronous detection.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    const found = detectCarotids(source, options);
    const base = stem(source.name);
    const perSide = (value) => found.mask.map((label) => (label === value ? 1 : 0));
    result = {
      found,
      source,
      files: {
        mask: niftiFile(createUint8Nifti(found.mask, source.headerBytes), `${base}_carotid_labels.nii`),
        variability: niftiFile(createFloat32Nifti(found.variability, source.headerBytes), `${base}_phase_sd.nii`),
        left: niftiFile(createUint8Nifti(perSide(1), source.headerBytes), `${base}_carotid_left.nii`),
        right: niftiFile(createUint8Nifti(perSide(2), source.headerBytes), `${base}_carotid_right.nii`),
      },
    };
    background = 'mask';
    await showImages();
    renderOutputs();
    $('outputSection').open = true;
    $('progress').value = 1;
    const { left, right } = found;
    const summary = found.method === 'velocity'
      ? `left ${Math.round(left.mean)} ml/min, right ${Math.round(right.mean)} ml/min`
      : `left ${left.pixels.length} px, right ${right.pixels.length} px`;
    status(`Both carotids found · ${summary} · systolic peak at frame ${right.peakFrame + 1} · ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    // Drop the previous run's overlays with its numbers: they described other settings.
    clearOutputs();
    await showImages().catch(() => {});
    status(error instanceof Error ? error.message : String(error), true);
  } finally {
    setBusy(false);
  }
};

$('saveButton').onclick = () => {
  if (!result) return;
  downloadBlob(new Blob([curvesCsv(result.found)], { type: 'text/csv' }), `${stem(result.source.name)}_carotid_curves.csv`);
};

async function init() {
  setBusy(true);
  try {
    await viewer.attachTo('gl1');
    viewer.sliceType = SLICE_TYPE.AXIAL;
    viewer.isColorbarVisible = false;
    // A crosshair through the centre of one slice covers the vessels it is meant to show.
    viewer.crosshairWidth = 0;
    viewer.addEventListener('locationChange', (event) => { $('location').textContent = event.detail?.string ?? ''; });
    ready = true;
    status('Ready · choose an example or drop a phase-contrast series');
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Visualization unavailable: ${error instanceof Error ? error.message : error}`;
  }
  setBusy(false);
}

window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  loading?.abort();
});
void init();

export default Object.freeze({ APP, SIDES });
