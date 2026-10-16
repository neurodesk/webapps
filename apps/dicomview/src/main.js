import NiiVue, { SLICE_TYPE } from '@niivue/niivue';
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  DicompareReportRenderer,
  ProgressManager,
  bindFileDrop,
  bindInfoTooltips,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createResultList,
  createViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import { downloadBlob, downloadFile } from '@neurodesk/webapp-components/file-io';
import { registerAppAutomation } from '@neurodesk/webapp-components/automation';
import { readImageSeries } from '@neurodesk/runtime-support/dcm2niix-client';
import { parseDicomHeader } from '@neurodesk/dicom2vid/readers/dicom.js';
import { APP } from './config.js';
import { indexFiles } from './dicom-index.js';
import { createDictionary, filterRows, headerRows, rowsToCsv, sidecarRows } from './header-rows.js';
import { protocolTables } from './protocol-table.js';
import { describeSeries, seriesLabel, seriesSummary } from './series-text.js';
import examples from '../examples.json';

const $ = (id) => document.getElementById(id);
// The explorer reads at most this much of an instance; enhanced multiframe headers can run to megabytes.
const HEADER_BYTES = 16 * 1024 * 1024;
const ROW_LIMIT = 2000;
const LAYOUTS = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
};

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'DICOM View',
  subtitle: 'DICOM series, headers and protocol, in your browser',
  mark: 'D',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'header', label: 'Header', disabled: true },
    { id: 'protocol', label: 'Protocol', hidden: true },
  ].map((view) => ({ ...view, onClick: () => showView(view.id) })),
});
$('viewer').prepend(toolbar);
const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);
bindInfoTooltips(document);
const progress = new ProgressManager();
const info = createInfoDialog();
$('aboutBtn').onclick = () => info.open('About DICOM View', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

// What the user is looking at. Conversions are cached per series, failed or cancelled
// ones dropped so selecting the series again retries.
const state = {
  index: null,
  seriesUid: null,
  instance: 0,
  output: 0,
  outputs: null,
  conversions: new Map(),
  view: 'multiplanar',
  acquisitions: null,
};

// Two jobs can run at once: reading and converting images, and dicompare. The status bar
// shows the most recent; its × cancels that one, and the other's message returns after.
const jobs = new Map();
let shown = null;

function status(message, error = false) {
  progress.setText(message);
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function begin(lane, message) {
  jobs.get(lane)?.controller.abort();
  const controller = new AbortController();
  jobs.set(lane, { controller, message });
  shown = lane;
  progress.begin(message);
  status(message);
  return controller;
}

function report(lane, fraction, message) {
  const job = jobs.get(lane);
  if (!job) return;
  job.message = message;
  if (shown === lane) progress.setProgress(fraction, message);
}

function finish(lane, controller, message, { error = null } = {}) {
  if (jobs.get(lane)?.controller !== controller) return;
  jobs.delete(lane);
  const cancelled = error?.name === 'AbortError';
  const text = cancelled ? `${message} cancelled` : error ? error.message : message;
  const [other] = jobs;
  if (other) {
    shown = other[0];
    progress.begin(other[1].message);
    log.log(text, error && !cancelled ? 'error' : 'info');
    return;
  }
  shown = null;
  progress.end(text, { success: !error });
  status(text, Boolean(error) && !cancelled);
}

$('cancelButton').onclick = () => {
  if (shown === 'viewer') exampleControl.cancel();
  jobs.get(shown)?.controller.abort();
};

const viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
let viewerReady = false;
const initialized = (async () => {
  try {
    await viewer.attachTo('gl1');
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.addEventListener('locationChange', (event) => { $('location').textContent = event.detail?.string ?? ''; });
    viewerReady = true;
  } catch (error) {
    $('viewerNotice').hidden = false;
    $('viewerNotice').textContent = `Images cannot be shown in this browser: ${error.message}. Headers and protocol still work.`;
  }
  progress.reset('Drag and drop files');
})();

function currentSeries() {
  return state.index?.series.find((series) => series.uid === state.seriesUid) ?? null;
}

function showView(id) {
  state.view = id;
  toolbar.setActive(id);
  $('headerReport').hidden = id !== 'header';
  $('protocolReport').hidden = id !== 'protocol';
  if (id === 'header') void renderHeader();
  if (LAYOUTS[id] !== undefined && viewerReady) {
    viewer.sliceType = LAYOUTS[id];
    viewer.drawScene();
  }
}

function viewTab(id) {
  return toolbar.viewTabs.querySelector(`[data-view="${id}"]`);
}

// ---- input ----

const seriesList = createResultList({
  element: $('seriesList'),
  onView: (uid) => selectSeries(uid),
  onDownload: (uid) => { void downloadSeries(uid); },
});

async function loadFiles(files, { signal, assertCurrent = () => {} } = {}) {
  for (const lane of jobs.keys()) jobs.get(lane).controller.abort();
  const controller = begin('viewer', 'Reading DICOM headers…');
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const index = await indexFiles(files, {
      signal: controller.signal,
      onProgress: (done, total) => report('viewer', done / total, `Reading headers ${done} of ${total}`),
    });
    if (!index.series.length) {
      const reason = index.skipped[0]?.reason;
      throw new Error(`No DICOM images in ${files.length} file${files.length === 1 ? '' : 's'}${reason ? ` (${reason})` : ''}.`);
    }
    assertCurrent();
    commit(index);
    finish('viewer', controller, `${index.series.length} series in ${files.length} files`);
    for (const { path, reason } of index.skipped) log.log(`Skipped ${path}: ${reason}`, 'warning');
    const first = index.series.find((series) => series.kind !== 'localizer') ?? index.series[0];
    selectSeries(first.uid);
  } catch (error) {
    finish('viewer', controller, 'Reading DICOM headers', { error });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function commit(index) {
  state.index = index;
  state.seriesUid = null;
  state.outputs = null;
  state.conversions = new Map();
  state.acquisitions = null;
  headerCache = new WeakMap();
  protocol?.clearFiles();
  const images = index.series.reduce((sum, series) => sum + series.files.length, 0);
  const skipped = index.skipped.length ? ` · ${index.skipped.length} skipped` : '';
  $('fileInfo').hidden = false;
  $('fileInfo').textContent = `${images} images · ${index.series.length} series${skipped}`;
  $('dropZone').classList.add('has-files');
  $('emptyState').hidden = true;
  $('protocolButton').disabled = false;
  $('protocolSummary').replaceChildren();
  $('complianceReport').replaceChildren();
  viewTab('header').disabled = false;
  viewTab('protocol').hidden = true;
  if (state.view === 'protocol') showView('header');
  seriesList.render(Object.fromEntries(index.series.map((series) => [series.uid, { description: seriesLabel(series) }])));
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(() => {});
}

$('dicomInput').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length) void importFiles(files);
});
bindFileDrop($('dropZone'), async (files) => importFiles(await files));

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { signal, fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(files, { signal, assertCurrent });
  },
});
$('exampleControl').replaceWith(exampleControl);

