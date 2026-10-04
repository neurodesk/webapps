import NiiVue, { lookupColorMap, SLICE_TYPE } from '@niivue/niivue';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  ProgressManager,
  bindFileDrop,
  bindInfoTooltips,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createMaskEditor,
  createResultList,
  createViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import {
  createFloat32Nifti,
  decodeNiftiBuffer,
  downloadBlob,
  downloadFile,
  extractNiftiHeader,
  readNiftiFrames,
} from '@neurodesk/webapp-components/file-io';
import { readImageFiles, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import { registerAppAutomation, createNiivueAdapter } from '@neurodesk/webapp-components/automation';
import { curvesCsv, detectCarotids, meanFrames, splitSeries } from './carotid.js';
import { flowChartSvg } from './chart.js';
import { APP, assignSeries, stem } from './config.js';
import { labelFiles, niftiFile, resultRows, withEditedLabels } from './outputs.js';
import examples from '../examples.json';
import './styles.css';

const $ = (id) => document.getElementById(id);
const progress = new ProgressManager();
const geometryFields = ['tiltLimit', 'posterior', 'anterior', 'lateral', 'midline', 'minSeparation'];

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
bindInfoTooltips(document);
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
  return [channel(map.R), channel(map.G), channel(map.B)];
}
for (const side of Object.values(SIDES)) {
  side.rgb = colormapMiddle(side.colormap);
  side.color = `rgb(${side.rgb.join(' ')})`;
}

const viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
// The label map and its drawing take each side's overlay colour: 1 is left, 2 is right.
const LABEL_COLORMAP = viewer.addColormap('carotidLabels', {
  R: [0, SIDES.left.rgb[0], SIDES.right.rgb[0]],
  G: [0, SIDES.left.rgb[1], SIDES.right.rgb[1]],
  B: [0, SIDES.left.rgb[2], SIDES.right.rgb[2]],
  A: [0, 255, 255],
  I: [0, 1, 2],
});
const editor = createMaskEditor({
  nv: viewer,
  labelNames: { 1: 'Left carotid', 2: 'Right carotid' },
  onApply: applyLabelEdit,
  onCancel: () => {
    results.setEditingEnabled(true);
    // A load or run that cancelled the session redraws the viewer itself.
    if (busy) return;
    status('Edits discarded');
    void showImages().catch((error) => status(error.message, true));
  },
  onError: (_stage, error) => status(error instanceof Error ? error.message : String(error), true),
});
toolbar.after(editor);
editor.addEventListener('nd-mask-edit-start', ({ detail }) => status(detail.message));
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

// The status line keeps one short sentence; the full message goes to the technical log.
function statusLine(message) {
  if (message.length <= 90) return message;
  const first = message.match(/^.*?[.;](?=\s)/)?.[0];
  return first && first.length <= 90 ? first : `${message.slice(0, 88).trimEnd()}…`;
}

