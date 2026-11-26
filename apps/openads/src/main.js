// OpenADS + StrokeView in the browser: canonical Neurodesk imaging workspace.
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import './openads.css';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  createMaskEditor,
  bindInfoTooltips,
  ProgressManager,
} from '@neurodesk/webapp-components/ui';
import { createElement } from '@neurodesk/webapp-components/core';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import { registerAppAutomation, runAbortable } from '@neurodesk/webapp-components/automation';
import { projectSubjectOntoCohort, cohortSummaryCsv } from '@neurodesk/openads';
import { APP, ROLES, assignRoles, detectMode, inferSubjectId } from './config.js';
import { renderReportView } from './report.js';
import examples from '../examples.json';

const $ = (id) => document.getElementById(id);

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: APP.title,
  controlsContract: { privacy: '#privacyBtn' },
});

let viewer = null;
let viewerReady = null;
let maskEditor = null;
let viewQueue = Promise.resolve();
let viewRevision = 0;
let activeViewTab = 'multiplanar';
let overlayOpacity = 0.65;

const layouts = {
  multiplanar: () => {
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.showRender = SHOW_RENDER.ALWAYS;
  },
  axial: () => {
    viewer.sliceType = SLICE_TYPE.AXIAL;
  },
  coronal: () => {
    viewer.sliceType = SLICE_TYPE.CORONAL;
  },
  sagittal: () => {
    viewer.sliceType = SLICE_TYPE.SAGITTAL;
  },
};

function setReportVisible(visible) {
  $('reportView').hidden = !visible;
  $('gl1').hidden = visible;
  $('emptyState').hidden = visible || hasLoadedImage();
}

const toolbar = createViewerToolbar({
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'report', label: 'Report' },
  ].map((view) => ({
    ...view,
    onClick: () => {
      activeViewTab = view.id;
      toolbar.setActive(view.id);
      if (view.id === 'report') {
        setReportVisible(true);
        return;
      }
      setReportVisible(false);
      if (viewer && layouts[view.id]) {
        layouts[view.id]();
        viewer.drawScene();
      }
    },
  })),
});
$('viewer').prepend(toolbar);
toolbar.control('overlayOpacity').value = String(overlayOpacity);
toolbar.control('overlayOpacityValue').textContent = `${Math.round(overlayOpacity * 100)}%`;

const log = createConsole({ id: 'technicalLog', resizable: true });
$('viewer').append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));

let files = [];
let assigned = Object.fromEntries(ROLES.map(({ role }) => [role, null]));
let outputs = {};
let lastResult = null;
let job = null;
const view = { baseKey: null, overlayKey: null };

function hasLoadedImage() {
  return Boolean(view.baseKey && outputs[view.baseKey]);
}

const selects = {};
for (const { role, label, name } of ROLES) {
  const select = createElement('select', { id: `${role}Select`, 'aria-label': name });
  select.addEventListener('change', () => {
    const idx = select.value === '' ? null : Number(select.value);
    for (const other of Object.keys(assigned)) {
      if (other !== role && idx !== null && assigned[other] === idx) assigned[other] = null;
    }
    assigned[role] = idx;
    renderInputs();
    clearResults();
    void show();
  });
  selects[role] = select;
  $('sequenceFields').append(
    createElement('div', { className: 'nd-field' }, [
      createElement('label', { for: select.id, text: label }),
      select,
    ]),
  );
}

const results = createResultList({
  element: $('resultList'),
  onView: (key) => {
    if (job?.kind === 'running') return;
    const entry = outputs[key];
    if (!entry) return;
    if (entry.isOverlay) {
      view.overlayKey = view.overlayKey === key ? null : key;
    } else {
      view.baseKey = key;
    }
    if (activeViewTab === 'report') {
      activeViewTab = 'multiplanar';
      toolbar.setActive('multiplanar');
      setReportVisible(false);
    }
    void show();
  },
  onEdit: (key, entry) => {
    if (!viewer || !entry?.file || job?.kind === 'running') return;
    view.overlayKey = key;
    if (activeViewTab === 'report') {
      activeViewTab = 'multiplanar';
      toolbar.setActive('multiplanar');
      setReportVisible(false);
    }
    void show().then(() => {
      if (!maskEditor) {
        maskEditor = createMaskEditor({
          nv: viewer,
          labelNames: { 1: 'Lesion' },
          onApply: (editedFile) => {
            outputs[key].file = editedFile;
            outputs[key].edited = true;
            status(`Updated ${outputs[key].label} mask.`);
            void show();
          },
          onCancel: () => status('Mask editing cancelled.'),
        });
        toolbar.after(maskEditor);
      }
      maskEditor.open(entry.file);
    });
  },
  onDownload: (_key, entry) => downloadFile(entry.file),
});

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  log.log(message, error ? 'error' : 'info');
}

