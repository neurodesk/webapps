// Canonical Neurodesk shell; the app owns conversion review and BIDS curation.
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  bindFileDrop,
  bindInfoTooltips,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createResultList,
  createViewerToolbar,
  ProgressManager,
} from '@neurodesk/webapp-components/ui';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { registerAppAutomation } from '@neurodesk/webapp-components/automation';
import { runDcm2niix } from '@neurodesk/runtime-support/dcm2niix-client';
import { SCAN_TYPES, seriesFromOutputs, validateDataset } from './bids.js';
import { exportBids } from './export.js';
import { examinationFiles, expandInputs } from './input.js';
import { createSeriesReview } from './review.js';
import { APP } from './config.js';
import examples from '../examples.json';

const $ = (id) => document.getElementById(id);
mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'dcm2niix',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});
const toolbar = createViewerToolbar({
  views: [{ id: 'series', label: 'Series review', active: true }],
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
});
$('viewer').prepend(toolbar);
const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);
const progress = new ProgressManager();
const info = createInfoDialog();
$('aboutBtn').onclick = () => info.open('About dcm2niix', $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
const results = createResultList({
  element: $('resultList'),
  onView: () => { $('seriesReport').hidden = false; },
  onDownload: (_stage, result) => downloadFile(result.file),
});
const review = createSeriesReview({
  rows: $('seriesRows'),
  editor: $('seriesEditor'),
  onChange: () => {
    automation.reset();
    invalidate();
  },
});
bindInfoTooltips(document);
let series = [];
let sourceFiles = [];
let active = null;
let generation = 0;

function status(message, error = false) {
  progress.setText(message);
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function invalidate() {
  results.render();
  $('outputSection').open = false;
  $('runButton').disabled = Boolean(active) || review.hasPendingEdits() || !series.length;
}

function busy(value) {
  $('imageInput').disabled = value;
  $('retryButton').disabled = value;
  $('clearButton').disabled = value || !sourceFiles.length;
  exampleControl.setDisabled(value);
  for (const input of document.querySelectorAll('#taskSection input, #taskSection select, #seriesReport input, #seriesReport select, #seriesReport textarea, #seriesReport button')) {
    input.disabled = value;
  }
  $('runButton').disabled = value || review.hasPendingEdits() || !series.length;
}

async function job(message, signal, run) {
  if (active) throw new Error('Wait for the current operation or cancel it.');
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  active = controller;
  busy(true);
  progress.begin(message);
  status(message);
  try {
    const value = await run(controller.signal);
    controller.signal.throwIfAborted();
    return value;
  } catch (error) {
    const cancelled = controller.signal.aborted || error.name === 'AbortError';
    const message = cancelled ? 'Operation cancelled' : error.message;
    progress.end(message, { success: false });
    status(message, !cancelled);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    active = null;
    progress.stopTimer();
    progress.setCancellable(false);
    busy(false);
  }
}

async function loadFiles(inputs, signal) {
  if (active) throw new Error('Wait for the current operation or cancel it.');
  const current = ++generation;
  sourceFiles = Array.from(inputs);
  series = [];
  invalidate();
  review.render([]);
  $('fileInfo').hidden = true;
  $('seriesReport').hidden = true;
  $('emptyState').hidden = false;
  $('retryButton').hidden = true;
  try {
    await job('Reading DICOM examination…', signal, async (signal) => {
      const expanded = await expandInputs(sourceFiles, { signal });
      const examination = await examinationFiles(expanded, { signal });
      progress.setIndeterminate('Converting MRI series with dcm2niix…');
      // Preserve all outputs, including bval/bvec, and retain metadata in memory
      // until the user explicitly chooses their download privacy policy.
      const outputs = await runDcm2niix(examination.files, {
        signal,
        niftiOnly: false,
        args: ["-ba", "n"],
        timeoutMs: 10 * 60 * 1000,
      });
      const converted = await seriesFromOutputs(outputs, { signal });
      signal.throwIfAborted();
      if (current !== generation) throw new DOMException('Input replaced', 'AbortError');
      series = converted;
      review.render(series);
      $('emptyState').hidden = true;
      $('seriesReport').hidden = false;
      $('fileInfo').hidden = false;
      $('fileInfo').textContent = `${examination.files.length} DICOM files · ${series.length} acquisitions`;
      $('location').textContent = `${series.length} converted acquisitions · review before export`;
      if (examination.skipped) log.log(`${examination.skipped} ancillary files skipped.`);
      progress.end('Conversion complete · confirm included series');
    });
  } catch (error) {
    $('retryButton').hidden = false;
    throw error;
  }
}

function options() {
  return {
    name: $('datasetName').value,
    subject: $('subject').value.trim(),
    session: $('session').value.trim(),
    privacy: $('privacy').value,
  };
}

async function exportDataset(signal) {
  if (review.hasPendingEdits()) throw new Error('Wait for gradient files to finish loading.');
  const settings = options();
  const errors = validateDataset(series, settings);
  if (errors.length) {
    review.revealErrors(errors);
    const ids = { name: 'datasetName', subject: 'subject', session: 'session', privacy: 'privacy' };
    const global = errors.find((error) => !error.id && ids[error.field]);
    if (global) {
      const field = $(ids[global.field]);
      field.setCustomValidity(global.message);
      field.reportValidity();
      field.focus();
    }
    status(errors[0].message, true);
    throw Object.assign(new Error(errors[0].message), { errors });
  }
  return job('Preparing BIDS dataset…', signal, async (signal) => {
    const dataset = await exportBids(series, settings, {
      signal,
      onProgress: (fraction) => progress.setProgress(fraction, 'Preparing BIDS files…'),
    });
    signal.throwIfAborted();
    const file = new File([dataset.bytes], `sub-${settings.subject}_ses-${settings.session}_bids.zip`, { type: 'application/zip' });
    results.render({ bids: { description: 'Reviewed BIDS dataset', file } });
    $('outputSection').open = true;
    progress.end('BIDS dataset ready');
    return {
      file,
      artifacts: [{ role: 'bids', file }],
      provenance: { method: 'dcm2niix-bids', acquisitions: dataset.count, identifyingMetadata: settings.privacy },
    };
  });
}

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    automation.reset();
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(files, signal);
    assertCurrent();
  },
});
$('exampleControl').append(exampleControl);

