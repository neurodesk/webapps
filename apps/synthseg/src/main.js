import examples from '../examples.json';
import appPackage from '../package.json';
import { createRunState, summarizeLabels, registerAppAutomation, createNiivueAdapter } from '@neurodesk/webapp-components/automation';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  createResultList,
  bindFileDrop,
  bindInfoTooltips,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createMaskEditor,
  ProgressManager,
} from '@neurodesk/webapp-components/ui';
import { downloadBlob, downloadFile, readNifti } from '@neurodesk/webapp-components/file-io';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { readImageSeries, runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import manifest from '@neurodesk/synthseg/manifest';
import { fieldStrengthFromSidecar, parseNorms, selectReference, subjectFromSidecar } from '@neurodesk/synthseg/brainquant';
import { LABELS_ARTIFACT, TISSUES, TISSUE_ARTIFACT, TISSUE_NAMES, outputNames, outputStem, volumesCsv } from '@neurodesk/synthseg/results';
import { editedResult, gridOf, labelNames, labelsResult, looksLikeCt, sameGrid } from './logic.js';
import { legendEntries, rawVolumeRows, volumeReport } from './volume-report.js';
import freesurferLut from '@neurodesk/webapp-components/automation/freesurfer-lut';
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
const technicalLog = createConsole({ id: 'technicalLog' });
const progressManager = new ProgressManager({ cancelId: 'cancelBtn' });
$('viewer').append(technicalLog);
const runs = createRunState({ app: 'synthseg', appVersion: appPackage.version });
const info = createInfoDialog({ id: 'infoDialog' });
const layouts = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const toolbar = createViewerToolbar({
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
      $('volumeReport').hidden = true;
      viewer.sliceType = layouts[view.id];
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })).concat({ id: 'volumes', label: 'Volumes', hidden: true, onClick: () => showVolumes() }),
});
$('viewer').prepend(toolbar);
toolbar.control('overlayOpacity').id = 'opacity';
$('opacity').value = '0.6';
$('opacity').disabled = true;
toolbar.control('overlayOpacityValue').textContent = '60%';
const results = createResultList({
  element: $('resultList'),
  onView: (stage) => {
    if (outputFile(stage) && !busy) void view(stage);
  },
  onDownload: (stage) => {
    if (outputFile(stage) && !busy) downloadFile(outputFile(stage));
  },
  onEdit: () => void editLabels(),
});
const assetBase = import.meta.env.VITE_SYNTHSEG_ASSET_BASE || manifest.base_url;
const offGridNote = () => `The input is shown resampled to SynthSeg's ${provenance?.voxelSizeMm ?? 1} mm label grid.`;

const webgpu = Boolean(navigator.gpu);
let source,
  sourceGrid,
  labels = null,
  editor = null,
  provenance,
  worker,
  viewer,
  viewerReady,
  busy = false,
  memoryRecommendation = null;
let operation;
let viewRevision = 0;
let displayedStage = null;
let importedImages = [];
// The last run's soft volumes (mri_synthseg --vol columns, mm³) and whether it ran in fast mode.
let volumes = null;
let volumesFast = true;
let volumesVoxelSizeMm = 1;
const normsLoads = new Map();
// Scanner field strength in tesla from the DICOM header; null for NIfTI input.
let fieldStrengthT = null;
// The last run's GM, WM and CSF probability maps as Files, or null.
let tissues = null;
renderResults();