function refreshControls() {
  const busy = job !== null;
  const plan = detectMode(assigned);
  exampleControl.setDisabled(busy);
  $('imageInput').disabled = busy;
  for (const select of Object.values(selects)) select.disabled = busy;
  $('runSyn').disabled = busy;
  $('runShap').disabled = busy;
  $('threshold').disabled = busy;
  $('cohortK').disabled = busy;
  results.inert = job?.kind === 'running';
  $('modeHint').textContent = plan.label;
  $('runButton').disabled = busy || !plan.ready;
}

function begin(kind, message) {
  const controller = new AbortController();
  job = { kind, controller, worker: null };
  progress.begin(message);
  status(message);
  refreshControls();
  return job;
}

function end(current, message, { success = true, error = false, value } = {}) {
  if (job !== current) return false;
  current.worker?.terminate();
  job = null;
  progress.end(message, { success });
  status(message, error);
  refreshControls();
  if (current.completion) {
    if (success) current.completion.resolve(value);
    else current.completion.reject(current.controller.signal.aborted ? current.controller.signal.reason : new Error(message));
  }
  return true;
}

function renderInputs() {
  for (const { role } of ROLES) {
    const select = selects[role];
    select.replaceChildren(
      createElement('option', { value: '', text: 'None' }),
      ...files.map((f, idx) => createElement('option', { value: String(idx), text: f.name })),
    );
    select.value = assigned[role] === null ? '' : String(assigned[role]);
  }
  $('sequenceFields').hidden = files.length === 0;
  refreshControls();
}

function rebuildInputOutputs() {
  outputs = {};
  for (const { role, label } of ROLES) {
    if (role === 'pwi-json') continue;
    const idx = assigned[role];
    if (idx === null) continue;
    outputs[`input_${role}`] = {
      label: `${label} (input)`,
      file: files[idx],
      isOverlay: role === 'mask' || role === 'brainmask',
      editable: false,
    };
  }
  const basePreference = ['input_dwi', 'input_adc', 'input_b0', 'input_pwi', 'input_mask'];
  view.baseKey = basePreference.find((k) => outputs[k]) || null;
  view.overlayKey = outputs.input_mask && view.baseKey !== 'input_mask' ? 'input_mask' : null;
  renderResultList();
}

function clearResults() {
  lastResult = null;
  $('summaryMetrics').hidden = true;
  $('summaryMetrics').replaceChildren();
  renderReportView($('reportView'), null);
  rebuildInputOutputs();
}

function renderResultList() {
  const items = {};
  const order = [];
  for (const [key, entry] of Object.entries(outputs)) {
    order.push(key);
    items[key] = {
      description: entry.label,
      file: entry.file,
      editable: Boolean(entry.editable),
      edited: Boolean(entry.edited),
      viewable: entry.viewable !== false,
    };
  }
  results.render(items, order);
}

async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({
        dragAndDropEnabled: false,
        backColor: [0, 0, 0, 1],
        show3Dcrosshair: true,
        onLocationChange: (data) => {
          $('location').textContent = data?.string || '';
        },
      });
      await viewer.attachToCanvas($('gl1'));
      layouts.multiplanar();
      return viewer;
    })();
  }
  return viewerReady;
}

function show() {
  const rev = ++viewRevision;
  renderResultList();
  const base = view.baseKey ? outputs[view.baseKey] : null;
  const overlay = view.overlayKey && view.overlayKey !== view.baseKey ? outputs[view.overlayKey] : null;
  if (!base) {
    $('emptyState').hidden = activeViewTab === 'report';
    return Promise.resolve();
  }
  $('emptyState').hidden = true;
  viewQueue = viewQueue.then(async () => {
    if (rev !== viewRevision) return;
    const nv = await ensureViewer();
    const list = [{ file: base.file, colormap: 'gray', opacity: 1 }];
    if (overlay) {
      list.push({
        file: overlay.file,
        colormap: overlay.label.toLowerCase().includes('hypoperfusion') ? 'winter' : 'warm',
        opacity: overlayOpacity,
        cal_min: 0.5,
        cal_max: 1.0,
      });
    }
    const volumes = [];
    for (const item of list) {
      const url = URL.createObjectURL(item.file);
      volumes.push({ ...item, url, name: item.file.name });
    }
    try {
      await nv.loadVolumes(volumes);
      if (activeViewTab !== 'report' && layouts[activeViewTab]) {
        layouts[activeViewTab]();
        nv.drawScene();
      }
    } finally {
      for (const v of volumes) URL.revokeObjectURL(v.url);
    }
  });
  return viewQueue;
}

toolbar.control('overlayOpacity').addEventListener('input', (event) => {
  overlayOpacity = Number(event.target.value);
  toolbar.control('overlayOpacityValue').textContent = `${Math.round(overlayOpacity * 100)}%`;
  if (viewer && viewer.volumes.length > 1) {
    viewer.setOpacity(1, overlayOpacity);
  }
});