// ---- series and images ----

function selectSeries(uid) {
  if (uid === state.seriesUid && jobs.has('viewer')) return;
  state.seriesUid = uid;
  state.instance = 0;
  state.output = 0;
  state.outputs = null;
  for (const row of seriesList.querySelectorAll('.nd-volume-toggle')) {
    row.querySelector('.nd-view-btn').classList.toggle('active', row.dataset.stage === uid);
  }
  const series = currentSeries();
  $('seriesInfo').hidden = false;
  $('seriesInfo').textContent = seriesSummary(series);
  $('outputField').hidden = true;
  $('instanceSlider').max = String(series.files.length - 1);
  $('instanceSlider').value = '0';
  if (state.view === 'header') void renderHeader();
  void showSeries(series);
}

function convert(series, signal) {
  let conversion = state.conversions.get(series.uid);
  if (!conversion) {
    conversion = readImageSeries(series.files.map((record) => record.file), { signal });
    state.conversions.set(series.uid, conversion);
    conversion.catch(() => {
      if (state.conversions.get(series.uid) === conversion) state.conversions.delete(series.uid);
    });
  }
  return conversion;
}

async function showSeries(series) {
  const controller = begin('viewer', `${describeSeries(series)} · converting…`);
  try {
    const outputs = await convert(series, controller.signal);
    controller.signal.throwIfAborted();
    if (state.seriesUid !== series.uid) return;
    state.outputs = outputs;
    $('outputSelect').replaceChildren(...outputs.map(({ image }, index) => new Option(image.name, String(index))));
    $('outputField').hidden = outputs.length < 2;
    await showOutput();
    finish('viewer', controller, `${describeSeries(series)} · ${outputs.length} image${outputs.length === 1 ? '' : 's'}`);
  } catch (error) {
    finish('viewer', controller, `${describeSeries(series)} · conversion`, { error });
  }
}

async function showOutput() {
  const output = state.outputs?.[state.output];
  if (!output) return;
  $('imageLabel').textContent = output.image.name;
  if (state.view === 'header' && $('headerSource').value === 'sidecar') void renderHeader();
  await initialized;
  if (!viewerReady) return;
  await viewer.loadVolumes([{ url: output.image, name: output.image.name }]);
}