function status(message, error = false) {
  progress.setText(statusLine(message));
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function refreshActions() {
  $('runButton').disabled = busy || !series || !ready;
  $('saveButton').disabled = busy || !result;
}

function setBusy(value) {
  busy = value;
  for (const id of ['imageInput', 'candidatePercentile', 'headPercentile', 'venc', ...geometryFields]) $(id).disabled = value;
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

function baseImage(state) {
  return state.result && state.background === 'variability' ? state.result.files.variability : state.series.amplitudeFile;
}

/** The chosen background under both carotids. Takes state explicitly so a failed load can
 *  redraw the previous inputs. */
async function showImages(state = { series, result, background }) {
  const base = baseImage(state);
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
  progress.setProgress(0);
  $('qcSummary').hidden = true;
}

async function loadFiles(files, { signal, assertCurrent = () => {}, label, chosen } = {}) {
  if (loading) throw new Error('A series is still loading. Wait or cancel, then retry.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin('Reading the series…');
  status('Reading the series…');
  try {
    const images = await readImageFiles(await files, { signal: controller.signal });
    controller.signal.throwIfAborted();
    assertCurrent();
    const next = await readSeries(chosen ?? assignSeries(images));
    controller.signal.throwIfAborted();
    assertCurrent();
    try {
      await editor.cancel();
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
    progress.stopTimer();
    progress.setCancellable(false);
    progress.setProgress(0);
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
    if (!result || busy || editor.session.state !== 'idle') return;
    background = stage;
    void showImages().catch((error) => status(error.message, true));
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
  onEdit: () => { void editLabels(); },
});

async function editLabels() {
  if (!result || busy) return;
  results.setEditingEnabled(false);
  const base = baseImage({ series, result, background });
  const mask = result.files.mask;
  try {
    await viewer.loadVolumes([
      { url: base, name: base.name },
      { url: mask, name: mask.name, colormap: LABEL_COLORMAP, calMin: 0, calMax: 2, opacity: overlayOpacity, isColorbarVisible: false },
    ]);
    const opened = await editor.start({ stage: 'mask', file: mask, label: 'Carotid labels', overlayIndex: 1, colormap: LABEL_COLORMAP });
    if (!opened) results.setEditingEnabled(true);
  } catch (error) {
    results.setEditingEnabled(true);
    status(error instanceof Error ? error.message : String(error), true);
    await showImages().catch(() => {});
  }
}

async function applyLabelEdit(_stage, file, { original }) {
  results.setEditingEnabled(true);
  const edited = result;
  const labels = (await readVolume(file)).data;
  if (result !== edited) return;
  result = withEditedLabels(result, file, labels, original);
  results.render(resultRows(result));
  await showImages();
  status('Carotid labels edited · curves and metrics keep the detected vessels');
}

toolbar.addEventListener('nd-overlay-change', ({ detail }) => {
  overlayOpacity = detail.value;
  if (!result || editor.session.state !== 'idle') return;
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

function readGeometry() {
  const values = {};
  for (const id of geometryFields) {
    const input = $(id);
    if (!input.value.trim() || !input.checkValidity()) {
      $('advancedSettings').open = true;
      input.focus();
      throw new Error(`${input.labels[0].firstChild.textContent.trim()} must be ${input.min} to ${input.max}, in steps of ${input.step}.`);
    }
    values[id] = Number(input.value);
  }
  if (values.midline >= values.lateral) {
    $('advancedSettings').open = true;
    $('midline').focus();
    throw new Error('Midline exclusion must be smaller than the lateral extent.');
  }
  return values;
}

function renderOutputs() {
  const qc = result.found.qc;
  $('qcSummary').hidden = !qc;
  if (qc) {
    const reasons = [];
    if (qc.tiltAtEdge) reasons.push('tilt at search limit');
    if (Math.abs(qc.peakLag) > 1) reasons.push('peaks differ by more than one frame');
    if (qc.pairOffcentre > 0.3) reasons.push('pair off centre');
    if (qc.pairVshift > 0.3) reasons.push('pair offset');
    $('qcSummary').textContent = `Tilt ${qc.tiltDegrees.toFixed(1)}° · ${reasons.length ? `Review: ${reasons.join('; ')}` : 'No automatic QC flags'}`;
    $('qcSummary').className = `nd-message ${qc.flag ? 'warning' : 'info'}`;
    log.log(`Quality checks: ${JSON.stringify(qc)}; static baseline ${result.found.baseline}`);
  }
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
  results.render(resultRows(result));
}

async function runDetection({ options: explicitOptions, signal, throwOnError = false } = {}) {
  signal?.throwIfAborted();
  if (!series || busy) {
    if (throwOnError) throw new Error('Load a series and wait for processing to finish before detecting carotids.');
    return;
  }
  const source = series;
  let options;
  try {
    // Validate while the fields are still enabled, so the one at fault can take focus.
    options = explicitOptions ?? {
      candidatePercentile: readSetting('candidatePercentile', 50, 100),
      headPercentile: readSetting('headPercentile', 0, 100),
      venc: readVenc(),
      ...readGeometry(),
    };
  } catch (error) {
    status(error.message, true);
    if (throwOnError) throw error;
    return;
  }
  setBusy(true);
  await editor.cancel();
  clearOutputs();
  progress.begin('Detecting carotids…', { cancellable: false });
  status('Detecting carotids…');
  const started = performance.now();
  try {
    // Let the status paint before the synchronous detection.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    signal?.throwIfAborted();
    const found = detectCarotids(source, options);
    result = {
      found,
      source,
      files: {
        ...labelFiles(found.mask, source),
        variability: niftiFile(createFloat32Nifti(found.variability, source.headerBytes), `${stem(source.name)}_phase_sd.nii`),
      },
    };
    background = 'mask';
    await showImages();
    signal?.throwIfAborted();
    renderOutputs();
    $('outputSection').open = true;
    progress.end('Detection complete');
    const { left, right } = found;
    const summary = found.method === 'velocity'
      ? `left ${Math.round(left.mean)} ml/min, right ${Math.round(right.mean)} ml/min`
      : `left ${left.pixels.length} px, right ${right.pixels.length} px`;
    status(`Both carotids found · ${summary} · systolic peak at frame ${right.peakFrame + 1}`);
    if (found.qc?.flag) status('Review flagged carotid pair · see quality checks in Flow curves');
    log.log(`Detection took ${Math.round(performance.now() - started)} ms`);
    return result;
  } catch (error) {
    // Drop the previous run's overlays with its numbers: they described other settings.
    clearOutputs();
    progress.end('Detection failed', { success: false });
    await showImages().catch(() => {});
    status(error instanceof Error ? error.message : String(error), true);
    if (throwOnError) throw error;
  } finally {
    setBusy(false);
  }
}
$('runButton').onclick = () => { void runDetection(); };

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
const initialized = init();

function measurements(found) {
  return {
    method: found.method,
    ...(found.qc ? { qc: found.qc, baseline: found.baseline, arterialSign: found.arterialSign } : {}),
    curveUnit: found.method === 'velocity' ? 'ml/min' : 'a.u.',
    vessels: Object.fromEntries(['left', 'right'].map(side => {
      const vessel = found[side];
      return [side, { areaMm2: vessel.areaMm2, pixelCount: vessel.pixels.length, mean: vessel.mean,
        peak: vessel.peak, peakFrame: vessel.peakFrame, pulsatility: vessel.pulsatility, curve: Array.from(vessel.curve) }];
    })),
  };
}

async function detectOperation({ inputs, parameters, signal, progress }) {
  await initialized;
  if (!ready) throw new Error('Carotid Flow viewer could not initialize.');
  const chosen = inputs.series ? { combined: inputs.series[0] } : { amplitude: inputs.amplitude[0], phase: inputs.phase[0] };
  progress('Reading the phase-contrast series');
  await loadFiles(Object.values(chosen), { signal, chosen });
  progress('Detecting carotids');
  const completed = await runDetection({ options: parameters, signal, throwOnError: true });
  const csv = new File([curvesCsv(completed.found)], `${stem(completed.source.name)}_carotid_curves.csv`, { type: 'text/csv' });
  return {
    artifacts: [
      { role: 'labels', file: completed.files.mask },
      { role: 'variability', file: completed.files.variability },
      { role: 'curves', file: csv },
    ],
    measurements: measurements(completed.found),
    provenance: { method: completed.found.method, parameters, phases: completed.source.phases, affine: completed.source.affine },
  };
}

const automation = registerAppAutomation({ app: APP.id, convertDicom: runDcm2niix,
  operations: { 'detect-combined': detectOperation, 'detect-pair': detectOperation },
});
automation.registerViewer('main', createNiivueAdapter(viewer, {
  tabs: {
    list: () => result ? ['mask', 'variability'].map(id => ({ id, label: id === 'mask' ? 'Carotid labels' : 'Temporal variability', active: background === id })) : [],
    async select(id) { background = id; await showImages(); },
  },
  regions: { list: () => result ? measurements(result.found).vessels : {} },
}));

export default Object.freeze({ APP, SIDES });