const outputFile = (stage) => (stage === 'labels' ? labels?.file : tissues?.[stage]);
function renderResults() {
  results.render({
    labels: labels ?? { description: 'FreeSurfer labels' },
    ...Object.fromEntries(TISSUES.map((tissue) => [tissue, { description: TISSUE_NAMES[tissue] }])),
  });
  const row = (stage) => $('resultList').querySelector(`[data-stage="${stage}"]`);
  row('labels').querySelector('.nd-download-btn').id = 'saveBtn';
  row('labels').querySelector('.nd-view-btn').id = 'viewResultBtn';
  for (const tissue of TISSUES) {
    row(tissue).querySelector('.nd-download-btn').id = `${tissue}SaveBtn`;
    row(tissue).querySelector('.nd-view-btn').id = `${tissue}ViewBtn`;
  }
  syncResultButtons();
}
function syncResultButtons() {
  $('saveBtn').disabled = busy || !labels;
  $('viewResultBtn').disabled = busy || !labels;
  for (const tissue of TISSUES) {
    $(`${tissue}SaveBtn`).disabled = busy || !tissues;
    $(`${tissue}ViewBtn`).disabled = busy || !tissues;
  }
}
const editing = () => Boolean(editor) && editor.session.state !== 'idle';
function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  technicalLog.log(message, error ? 'error' : 'info');
  runs.message(message);
}
function setBusy(value, cancellable = false) {
  busy = value;
  exampleControl.setDisabled(value);
  for (const id of ['imageInput', 'seriesSelect', 'mode', 'ct', 'age', 'sex', 'reference', 'robustFov', 'voxelSizeMm', 'downsampleButton'])
    $(id).disabled = value;
  $('processButton').disabled = value || !source || !webgpu;
  progressManager.setCancellable(value && cancellable);
  $('opacity').disabled = value || !labels || editing();
  syncResultButtons();
  results.setEditingEnabled(!value && !editing());
  $('reportBtn').disabled = value || runs.snapshot().state !== 'succeeded';
  $('volumesBtn').disabled = value || !volumes;
  if (!value) {
    progressManager.stopTimer();
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
    editor = createMaskEditor({
      nv: viewer,
      labelNames: labelNames(freesurferLut),
      onApply: async (_stage, file, { original }) => {
        if (labels?.file !== original) return;
        labels = editedResult(labels, file);
        renderResults();
        endEdit();
        await show('labels');
        status('Labels edited · Download saves the edited file');
      },
      onCancel: async () => {
        endEdit();
        if (!labels) return;
        await show('labels');
        status('Edits discarded · labels unchanged');
      },
      onError: (_stage, error) => status(`Editing failed: ${error.message}`, true),
    });
    editor.addEventListener('nd-mask-edit-end', endEdit);
    editor.addEventListener('nd-mask-edit-start', ({ detail }) => {
      status(sameGrid(sourceGrid, labels.grid) ? detail.message : `${detail.message} ${offGridNote()}`);
    });
    toolbar.after(editor);
    automation.registerViewer('main', createNiivueAdapter(viewer, {
      tabs: {
        list: () => [
          ...(source ? [{ id: 'original', label: 'Original', active: displayedStage === 'original' }] : []),
          ...(labels ? [{ id: 'labels', label: 'FreeSurfer labels', active: displayedStage === 'labels' }] : []),
          ...(tissues ? TISSUES.map((id) => ({ id, label: TISSUE_NAMES[id], active: displayedStage === id })) : []),
        ],
        select: id => view(id),
      },
      regions: { list: () => runs.snapshot().report?.measurements?.labels ?? [] },
    }));
    return viewer;
  })();
  return viewerReady;
}
// The drawing lives on volume 0's voxels, so off the input's grid the hidden labels are volume 0
// and the input is resampled onto them.
function stack(stage) {
  const input = { url: source, name: source.name };
  if (!labels) return { title: 'ORIGINAL IMAGE', volumes: [input], labelOverlay: false };
  const overlay = { url: labels.file, name: labels.file.name };
  if (stage === 'edit' && sameGrid(sourceGrid, labels.grid)) {
    return { title: 'ORIGINAL IMAGE · EDITING LABELS', volumes: [input], labelOverlay: false };
  }
  if (stage === 'edit') {
    return {
      title: `ORIGINAL IMAGE ON THE ${provenance?.voxelSizeMm ?? 1} MM LABEL GRID · EDITING LABELS`,
      volumes: [{ ...overlay, opacity: 0 }, input],
      labelOverlay: false,
    };
  }
  if (TISSUES.includes(stage) && tissues) {
    const map = { url: tissues[stage], name: tissues[stage].name, colormap: 'warm', calMin: 0.1, calMax: 1, isTransparentBelowCalMin: true };
    return {
      title: `ORIGINAL IMAGE · ${TISSUE_NAMES[stage].toUpperCase()}`,
      volumes: [input, { ...map, opacity: Number($('opacity').value) }],
      labelOverlay: false,
    };
  }
  const opacity = stage === 'labels' ? Number($('opacity').value) : 0;
  return {
    title: stage === 'labels' ? 'ORIGINAL IMAGE · FREESURFER LABELS' : 'ORIGINAL IMAGE',
    volumes: [input, { ...overlay, opacity }],
    labelOverlay: true,
  };
}
async function show(stage = labels ? 'labels' : 'original') {
  const revision = ++viewRevision;
  const { title, volumes, labelOverlay } = stack(stage);
  $('emptyState').hidden = true;
  $('imageLabel').textContent = title;
  try {
    const nv = await ensureViewer();
    if (revision !== viewRevision) return false;
    await nv.loadVolumes(volumes);
    if (revision !== viewRevision) return false;
    // Label names too, so the location bar reads e.g. "Left-Hippocampus".
    if (labelOverlay) await nv.setColormapLabel(1, freesurferLut);
    if (revision !== viewRevision) return false;
    displayedStage = stage;
    $('viewerError').hidden = true;
    return true;
  } catch (error) {
    if (revision !== viewRevision) return false;
    $('viewerError').hidden = false;
    $('viewerError').textContent =
      `Visualization unavailable: ${error.message}. Processing and NIfTI download remain available.`;
    return false;
  }
}
async function view(stage) {
  await editor?.cancel();
  await show(stage);
}
async function editLabels() {
  if (!labels || busy || editing()) return;
  const { file } = labels;
  results.setEditingEnabled(false);
  $('opacity').disabled = true;
  try {
    if (!await show('edit') || labels?.file !== file) throw new Error('the viewer could not show the labels');
    const colormap = viewer.addColormap('FreeSurferLabels', freesurferLut);
    if (!await editor.start({ stage: 'labels', file, label: 'FreeSurfer labels', overlayIndex: null, colormap })) endEdit();
  } catch (error) {
    endEdit();
    if (labels?.file === file) void show('labels');
    status(`Editing unavailable: ${error.message}`, true);
  }
}
function endEdit() {
  results.setEditingEnabled(!busy && !editing());
  $('opacity').disabled = busy || !labels || editing();
}
const volumesTab = () => toolbar.viewTabs.querySelector('[data-view="volumes"]');
function hideVolumes() {
  volumesTab().hidden = true;
  if (!$('volumeReport').hidden) {
    $('volumeReport').hidden = true;
    toolbar.setActive(Object.keys(layouts).find((id) => layouts[id] === viewer?.sliceType) ?? 'multiplanar');
  }
  $('volumeReport').replaceChildren();
}
function showVolumes() {
  if (!volumes) return;
  $('volumeReport').hidden = false;
  toolbar.setActive('volumes');
  void renderVolumes();
}
/** The subject the report compares against: the Age and Sex fields, blank meaning unknown. */
function subject() {
  const age = $('age').value === '' ? null : Number($('age').value);
  return {
    age: Number.isInteger(age) && age >= 0 && age <= 120 ? age : null,
    sex: $('sex').value || null,
  };
}
function setSubject({ age = null, sex = null } = {}, fromHeader = false) {
  $('age').value = age === null ? '' : String(age);
  $('sex').value = sex ?? '';
  $('subjectHint').hidden = !fromHeader || (age === null && sex === null);
}
/** A new image's field strength, which Auto reads; the Reference field returns to Auto. */
function setFieldStrength(value) {
  fieldStrengthT = value;
  $('reference').value = 'auto';
  showReferenceHint();
}
/** The reference norms the report uses: the Reference field, Auto deciding from the field strength, and the run's mode. */
function reference() {
  return selectReference($('reference').value, fieldStrengthT, volumesFast);
}
function showReferenceHint() {
  const { cohort } = reference();
  const hint = $('referenceHint');
  hint.hidden = !source || $('reference').value !== 'auto';
  hint.textContent = `Auto: ${$('reference').querySelector(`option[value="${cohort}"]`).textContent} · ${
    fieldStrengthT === null ? 'field strength unknown' : `scanner ${fieldStrengthT} T`}`;
}
// Each reference's norms are fetched once, when a report first needs them, and checked against the manifest.
function loadNorms(id) {
  if (!normsLoads.has(id)) {
    const pin = manifest.norms[id];
    const load = fetchModel({ url: pin.url, integrity: { bytes: pin.bytes, sha256: pin.sha256 } }, {
      requestFailureMessage: 'Could not download the reference volumes.',
    }).then((bytes) => parseNorms(JSON.parse(new TextDecoder().decode(bytes))));
    load.catch(() => normsLoads.delete(id));
    normsLoads.set(id, load);
  }
  return normsLoads.get(id);
}
/** The report as the JSON run report and automation record it, or why it is missing. */
async function reportSummary() {
  if (!volumes) return null;
  const used = subject();
  const selected = reference();
  const { version, url, sha256 } = manifest.norms[selected.id];
  const referenceRecord = { choice: $('reference').value, fieldStrengthT, reason: selected.reason };
  try {
    const norms = await loadNorms(selected.id);
    const { report } = volumeReport(norms, volumes, used, { reference: selected, voxelSizeMm: volumesVoxelSizeMm });
    return {
      norms: { id: selected.id, version, url, sha256 },
      reference: referenceRecord,
      subject: used,
      voxelSizeMm: volumesVoxelSizeMm,
      icvMm3: report.icvMm3,
      outsideReferenceAge: report.outsideReferenceAge,
      results: report.results,
    };
  } catch (error) {
    return { subject: used, reference: referenceRecord, unavailable: error.message };
  }
}
function element(tag, { className, text } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  node.append(...children);
  return node;
}
function svgElement(markup) {
  // The HTML parser puts <svg> in the SVG namespace; an XML parse without xmlns would not.
  return new DOMParser().parseFromString(markup, 'text/html').body.firstElementChild;
}
function renderTable(rows, raw = false) {
  const headings = raw ? ['Structure', 'Volume (mL)'] : ['Structure', 'Volume (mL)', 'Adjusted (mL)', 'z', 'Percentile', 'Flag'];
  const numeric = [false, true, true, true, true, false];
  const head = element('tr', {}, headings.map((text, index) => element('th', { text, className: numeric[index] ? 'nd-numeric' : '' })));
  const body = rows.map((row) => {
    const cells = raw ? [row.title, row.volumeMl] : [row.title, row.volumeMl, row.adjustedMl, row.z, row.percentile, row.flag];
    const line = element('tr', {}, cells.map((text, index) => element('td', { text, className: numeric[index] ? 'nd-numeric' : '' })));
    if (row.flag) line.dataset.flag = row.flag;
    return line;
  });
  const table = element('table', { className: 'nd-data-table' }, [element('thead', {}, [head]), element('tbody', {}, body)]);
  return element('div', { className: 'nd-table-scroll' }, [table]);
}
let renderRevision = 0;
async function renderVolumes() {
  const panel = $('volumeReport');
  if (!volumes || panel.hidden) return;
  const revision = ++renderRevision;
  const selected = reference();
  try {
    const norms = await loadNorms(selected.id);
    if (revision !== renderRevision || !volumes) return;
    const used = subject();
    const view = volumeReport(norms, volumes, used, { reference: selected, voxelSizeMm: volumesVoxelSizeMm });
    const lines = view.header.map((text) => element('p', { text }));
    lines.at(-1).className = 'nd-report-lead';
    const legend = element('ul', { className: 'nd-chart-legend' }, legendEntries(used.age !== null).map(({ label, svg }) => element('li', {}, [svgElement(svg), label])));
    const charts = element('div', { className: 'nd-chart-grid' }, view.charts.map((chart) => {
      const figure = element('figure', { className: 'nd-chart-figure' }, [element('figcaption', { text: chart.caption }), svgElement(chart.svg)]);
      if (chart.flagged) figure.dataset.flag = '';
      return figure;
    }));
    const notes = element('div', { className: 'nd-report-notes' }, view.footer.map((text) => element('p', { text })));
    panel.replaceChildren(...lines, legend, charts, renderTable(view.rows), notes);
  } catch (error) {
    if (revision !== renderRevision || !volumes) return;
    panel.replaceChildren(
      element('p', { className: 'nd-message error', text: `The population report is unavailable: ${error.message} The labels and raw volumes remain available.` }),
      renderTable(rawVolumeRows(volumes), true),
    );
  }
}
function subjectChanged() {
  $('subjectHint').hidden = true;
  void renderVolumes();
}
$('age').oninput = subjectChanged;
$('sex').onchange = subjectChanged;
bindInfoTooltips(document);
$('reference').onchange = () => {
  showReferenceHint();
  void renderVolumes();
};
function clearOutputs() {
  const cancelled = editor?.cancel();
  labels = null;
  tissues = null;
  provenance = null;
  volumes = null;
  renderResults();
  $('outputSection').open = false;
  $('reportBtn').disabled = true;
  $('volumesBtn').disabled = true;
  hideVolumes();
  return cancelled;
}
async function beginImport() {
  const run = runs.begin('loading');
  operation = run;
  source = null;
  memoryRecommendation = null;
  $('downsampleButton').hidden = true;
  $('voxelSizeMm').value = '1';
  progressManager.reset();
  ++viewRevision;
  const cancelled = clearOutputs();
  $('fileInfo').hidden = true;
  setBusy(true, true);
  await cancelled;
  return run;
}
async function load(file, signal, existingRun, sidecar = null) {
  if ((!existingRun && busy) || !file) return false;
  const run = existingRun || await beginImport();
  const abort = () => {
    if (operation !== run) return;
    cancel();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error('Choose a .nii or .nii.gz image.');
    status('Reading image…');
    const image = await readNifti(await file.arrayBuffer());
    const { data, dims } = image;
    signal?.throwIfAborted();
    run.signal.throwIfAborted();
    if (!run.current) return false;
    source = file;
    sourceGrid = gridOf(image);
    setSubject(sidecar ? subjectFromSidecar(sidecar) : {}, Boolean(sidecar));
    setFieldStrength(sidecar ? fieldStrengthFromSidecar(sidecar) : null);
    $('ct').checked = looksLikeCt(data);
    progressManager.reset();
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${file.name} · ${dims.join(' × ')} voxels`;
    void show();
    if (webgpu) run.ready('Image loaded · ready to segment');
    else run.fail('Image loaded · this browser cannot run SynthSeg');
    status(
      webgpu
        ? 'Image loaded · ready to segment'
        : 'Image loaded · this browser cannot run SynthSeg',
      !webgpu,
    );
    return true;
  } catch (error) {
    if (run.fail(error)) status(error.message, true);
    return false;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (operation === run) setBusy(false);
  }
}
async function importImages(filesPromise) {
  exampleControl.cancel();
  if (busy) return;
  const run = await beginImport();
  status('Reading images · converting DICOM if needed…');
  try {
    const files = await filesPromise;
    run.signal.throwIfAborted();
    // The sidecars carry identifying fields; only age, sex and field strength are read from them, and nothing is saved.
    const images = await readImageSeries(files, { signal: run.signal });
    run.signal.throwIfAborted();
    if (!images.length) throw new Error('Choose NIfTI files or a complete DICOM series.');
    if (!(await load(images[0].image, undefined, run, images[0].sidecar)) || operation !== run) return;
    importedImages = images;
    $('seriesSelect').replaceChildren(
      ...images.map(({ image }, index) => new Option(image.name, String(index))),
    );
    $('seriesSelect').hidden = images.length < 2;
  } catch (error) {
    if (run.fail(error)) {
      setBusy(false);
      status(error.message, true);
    }
  } finally {
    if (operation === run) setBusy(false);
  }
}
$('imageInput').onchange = () => {
  const files = Array.from($('imageInput').files);
  $('imageInput').value = '';
  if (files.length) void importImages(Promise.resolve(files));
};
$('seriesSelect').onchange = async () => {
  const { image, sidecar } = importedImages[Number($('seriesSelect').value)];
  if (!(await load(image, undefined, undefined, sidecar)))
    $('seriesSelect').value = String(importedImages.findIndex((entry) => entry.image === source));
};
bindFileDrop($('dropZone'), (files) => {
  if (!busy) void importImages(files);
});
const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const run = await beginImport();
    const abort = () => {
      if (operation === run) cancel();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const files = await fetchFiles();
      assertCurrent();
      if (!await load(files[0], signal, run)) throw new Error('The example image could not be loaded.');
      assertCurrent();
    } catch (error) {
      run.fail(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (operation === run) setBusy(false);
    }
  },
  onStatus: status,
});
exampleControl.select.id = 'exampleSelect';
exampleControl.querySelector('label').htmlFor = 'exampleSelect';
$('exampleControl').replaceWith(exampleControl);

$('opacity').oninput = () => {
  const value = Number($('opacity').value);
  toolbar.control('overlayOpacityValue').textContent = `${Math.round(value * 100)}%`;
  if (labels && viewer && (displayedStage === 'labels' || TISSUES.includes(displayedStage))) void viewer.setVolume(1, { opacity: value });
};
// Automation passes voxelSizeMm: its contract declares the 1 mm grid, whatever the form holds.
async function segmentImage(parameters, { signal, progress = () => {}, voxelSizeMm: fixedVoxelSizeMm } = {}) {
  if (!source || busy) throw new Error('Load an image before starting segmentation.');
  if (!webgpu) throw new Error('SynthSeg requires WebGPU.');
  signal?.throwIfAborted();
  const voxelSizeMm = fixedVoxelSizeMm ?? Number($('voxelSizeMm').value);
  if (fixedVoxelSizeMm === undefined && !$('voxelSizeMm').checkValidity()) {
    $('preparationSection').open = true;
    $('voxelSizeMm').reportValidity();
    throw new Error('Choose a processing voxel size between 1 and 3 mm.');
  }
  const cancelled = clearOutputs();
  memoryRecommendation = null;
  $('downsampleButton').hidden = true;
  const options = { fast: parameters.mode === 'fast', ct: parameters.ct ?? $('ct').checked,
    robustFov: $('robustFov').checked, voxelSizeMm };
  if (parameters.age !== undefined || parameters.sex !== undefined) {
    const current = subject();
    setSubject({ age: parameters.age ?? current.age, sex: parameters.sex ?? current.sex });
  }
  if (parameters.reference !== undefined) {
    $('reference').value = parameters.reference;
    showReferenceHint();
  }
  const run = runs.begin('running', {
    inputs: { image: source },
    parameters: { mode: parameters.mode, ct: options.ct, ...subject(), reference: $('reference').value },
  });
  operation = run;
  setBusy(true, true);
  const abort = () => cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await cancelled;
    signal?.throwIfAborted();
    run.signal.throwIfAborted();
    void show();
    progressManager.begin('Preparing image…');
    progressManager.setProgress(0);
    return await new Promise((resolve, reject) => {
      run.signal.addEventListener('abort', () => {
        queueMicrotask(() => {
          const snapshot = runs.snapshot();
          reject(snapshot.state === 'failed' ? new Error(snapshot.message) : run.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        });
      }, { once: true });
      const fail = error => {
        run.fail(error);
        if (operation === run) {
          progressManager.end(error.message || String(error), { success: false });
          setBusy(false);
          status(error.message || String(error), true);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        worker = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = async ({ data }) => {
          if (!run.current) return;
          if (data.type === 'progress') {
            run.progress(data);
            progress(data);
            status(data.message);
            progressManager.setProgress(data.value);
          }
          if (data.type === 'error') {
            if (data.recommendation?.voxelSizeMm) {
              memoryRecommendation = data.recommendation;
              $('preparationSection').open = true;
              $('downsampleButton').textContent = `Use ${memoryRecommendation.voxelSizeMm} mm and segment`;
              $('downsampleButton').hidden = false;
            }
            fail(new Error(data.message));
          }
          if (data.type === 'result') {
            try {
              const file = new File([data.buffer], outputNames(source.name).labels, { type: LABELS_ARTIFACT.mediaType });
              const image = await readNifti(data.buffer);
              if (!run.current) throw new DOMException('Cancelled', 'AbortError');
              volumes = data.volumes ?? null;
              volumesFast = options.fast;
              volumesVoxelSizeMm = options.voxelSizeMm;
              const names = outputNames(source.name);
              // A result without all three maps offers none, rather than files that hold no image.
              const maps = TISSUES.every((tissue) => data.tissues?.[tissue]?.byteLength > 0)
                ? Object.fromEntries(TISSUES.map((tissue) => [tissue, new File([data.tissues[tissue]], names[tissue], { type: TISSUE_ARTIFACT.mediaType })]))
                : null;
              const space = voxelSizeMm > 1 ? `subject-${voxelSizeMm}mm` : LABELS_ARTIFACT.space;
              const measurements = {
                ...summarizeLabels(image, freesurferLut),
                softVolumesMm3: volumes,
                volumeReport: await reportSummary(),
              };
              if (!run.current) throw new DOMException('Cancelled', 'AbortError');
              const succeeded = await run.succeed({
                artifacts: {
                  labels: { file, ...LABELS_ARTIFACT, space },
                  ...Object.fromEntries(Object.entries(maps ?? {}).map(([tissue, map]) => [tissue, { file: map, ...TISSUE_ARTIFACT, space }])),
                },
                provenance: data.provenance,
                measurements,
              });
              if (!succeeded) throw new DOMException('Cancelled', 'AbortError');
              labels = labelsResult(file, gridOf(image));
              tissues = maps;
              renderResults();
              provenance = data.provenance;
              $('outputSection').open = true;
              progressManager.end('Labels ready');
              setBusy(false);
              volumesTab().hidden = !volumes;
              await show();
              signal?.throwIfAborted();
              const preparation = provenance.preparation;
              const adjustments = `${preparation?.robustFov ? ' · robust FOV' : ''}${options.voxelSizeMm > 1 ? ` · ${options.voxelSizeMm} mm` : ''}`;
              status(`Labels ready · ${provenance.outputShape.join(' × ')} · ${Math.round(provenance.seconds)} s${adjustments}`);
              const artifacts = [{ role: 'labels', file }, ...Object.entries(maps ?? {}).map(([role, map]) => ({ role, file: map }))];
              resolve({ artifacts, provenance, measurements });
            } catch (error) { fail(error); }
          }
        };
        worker.onerror = event => fail(new Error(event.message || 'The inference worker could not run. Reload the app and try again.'));
        const asset = manifest.assets.find(entry => entry.filename === 'synthseg-2.0.onnx');
        worker.postMessage({ file: source, options, model: { ...asset, url: `${assetBase}${asset.filename}?sha256=${asset.sha256}` } });
      } catch (error) { fail(error); }
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
$('processButton').onclick = () => {
  void segmentImage({ mode: $('mode').value, ct: $('ct').checked }).catch(error => {
    if (error.name !== 'AbortError') status(error.message, true);
  });
};
$('downsampleButton').onclick = () => {
  if (!memoryRecommendation || busy) return;
  $('voxelSizeMm').value = String(memoryRecommendation.voxelSizeMm);
  $('processButton').click();
};
for (const id of ['robustFov', 'voxelSizeMm']) {
  $(id).onchange = () => {
    memoryRecommendation = null;
    $('downsampleButton').hidden = true;
  };
}
const automation = registerAppAutomation({
  app: 'synthseg',
  convertDicom: (files, options) => runDcm2niix(files, { ...options, args: ["-ba", "n"] }),
  operations: {
    segment: async ({ inputs, inputDetails, parameters, signal, progress }) => {
      exampleControl.cancel();
      const sidecars = inputDetails.image.sidecars.filter((file) => /\.json$/i.test(file.name));
      const [series] = await readImageSeries([...inputs.image, ...sidecars], { signal });
      if (!await load(series.image, signal, undefined, series.sidecar)) throw new Error('The input image could not be loaded.');
      return segmentImage(parameters, { signal, progress, voxelSizeMm: 1 });
    },
  },
});
function cancel() {
  exampleControl.cancel();
  if (!runs.cancel()) return;
  operation = null;
  ++viewRevision;
  clearOutputs();
  setBusy(false);
  progressManager.reset();
  status('Processing cancelled. Your original image is unchanged.');
}
$('cancelBtn').onclick = cancel;
$('reportBtn').onclick = async () => {
  const { report } = runs.snapshot();
  if (!report || busy) return;
  // The Age, Sex and Reference fields may have changed since the run, so the volume report follows them.
  const current = { ...report, measurements: { ...report.measurements, volumeReport: await reportSummary() } };
  downloadBlob(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }), report.artifacts.labels.filename.replace(/\.nii\.gz$/, '.json'));
};
$('volumesBtn').onclick = () => {
  if (!volumes || busy) return;
  downloadBlob(new Blob([volumesCsv(outputStem(source.name), volumes)], { type: 'text/csv' }), outputNames(source.name).volumes);
};
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
$('standaloneBtn').onclick = () => info.open('Standalone', $('standaloneContent'), { wide: true });
if (!webgpu) {
  const message = 'This browser does not support WebGPU. SynthSeg needs WebGPU; try Chrome, Edge, or Safari 26 on a desktop.';
  runs.fail(message);
  status(message, true);
}
window.addEventListener('pagehide', () => {
  exampleControl.cancel();
  runs.cancel();
  worker?.terminate();
  progressManager.reset();
});