$('outputSelect').addEventListener('change', () => {
  state.output = Number($('outputSelect').value);
  void showOutput().catch((error) => status(error.message, true));
});

function sidecarFile({ image, sidecar }) {
  const name = image.name.replace(/\.nii(\.gz)?$/i, '.json');
  return new File([`${JSON.stringify(sidecar, null, 2)}\n`], name, { type: 'application/json' });
}

async function downloadSeries(uid) {
  const series = state.index?.series.find((candidate) => candidate.uid === uid);
  if (!series) return;
  if (uid !== state.seriesUid) selectSeries(uid);
  try {
    const outputs = await state.conversions.get(uid);
    for (const output of outputs) {
      downloadFile(output.image);
      if (output.sidecar) downloadFile(sidecarFile(output));
    }
  } catch {
    // The conversion reports its own failure in the status bar.
  }
}

// ---- header explorer ----

let dictionaryPromise = null;
function loadDictionary() {
  dictionaryPromise ??= import('dcmjs/dictionary').then((module) => createDictionary(module.default));
  return dictionaryPromise;
}

let headerCache = new WeakMap();
function recordRows(record, series) {
  if (!headerCache.has(record)) {
    const rows = (async () => {
      const dictionary = await loadDictionary();
      const buffer = await record.file.slice(0, HEADER_BYTES).arrayBuffer();
      const header = parseDicomHeader(buffer, { vrOf: dictionary.vrOf });
      return { rows: headerRows(header, dictionary, series.varyingTags), complete: header.complete || buffer.byteLength >= record.file.size };
    })();
    rows.catch(() => headerCache.delete(record));
    headerCache.set(record, rows);
  }
  return headerCache.get(record);
}

let shownRows = [];
let headerRender = 0;
async function renderHeader() {
  const series = currentSeries();
  if (!series) return;
  const render = ++headerRender;
  const record = series.files[state.instance];
  const sidecar = $('headerSource').value === 'sidecar';
  $('instanceSlider').disabled = sidecar;
  $('varyingOnly').disabled = sidecar;
  $('instanceLabel').textContent = `${state.instance + 1} of ${series.files.length}`;
  let rows;
  let note;
  try {
    if (sidecar) {
      const output = state.outputs?.[state.output];
      rows = sidecarRows(output?.sidecar);
      note = output ? output.image.name : 'The sidecar appears once the series is converted.';
    } else {
      const header = await recordRows(record, series);
      rows = header.rows;
      note = `${record.path}${header.complete ? '' : ' · header continues past the first 16 MB'}`;
    }
  } catch (error) {
    rows = [];
    note = `This header cannot be read: ${error.message}`;
  }
  if (render !== headerRender) return;
  shownRows = filterRows(rows, { query: $('headerFilter').value, varyingOnly: !sidecar && $('varyingOnly').checked });
  const limited = shownRows.length > ROW_LIMIT ? ` · first ${ROW_LIMIT} shown; filter to narrow` : '';
  $('headerNote').textContent = `${shownRows.length} of ${rows.length} fields${limited} · ${note}`;
  $('headerRows').replaceChildren(...shownRows.slice(0, ROW_LIMIT).map(headerRow));
}

function headerRow(row) {
  const tr = document.createElement('tr');
  if (row.varies) tr.dataset.flag = '';
  const cells = [row.tag, `${'> '.repeat(row.depth)}${row.keyword}`, row.vr, row.value];
  tr.append(...cells.map((text) => Object.assign(document.createElement('td'), { textContent: text })));
  return tr;
}

$('instanceSlider').addEventListener('input', () => {
  state.instance = Number($('instanceSlider').value);
  void renderHeader();
});
for (const id of ['headerFilter', 'varyingOnly', 'headerSource']) {
  $(id).addEventListener(id === 'headerFilter' ? 'input' : 'change', () => { void renderHeader(); });
}

function headerFileStem() {
  const series = currentSeries();
  const source = $('headerSource').value === 'sidecar' ? 'sidecar' : `instance${state.instance + 1}`;
  return `series${series?.number ?? ''}_${source}`;
}

$('copyHeader').onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(shownRows, null, 2));
    status(`Copied ${shownRows.length} fields as JSON`);
  } catch (error) {
    status(`Copy failed: ${error.message}`, true);
  }
};
$('downloadHeader').onclick = () => {
  downloadBlob(new Blob([rowsToCsv(shownRows)], { type: 'text/csv' }), `${headerFileStem()}.csv`);
};

