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
import { ProtocolSession, SCHEMAS } from './protocol-session.js';
import { checkOutcome, protocolTables } from './protocol-table.js';
import { describeSeries, downloadFiles, seriesLabel, seriesSummary } from './series-text.js';
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
    { id: 'header', label: 'Header', hidden: true },
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
// ones dropped so selecting the series again retries. generation counts committed
// inputs: a result computed from an earlier input is never written over a later one.
const state = {
  generation: 0,
  index: null,
  seriesUid: null,
  instance: 0,
  output: 0,
  outputs: null,
  conversions: new Map(),
  view: 'multiplanar',
  acquisitions: null,
};

// Jobs run in lanes: reading headers ('index'), converting images ('viewer') and dicompare
// ('protocol'). Reading a new input cancels every lane; otherwise the image and protocol
// lanes run side by side. The status bar shows the most recent; its × cancels that one,
// and the other's message returns after.
const jobs = new Map();
let shown = null;

function syncProtocolButton() {
  $('protocolButton').disabled = !state.index || jobs.has('index') || jobs.has('protocol');
}

function assertGeneration(generation) {
  if (state.generation !== generation) throw new DOMException('A new input replaced this one', 'AbortError');
}

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
  syncProtocolButton();
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
  syncProtocolButton();
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
  if (shown === 'index') exampleControl.cancel();
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
  if (!jobs.size && !state.index) progress.reset('Drag and drop files');
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


const seriesList = createResultList({
  element: $('seriesList'),
  onView: (uid) => selectSeries(uid),
  onDownload: (uid) => { void downloadSeries(uid); },
});

async function loadFiles(files, { signal, assertCurrent = () => {} } = {}) {
  for (const lane of jobs.keys()) jobs.get(lane).controller.abort();
  const controller = begin('index', 'Reading DICOM headers…');
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  // Choosing a listed series would cancel the read that is replacing the list.
  seriesList.inert = true;
  try {
    const index = await indexFiles(files, {
      signal: controller.signal,
      onProgress: (done, total) => report('index', done / total, `Reading headers ${done} of ${total}`),
    });
    if (!index.series.length) {
      const reason = index.skipped[0]?.reason;
      throw new Error(`No DICOM images in ${files.length} file${files.length === 1 ? '' : 's'}${reason ? ` (${reason})` : ''}.`);
    }
    assertCurrent();
    commit(index);
    finish('index', controller, `${index.series.length} series in ${files.length} files`);
    for (const { path, reason } of index.skipped) log.log(`Skipped ${path}: ${reason}`, 'warning');
    const first = index.series.find((series) => series.kind !== 'localizer') ?? index.series[0];
    selectSeries(first.uid);
  } catch (error) {
    finish('index', controller, 'Reading DICOM headers', { error });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!jobs.has('index')) seriesList.inert = false;
  }
}

function commit(index) {
  state.generation += 1;
  state.index = index;
  state.seriesUid = null;
  state.outputs = null;
  state.conversions = new Map();
  void clearImage();
  state.acquisitions = null;
  headerCache = new WeakMap();
  const images = index.series.reduce((sum, series) => sum + series.files.length, 0);
  const skipped = index.skipped.length ? ` · ${index.skipped.length} skipped` : '';
  $('fileInfo').hidden = false;
  $('fileInfo').textContent = `${images} images · ${index.series.length} series${skipped}`;
  $('dropZone').classList.add('has-files');
  syncProtocolButton();
  $('protocolSummary').replaceChildren();
  $('complianceReport').replaceChildren();
  viewTab('header').hidden = false;
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
  // The selector reports "loaded" once its files are in; by then a conversion may own the status bar.
  onStatus: (message, error) => (jobs.size && !error ? log.log(message) : status(message, error)),
  onLoad: async (_example, { signal, fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(files, { signal, assertCurrent });
  },
});
$('exampleControl').replaceWith(exampleControl);


function selectSeries(uid) {
  if (uid === state.seriesUid && jobs.has('viewer')) return;
  state.seriesUid = uid;
  state.instance = 0;
  state.output = 0;
  state.outputs = null;
  void clearImage();
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
    conversion = readImageSeries(series.files.map((record) => record.file), { signal, anonymizeSidecar: true });
    state.conversions.set(series.uid, conversion);
    conversion.catch(() => {
      if (state.conversions.get(series.uid) === conversion) state.conversions.delete(series.uid);
    });
  }
  return conversion;
}