async function loadInputFiles(incoming, explicitRoles = {}) {
  const list = Array.from(incoming || []);
  if (!list.length) return;
  const current = begin('loading', 'Reading input files…');
  try {
    const jsonFiles = list.filter((f) => f.name.toLowerCase().endsWith('.json'));
    const imageCandidates = list.filter((f) => !f.name.toLowerCase().endsWith('.json'));
    const converted = [];
    if (imageCandidates.length) {
      const niftiOnly = imageCandidates.every((f) => /\.nii(\.gz)?$/i.test(f.name));
      if (niftiOnly) {
        converted.push(...imageCandidates);
      } else {
        const result = await readImageFiles(imageCandidates, { niftiOnly: false });
        for (const item of result) converted.push(item);
      }
    }
    const all = [...converted, ...jsonFiles];
    if (!all.length) throw new Error('No supported NIfTI, DICOM or JSON files found.');
    files = all;
    assigned = assignRoles(files, explicitRoles);
    renderInputs();
    clearResults();
    end(current, `Loaded ${files.length} file${files.length === 1 ? '' : 's'}.`);
    await show();
  } catch (err) {
    end(current, err.message || 'Could not read input files.', { success: false, error: true });
    throw err;
  }
}

const exampleControl = createExampleSelector({
  examples,
  scope: $('inputSection'),
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    const roleByName = new Map(example.files.map(({ name, role }) => [name, role]));
    const explicitRoles = {};
    fetched.forEach((file, idx) => {
      const role = roleByName.get(file.name);
      if (role) explicitRoles[role] = idx;
    });
    await loadInputFiles(fetched, explicitRoles);
    assertCurrent();
  },
});
$('exampleControl').append(exampleControl);

bindFileDrop($('dropZone'), (dropped) => {
  void loadInputFiles(dropped);
});
$('imageInput').addEventListener('change', (event) => {
  const picked = event.target.files;
  if (picked?.length) void loadInputFiles(picked);
});

function buildDownloads(reporting) {
  const list = [
    {
      label: 'Report (.txt)',
      file: new File([reporting.report.text], `${reporting.subjectId}_automatic_radiological_report.txt`, { type: 'text/plain' }),
    },
  ];
  for (const [name, content] of Object.entries(reporting.csvFiles || {})) {
    const short = name.replace(`${reporting.subjectId}_`, '');
    list.push({ label: short, file: new File([content], name, { type: 'text/csv' }) });
  }
  return list;
}