// ---- protocol (dicompare) ----

let protocol = null;
let protocolModule = null;
const schemas = new Map();
const renderer = new DicompareReportRenderer();

function loadProtocolModule() {
  protocolModule ??= import('./protocol-session.js');
  return protocolModule;
}

async function loadSchema(id) {
  if (!schemas.has(id)) {
    const { SCHEMAS } = await loadProtocolModule();
    const url = SCHEMAS.find((schema) => schema.id === id).url;
    const loaded = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Schema ${id}: HTTP ${response.status}`);
      return response.json();
    });
    loaded.catch(() => schemas.delete(id));
    schemas.set(id, loaded);
  }
  return schemas.get(id);
}

void loadProtocolModule().then(({ SCHEMAS }) => {
  $('schemaSelect').append(...SCHEMAS.map((schema) => new Option(schema.name, schema.id)));
});

function refreshProtocolButton() {
  $('protocolButton').textContent = $('schemaSelect').value ? 'Check compliance' : 'Summarize protocol';
}

$('schemaSelect').addEventListener('change', async () => {
  refreshProtocolButton();
  const id = $('schemaSelect').value;
  $('schemaAcquisitionField').hidden = true;
  if (!id) return;
  try {
    const schema = await loadSchema(id);
    if ($('schemaSelect').value !== id) return;
    const names = Object.keys(schema.acquisitions ?? {});
    $('schemaAcquisition').replaceChildren(...names.map((name, index) => new Option(name, String(index))));
    $('schemaAcquisitionField').hidden = names.length < 2;
  } catch (error) {
    status(error.message, true);
  }
});

async function runProtocol({ signal } = {}) {
  if (!state.index) throw new Error('Load DICOM files before summarising the protocol.');
  const controller = begin('protocol', 'Starting dicompare…');
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const schemaId = $('schemaSelect').value;
  $('protocolButton').disabled = true;
  try {
    const { ProtocolSession } = await loadProtocolModule();
    protocol ??= new ProtocolSession((message) => log.log(message));
    if (!state.acquisitions) {
      const index = state.index;
      const files = index.series.flatMap((series) => series.files.map((record) => record.file));
      const acquisitions = await protocol.summarize(files, {
        signal: controller.signal,
        onProgress: (fraction, message) => report('protocol', fraction, message),
      });
      if (state.index !== index) throw new DOMException('The files changed', 'AbortError');
      state.acquisitions = acquisitions;
      $('protocolSummary').replaceChildren(...protocolTables(acquisitions, document));
    }
    let schema = null;
    let compliance = null;
    if (schemaId) {
      report('protocol', 1, 'Checking compliance…');
      schema = await loadSchema(schemaId);
      compliance = await protocol.check(schema, Number($('schemaAcquisition').value || 0), { signal: controller.signal });
      renderer.render($('complianceReport'), { acquisitions: state.acquisitions, complianceResults: compliance, schema });
    } else {
      $('complianceReport').replaceChildren();
    }
    viewTab('protocol').hidden = false;
    showView('protocol');
    const count = `${state.acquisitions.length} acquisition${state.acquisitions.length === 1 ? '' : 's'}`;
    finish('protocol', controller, schema ? `${count} checked against ${schema.name}` : `${count} summarised`);
    return { acquisitions: state.acquisitions, compliance };
  } catch (error) {
    finish('protocol', controller, 'Protocol summary', { error });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    $('protocolButton').disabled = !state.index;
  }
}

$('protocolButton').addEventListener('click', () => { void runProtocol().catch(() => {}); });

// ---- automation ----

registerAppAutomation({
  app: APP.id,
  operations: {
    'index-series': async ({ inputs, signal }) => {
      await loadFiles(inputs.dicom, { signal });
      const series = currentSeries();
      const outputs = await convert(series, signal);
      const index = state.index.series.map((entry) => ({
        uid: entry.uid,
        number: entry.number,
        description: entry.description,
        modality: entry.modality,
        images: entry.files.length,
        rows: entry.rows,
        cols: entry.cols,
        kind: entry.kind,
        summary: entry.summary,
      }));
      return {
        artifacts: [
          { role: 'series', file: new File([JSON.stringify(index, null, 2)], 'series.json', { type: 'application/json' }) },
          ...outputs.map(({ image }) => ({ role: 'image', file: image })),
        ],
        provenance: { converter: 'dcm2niix', series: series.uid },
      };
    },
  },
});

window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  for (const job of jobs.values()) job.controller.abort();
  protocol?.terminate();
});

export default Object.freeze({ APP, state });