function untilAborted(signal) {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

async function showSeries(series) {
  const { generation } = state;
  const controller = begin('viewer', `${describeSeries(series)} · converting…`);
  let outputs = null;
  try {
    outputs = await convert(series, controller.signal);
    controller.signal.throwIfAborted();
    assertGeneration(generation);
    if (state.seriesUid !== series.uid) return;
    state.outputs = outputs;
    $('outputSelect').replaceChildren(...outputs.map(({ image }, index) => new Option(image.name, String(index))));
    $('outputField').hidden = outputs.length < 2;
    await Promise.race([showOutput(), untilAborted(controller.signal)]);
    controller.signal.throwIfAborted();
    finish('viewer', controller, `${describeSeries(series)} · ${outputs.length} image${outputs.length === 1 ? '' : 's'}`);
  } catch (error) {
    // A load cannot be stopped once NiiVue has it; clearImage, queued behind it, takes the
    // image down again so a cancelled or failed one never stays current.
    if (outputs && state.outputs === outputs) {
      state.outputs = null;
      $('outputField').hidden = true;
      void clearImage();
    }
    finish('viewer', controller, `${describeSeries(series)} · conversion`, { error });
  }
}

// Loads run one after another and skip images no longer chosen, so a slow load of an
// earlier series cannot finish over the selected one.
let viewerLoads = initialized;
function showOutput() {
  const output = state.outputs?.[state.output];
  if (!output) return Promise.resolve();
  $('imageLabel').textContent = output.image.name;
  if (state.view === 'header' && $('headerSource').value === 'sidecar') void renderHeader();
  const load = viewerLoads.then(async () => {
    if (!viewerReady || state.outputs?.[state.output] !== output) return;
    await viewer.loadVolumes([{ url: output.image, name: output.image.name }]);
    $('emptyState').hidden = true;
  });
  viewerLoads = load.catch(() => {});
  return load;
}

// Queued behind any load in flight, so an image of an earlier series or folder never
// stays on screen beside the header of the one now selected. The selection's own images
// may be ready by then; they load after this, so the clear still runs. Only a later
// selection, which queues its own clear, makes this one moot.
function clearImage() {
  $('imageLabel').textContent = '';
  const { seriesUid } = state;
  const clear = viewerLoads.then(async () => {
    if (!viewerReady || state.seriesUid !== seriesUid) return;
    await viewer.removeAllVolumes();
    $('emptyState').hidden = false;
  });
  viewerLoads = clear.catch(() => {});
  return clear;
}

$('outputSelect').addEventListener('change', () => {
  state.output = Number($('outputSelect').value);
  void showOutput().catch((error) => status(error.message, true));
});

async function downloadSeries(uid) {
  const series = state.index?.series.find((candidate) => candidate.uid === uid);
  if (!series) return;
  if (uid !== state.seriesUid || !state.conversions.has(uid)) selectSeries(uid);
  try {
    const outputs = await state.conversions.get(uid);
    for (const { image, sidecar } of downloadFiles(series, outputs, state.index.series)) {
      downloadFile(image);
      if (sidecar) downloadFile(sidecar);
    }
  } catch {
    // The conversion reports its own failure in the status bar.
  }
}


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
      const header = await parseDicomHeader(buffer, { vrOf: dictionary.vrOf });
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
  setExportable(false);
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
  setExportable(true);
}

// The exports name the current selection, so they wait until its rows are shown.
function setExportable(ready) {
  $('copyHeader').disabled = !ready;
  $('downloadHeader').disabled = !ready;
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


let protocol = null;
const schemas = new Map();
const renderer = new DicompareReportRenderer();

function loadSchema(id) {
  if (!schemas.has(id)) {
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

$('schemaSelect').append(...SCHEMAS.map((schema) => new Option(schema.name, schema.id)));

$('schemaSelect').addEventListener('change', async () => {
  $('protocolButton').textContent = $('schemaSelect').value ? 'Check compliance' : 'Summarize protocol';
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

async function runProtocol() {
  const { generation } = state;
  const controller = begin('protocol', 'Starting dicompare…');
  const schemaId = $('schemaSelect').value;
  try {
    protocol ??= new ProtocolSession((message) => log.log(message));
    if (!state.acquisitions) {
      const records = state.index.series.flatMap((series) => series.files);
      const acquisitions = await protocol.summarize(records, {
        signal: controller.signal,
        onProgress: (fraction, message) => report('protocol', fraction, message),
      });
      assertGeneration(generation);
      state.acquisitions = acquisitions;
      $('protocolSummary').replaceChildren(...protocolTables(state.acquisitions, document));
    }
    let outcome = { message: `${state.acquisitions.length} acquisition${state.acquisitions.length === 1 ? '' : 's'} summarised`, failed: false };
    if (schemaId) {
      report('protocol', 1, 'Checking compliance…');
      const schema = await loadSchema(schemaId);
      const complianceResults = await protocol.check(state.acquisitions, schema, Number($('schemaAcquisition').value || 0), { signal: controller.signal });
      assertGeneration(generation);
      renderer.render($('complianceReport'), { acquisitions: state.acquisitions, complianceResults, schema });
      outcome = checkOutcome(complianceResults, schema.name);
    } else {
      $('complianceReport').replaceChildren();
    }
    viewTab('protocol').hidden = false;
    showView('protocol');
    finish('protocol', controller, outcome.message, { error: outcome.failed ? new Error(outcome.message) : null });
  } catch (error) {
    finish('protocol', controller, 'Protocol summary', { error });
  }
}

$('protocolButton').addEventListener('click', () => { void runProtocol(); });


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
          ...downloadFiles(series, outputs, state.index.series).map(({ image }) => ({ role: 'image', file: image })),
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