function runAnalysis(options = {}) {
  const plan = detectMode(assigned);
  if (!plan.ready) {
    status('Load DWI + b0/ADC or an MNI152 lesion mask first.', true);
    return Promise.reject(new Error('Inputs incomplete.'));
  }
  const runSyn = options.runSyn ?? $('runSyn').checked;
  const runShap = options.runShap ?? $('runShap').checked;
  const threshold = Number(options.threshold ?? $('threshold').value) || 0.5;
  const cohortK = Math.max(10, Math.min(250, parseInt(options.cohortK ?? $('cohortK').value, 10) || 50));
  const subjectId = inferSubjectId(files);

  const selectedFiles = {};
  for (const { role } of ROLES) {
    if (assigned[role] !== null) selectedFiles[role] = files[assigned[role]];
  }

  const current = begin('running', `Running OpenADS (${plan.mode})…`);
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((res, rej) => {
    resolveCompletion = res;
    rejectCompletion = rej;
  });
  current.completion = { resolve: resolveCompletion, reject: rejectCompletion };

  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  current.worker = worker;

  worker.onmessage = async ({ data: msg }) => {
    if (job !== current) return;
    if (msg.type === 'progress') {
      progress.setProgress(msg.value, msg.message);
      $('statusText').textContent = msg.message;
      return;
    }
    if (msg.type === 'log') {
      log.log(msg.message, 'info');
      return;
    }
    if (msg.type === 'error') {
      end(current, msg.message || 'OpenADS processing failed.', { success: false, error: true });
      return;
    }
    if (msg.type === 'result') {
      const { reporting, outputVolumes, elapsedSeconds } = msg.result;
      lastResult = msg.result;
      for (const vol of outputVolumes) {
        outputs[vol.key] = {
          label: vol.label,
          file: new File([vol.bytes], vol.filename, { type: 'application/gzip' }),
          isOverlay: Boolean(vol.isOverlay),
          editable: Boolean(vol.editable),
        };
      }
      const downloads = buildDownloads(reporting);
      const reportFile = downloads[0].file;
      const vascCsvFile = downloads.find((d) => d.file.name.includes('VASCULAR_QFV'))?.file;
      let cohortCsvFile = null;
      if (reporting.cohortRefs?.lobe && reporting.qfv?.lobe) {
        const proj = projectSubjectOntoCohort({
          qfvByRegion: reporting.qfv.lobe.byRegion,
          refData: reporting.cohortRefs.lobe,
          kNeighbors: cohortK,
        });
        cohortCsvFile = new File(
          [cohortSummaryCsv(proj.summary)],
          `${subjectId}_strokeview_lobe_neighbors.csv`,
          { type: 'text/csv' },
        );
      }

      const summary = $('summaryMetrics');
      summary.hidden = false;
      summary.replaceChildren(
        createElement('p', {
          className: 'nd-hint',
          text: `Core ${reporting.volumes.totalMl.toFixed(1)} mL · ASPECTS ${reporting.report.aspectsScore ?? 'N.A.'}/10${reporting.mismatch ? ` · HP ${reporting.mismatch.hpMl.toFixed(1)} mL` : ''}`,
        }),
      );

      renderReportView($('reportView'), {
        ...reporting,
        defaultK: cohortK,
        downloads,
      });

      if (outputs.dwi_mni) view.baseKey = 'dwi_mni';
      else if (outputs.adc_mni) view.baseKey = 'adc_mni';
      if (outputs.stroke_mni) view.overlayKey = 'stroke_mni';

      $('outputSection').open = true;
      renderResultList();
      activeViewTab = 'report';
      toolbar.setActive('report');
      setReportVisible(true);
      await show();

      const lesionFile = outputs.stroke_mni?.file || outputs.input_mask?.file;
      const artifacts = [
        ...(lesionFile ? [{ role: 'lesion_mask', file: lesionFile }] : []),
        { role: 'radiological_report', file: reportFile },
        ...(vascCsvFile ? [{ role: 'qfv_vascular', file: vascCsvFile }] : []),
        ...(cohortCsvFile ? [{ role: 'cohort_summary', file: cohortCsvFile }] : []),
      ];

      end(current, `Done in ${elapsedSeconds}s — ${reporting.volumes.totalMl.toFixed(2)} mL, ASPECTS ${reporting.report.aspectsScore ?? 'N.A.'}.`, {
        success: true,
        value: {
          artifacts,
          measurements: {
            subjectId,
            lesionVolumeMl: reporting.volumes.totalMl,
            aspectsScore: reporting.report.aspectsScore,
            hydrocephalus: reporting.hydrocephalus?.predict ?? null,
            mismatchVolumeMl: reporting.mismatch?.mismatchVolumeMl ?? null,
          },
        },
      });
    }
  };

  worker.onerror = (event) => {
    end(current, event.message || 'OpenADS worker crashed.', { success: false, error: true });
  };

  worker.postMessage({
    mode: plan.mode,
    subjectId,
    files: selectedFiles,
    runSyn,
    runShap,
    threshold,
    assetBase: new URL('./', window.location.href).href,
  });

  return completion;
}

$('runButton').addEventListener('click', () => {
  void runAnalysis().catch(() => {});
});

$('cancelButton').addEventListener('click', () => {
  if (!job) return;
  job.controller.abort(new DOMException('Cancelled by user.', 'AbortError'));
  end(job, 'Cancelled.', { success: false });
});

registerAppAutomation({
  app: APP.id,
  operations: {
    analyze: async ({ inputs, parameters, signal }) => {
      const incoming = [];
      const explicitRoles = {};
      for (const { role } of ROLES) {
        const list = inputs?.[role];
        if (list?.length) {
          explicitRoles[role] = incoming.length;
          incoming.push(list[0]);
        }
      }
      if (!incoming.length) throw new Error('Supply DWI+b0/ADC or an MNI152 stroke mask.');
      await loadInputFiles(incoming, explicitRoles);
      if (parameters?.runSyn !== undefined) $('runSyn').checked = Boolean(parameters.runSyn);
      if (parameters?.runShap !== undefined) $('runShap').checked = Boolean(parameters.runShap);
      if (parameters?.threshold !== undefined) $('threshold').value = String(parameters.threshold);
      if (parameters?.cohortK !== undefined) $('cohortK').value = String(parameters.cohortK);
      return runAbortable(signal, () => runAnalysis(parameters || {}), () => {
        if (job) {
          job.controller.abort(new DOMException('Aborted.', 'AbortError'));
          end(job, 'Cancelled.', { success: false });
        }
      });
    },
  },
  reset: () => {
    if (job) {
      job.controller.abort(new DOMException('Reset.', 'AbortError'));
      end(job, 'Ready', { success: false });
    }
    files = [];
    assigned = Object.fromEntries(ROLES.map(({ role }) => [role, null]));
    renderInputs();
    clearResults();
    progress.reset();
    activeViewTab = 'multiplanar';
    toolbar.setActive('multiplanar');
    setReportVisible(false);
  },
  viewer: () => viewer,
});

refreshControls();