async function importFiles(files) {
  automation.reset();
  exampleControl.cancel();
  try {
    await loadFiles(await files);
  } catch (error) {
    if (error.name !== 'AbortError') status(error.message, true);
  }
}
$('imageInput').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($('dropZone'), importFiles);
$('cancelButton').onclick = () => {
  exampleControl.cancel();
  active?.abort();
};
$('retryButton').onclick = () => void importFiles(Promise.resolve(sourceFiles));
$('runButton').onclick = async () => {
  try {
    const result = await exportDataset();
    downloadFile(result.file);
  } catch (error) {
    if (!error.errors && error.name !== 'AbortError') status(error.message, true);
  }
};
for (const input of document.querySelectorAll('#taskSection input, #taskSection select')) {
  input.addEventListener('input', () => {
    automation.reset();
    input.setCustomValidity('');
    invalidate();
  });
}
function clear() {
  automation.reset();
  generation++;
  active?.abort();
  sourceFiles = [];
  series = [];
  $('imageInput').value = '';
  $('subject').value = '';
  $('session').value = '';
  $('datasetName').value = 'MRI examination';
  $('privacy').value = '';
  $('retryButton').hidden = true;
  $('fileInfo').hidden = true;
  $('fileInfo').textContent = '';
  $('location').textContent = '';
  $('seriesReport').hidden = true;
  $('emptyState').hidden = false;
  review.render([]);
  invalidate();
  log.clear();
  progress.reset('Drag and drop files');
  $('clearButton').disabled = true;
}
$('clearButton').onclick = clear;

// Batch callers make the same explicit assignments as the review table. No
// automatic contrast decision is silently accepted by the automation contract.
const automation = registerAppAutomation({
  app: APP.id,
  operations: {
    'convert-bids': async ({ inputs, parameters, signal }) => {
      const assignmentError = 'Supply one explicit assignment per converted acquisition.';
      let assignments;
      try {
        assignments = JSON.parse(parameters.assignments);
      } catch {
        throw new Error(assignmentError);
      }
      if (!Array.isArray(assignments) || assignments.some(item =>
        !item || Array.isArray(item) || typeof item !== 'object' || !SCAN_TYPES.includes(item.type))) {
        throw new Error(assignmentError);
      }
      await loadFiles(inputs.dicom, signal);
      if (assignments.length !== series.length) {
        throw new Error(assignmentError);
      }
      assignments.forEach((assignment, index) => {
        const item = series[index];
        for (const key of ['type', 'acquisition', 'direction', 'targets', 'bval', 'bvec']) {
          if (assignment[key] !== undefined) item[key] = assignment[key];
        }
        if (assignment.metadata) Object.assign(item.metadata, assignment.metadata);
        item.reviewed = true;
      });
      $('datasetName').value = parameters.name || 'MRI examination';
      $('subject').value = parameters.subject;
      $('session').value = parameters.session;
      $('privacy').value = parameters.privacy;
      review.render(series);
      return exportDataset(signal);
    },
  },
});
window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  clear();
});
