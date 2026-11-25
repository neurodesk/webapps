// LCModel webapp: FID-A preprocessing and LCModel fitting of single-voxel MRS,
// both in a worker (see lcmodel-worker.js). The page sorts the dropped files,
// recommends a basis set, and shows the fit, the metabolite table and the
// preprocessing quality checks. Several datasets (a folder of subjects) are
// fitted one after the other into a group table (group.js, group-view.js);
// every fit has a printable report (report.js).
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./styles.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  renderInfoIcon,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { zipSync, strToU8 } from "fflate";
import { runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import manifest from "@neurodesk/lcmodel/manifest" with { type: "json" };
import examples from "../examples.json" with { type: "json" };
import { APP } from "./config.js";
import { basisLibrary } from "@neurodesk/lcmodel/library";
import { rankBases, assessBasis, hasBasisMacromolecules } from "@neurodesk/lcmodel/basis-select";
import { sortInputs, textHead, parseControl } from "@neurodesk/lcmodel/inputs";
import { spectrumSvg, fitSeries, metaboliteSeries } from "@neurodesk/lcmodel/spectrum-plot";
import { STATUS, fileStem, groupCsvLong, groupCsvWide, metaboliteNames } from "@neurodesk/lcmodel/group";
import { parseEventsText } from "@neurodesk/lcmodel/fmrs";
import { qcTimeCourseSvg, timeCourseSvg, transientDriftSvg } from "@neurodesk/lcmodel/fmrs-plot";
import { formatConc, SD_LIMIT } from "@neurodesk/lcmodel/report";
import {
  CUSTOM,
  acquisitionMessage,
  applyEditing,
  RANGES,
  checkBasis,
  datasetLabel as labelOf,
  defaultRangeText as rangeTextOf,
  describeDataset as describeOf,
  failedEntry,
  fidaInput,
  fitDataset as fitInput,
  fitFmrsDataset,
  fitPlanned,
  fitSummary,
  fmrsResultTexts,
  groupMeasurements,
  groupRecords as recordsOf,
  headerFor as headerOf,
  isEdited as editedOf,
  loadMessages,
  parseCustomBasis,
  planGroup,
  rangeUntouched,
  rawInput,
  reportHtml as reportOf,
  reportVersions,
  resultTexts,
  settingsFrom,
  summarizeReport,
} from "@neurodesk/lcmodel/pipeline";
import { renderFmrsTables } from "./fmrs-view.js";
import { renderGroupTable } from "./group-view.js";
import { createTissuePanel } from "./tissue-panel.js";
import { createWorkerSession } from "./worker-session.js";

const $ = (id) => document.getElementById(id);
const VERSIONS = Object.freeze(reportVersions(`LCModel web app ${APP.version}`));

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "LCModel",
  subtitle: "FID-A preprocessing and LCModel fitting",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const VIEWS = [
  { id: "fit", label: "Fit" },
  { id: "metabolites", label: "Metabolites" },
  { id: "preprocessing", label: "Preprocessing" },
  { id: "fmrs", label: "Time course" },
  { id: "voxel", label: "Voxel" },
  { id: "group", label: "Group" },
];
// The group table shows concentrations or ratios; how it is displayed belongs in the toolbar.
const groupShow = document.createElement("select");
groupShow.id = "groupShow";
groupShow.setAttribute("aria-label", "Group table values");
groupShow.hidden = true;
groupShow.append(new Option("Concentrations", "concentration"), new Option("Ratios", "ratio"), new Option("Tissue-corrected", "tissue"));
const fmrsPanelSelect = document.createElement("select");
fmrsPanelSelect.id = "fmrsPanel";
fmrsPanelSelect.setAttribute("aria-label", "Time course view");
fmrsPanelSelect.hidden = true;
fmrsPanelSelect.append(
  new Option("Metabolite time course", "metabolite"),
  new Option("QC time courses", "qc"),
  new Option("Transient drift", "transients"),
  new Option("Contrasts & windows", "stats"),
);
const fmrsMetabSelect = document.createElement("select");
fmrsMetabSelect.id = "fmrsMetabolite";
fmrsMetabSelect.setAttribute("aria-label", "Metabolite to plot");
fmrsMetabSelect.hidden = true;
const toolbar = createViewerToolbar({
  views: VIEWS.map((v) => ({ ...v, disabled: true, onClick: () => showView(v.id) })),
  viewsLabel: "Plot",
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [groupShow, fmrsPanelSelect, fmrsMetabSelect],
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog" });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

// Optional tissue correction: T1, segmentation, voxel fractions (tissue-panel.js).
const tissue = createTissuePanel({
  status: (message, error) => status(message, error),
  log,
  progress,
  setBusy: (value) => setBusy(value),
  onChange: () => fit && renderConcentrations(),
  onViewAvailable: (available) => setViewEnabled("voxel", available),
  onViewRequested: () => {
    $("outputSection").open = true;
    showView("voxel");
  },
  onT1Replace: () => {
    if (syncQueuedImport) {
      syncQueuedImport.t1 = { clear: true };
      return;
    }
    if (syncImportController) {
      pendingDroppedT1 = { controller: syncImportController, clear: true };
      return;
    }
    if (busy && !importAbort) return;
    const entry = { clear: true };
    syncDroppedT1 = entry;
    queueMicrotask(() => {
      if (syncDroppedT1 !== entry) return;
      syncDroppedT1 = null;
      if (!syncQueuedImport && !syncImportController && !busy) tissue.reset();
    });
  },
  onT1Input: (files) => {
    if (syncQueuedImport) {
      syncQueuedImport.t1 = { files };
      return true;
    }
    if (syncImportController) {
      pendingDroppedT1 = { controller: syncImportController, files };
      return true;
    }
    if (busy) {
      if (importAbort) {
        const entry = { files };
        syncDroppedT1 = entry;
        queueMicrotask(() => {
          if (syncDroppedT1 === entry) syncDroppedT1 = null;
        });
      }
      return true;
    }
    return false;
  },
});
toolbar.actions.append(...tissue.viewControls);
$("resultList").before(...tissue.outputControls);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About LCModel", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const library = basisLibrary(manifest);
const results = createResultList({
  element: $("resultList"),
  onView: (stage, result) => {
    if (stage === "fitReport" || stage === "fmrsReport") openReport(result);
    else if (stage.startsWith("fmrs")) showView("fmrs");
    else if (stage.startsWith("group")) showView("group");
    else if (["gmMap", "wmMap", "csfMap"].includes(stage)) {
      showView("voxel");
      void tissue.show(stage.slice(0, -3));
    } else showView(stage === "preprocessing" ? "preprocessing" : stage === "voxelMask" ? "voxel" : "fit");
  },
  onDownload: (_stage, result) => result && downloadFile(result.file ?? result.make()),
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The loaded input: FID-A datasets or an LCModel .RAW (direct). */
let input = null;
let spectraSessionId = 0; // increments only on spectroscopy replacement, not water-reference updates
let customBasis = null; // { name, text, header, sha256?, file? }
let basisGeneration = 0;
let activeBasisReadGen = null; // basisGeneration of the current in-flight loadBasisFile read
let pendingDeferredBasis = null; // { gen, basis, file } finished reading while an import was busy
/** Each dataset's last fit, fitted, failed or cancelled, by dataset index. */
const fits = new Map();
let processed = null; // FID-A result shown in the viewer
let fit = null; // parsed LCModel output shown in the viewer
let activeEntry = null; // entry currently shown in the viewer (conventional, grand mean, or fMRS window)
let fmrsEvents = null; // { name, events, file }
let eventsGeneration = 0;
let activeEventsReadGen = null; // eventsGeneration of the current in-flight loadEventsFile read
let pendingDeferredEvents = null; // { gen, name, events, file, ownerSession } finished reading while busy on same spectrum
let syncDroppedEvents = null; // { files, clear } delivered to #eventsInput earlier in the same synchronous drop turn
let syncImportController = null; // AbortController started in the current synchronous drop/Undo turn
let pendingDroppedEvents = null; // { controller, files, clear } delivered in the same synchronous turn as loadFiles
let syncDroppedBasis = null; // { file, clear } delivered to #basisInput earlier in the same synchronous turn
let pendingDroppedBasis = null; // { controller, file, clear } delivered in the same synchronous turn as loadFiles
let syncDroppedT1 = null; // { files, clear } delivered to #t1Input earlier in the same synchronous turn
let pendingDroppedT1 = null; // { controller, files, clear } delivered in the same synchronous turn as loadFiles
const waterTargetByFile = new WeakMap(); // File -> targetPath[] committed for Undo restoration
let undoWaterSnapshot = null; // { files, groups } committed water assignments before the last input commit
let undoSessionState = null; // { files, mode, selectedPath, editOverrides } for Undo restoration
let syncDroppedWater = null; // File[] delivered to #waterInput for a queued Undo import
let pendingDroppedWater = null; // { controller, files } delivered to #waterInput in the same synchronous turn as loadFiles
let queuedImport = null; // { files, options, events, waterFiles, basis, t1 } queued to supersede an in-flight import (e.g. Undo)
let syncQueuedImport = null; // queuedImport created in the current synchronous drop/Undo turn
let fmrsResult = null; // completed fMRS run
let fmrsWindowIndex = -1;
let view = "fit";
let busy = false;
let runAbort = null; // a group run's stop signal (the footer ×)

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

// ---------------------------------------------------------------------------
// Worker: one job at a time; Cancel terminates it (the module state goes too).
// ---------------------------------------------------------------------------

let worker = null;
let importAbort = null;
let workerProgress = null; // a group run maps each dataset's progress into its share

function ensureWorker() {
  if (worker) return worker;
  worker = createWorkerSession(reportWorkerProgress);
  return worker;
}

function reportWorkerProgress(fraction, text) {
  if (workerProgress) workerProgress(fraction, text);
  else progress.setProgress(fraction, text);
}

function runJob(job, transfer = []) {
  return ensureWorker().run(job, transfer);
}

/** The shared pipeline's engine: FID-A and LCModel in the worker. */
const engine = {
  async process(k, options) {
    await ensureLoaded();
    return runJob({ type: "process", dataset: k, options });
  },
  async processFmrs(k, options) {
    await ensureLoaded();
    return runJob({ type: "processFmrs", dataset: k, options });
  },
  fit: (request) => runJob({ type: "fit", ...request }),
};

function cancelWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  // The module's loaded datasets went with the worker; ensureLoaded reads them again.
  if (input?.kind === "fida") input.stale = true;
}

/** Read the files into a fresh worker after Cancel, or after a WebAssembly trap. */
async function ensureLoaded() {
  if (input?.kind !== "fida" || !input.stale) return;
  progress.setIndeterminate("Reading the data again…");
  const payload = await Promise.all(input.sources.map(async (s) => ({ name: s.name, bytes: await s.file.arrayBuffer() })));
  const loaded = await runJob({ type: "load", files: payload, options: input.loadOptions }, payload.map((f) => f.bytes));
  if (loaded.error) throw new Error(loaded.error);
  if (loaded.datasets.length !== input.datasets.length) throw new Error("The files changed since they were loaded. Load them again.");
  input.stale = false;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function flushDeferredReads() {
  if (busy) return;
  if (pendingDeferredBasis && pendingDeferredBasis.gen === basisGeneration) {
    const deferred = pendingDeferredBasis;
    pendingDeferredBasis = null;
    setCustomBasis(deferred.basis.name, deferred.basis.text, deferred.file);
    log.log(`${deferred.file.name} loaded as the basis set`);
  } else {
    pendingDeferredBasis = null;
  }
  if (pendingDeferredEvents && pendingDeferredEvents.gen === eventsGeneration) {
    const deferred = pendingDeferredEvents;
    pendingDeferredEvents = null;
    if (spectraSessionId === deferred.ownerSession) {
      commitParsedEvents(deferred.name, deferred.events, deferred.file);
      log.log(`${deferred.name} loaded (${deferred.events.length} stimulus events)`);
    } else {
      clearEvents({ notify: true });
    }
  } else {
    pendingDeferredEvents = null;
  }
}

function setBusy(value) {
  busy = value;
  $("dataInput").disabled = value;
  $("folderInput").disabled = value;
  $("datasetSelect").disabled = value;
  $("waterInput").disabled = value || !input;
  $("basisInput").disabled = value;
  $("eventsInput").disabled = value;
  $("clearEventsBtn").disabled = value;
  $("editedToggle").disabled = value;
  tissue.setDisabled(value);
  exampleControl.setDisabled(value);
  if (!value) flushDeferredReads();
  updateRunButton();
}

function clearFmrsResult() {
  if (!fmrsResult) return;
  const showingFmrsEntry = Boolean(
    activeEntry && (activeEntry === fmrsResult.grandEntry || fmrsResult.windows.some((w) => w.entry === activeEntry)),
  );
  fmrsResult = null;
  fmrsWindowIndex = -1;
  setViewEnabled("fmrs", false);
  if (showingFmrsEntry) {
    clearResults();
  } else {
    if (view === "fmrs") showView(fit ? "fit" : hasGroup() ? "group" : "fit");
    renderResultList();
  }
}

function clearEvents({ notify = true, cancelPending = false } = {}) {
  eventsGeneration += 1;
  pendingDeferredEvents = null;
  fmrsEvents = null;
  $("eventsInfo").hidden = true;
  $("eventsInfo").textContent = "";
  $("clearEventsBtn").hidden = true;
  $("eventsDrop").classList.remove("has-files");
  clearFmrsResult();
  if (notify) {
    // Keep pageDrop's Undo snapshot in sync so Undo never resurrects an explicitly cleared
    // schedule, while still letting a spectra-only drop record the cleared schedule for Undo.
    const detail = cancelPending ? { files: [], cancelPending: true } : { files: [], restoreWithUndo: true };
    $("eventsInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail }));
  }
  updateRunButton();
}

function datasetCount() {
  return input?.kind === "fida" ? input.datasets.length : 0;
}

function fmrsActive() {
  return $("fmrsMode").value !== "off";
}

function updateFmrsControls() {
  const mode = $("fmrsMode").value;
  $("fmrsWindowRow").hidden = mode !== "sliding";
  $("fmrsControls").hidden = mode === "off";
  updateRunButton();
}

function fmrsEligible(k = input?.index) {
  if (input?.kind !== "fida") return false;
  const h = input.datasets[k]?.header;
  if (!h) return false;
  if (isEdited(k)) return false;
  if ((h.subspectra ?? 1) > 1) return false;
  if ((h.averages ?? 0) < 2) return false;
  if (!(h.trMs > 0)) return false;
  return true;
}

const isReadingEvents = () => activeEventsReadGen !== null && activeEventsReadGen === eventsGeneration;
const isReadingBasis = () => activeBasisReadGen !== null && activeBasisReadGen === basisGeneration;

function updateRunButton() {
  const acquisitionOk = input?.kind !== "raw" || (acquisitionFromFields().hzpppm > 0 && acquisitionFromFields().deltat > 0);
  const basisOk = $("basisSelect").value !== CUSTOM || Boolean(customBasis);
  const mode = $("fmrsMode").value;
  const fmrsOn = mode !== "off";
  const fmrsEventsOk = !fmrsOn || mode === "sliding" || Boolean(fmrsEvents?.events?.length);
  const fmrsInputOk = !fmrsOn || fmrsEligible();
  const disabled = busy || isReadingEvents() || isReadingBasis() || !input || !acquisitionOk || !basisOk || !fmrsEventsOk || !fmrsInputOk;
  const many = datasetCount() > 1;
  $("runButton").disabled = disabled;
  $("runButton").textContent = fmrsOn ? "Run fMRS analysis" : many ? `Fit all ${datasetCount()} datasets` : "Preprocess and fit";
  $("runSelectedButton").hidden = !many || fmrsOn;
  $("runSelectedButton").disabled = disabled;
}

/** Clear the fit shown in the viewer and sidebar (stored fits stay). */
function clearResults() {
  processed = null;
  fit = null;
  activeEntry = null;
  fmrsWindowIndex = -1;
  $("concTable").hidden = true;
  $("fitSummary").hidden = true;
  $("plot").replaceChildren();
  $("viewerNotice").hidden = true;
  $("plotLabel").textContent = "";
  $("tissueAdvice").hidden = true;
  $("corrHeader").hidden = true;
  $("ratioHeader").hidden = false;
  $("concColumnField").hidden = true;
  tissue.hide();
  for (const v of VIEWS) if (v.id !== "group" && v.id !== "voxel" && v.id !== "fmrs") setViewEnabled(v.id, false);
  setViewEnabled("fmrs", Boolean(fmrsResult));
  renderResultList();
  $("outputSection").open = hasGroup() || Boolean(fmrsResult);
  if (view === "group" && !hasGroup()) showView("fit");
  if (view === "fmrs" && !fmrsResult) showView("fit");
}

function sourceFiles(files) {
  return files.map((file) => ({ name: file.webkitRelativePath || file._webkitRelativePath || file.name, file }));
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readSources(sources, signal) {
  return Promise.all(sources.map(async ({ name, file }) => {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await abortable(file.arrayBuffer(), signal));
    signal?.throwIfAborted();
    return { name, bytes, head: textHead(bytes), file };
  }));
}

function stageWaterFiles(targetPath, files) {
  const entries = sourceFiles(files);
  const flat = entries.length > 0 && entries.every((s) => !s.name.includes("/"));
  const folder = flat ? `${fileStem(entries[0].name)}/` : "";
  const prefix = `water-references/${encodeURIComponent(targetPath)}/${folder}`;
  return entries.map((source) => ({ ...source, name: `${prefix}${source.name}` }));
}

function waterSources(files) {
  if (!input) throw new Error("Load a spectrum before adding its water reference.");
  const applyAll = datasetCount() > 1 && $("waterAllToggle").checked;
  const targetPath = applyAll ? "*" : input.datasets[input.index].path;
  const previous = (input.loadOptions?.water ?? []).filter((w) => w.targetPath !== "*");
  const allPrevWaterNames = new Set((input.loadOptions?.water ?? []).flatMap((w) => w.files ?? []));
  const metabSources = input.sources.filter((s) => !allPrevWaterNames.has(s.name));
  if (applyAll) {
    const added = stageWaterFiles("*", files);
    return {
      applyAll: true,
      files,
      sources: [...metabSources, ...added],
      options: { water: [{ targetPath: "*", files: added.map((s) => s.name) }] },
      targetPath: input.datasets[input.index].path,
      previous,
      metabSources,
      prevSources: input.sources,
    };
  }
  const keptPrev = previous.filter((w) => w.targetPath !== targetPath);
  const keptPrevNames = new Set(keptPrev.flatMap((w) => w.files ?? []));
  const added = stageWaterFiles(targetPath, files);
  const sources = [...metabSources, ...input.sources.filter((s) => keptPrevNames.has(s.name)), ...added];
  return {
    applyAll: false,
    files,
    sources,
    options: { water: [...keptPrev, { targetPath, files: added.map((s) => s.name) }] },
    targetPath,
    previous,
    metabSources,
    prevSources: input.sources,
  };
}

function committedWaterGroups(fida) {
  if (fida?.kind !== "fida" || !fida.loadOptions?.water?.length) return [];
  const byName = new Map(fida.sources.map((s) => [s.name, s.file]));
  const groups = [];
  for (const entry of fida.loadOptions.water) {
    const files = (entry.files ?? []).map((name) => byName.get(name)).filter(Boolean);
    if (files.length) groups.push({ targetPath: entry.targetPath, files });
  }
  return groups;
}

function syncWaterTargets(fida) {
  const byFile = new Map();
  for (const { targetPath, files } of committedWaterGroups(fida)) {
    for (const file of files) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(targetPath);
    }
  }
  for (const [file, targets] of byFile) waterTargetByFile.set(file, targets);
}

function buildRestoredWaterAssignment(metabSources, waterFiles) {
  let groups;
  if (undoWaterSnapshot && sameFileList(undoWaterSnapshot.files, waterFiles)) {
    groups = undoWaterSnapshot.groups;
  } else {
    const byTarget = new Map();
    for (const file of waterFiles) {
      const raw = waterTargetByFile.get(file);
      const targets = Array.isArray(raw) ? raw : [raw ?? "*"];
      for (const targetPath of targets) {
        if (!byTarget.has(targetPath)) byTarget.set(targetPath, []);
        byTarget.get(targetPath).push(file);
      }
    }
    groups = [...byTarget.entries()].map(([targetPath, files]) => ({ targetPath, files }));
  }
  const waterOpts = [];
  const combined = [...metabSources];
  for (const { targetPath, files } of groups) {
    const added = stageWaterFiles(targetPath, files);
    combined.push(...added);
    waterOpts.push({ targetPath, files: added.map((s) => s.name) });
  }
  return { sources: combined, options: { water: waterOpts } };
}

function chooseAnatomy(images, signal, optional) {
  if (images.length === 1) return Promise.resolve(images[0]);
  const field = $("anatomySeriesField");
  const select = $("anatomySeries");
  field.hidden = false;
  $("tissueSection").open = true;
  select.replaceChildren(new Option("Choose the T1 series…", ""), ...images.map((image, index) => new Option(image.name, String(index))));
  if (optional) select.add(new Option("None", "none"));
  status("Choose the T1 anatomical series to finish importing.");
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      field.hidden = true;
      select.removeEventListener("change", choose);
      signal.removeEventListener("abort", abort);
    };
    const choose = () => {
      if (select.value === "") return;
      const image = select.value === "none" ? null : images[Number(select.value)];
      cleanup();
      resolve(image);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    select.addEventListener("change", choose);
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
  });
}

function residentSpectraFiles() {
  if (!input) return [];
  if (input.kind === "fida") {
    const waterNames = new Set((input.loadOptions?.water ?? []).flatMap((w) => w.files ?? []));
    return input.sources.filter((s) => !waterNames.has(s.name)).map((s) => s.file).filter(Boolean);
  }
  return [...(input.rawFiles ?? []), ...(input.bundledWaterFile ? [input.bundledWaterFile] : [])];
}

function residentWaterFiles() {
  if (!input) return [];
  if (input.kind === "fida") {
    const waterNames = new Set((input.loadOptions?.water ?? []).flatMap((w) => w.files ?? []));
    return [...new Set(input.sources.filter((s) => waterNames.has(s.name)).map((s) => s.file).filter(Boolean))];
  }
  return input.attachedWaterFile ? [input.attachedWaterFile] : [];
}

const sameFileList = (a, b) => a.length === b.length && a.every((file, idx) => file === b[idx]);

async function stageAnatomy({ request, change, images, sources, pairedT1, signal }) {
  if (request.kind === "fit-request") {
    if (!request.inputs.t1?.length) return { kind: "keep" };
    return { kind: "replace", prepared: await tissue.prepareT1(request.inputs.t1, signal) };
  }
  if (pairedT1?.clear) return { kind: "clear" };
  if (pairedT1?.files?.length) {
    if (sameFileList(pairedT1.files, tissue.files)) return { kind: "keep" };
    return { kind: "replace", prepared: await tissue.prepareT1(pairedT1.files, signal) };
  }
  if (change.kind === "water-reference" || !images.length) return { kind: "keep" };
  const optional = change.kind === "replacement";
  const image = await chooseAnatomy(images, signal, optional);
  signal.throwIfAborted();
  if (!image) return { kind: "clear" };
  const original = new Map(sources.map((source) => [source.name, source.file]));
  try {
    return { kind: "replace", prepared: await tissue.prepareT1(image.files.map((name) => original.get(name)), signal) };
  } catch (error) {
    signal.throwIfAborted();
    if (!optional) throw error;
    return { kind: "clear", warning: `Anatomy skipped: ${error.message}` };
  }
}

async function loadFiles(request, signal) {
  const automation = request.kind === "fit-request";
  const rawFiles = automation ? request.inputs.spectra : request.files;
  let water = request.kind === "water-reference";
  const isScheduleFile = (file) => /\.(tsv|csv)$/i.test(file.name);
  const bundledEvents = !automation && !water ? rawFiles.filter(isScheduleFile) : [];
  const files = bundledEvents.length ? rawFiles.filter((file) => !isScheduleFile(file)) : rawFiles;
  const p = automation ? request.parameters : {};
  const settings = settingsFrom(p);
  const fractionKeys = ["fractionGM", "fractionWM", "fractionCSF"];
  const given = fractionKeys.filter((key) => typeof p[key] === "number");
  if (automation && !files?.length) throw new Error("No spectroscopy data found among the files.");
  if (given.length && given.length < 3) throw new Error("Give all three tissue fractions (fractionGM, fractionWM, fractionCSF), or none.");
  if (given.length && request.inputs.t1?.length) throw new Error("Give either a T1 image or tissue fractions, not both.");
  if (busy) throw new Error("Files are still loading. Wait or cancel, then retry.");
  if (water && !input) throw new Error("Load a spectrum before adding its water reference.");
  let committed = false;
  let replacedSpectra = false;
  const controller = new AbortController();
  importAbort = controller;
  if (!automation) {
    syncImportController = controller;
    queueMicrotask(() => {
      if (syncImportController === controller) syncImportController = null;
    });
    if (!water) {
      // Capture resident auxiliary inputs onto any active pageDrop Undo snapshot
      // synchronously before the first await so immediate Undo (mid-read or mid-render)
      // restores explicit water references, schedules, custom bases, and T1 anatomy.
      const priorWater = residentWaterFiles();
      const priorEvents = fmrsEvents?.file ? [fmrsEvents.file] : [];
      const priorBasis = customBasis?.file ? [customBasis.file] : [];
      const priorT1 = tissue.files;
      if (priorWater.length) {
        $("waterInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: priorWater, restoreWithUndo: true } }));
      }
      if (priorEvents.length) {
        $("eventsInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: priorEvents, restoreWithUndo: true } }));
      }
      if (priorBasis.length) {
        $("basisInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: priorBasis, restoreWithUndo: true } }));
      }
      if (priorT1.length) {
        $("t1Input").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: priorT1, restoreWithUndo: true } }));
      }
    }
  }
  const earlyDroppedEvents = !automation ? syncDroppedEvents : null;
  syncDroppedEvents = null;
  const earlyDroppedBasis = !automation ? syncDroppedBasis : null;
  syncDroppedBasis = null;
  const earlyDroppedT1 = !automation ? syncDroppedT1 : null;
  syncDroppedT1 = null;
  const earlyDroppedWater = !automation ? syncDroppedWater : null;
  syncDroppedWater = null;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const importSignal = controller.signal;
  let candidate = null;
  const stopCandidate = () => candidate?.session.terminate();
  importSignal.addEventListener("abort", stopCandidate);
  setBusy(true);
  progress.begin(water ? "Reading the water reference…" : "Reading files…");
  status(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  try {
    // Allow any same-turn synchronous Undo/drop events (water, T1, basis, events) to land
    // before checking resident file identity, so anatomy-only Undo never reopens resident spectra.
    await Promise.resolve();
    importSignal.throwIfAborted();
    const pairedWater = !automation && !water
      ? ((pendingDroppedWater?.controller === controller ? pendingDroppedWater.files : null) ?? earlyDroppedWater)
      : null;
    if (pendingDroppedWater?.controller === controller) pendingDroppedWater = null;
    const unchangedSpectrum = !automation
      && !water
      && Boolean(input)
      && sameFileList(files, residentSpectraFiles())
      && sameFileList(pairedWater ?? [], residentWaterFiles());
    const read = unchangedSpectrum ? [] : await readSources(sourceFiles(files), importSignal);
    const sorted = sortInputs(read);
    const decode = (file) => new TextDecoder().decode(file.bytes);
    let basis = automation && request.inputs.basis?.length
      ? { ...(await readBasisFile(request.inputs.basis[0])), file: request.inputs.basis[0] }
      : sorted.basis.length ? { ...parseCustomBasis(sorted.basis[0].name, decode(sorted.basis[0])), file: sorted.basis[0].file } : null;
    const control = sorted.control.length ? parseControl(decode(sorted.control[0])) : null;
    let change = { kind: "none" };
    let images = [];
    let sources = [];
    let wildcardWater = null;
    if (unchangedSpectrum) {
      // Undo after an anatomy-only or auxiliary-only drop replays the already-resident
      // spectrum files; preserve resident acquisition fields, fits, and fMRS results.
    } else if (!automation && input?.kind === "raw" && (water || (!sorted.raw.length && sorted.water.length))) {
      const references = [...sorted.raw, ...sorted.water];
      if (references.length !== 1 || sorted.other.length) throw new Error("Choose one LCModel .H2O or water .RAW reference for this .RAW spectrum.");
      const reference = rawInput({ name: input.name, text: input.text, waterName: references[0].name, water: decode(references[0]), control: input.header });
      change = {
        kind: "water-reference",
        input: { ...input, waterName: reference.waterName, water: reference.water, attachedWaterFile: references[0].file ?? null },
      };
      water = true;
    } else if (!water && sorted.raw.length) {
      let attachedWaterFile = null;
      let waterName = sorted.water[0]?.name ?? null;
      let waterText = sorted.water.length ? decode(sorted.water[0]) : null;
      if (pairedWater?.length === 1) {
        const [wf] = pairedWater;
        const wBytes = new Uint8Array(await abortable(wf.arrayBuffer(), importSignal));
        importSignal.throwIfAborted();
        waterName = wf.name;
        waterText = new TextDecoder().decode(wBytes);
        attachedWaterFile = wf;
      }
      change = {
        kind: "replacement",
        input: {
          ...rawInput({ name: sorted.raw[0].name, text: decode(sorted.raw[0]), waterName, water: waterText, control }),
          rawFiles: [...sorted.raw, ...sorted.control].map((s) => s.file).filter(Boolean),
          bundledWaterFile: sorted.water[0]?.file ?? null,
          attachedWaterFile,
        },
      };
      if (sorted.other.length) {
        candidate = await stageFida(sorted.other, importSignal);
        if (candidate.loaded.datasets.length) throw new Error("Import LCModel .RAW and vendor spectra separately.");
        images = candidate.loaded.images ?? [];
        sources = sorted.other;
      }
    } else if (sorted.other.length || water) {
      let assignment = water ? waterSources(files) : null;
      let restoredWaterOptions = null;
      let inputs;
      if (assignment) {
        inputs = await readSources(assignment.sources, importSignal);
      } else if (pairedWater?.length) {
        const restored = buildRestoredWaterAssignment(
          sorted.other.map(({ name, file }) => ({ name, file })),
          pairedWater,
        );
        restoredWaterOptions = restored.options;
        inputs = await readSources(restored.sources, importSignal);
      } else {
        inputs = sorted.other;
      }
      candidate = await stageFida(inputs, importSignal, assignment?.options ?? restoredWaterOptions ?? undefined);
      if (!automation && !water && !candidate.loaded.datasets.length && candidate.loaded.unpairedWater?.length && input?.kind === "fida") {
        candidate.session.terminate();
        assignment = waterSources(files);
        inputs = await readSources(assignment.sources, importSignal);
        candidate = await stageFida(inputs, importSignal, assignment.options);
        water = true;
      }
      let loaded = candidate.loaded;
      wildcardWater = assignment ? (loaded.wildcardWater ?? null) : null;
      let finalSources = inputs;
      let finalOptions = assignment?.options ?? restoredWaterOptions ?? undefined;
      if (assignment?.applyAll && loaded.datasets.length) {
        // Materialize wildcard "*" into per-dataset targetPath entries for the datasets that
        // accepted the shared file, preserving any previously attached references on skipped
        // datasets and leaving no stale "*" entry that could reject later individual replacements.
        const wildcardPrefix = `water-references/${encodeURIComponent("*")}/`;
        const acceptedPaths = loaded.datasets
          .filter((d) => d.waterPath?.startsWith(wildcardPrefix))
          .map((d) => d.path);
        const acceptedSet = new Set(acceptedPaths);
        const keptPrev = assignment.previous.filter((w) => !acceptedSet.has(w.targetPath));
        const keptPrevNames = new Set(keptPrev.flatMap((w) => w.files ?? []));
        const prevWaterSources = assignment.prevSources.filter((s) => keptPrevNames.has(s.name));
        const acceptedAdded = [];
        const acceptedOpts = [];
        for (const tp of acceptedPaths) {
          const added = stageWaterFiles(tp, assignment.files);
          acceptedAdded.push(...added);
          acceptedOpts.push({ targetPath: tp, files: added.map((s) => s.name) });
        }
        const mergedSources = [...assignment.metabSources, ...prevWaterSources, ...acceptedAdded];
        const mergedOptions = { water: [...keptPrev, ...acceptedOpts] };
        if (keptPrev.length > 0) {
          candidate.session.terminate();
          finalSources = await readSources(mergedSources, importSignal);
          candidate = await stageFida(finalSources, importSignal, mergedOptions);
          loaded = candidate.loaded;
        } else {
          finalSources = mergedSources;
        }
        finalOptions = mergedOptions;
      }
      const imageNames = new Set((loaded.images ?? []).flatMap((image) => image.files));
      images = loaded.images ?? [];
      sources = finalSources;
      if (loaded.datasets.length) {
        const next = {
          ...fidaInput(loaded),
          sources: finalSources.filter((s) => !imageNames.has(s.name)).map(({ name, file }) => ({ name, file })),
          loadOptions: finalOptions,
        };
        if (assignment) {
          const overrides = new Map(input.datasets.map((dataset) => [dataset.path, dataset.editOverride]));
          for (const dataset of next.datasets) if (overrides.has(dataset.path)) dataset.editOverride = overrides.get(dataset.path);
          next.index = next.datasets.findIndex((d) => d.path === assignment.targetPath);
        }
        if (next.index < 0) throw new Error("The selected spectrum could not be paired with this water reference.");
        change = { kind: assignment ? "water-reference" : "replacement", input: next };
      }
    } else if (sorted.water.length) {
      throw new Error("Only a water reference was found. Load its spectrum first, then add the reference.");
    } else if (!basis) {
      throw new Error("No spectroscopy data found among the files.");
    }
    const pairedT1 = !automation
      ? ((pendingDroppedT1?.controller === controller ? pendingDroppedT1 : null) ?? earlyDroppedT1)
      : null;
    if (pendingDroppedT1?.controller === controller) pendingDroppedT1 = null;
    const pairedBasis = !automation
      ? ((pendingDroppedBasis?.controller === controller ? pendingDroppedBasis : null) ?? earlyDroppedBasis)
      : null;
    if (pendingDroppedBasis?.controller === controller) pendingDroppedBasis = null;
    if (!basis && pairedBasis?.file && customBasis?.file !== pairedBasis.file) {
      basis = { ...(await readBasisFile(pairedBasis.file)), file: pairedBasis.file };
      importSignal.throwIfAborted();
    }
    const anatomy = await stageAnatomy({ request, change, images, sources, pairedT1, signal: importSignal });
    if (!unchangedSpectrum && change.kind === "none" && !basis && anatomy.kind !== "replace") {
      const loaded = candidate?.loaded;
      const first = loaded?.errors[0];
      throw new Error(loaded?.unpairedWater?.length ? "Only a water reference was found. Load its spectrum first, then add the reference." : first ? `${first.file}: ${first.error}` : "No readable spectroscopy data found.");
    }
    if (automation && change.kind !== "replacement") throw new Error("No spectroscopy data found among the supplied spectra files.");
    const next = change.kind === "none" ? null : change.input;
    if (automation && typeof p.edited === "boolean") applyEditing(next, p.edited);
    // Read any paired dropped or co-selected events file BEFORE clearing importAbort or mutating
    // `input`, so Undo or Cancel while the schedule read is pending cleanly aborts the whole import.
    let droppedEvents = null;
    if ((next || unchangedSpectrum) && !automation) {
      const pairedEvents = (pendingDroppedEvents?.controller === controller ? pendingDroppedEvents : null)
        ?? earlyDroppedEvents;
      if (pendingDroppedEvents?.controller === controller) pendingDroppedEvents = null;
      const evFiles = pairedEvents?.files ?? (bundledEvents.length ? bundledEvents : null);
      if (pairedEvents?.clear) {
        droppedEvents = { clear: true };
      } else if (evFiles?.length === 1) {
        const [evFile] = evFiles;
        if (!(unchangedSpectrum && evFile === fmrsEvents?.file)) {
          try {
            const evText = await abortable(evFile.text(), importSignal);
            importSignal.throwIfAborted();
            droppedEvents = { file: evFile, events: parseEventsText(evText) };
          } catch (evError) {
            if (evError.name === "AbortError") throw evError;
            droppedEvents = { file: evFile, error: evError.message };
          }
        }
      } else if (evFiles?.length > 1) {
        droppedEvents = { ambiguous: evFiles.length };
      }
    }
    importSignal.throwIfAborted();
    importSignal.removeEventListener("abort", stopCandidate);
    signal?.removeEventListener("abort", abort);
    committed = true;
    replacedSpectra = Boolean(next && change.kind === "replacement");
    if (automation) {
      basisGeneration += 1;
      pendingDeferredBasis = null;
      customBasis = null;
      $("basisDrop").classList.remove("has-files");
      tissue.reset();
      $("removeBad").checked = settings.preprocessing.removeBadAverages;
      $("badSd").value = settings.preprocessing.badAverageSd ?? "";
      $("driftCorrection").checked = settings.preprocessing.driftCorrection;
      $("phaseReference").checked = settings.preprocessing.phaseAndReference;
      $("metabRelax").checked = p.metaboliteRelaxation ?? true;
      $("mmModel").value = settings.mmModel;
      $("lineBroadening").value = settings.lineBroadening;
      $("simulateMm").checked = settings.simulateMacromolecules;
      $("baselineStiffness").value = settings.baselineStiffness ?? "";
      $("fmrsMode").value = "off";
      undoSessionState = null;
      updateFmrsControls();
    }
    if (next) {
      const prevGroups = committedWaterGroups(input);
      undoWaterSnapshot = prevGroups.length ? { files: residentWaterFiles(), groups: prevGroups } : null;
      const prevSpectra = residentSpectraFiles();
      const prevMode = $("fmrsMode").value;
      const prevSelectedPath = input?.kind === "fida" ? (input.datasets[input.index]?.path ?? null) : null;
      const prevEditOverrides = input?.kind === "fida"
        ? new Map(input.datasets.filter((d) => d.editOverride !== undefined).map((d) => [d.path, d.editOverride]))
        : null;
      const restoredSession = !automation && change.kind === "replacement" && undoSessionState && sameFileList(undoSessionState.files, files)
        ? undoSessionState
        : null;
      if (change.kind === "replacement" || change.kind === "water-reference") {
        undoSessionState = !automation && prevSpectra.length
          ? { files: prevSpectra, mode: prevMode, selectedPath: prevSelectedPath, editOverrides: prevEditOverrides }
          : null;
      }
      if (restoredSession && next.kind === "fida") {
        if (restoredSession.editOverrides?.size) {
          for (const ds of next.datasets) {
            if (restoredSession.editOverrides.has(ds.path)) ds.editOverride = restoredSession.editOverrides.get(ds.path);
          }
        }
        if (restoredSession.selectedPath) {
          const idx = next.datasets.findIndex((d) => d.path === restoredSession.selectedPath);
          if (idx >= 0) next.index = idx;
        }
      }
      worker?.terminate();
      worker = next.kind === "fida" ? candidate.session : null;
      if (next.kind === "fida") candidate = null;
      input = next;
      if (input.kind === "fida") syncWaterTargets(input);
      fits.clear();
      fmrsResult = null;
      fmrsWindowIndex = -1;
      if (change.kind === "replacement") {
        spectraSessionId += 1;
        if (pendingDroppedEvents?.controller === controller) pendingDroppedEvents = null;
        clearEvents({ notify: !automation && !droppedEvents?.events });
        if (!fmrsEligible()) {
          $("fmrsMode").value = "off";
          updateFmrsControls();
        } else if (restoredSession?.mode && $("fmrsMode").value !== restoredSession.mode) {
          $("fmrsMode").value = restoredSession.mode;
          updateFmrsControls();
        }
      }
      renderGroup();
      clearResults();
      if (input.kind === "raw") {
        const message = acquisitionMessage(input.name, input.header);
        log.log(message.text, message.level);
      }
      if (input.kind === "raw" && !water) {
        $("hzpppmInput").value = input.header.hzpppm ?? "";
        $("dwellInput").value = input.header.deltat ? +(input.header.deltat * 1000).toPrecision(6) : "";
      }
      if (automation) {
        if (p.frequencyMHz) $("hzpppmInput").value = String(p.frequencyMHz);
        if (p.dwellTimeMs) $("dwellInput").value = String(p.dwellTimeMs);
      }
      $("fileInfo").hidden = false;
      $("fileInfo").textContent = input.kind === "raw" ? input.name : input.sources.length > 6 ? `${input.sources.length} files` : input.sources.map((s) => s.file.name).join(", ");
      $("dropZone").classList.add("has-files");
      $("emptyState").textContent = datasetCount() > 1 ? "Data loaded. Check the basis set, then fit all datasets." : "Data loaded. Check the basis set, then preprocess and fit.";
      $("emptyState").hidden = false;
      showDataset();
    }
    if (droppedEvents?.events) {
      commitParsedEvents(droppedEvents.file.name, droppedEvents.events, droppedEvents.file);
    } else if (droppedEvents?.clear) {
      clearEvents({ notify: true });
    } else if (droppedEvents?.error) {
      clearEvents({ notify: true });
      log.log(`${droppedEvents.file.name}: ${droppedEvents.error}`, "warning");
    } else if (droppedEvents?.ambiguous) {
      clearEvents({ notify: true });
      log.log(`Found ${droppedEvents.ambiguous} tabular files (.tsv/.csv); choose the stimulus events schedule under Functional MRS.`, "warning");
    }
    if (basis) setCustomBasis(basis.name, basis.text, basis.file ?? null);
    else if (pairedBasis?.clear) clearCustomBasis({ notify: true });
    else if (!automation && pendingDeferredBasis && pendingDeferredBasis.gen === basisGeneration) {
      const deferred = pendingDeferredBasis;
      pendingDeferredBasis = null;
      setCustomBasis(deferred.basis.name, deferred.basis.text, deferred.file);
      log.log(`${deferred.file.name} loaded as the basis set`);
    }
    if (automation && !basis && p.basisSet && p.basisSet !== "auto") {
      $("basisSelect").value = p.basisSet;
      showBasisAdvice();
    }
    if (automation) {
      const range = defaultRangeText(input.index);
      $("ppmStart").value = String(p.ppmStart ?? range[0]);
      $("ppmEnd").value = String(p.ppmEnd ?? range[1]);
      if (!$("waterScaling").disabled) $("waterScaling").checked = p.waterScaling ?? true;
      if (!$("ecc").disabled) $("ecc").checked = p.eddyCurrentCorrection ?? true;
    }
    if (anatomy.kind === "clear") tissue.reset();
    if (anatomy.warning) log.log(anatomy.warning, "warning");
    if (given.length) tissue.setFractions({ gm: p.fractionGM, wm: p.fractionWM, csf: p.fractionCSF });
    const nextT1 = anatomy.kind === "replace" ? anatomy.prepared : null;
    const presentation = nextT1 ? tissue.commitT1(nextT1) : null;
    progress.end("Inputs loaded");
    if (nextT1) {
      $("tissueSection").open = true;
      await abortable(presentation, importSignal);
    } else if (next && view === "voxel" && tissue.hasT1) showView("voxel");
    const waterMessage = wildcardWater
      ? wildcardWater.attached < wildcardWater.total
        ? `Water reference attached to ${wildcardWater.attached} of ${wildcardWater.total} datasets (incompatible or overridden datasets kept their existing references).`
        : `Water reference attached to all ${wildcardWater.total} datasets.`
      : "Water reference attached to the selected dataset.";
    const partialWater = Boolean(wildcardWater && wildcardWater.attached < wildcardWater.total);
    const message = unchangedSpectrum
      ? (anatomy.kind === "clear" ? "Previous inputs restored; anatomy cleared." : nextT1 ? "Previous anatomy restored." : "Previous inputs restored.")
      : anatomy.kind === "clear" ? `${describeInput()} loaded; anatomy skipped.`
      : water ? waterMessage
      : next ? `${describeInput()} loaded`
      : nextT1 ? "T1 loaded."
      : "Basis set loaded; add spectroscopy data.";
    progress.end(message);
    status(message, partialWater);
    if (partialWater) log.open?.();
  } finally {
    if (pendingDroppedEvents?.controller === controller) pendingDroppedEvents = null;
    if (pendingDroppedBasis?.controller === controller) pendingDroppedBasis = null;
    if (pendingDroppedT1?.controller === controller) pendingDroppedT1 = null;
    if (pendingDroppedWater?.controller === controller) pendingDroppedWater = null;
    if (syncImportController === controller) syncImportController = null;
    candidate?.session.terminate();
    importSignal.removeEventListener("abort", stopCandidate);
    signal?.removeEventListener("abort", abort);
    if (importAbort === controller) importAbort = null;
    setBusy(false);
    if (!queuedImport) {
      // Keep pageDrop's remembered inputs aligned with the actual resident session across
      // manual drops, drop-zone/folder imports, non-replacement/rejected imports, AND
      // automation runs so a later Undo never restores files from an earlier session.
      const residentSpectra = residentSpectraFiles();
      const residentWater = residentWaterFiles();
      const residentEvents = fmrsEvents?.file ? [fmrsEvents.file] : [];
      const residentBasis = customBasis?.file ? [customBasis.file] : [];
      const residentT1 = tissue.files;
      const keepUndo = !automation && committed;
      const dataDetail = keepUndo
        ? { files: residentSpectra }
        : { files: residentSpectra, cancelPending: true };
      const pairedOpts = keepUndo ? { restoreWithUndo: true } : {};
      $("dataInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: dataDetail }));
      $("waterInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: residentWater, ...pairedOpts } }));
      $("eventsInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: residentEvents, ...pairedOpts } }));
      $("basisInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: residentBasis, ...pairedOpts } }));
      $("t1Input").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: residentT1, ...pairedOpts } }));
    }
    if (queuedImport) {
      const nextImport = queuedImport;
      queuedImport = null;
      if (syncQueuedImport === nextImport) syncQueuedImport = null;
      const currentSpectra = residentSpectraFiles();
      const currentWater = residentWaterFiles();
      const sameFidaInput = !nextImport.options?.water
        && input?.kind === "fida"
        && sameFileList(currentSpectra, nextImport.files)
        && sameFileList(currentWater, nextImport.waterFiles ?? []);
      if (sameFidaInput) {
        $("dataInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: currentSpectra } }));
        $("waterInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: currentWater } }));
        if (nextImport.events?.clear) clearEvents({ notify: true });
        else if (nextImport.events?.files?.length === 1 && fmrsEvents?.file !== nextImport.events.files[0]) {
          void loadEventsFile(nextImport.events.files[0]);
        } else {
          $("eventsInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: fmrsEvents?.file ? [fmrsEvents.file] : [] } }));
        }
        if (nextImport.basis?.clear) clearCustomBasis({ notify: true });
        else if (nextImport.basis?.file && customBasis?.file !== nextImport.basis.file) void loadBasisFile(nextImport.basis.file);
        else $("basisInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: customBasis?.file ? [customBasis.file] : [] } }));
        if (nextImport.t1?.clear) tissue.reset();
        else if (nextImport.t1?.files?.length && !sameFileList(nextImport.t1.files, tissue.files)) void loadT1Files(nextImport.t1.files);
        else $("t1Input").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: tissue.files } }));
        progress.end("Restored previous inputs");
        status("Restored previous inputs");
      } else {
        if (nextImport.events) syncDroppedEvents = nextImport.events;
        if (nextImport.waterFiles?.length) syncDroppedWater = nextImport.waterFiles;
        if (nextImport.basis) syncDroppedBasis = nextImport.basis;
        if (nextImport.t1) syncDroppedT1 = nextImport.t1;
        void importFiles(nextImport.files, nextImport.options);
      }
    }
  }
}

/** A structural image for the tissue correction (example or automation input). */
async function loadT1Files(files, signal) {
  setBusy(true);
  try {
    await tissue.loadT1(files, signal);
    $("tissueSection").open = true;
  } finally {
    setBusy(false);
  }
}

async function stageFida(files, signal, options) {
  progress.setIndeterminate("Reading the data with FID-A…");
  const session = createWorkerSession(reportWorkerProgress);
  const abort = () => session.terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const payload = files.map((f) => ({ name: f.name, bytes: f.bytes.buffer }));
    const loaded = await session.run({ type: "load", files: payload, options }, payload.map((f) => f.bytes));
    signal.throwIfAborted();
    if (loaded.error) throw new Error(loaded.error);
    for (const { text, level } of loadMessages(loaded)) log.log(text, level);
    return { session, loaded };
  } catch (error) {
    session.terminate();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** What the basis set is matched against, for dataset `k`. */
function headerFor(k = input?.index) {
  if (!input) return null;
  return headerOf(input, k, acquisitionFromFields());
}

const currentHeader = () => headerFor();

function acquisitionFromFields() {
  const hz = Number($("hzpppmInput").value);
  const dwellMs = Number($("dwellInput").value);
  return { hzpppm: hz > 0 ? hz : null, deltat: dwellMs > 0 ? dwellMs / 1000 : null };
}

/** The library and the user's own basis set, as the pipeline takes them. */
const bases = () => ({ library, custom: customBasis });

const isEdited = (k = input?.index) => editedOf(input, k);

function hasWater() {
  if (!input) return false;
  return input.kind === "raw" ? Boolean(input.water) : Boolean(input.datasets[input.index].water);
}

function describeInput() {
  if (!input) return "";
  if (input.kind === "raw") return `${input.name} (LCModel .RAW, ${input.points} points)`;
  if (input.datasets.length > 1) return `${input.datasets.length} datasets`;
  return describeOf(input, 0);
}

const datasetLabel = (k) => labelOf(input, k);

/** The fit range fields' default for dataset `k`, with the basis and macromolecule model as selected. */
const defaultRangeText = (k) => rangeTextOf(input, k, $("basisSelect").value, $("mmModel").value, bases());

function showDataset() {
  const multi = datasetCount() > 1;
  $("datasetField").hidden = !multi;
  if (multi) {
    $("datasetSelect").replaceChildren(...input.datasets.map((d, k) => new Option(`${d.label} (${d.format})`, String(k))));
    $("datasetSelect").value = String(input.index);
  }
  $("acquisitionFields").hidden = input?.kind !== "raw";
  const summary = $("datasetSummary");
  if (!input) {
    summary.hidden = true;
  } else if (input.kind === "raw") {
    summary.hidden = false;
    summary.textContent = `LCModel .RAW, ${input.points} points${input.water ? ", with water" : ""}${input.header.teMs ? `, TE ${input.header.teMs} ms` : ""}. Fitted without preprocessing.`;
  } else {
    const h = input.datasets[input.index].header;
    const edited = isEdited();
    const split = edited && h.editing;
    const parts = [edited ? "MEGA-PRESS" : h.family || "sequence not in header", `${h.fieldT ? h.fieldT.toFixed(2) : "?"} T`, `TE ${h.teMs} ms`];
    if (h.tmMs > 0 && h.family === "STEAM") parts.push(`TM ${h.tmMs} ms`);
    if (h.coils > 1) parts.push(`${h.coils} coils`);
    if (h.averages > 1) parts.push(`${split ? h.averages / 2 : h.averages} averages`);
    if (h.subspectra > 1 || split) parts.push(`${split ? 2 : h.subspectra} subspectra`);
    parts.push(input.datasets[input.index].water ? "with water" : "no water reference");
    summary.hidden = false;
    summary.textContent = parts.join(", ");
  }
  showEditing();
  const water = hasWater();
  const waterName = input?.kind === "raw" ? input.waterName : input?.datasets[input.index]?.water;
  $("waterInfo").hidden = !waterName;
  $("waterInfo").textContent = waterName ? `${waterName} → ${describeInput()}` : "";
  $("waterAllField").hidden = !(datasetCount() > 1);
  $("waterDrop").classList.toggle("has-files", water);
  $("waterScaling").disabled = !water;
  $("waterScaling").checked = water;
  $("ecc").disabled = !water;
  $("preprocessingSettings").hidden = input?.kind === "raw";
  const fmrsUnsupported = !fmrsEligible();
  $("fmrsSection").hidden = fmrsUnsupported;
  if (fmrsUnsupported && $("fmrsMode").value !== "off") {
    $("fmrsMode").value = "off";
    updateFmrsControls();
  }
  tissue.setDataset(input?.kind === "fida" ? input.datasets[input.index].header : null);
  recommend();
  showMacromoleculeModel();
  updateRunButton();
}

// The model control is shown for edited data; the fit range follows the
// model unless the user typed their own.
function showMacromoleculeModel() {
  const suppressed = library.find((b) => b.id === $("basisSelect").value)?.mmSuppressed === true;
  const edited = Boolean(input && isEdited());
  $("mmModelField").hidden = !edited;
  // MEGA-PRESS keeps LCModel's own line-broadening prior (fitDataset).
  $("lineBroadening").disabled = edited;
  $("lineBroadeningHint").hidden = !edited;
  $("simulateMmField").hidden = edited;
  $("baselineStiffnessField").hidden = edited;
  $("mmModel").disabled = suppressed;
  $("mmModelHint").hidden = !suppressed;
  const current = [$("ppmStart").value, $("ppmEnd").value];
  const range = input ? defaultRangeText(input.index) : RANGES.plain;
  if (rangeUntouched(current)) [$("ppmStart").value, $("ppmEnd").value] = range;
}

/** The editing switch, for GE and Philips data with alternate transients. */
function showEditing() {
  const editing = input?.kind === "fida" ? input.datasets[input.index].header.editing : null;
  $("editedField").hidden = !editing;
  if (!editing) return;
  $("editedToggle").checked = isEdited();
  const ratio = editing.contrast.toFixed(1);
  $("editedInfo").textContent = editing.detected
    ? `GE and Philips files do not record editing. Alternate transients differ in NAA/Cr by a factor of ${ratio}: the 1.9 ppm editing pulse nearly erases NAA in edit-ON, so these are edit-ON/OFF pairs.`
    : `GE and Philips files do not record editing. Alternate transients agree in NAA/Cr (factor ${ratio}), so these look unedited. Edited data whose transients the scanner averaged in pairs cannot be separated.`;
}

// ---------------------------------------------------------------------------
// Basis set choice
// ---------------------------------------------------------------------------

function setCustomBasis(name, text, file = null) {
  basisGeneration += 1;
  pendingDeferredBasis = null;
  customBasis = { ...parseCustomBasis(name, text), file };
  const { header } = customBasis;
  $("basisInfo").hidden = false;
  $("basisInfo").textContent = `${name}: ${header.metabolites.length} metabolites${header.teMs ? `, TE ${header.teMs} ms` : ""}${header.hzpppm ? `, ${(header.hzpppm / 42.577).toFixed(1)} T` : ""}`;
  $("basisDrop").classList.add("has-files");
  recommend();
  $("basisSelect").value = CUSTOM;
  showBasisAdvice();
  showMacromoleculeModel();
  if (file) {
    $("basisInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file], restoreWithUndo: true } }));
  }
}

function clearCustomBasis({ notify = true } = {}) {
  basisGeneration += 1;
  pendingDeferredBasis = null;
  customBasis = null;
  $("basisInfo").hidden = true;
  $("basisInfo").textContent = "";
  $("basisDrop").classList.remove("has-files");
  recommend();
  showBasisAdvice();
  showMacromoleculeModel();
  updateRunButton();
  if (notify) {
    $("basisInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [], restoreWithUndo: true } }));
  }
}

function renderBasisOptions(ranked, assessed) {
  const select = $("basisSelect");
  const previous = select.value;
  const options = ranked.map((r, k) => new Option(`${r.basis.label}${assessed && k === 0 && r.usable ? " (recommended)" : ""}${r.usable ? "" : " (unusable)"}`, r.basis.id));
  if (customBasis) options.push(new Option(`Your basis set: ${customBasis.name}`, CUSTOM));
  select.replaceChildren(...options);
  return previous;
}

function recommend() {
  const header = currentHeader();
  const ranked = header ? rankBases(header, library) : library.map((basis) => ({ basis, usable: true, score: 0, level: "info", notes: [] }));
  const previous = renderBasisOptions(ranked, Boolean(header));
  const select = $("basisSelect");
  if (customBasis && (previous === CUSTOM || !input)) select.value = CUSTOM;
  else if (customBasis && previous !== CUSTOM && !header) select.value = CUSTOM;
  else if (header && ranked[0]?.usable) select.value = customBasis && previous === CUSTOM ? CUSTOM : ranked[0].basis.id;
  else if (library.some((b) => b.id === previous)) select.value = previous;
  showBasisAdvice();
}

function showBasisAdvice() {
  const choice = $("basisSelect").value;
  const custom = choice === CUSTOM;
  $("basisInfo").hidden = !custom || !customBasis;
  const advice = $("basisAdvice");
  const header = currentHeader();
  const basis = custom ? (customBasis ? { id: CUSTOM, ...customBasis.header } : null) : library.find((b) => b.id === choice);
  if (!basis || !header) {
    advice.hidden = !custom || Boolean(customBasis);
    advice.className = "nd-message info";
    advice.textContent = custom ? "Drop an LCModel .BASIS file simulated for these data." : "";
    updateRunButton();
    return;
  }
  const a = assessBasis(header, basis);
  advice.hidden = false;
  advice.className = `nd-message ${a.level === "match" ? "success" : a.level === "error" ? "error" : a.level === "warning" ? "warning" : "info"}`;
  const texts = a.notes.filter((n) => n.level !== "info" || a.level === "match").map((n) => n.text);
  const mmNote = custom && hasBasisMacromolecules(customBasis?.header) ? " Includes MM basis; uncheck Simulate macromolecules (nsimul=0) to avoid double-fitting." : "";
  advice.textContent = (a.level === "match" ? "Matches the data's field strength, sequence and echo time." : texts.join(" ") || "No mismatch found.") + mmNote;
  updateRunButton();
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Fit settings shared by the datasets of a run, from the controls. A null
 * `range` means each dataset uses its default (MEGA-PRESS data a different
 * one); the water switches apply wherever a dataset has a water reference.
 */
function fitSettings() {
  const fields = [$("ppmStart").value, $("ppmEnd").value];
  const sd = Number($("badSd").value);
  const dk = Number($("baselineStiffness").value);
  return {
    preprocessing: {
      removeBadAverages: $("removeBad").checked,
      badAverageSd: sd > 0 ? sd : undefined,
      driftCorrection: $("driftCorrection").checked,
      phaseAndReference: $("phaseReference").checked,
    },
    scaleWater: $("waterScaling").disabled || $("waterScaling").checked,
    ecc: $("ecc").disabled || $("ecc").checked,
    range: rangeUntouched(fields) ? null : fields.map(Number),
    mmModel: $("mmModel").value,
    lineBroadening: $("lineBroadening").value,
    simulateMacromolecules: $("simulateMm").checked,
    baselineStiffness: dk > 0 ? dk : null,
  };
}

function fmrsSettings() {
  const step = Number($("fmrsStep").value);
  return {
    mode: $("fmrsMode").value,
    windowSize: Math.max(1, Number($("fmrsWindow").value) || 4),
    stepSize: step > 0 ? step : undefined,
    events: fmrsEvents?.events ?? [],
    matchLinewidth: $("matchLinewidth").checked,
    dynamicGlm: $("dynamicGlm").checked,
  };
}

const logLine = (message, level) => log.log(message, level);

/** Preprocess (FID-A) and fit (LCModel) dataset `k`; throws when either step fails. */
function fitDataset(k, { choice, range, settings, onStep }) {
  return fitInput(engine, { input, index: k, choice, range, settings, bases: bases(), acquisition: acquisitionFromFields(), onStep, log: logLine });
}

/** A worker that trapped may hold broken module state: start a fresh one. */
function recycleWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  if (input?.kind === "fida") input.stale = true;
}

/** Fit the selected dataset with the chosen basis set and the fields as set. */
async function run({ throwOnError = false } = {}) {
  if (!input || busy || isReadingBasis()) {
    if (throwOnError) throw new Error(busy || isReadingBasis() ? "Another job is running." : "No spectroscopy data loaded.");
    return null;
  }
  const k = input.kind === "fida" ? input.index : 0;
  setBusy(true);
  fits.delete(k);
  clearResults();
  progress.begin("Preparing…");
  const started = performance.now();
  const step = (text) => {
    progress.setText(text);
    status(text);
  };
  try {
    const entry = await fitDataset(k, {
      choice: $("basisSelect").value,
      range: [Number($("ppmStart").value), Number($("ppmEnd").value)],
      settings: fitSettings(),
      onStep: step,
    });
    const segmented = entry.fit.water && tissue.needsSegmentation;
    if (segmented) {
      progress.setIndeterminate("Segmenting the T1 image…");
      try {
        await tissue.measure();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        log.log(`Tissue correction skipped: ${error.message}`, "warning");
      }
    }
    fits.set(k, entry);
    showEntry(entry, { view: segmented && tissue.source?.kind === "segmentation" ? "voxel" : "fit" });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    progress.end(`Fit done in ${seconds} s`);
    status(`Fit done in ${seconds} s`);
    return entry.fit;
  } catch (error) {
    if (error.trap) recycleWorker();
    if (error.name !== "AbortError" && datasetCount() > 1) fits.set(k, failedEntry(k, error, $("basisSelect").value));
    if (throwOnError) {
      progress.end(error.message, { success: false });
      status(error.message, true);
      throw error;
    }
    if (error.name === "AbortError") {
      progress.reset("Cancelled");
      status("Cancelled");
    } else {
      progress.end(error.message, { success: false });
      status(error.message, true);
      log.open?.();
    }
  } finally {
    setBusy(false);
    renderGroup();
  }
  return null;
}

const cancelledEntry = (k) => ({ index: k, status: STATUS.cancelled, error: "Cancelled before it was fitted.", basis: null, generated: new Date() });

/**
 * Fit every loaded dataset, one after the other, with the current settings.
 * A dataset that fails is recorded and the rest continue; the footer ×
 * stops the run and keeps what was fitted.
 * @param {{settings?: ReturnType<typeof fitSettings>, explicitBasis?: boolean, throwOnError?: boolean}} options
 */
async function runGroup({ settings = fitSettings(), explicitBasis = false, throwOnError = false } = {}) {
  if (!input || busy || isReadingBasis() || input.kind !== "fida") {
    if (throwOnError) throw new Error(busy || isReadingBasis() ? "Another job is running." : "No spectroscopy data loaded.");
    return null;
  }
  const n = input.datasets.length;
  const plan = planGroup(input, { choice: $("basisSelect").value, explicit: explicitBasis, bases: bases(), acquisition: acquisitionFromFields() });
  const controller = new AbortController();
  setBusy(true);
  fits.clear();
  clearResults();
  runAbort = controller;
  progress.begin(`Fitting ${n} datasets…`);
  status(`Fitting ${n} datasets. ${plan.description}`);
  const started = performance.now();
  try {
    for (let k = 0; k < n; k += 1) {
      if (controller.signal.aborted) {
        fits.set(k, cancelledEntry(k));
        continue;
      }
      const prefix = `Dataset ${k + 1} of ${n} (${input.datasets[k].label})`;
      workerProgress = (fraction, text) => progress.setProgress((k + Math.min(1, Math.max(0, fraction ?? 0))) / n, `${prefix}: ${text}`);
      progress.setProgress(k / n, `${prefix}…`);
      const basisId = plan.bases[k];
      try {
        const onStep = (text) => progress.setText(`${prefix}: ${text}`);
        const entry = await fitPlanned(engine, { input, index: k, basisId, settings, bases: bases(), acquisition: acquisitionFromFields(), onStep, log: logLine });
        await correctGroupEntry(entry, controller.signal, (text) => progress.setText(`${prefix}: ${text}`));
        fits.set(k, entry);
        log.log(`${input.datasets[k].label}: fitted with ${entry.basis.label}`);
      } catch (error) {
        if (error.name === "AbortError") {
          fits.set(k, cancelledEntry(k));
          controller.abort();
          continue;
        }
        if (error.trap) recycleWorker();
        fits.set(k, failedEntry(k, error, basisId));
        log.log(`${input.datasets[k].label}: ${error.message}`, "error");
      }
      renderGroup();
    }
  } finally {
    workerProgress = null;
    runAbort = null;
    setBusy(false);
  }
  const entries = [...fits.values()];
  const fitted = entries.filter((e) => e.status === STATUS.fitted).length;
  const failed = entries.filter((e) => e.status === STATUS.failed).length;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const message = controller.signal.aborted
    ? `Cancelled: ${fitted} of ${n} datasets fitted`
    : `${fitted} of ${n} datasets fitted in ${seconds} s${failed ? `, ${failed} failed` : ""}`;
  progress.end(message, { success: !controller.signal.aborted && fitted > 0 });
  status(message, failed > 0 && !controller.signal.aborted);
  if (failed) log.open?.();
  // Show the group, and the first fitted dataset unless the selected one fitted.
  if (fits.get(input.index)?.status !== STATUS.fitted) {
    const first = entries.find((e) => e.status === STATUS.fitted);
    if (first) input.index = first.index;
  }
  showDataset();
  renderGroup();
  showEntry(fits.get(input.index), { view: "group" });
  $("outputSection").open = true;
  if (throwOnError && controller.signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
  if (throwOnError && !fitted) throw new Error(`No dataset could be fitted: ${entries[0]?.error ?? "unknown error"}`);
  return { plan, n, fitted, failed };
}

/** Run functional MRS analysis on the selected dataset. */
async function runFmrs({ throwOnError = false } = {}) {
  if (!input || busy || isReadingEvents() || isReadingBasis() || input.kind !== "fida") {
    if (throwOnError) throw new Error(busy || isReadingEvents() || isReadingBasis() ? "Another job is running." : "Load multi-transient spectroscopy data first.");
    return null;
  }
  const k = input.index;
  const controller = new AbortController();
  setBusy(true);
  fmrsResult = null;
  fmrsWindowIndex = -1;
  clearResults();
  runAbort = controller;
  progress.begin("Preprocessing fMRS transients…");
  const started = performance.now();
  const step = (text) => {
    progress.setText(text);
    status(text);
  };
  let preprocessed = null;
  try {
    const result = await fitFmrsDataset(engine, {
      input,
      index: k,
      choice: $("basisSelect").value,
      range: [Number($("ppmStart").value), Number($("ppmEnd").value)],
      settings: fitSettings(),
      bases: bases(),
      fmrs: fmrsSettings(),
      signal: controller.signal,
      onStep: step,
      onPreprocessed: (pre) => { preprocessed = pre; },
      onBinProgress: (fraction, text) => progress.setProgress(fraction, text),
      log: logLine,
    });
    fmrsResult = result;
    const names = metaboliteNames(result.windows);
    const preferred = names.includes("Glu") ? "Glu" : names.includes("Glu+Gln") ? "Glu+Gln" : names[0] ?? "";
    fmrsMetabSelect.replaceChildren(...names.map((n) => new Option(n, n)));
    if (preferred) fmrsMetabSelect.value = preferred;
    const metabOpt = fmrsPanelSelect.querySelector('option[value="metabolite"]');
    const wasNoMetab = Boolean(metabOpt?.disabled);
    if (metabOpt) metabOpt.disabled = names.length === 0;
    if (names.length === 0) {
      fmrsPanelSelect.value = result.transients?.length ? "transients" : "stats";
    } else if (wasNoMetab) {
      fmrsPanelSelect.value = "metabolite";
    }
    const firstFitted = result.grandEntry ?? result.windows.find((w) => w.entry)?.entry ?? null;
    if (firstFitted) {
      // Route through showEntry so input.index and tissue controller always match the owning dataset.
      showEntry(firstFitted, { view: "fmrs", windowIndex: firstFitted.windowIndex ?? -1 });
    } else {
      processed = result.grandProcessed ?? null;
      setViewEnabled("preprocessing", Boolean(processed));
      setViewEnabled("fmrs", true);
      showView("fmrs");
    }
    renderResultList();
    $("outputSection").open = true;
    const fittedCount = result.windows.filter((w) => w.status === STATUS.fitted).length;
    const firstErr = result.windows.find((w) => w.error)?.error ?? "all bins failed";
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const message = controller.signal.aborted
      ? `Cancelled: ${fittedCount} of ${result.windows.length} fMRS bins fitted`
      : fittedCount === 0
        ? `No fMRS windows could be fitted (${firstErr}). Inspect per-transient drift and QC to diagnose.`
        : `fMRS done: ${fittedCount} of ${result.windows.length} bins fitted in ${seconds} s`;
    progress.end(message, { success: !controller.signal.aborted && fittedCount > 0 });
    status(message, fittedCount === 0 && !controller.signal.aborted);
    if (fittedCount === 0 && !controller.signal.aborted) log.open?.();
    if (throwOnError && controller.signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    if (throwOnError && !fittedCount) throw new Error(`No fMRS windows could be fitted: ${firstErr}`);
    return result;
  } catch (error) {
    if (error.trap) recycleWorker();
    if (!throwOnError && error.name !== "AbortError" && preprocessed) {
      const cfg = fmrsSettings();
      const grandProcessed = preprocessed.grandMean
        ? { report: preprocessed.report, spectrum: preprocessed.grandMean.spectrum, unprocessed: preprocessed.grandMean.unprocessed ?? null }
        : null;
      fmrsResult = {
        datasetIndex: k,
        datasetName: datasetLabel(k),
        generated: new Date(),
        basis: null,
        header: preprocessed.header ?? input.datasets[k]?.header ?? null,
        report: preprocessed.report,
        transients: preprocessed.report?.transients ?? [],
        events: cfg.events ?? [],
        mode: cfg.mode ?? "sliding",
        matchLinewidth: Boolean(cfg.matchLinewidth),
        targetLinewidthHz: preprocessed.report?.targetLinewidthHz ?? null,
        fittedCount: 0,
        grandProcessed,
        grandEntry: null,
        windows: (preprocessed.bins ?? []).map((b, i) => ({
          ...b,
          index: i,
          status: STATUS.failed,
          error: error.message,
          metabolites: [],
          entry: null,
        })),
        conditionSummary: [],
        baselineCondition: null,
        windowedStats: null,
        dynamicGlm: null,
      };
      fmrsMetabSelect.replaceChildren();
      const metabOpt = fmrsPanelSelect.querySelector('option[value="metabolite"]');
      if (metabOpt) metabOpt.disabled = true;
      fmrsPanelSelect.value = fmrsResult.transients.length ? "transients" : "stats";
      processed = grandProcessed;
      setViewEnabled("preprocessing", Boolean(processed));
      setViewEnabled("fmrs", true);
      showView("fmrs");
      renderResultList();
      $("outputSection").open = true;
    }
    if (throwOnError) {
      progress.end(error.message, { success: false });
      status(error.message, true);
      throw error;
    }
    if (error.name === "AbortError") {
      progress.reset("Cancelled");
      status("Cancelled");
    } else {
      progress.end(error.message, { success: false });
      status(error.message, true);
      log.open?.();
    }
    return null;
  } finally {
    runAbort = null;
    setBusy(false);
  }
}

/**
 * A group run with a T1 loaded measures each dataset's own voxel on it (the
 * datasets are voxels of one session) and keeps the corrected values in the
 * entry. Entered fractions describe one voxel, so they correct only the
 * dataset on display (renderConcentrations).
 */
async function correctGroupEntry(entry, signal, onStep) {
  const header = input.datasets[entry.index].header;
  if (!tissue.hasT1 || !entry.fit.water || !header.voxel) return;
  tissue.setDataset(header);
  try {
    if (tissue.needsSegmentation) {
      onStep("Segmenting the T1 image…");
      await tissue.measure(signal);
    }
    setCorrection(entry.fit, tissue.correct(entry.fit.rows, { waterScaled: true, edited: Boolean(entry.fit.lcm.edited) }));
  } catch (error) {
    if (error.name === "AbortError") throw error;
    log.log(`${datasetLabel(entry.index)}: tissue correction skipped: ${error.message}`, "warning");
  }
}

/** Keep a tissue correction with its fit, with the fractions' source. */
function setCorrection(f, correction) {
  f.correction = correction?.rows ? { ...correction, source: tissue.source } : null;
  return correction;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function setViewEnabled(id, enabled) {
  const tab = toolbar.viewTabs?.querySelector(`[data-view="${id}"]`) ?? toolbar.viewTabs?.querySelectorAll("button")[VIEWS.findIndex((v) => v.id === id)];
  if (tab) tab.disabled = !enabled;
}

/** Show a stored fit (or why there is none) in the viewer and sidebar. */
function showEntry(entry, { view: next = "fit", windowIndex = -1 } = {}) {
  if (entry?.status === STATUS.fitted) {
    // Always bind the active dataset and tissue controller to the owning dataset
    // so a window from dataset A is never shown or tissue-corrected under dataset B.
    if (input?.kind === "fida" && entry.index >= 0 && entry.index < input.datasets.length && entry.index !== input.index) {
      input.index = entry.index;
      showDataset();
      renderGroup();
    }
    fmrsWindowIndex = windowIndex;
    activeEntry = entry;
    processed = entry.processed;
    fit = entry.fit;
    showResults(next);
    return;
  }
  clearResults();
  if (next === "group" && hasGroup()) showView("group");
  if (!entry) return;
  $("emptyState").hidden = true;
  $("viewerNotice").hidden = view === "group";
  $("viewerNotice").textContent = `${datasetLabel(entry.index)}: ${entry.error}`;
}

/** `text` as nodes with a line-break opportunity after each "+". */
function breakablePlus(text) {
  const parts = text.split("+");
  return parts.flatMap((part, k) => (k < parts.length - 1 ? [`${part}+`, document.createElement("wbr")] : [part]));
}

/** The concentration table and downloads, with the tissue correction when it applies. */
function renderConcentrations() {
  const { rows, ratioTo } = fit;
  const correction = setCorrection(fit, tissue.correct(rows, { waterScaled: fit.water, edited: Boolean(fit.lcm.edited) }));
  $("tissueAdvice").hidden = !correction?.reason;
  $("tissueAdvice").textContent = correction?.reason ?? "";
  // The sidebar has room for one value column after %SD: the ratio, or the
  // tissue-corrected value when there is one (the Group tab and the report show both).
  $("concColumnField").hidden = !fit.correction;
  const showTissue = Boolean(fit.correction) && $("concColumn").value === "tissue";
  $("corrHeader").hidden = !showTissue;
  $("ratioHeader").hidden = showTissue;
  $("modelNote").hidden = !rows.some((r) => r.modelDependent);
  $("concHeader").textContent = fit.water ? "Conc. (mM)" : "Conc. (a.u.)";
  $("ratioHeader").textContent = ratioTo ? `/${ratioTo}` : "Ratio";
  $("concBody").replaceChildren(...rows.map((r, k) => {
    const tr = document.createElement("tr");
    tr.dataset.metabolite = r.name;
    if (r.combination) tr.className = "lcm-combination";
    if (r.sdPercent > 20) tr.classList.add("lcm-uncertain");
    const last = showTissue ? formatConc(fit.correction.rows[k].corrected) : r.ratio == null ? "" : formatConc(r.ratio);
    const cells = [r.name, formatConc(r.concentration), `${r.sdPercent}%`, last];
    cells.forEach((text, column) => {
      const td = document.createElement("td");
      // Combination names (MM14+Lip13a+Lip13b+MM12) may wrap after each "+", so the
      // name column does not push the numbers out of the sidebar.
      const content = column === 0 ? breakablePlus(text) : [text];
      const target = r.primary ? td.appendChild(document.createElement("strong")) : td;
      target.append(...content);
      tr.append(td);
    });
    if (r.modelDependent) tr.cells[0].append(" ", renderInfoIcon(r.note, { label: `${r.name} depends on the macromolecule model` }));
    return tr;
  }));
  bindInfoTooltips($("concBody"));
  $("concTable").hidden = false;
  if (hasGroup()) renderGroup();
  else renderResultList();
}

function showResults(next = "fit") {
  renderConcentrations();
  const s = fit.coord.summary;
  const name = datasetCount() > 1 ? datasetLabel(input.index) : null;
  $("fitSummary").hidden = false;
  $("fitSummary").textContent = [name, s.fwhmPpm != null && `FWHM ${s.fwhmPpm} ppm`, s.snr != null && `S/N ${s.snr}`, s.shiftPpm != null && `shift ${s.shiftPpm} ppm`, fit.coord.diagnostics.length && `${fit.coord.diagnostics.length} LCModel messages`].filter(Boolean).join(" · ");
  setViewEnabled("fit", true);
  setViewEnabled("metabolites", fit.coord.metabolites.length > 0);
  setViewEnabled("preprocessing", Boolean(processed));
  setViewEnabled("fmrs", Boolean(fmrsResult));
  $("outputSection").open = true;
  $("emptyState").hidden = true;
  showView(next === "group" && !hasGroup() ? "fit" : next === "fmrs" && !fmrsResult ? "fit" : next);
}

/** The selected fit's entry in `fits`. */
const currentEntry = () => fits.get(input?.kind === "fida" ? input.index : 0);

/** The fit's downloads, keyed by result stage (also the automation artifact roles). */
function resultFiles(entry) {
  const { fit: f } = entry;
  const asFile = ({ name, body, type }) => new File([body], name, { type });
  const entries = Object.fromEntries(Object.entries(resultTexts(entry, input, VERSIONS)).map(([role, item]) => {
    const { description, viewable } = item;
    const result = item.make ? { description, make: () => asFile({ ...item, body: item.make() }) } : { description, file: asFile(item) };
    return [role, viewable === undefined ? result : { ...result, viewable }];
  }));
  // The panel describes the dataset (and fMRS window/grand mean) on display, which is the one whose files these are.
  const stem = entry.windowId ? `${fileStem(datasetLabel(entry.index))}_${entry.windowId}` : fileStem(datasetLabel(entry.index));
  Object.assign(entries, tissue.resultFiles(f.correction, stem, f.ratioTo));
  return entries;
}

// ---------------------------------------------------------------------------
// Reports and the group table
// ---------------------------------------------------------------------------

const reportHtml = (entry) => reportOf(entry, input, VERSIONS);

function reportFile(entry) {
  const { name, type, make } = resultTexts(entry, input, VERSIONS).fitReport;
  return new File([make()], name, { type });
}

/** The report in a new tab, where the browser prints it to PDF. */
function openReport(result) {
  const url = URL.createObjectURL(result.file ?? result.make());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function hasGroup() {
  return datasetCount() + (input?.loadErrors?.length ?? 0) > 1 && fits.size > 0;
}

/** Group table records, in dataset order; unreadable files are failed rows with no fit to select. */
const groupRecords = () => recordsOf(input, fits);

/** Every fitted dataset's report (and the group table) in one archive. */
function reportsZip() {
  const files = {};
  for (const entry of [...fits.values()].sort((a, b) => a.index - b.index)) {
    if (entry.status !== STATUS.fitted) continue;
    files[reportFile(entry).name] = strToU8(reportHtml(entry));
  }
  files["lcmodel_group.csv"] = strToU8(groupCsvLong(groupRecords().records));
  return new File([zipSync(files, { level: 6 })], "lcmodel_reports.zip", { type: "application/zip" });
}

function groupFiles() {
  if (!hasGroup()) return {};
  const { records } = groupRecords();
  const csv = (name, body) => new File([body], name, { type: "text/csv" });
  return {
    groupTable: { description: "Group table (.csv)", file: csv("lcmodel_group.csv", groupCsvLong(records)) },
    groupWide: { description: "Group table, one row per dataset (.csv)", file: csv("lcmodel_group_wide.csv", groupCsvWide(records)) },
    groupReports: { description: "Reports of every fit (.zip)", make: reportsZip, viewable: false },
  };
}

function fmrsFiles() {
  if (!fmrsResult) return {};
  const asFile = ({ name, body, type }) => new File([body], name, { type });
  return Object.fromEntries(Object.entries(fmrsResultTexts(fmrsResult, VERSIONS)).map(([role, item]) => {
    const { description, viewable } = item;
    const result = item.make ? { description, make: () => asFile({ ...item, body: item.make() }) } : { description, file: asFile(item) };
    return [role, viewable === undefined ? result : { ...result, viewable }];
  }));
}

function renderResultList() {
  const entry = fit ? (activeEntry ?? currentEntry()) : null;
  results.render({ ...fmrsFiles(), ...groupFiles(), ...(entry?.status === STATUS.fitted ? resultFiles(entry) : {}) });
}

function renderGroup() {
  const active = hasGroup();
  setViewEnabled("group", active);
  if (!active) {
    $("groupView").replaceChildren();
    return;
  }
  const { indices, records } = groupRecords();
  // Tissue-corrected values are offered once a dataset has them.
  const tissueOption = groupShow.querySelector('option[value="tissue"]');
  tissueOption.disabled = !records.some((r) => r.fractionSource);
  tissueOption.hidden = tissueOption.disabled;
  if (tissueOption.disabled && groupShow.value === "tissue") groupShow.value = "concentration";
  renderGroupTable($("groupView"), records, { indices, selected: input.index, show: groupShow.value, onSelect: selectDataset });
  renderResultList();
}

/** A row of the group table, or the Dataset select: show that dataset's fit. */
function selectDataset(k, { keepView = false } = {}) {
  if (k < 0) return;
  input.index = k;
  fmrsWindowIndex = -1;
  showDataset();
  renderGroup();
  const entry = fits.get(k);
  if (entry) showEntry(entry, { view: keepView && view === "group" ? "group" : "fit" });
  else clearResults();
}

function showView(id) {
  view = id;
  toolbar.setActive(id);
  const plot = $("plot");
  const notice = $("viewerNotice");
  const group = id === "group";
  const fmrs = id === "fmrs" && Boolean(fmrsResult);
  const fmrsPanel = fmrsPanelSelect.value;
  const fmrsStatsMode = fmrs && fmrsPanel === "stats";
  notice.hidden = true;
  plot.hidden = group || fmrsStatsMode;
  $("groupView").hidden = !group;
  $("fmrsView").hidden = !fmrsStatsMode;
  groupShow.hidden = !group;
  fmrsPanelSelect.hidden = !fmrs;
  fmrsMetabSelect.hidden = !(fmrs && fmrsPanel === "metabolite" && fmrsMetabSelect.options.length > 0);
  if (id !== "voxel") tissue.hide();
  if (id === "voxel") {
    plot.replaceChildren();
    $("emptyState").hidden = true;
    void tissue.show();
    return;
  }
  if (group) {
    const { records } = groupRecords();
    const fitted = records.filter((r) => r.status === STATUS.fitted).length;
    $("emptyState").hidden = true;
    $("plotLabel").textContent = `${fitted} of ${records.length} datasets fitted. Select a dataset to show its fit; %SD above 20% is dimmed.`;
    return;
  }
  if (fmrs) {
    $("emptyState").hidden = true;
    const { windows, events, transients, baselineCondition } = fmrsResult;
    const pooled = fmrsResult.mode === "conditions";
    const categories = pooled ? windows.map((w) => w.label) : null;
    if (fmrsPanel === "stats") {
      renderFmrsTables($("fmrsView"), fmrsResult, {
        selectedWindow: fmrsWindowIndex,
        onSelectWindow: (winIdx) => {
          const w = fmrsResult.windows[winIdx];
          if (!w?.entry) return;
          showEntry(w.entry, { view: "fit", windowIndex: winIdx });
          $("fitSummary").textContent = `${w.label} · ${$("fitSummary").textContent}`;
          $("plot").focus({ preventScroll: true });
        },
      });
      $("plotLabel").textContent = `${fmrsResult.datasetName}: ${windows.length} bins (${fmrsResult.mode})${fmrsResult.matchLinewidth ? `, BOLD target LW ${fmrsResult.targetLinewidthHz?.toFixed(1) ?? "?"} Hz` : ""}. Select a window to inspect its LCModel fit.`;
      return;
    }
    if (fmrsPanel === "qc") {
      plot.innerHTML = qcTimeCourseSvg({ windows, events: pooled ? [] : events, baselineCondition, categories });
      $("plotLabel").textContent = `QC ${pooled ? "by condition" : "time courses"} across ${windows.length} bins: linewidth (Hz${fmrsResult.matchLinewidth ? ", grey pre-match / coloured post-match FID-A LW" : ""}), LCModel S/N, and tNAA/tCr.`;
      return;
    }
    if (fmrsPanel === "transients") {
      plot.innerHTML = transientDriftSvg({ transients, events, baselineCondition });
      const removed = transients.filter((t) => !t.kept).length;
      $("plotLabel").textContent = `Per-transient spectral registration: ${transients.length - removed}/${transients.length} kept (${removed} removed bad averages shown in red).`;
      return;
    }
    const metab = fmrsMetabSelect.value;
    if (!metab) {
      plot.replaceChildren();
      notice.hidden = false;
      notice.textContent = "No fitted windows are available for metabolite time courses. Switch to Per-transient drift, QC metrics, or Summary & stats to diagnose fit failures.";
      $("plotLabel").textContent = "No fitted windows available.";
      return;
    }
    const unit = windows.find((w) => w.unit)?.unit ?? "a.u.";
    const pts = windows.map((w, idx) => {
      const m = w.metabolites?.find((r) => r.name === metab);
      const y = m?.concentration ?? null;
      const err = y != null && m?.sdPercent != null ? (y * m.sdPercent) / 100 : null;
      return {
        x: pooled ? idx : w.midTimeS,
        y,
        err,
        flagged: m && m.sdPercent > SD_LIMIT,
        tip: `${w.label}${w.condition ? ` (${w.condition})` : ""}: ${y != null ? formatConc(y) : "—"} ${unit} (${m?.sdPercent ?? "?"}% SD)`,
      };
    });
    plot.innerHTML = timeCourseSvg({
      points: pts,
      events: pooled ? [] : events,
      baselineCondition,
      categories,
      xLabel: pooled ? "Condition" : "Time (s)",
      yLabel: `${metab} (${unit})`,
      ariaLabel: `${metab} ${pooled ? "by condition" : "time course"}`,
    });
    const stat = fmrsResult.windowedStats?.metabolites?.find((m) => m.name === metab)?.contrasts?.[0];
    const dyn = fmrsResult.dynamicGlm?.aligned !== false
      ? fmrsResult.dynamicGlm?.metabolites?.find((m) => m.name === metab)?.contrasts?.[0]
      : null;
    const summaryBits = [
      `${metab} across ${windows.length} bins`,
      stat?.percentChange != null && `windowed ${stat.condition} vs ${stat.baseline}: ${stat.percentChange >= 0 ? "+" : ""}${stat.percentChange.toFixed(1)}% (p=${stat.pValue != null ? stat.pValue.toFixed(3) : "—"})`,
      dyn?.percentChange != null && `dynamic projection: ${dyn.percentChange >= 0 ? "+" : ""}${dyn.percentChange.toFixed(1)}% (p=${dyn.pValue != null ? dyn.pValue.toFixed(3) : "—"})`,
    ].filter(Boolean);
    $("plotLabel").textContent = summaryBits.join(" · ");
    return;
  }
  const range = [Number($("ppmStart").value) + 0.2, Math.max(-0.5, Number($("ppmEnd").value) - 0.2)];
  if (id === "preprocessing" && processed?.editOff) {
    // Edited data: FID-A's edit-OFF subspectrum above the difference spectrum it fits.
    const off = processed.editOff.real;
    const diff = processed.spectrum.real;
    const lift = Math.max(...diff) - Math.min(...off) + (Math.max(...off) - Math.min(...off)) * 0.1;
    const series = [
      { values: diff, kind: "fit", label: "Difference (edit-ON minus edit-OFF)" },
      { values: off, kind: "reference", label: "Edit-OFF", offset: lift },
    ];
    plot.innerHTML = spectrumSvg({ ppm: processed.spectrum.ppm, series, range: [4.5, 0.5], ariaLabel: "MEGA-PRESS edit-OFF and difference spectra after FID-A preprocessing" });
    $("plotLabel").textContent = `FID-A: edit-OFF (top) and the difference spectrum LCModel fits (bottom). ${summarizeReport(processed.report)}`;
  } else if (id === "preprocessing" && processed) {
    const series = [{ values: processed.spectrum.real, kind: "fit", label: "Preprocessed (FID-A)" }];
    const raw = processed.unprocessed;
    if (raw?.real?.length === processed.spectrum.real.length) series.unshift({ values: raw.real, kind: "reference", label: "Coil-combined and averaged, no correction" });
    plot.innerHTML = spectrumSvg({ ppm: processed.spectrum.ppm, series, range: [4.5, 0], ariaLabel: "Spectrum before and after FID-A preprocessing" });
    $("plotLabel").textContent = `FID-A preprocessing, grey before and coloured after bad-average removal and drift correction: ${summarizeReport(processed.report)}`;
  } else if (id === "metabolites" && fit) {
    plot.innerHTML = spectrumSvg({ ppm: fit.coord.ppm, series: metaboliteSeries(fit.coord), range, gaps: fit.coord.gaps, height: 560, ariaLabel: "Fitted metabolite spectra" });
    $("plotLabel").textContent = "Each fitted metabolite's contribution, largest at the bottom";
  } else if (fit) {
    plot.innerHTML = spectrumSvg({ ppm: fit.coord.ppm, series: fitSeries(fit.coord), range, gaps: fit.coord.gaps, ariaLabel: "LCModel fit: data, fit, baseline and residual" });
    $("plotLabel").textContent = `Data (grey), LCModel fit (coloured), baseline (dashed), residual (top)${fit.coord.gaps.length ? "; shaded: not fitted" : ""}`;
  } else {
    plot.replaceChildren();
    $("plotLabel").textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function importFiles(files, options) {
  exampleControl.cancel();
  if (!options?.water && !busy && files.length === 1 && /\.(tsv|csv)$/i.test(files[0].name) && input) {
    // Restore pageDrop's remembered spectroscopy files so a lone schedule picked through
    // #dataInput never replaces the resident scan in a future Undo snapshot.
    $("dataInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: residentSpectraFiles() } }));
    return loadEventsFile(files[0]);
  }
  if (busy && importAbort) {
    // Supersede an in-flight import (e.g. clicking Undo or dropping replacement files
    // while a slow read or anatomy render is still pending) instead of rejecting and stranding paired inputs.
    const nextImport = {
      files,
      options,
      events: syncDroppedEvents,
      waterFiles: syncDroppedWater,
      basis: syncDroppedBasis,
      t1: syncDroppedT1,
    };
    syncDroppedEvents = null;
    syncDroppedWater = null;
    syncDroppedBasis = null;
    syncDroppedT1 = null;
    queuedImport = nextImport;
    syncQueuedImport = nextImport;
    queueMicrotask(() => {
      if (syncQueuedImport === nextImport) syncQueuedImport = null;
    });
    importAbort.abort(Object.assign(new Error("Superseded"), { name: "AbortError", superseded: true }));
    return Promise.resolve();
  }
  return loadFiles({ kind: options?.water ? "water-reference" : "import", files }).catch((error) => {
    if (error?.superseded) return;
    status(error.name === "AbortError" ? "Loading cancelled" : error.message, error.name !== "AbortError");
    progress.end(error.name === "AbortError" ? "Loading cancelled" : error.message, { success: false });
  });
}

$("cancelButton").onclick = () => {
  if (importAbort) {
    importAbort.abort();
    return;
  }
  runAbort?.abort();
  exampleControl.cancel();
  tissue.cancel();
  cancelWorker();
};
$("dataInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(files);
});
bindFileDrop($("dropZone"), async (files) => importFiles(await files));
$("waterInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (!files.length) return;
  if (syncQueuedImport) {
    syncQueuedImport.waterFiles = files;
    return;
  }
  if (syncImportController) {
    pendingDroppedWater = { controller: syncImportController, files };
    return;
  }
  void importFiles(files, { water: true });
});
bindFileDrop($("waterDrop"), async (files) => importFiles(await files, { water: true }));
$("folderInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(files);
});
async function readBasisFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = /\.gz$/i.test(file.name)
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(bytes);
  return parseCustomBasis(file.name, text);
}

function formatBasisInfo(basis) {
  const { header } = basis;
  return `${basis.name}: ${header.metabolites.length} metabolites${header.teMs ? `, TE ${header.teMs} ms` : ""}${header.hzpppm ? `, ${(header.hzpppm / 42.577).toFixed(1)} T` : ""}`;
}

function restoreBasisInfo() {
  if (customBasis) {
    $("basisInfo").hidden = false;
    $("basisInfo").textContent = formatBasisInfo(customBasis);
  } else {
    $("basisInfo").hidden = true;
    $("basisInfo").textContent = "";
  }
}

async function loadBasisFile(file) {
  if (!file || busy) return;
  const gen = ++basisGeneration;
  activeBasisReadGen = gen;
  $("basisInfo").hidden = false;
  $("basisInfo").textContent = `Reading ${file.name}…`;
  updateRunButton();
  try {
    const basis = await readBasisFile(file);
    if (gen !== basisGeneration) return;
    if (busy) {
      // An overlapping spectrum import started while this basis was reading: defer committing
      // until the import settles so read order never silently discards the user's basis choice.
      pendingDeferredBasis = { gen, basis, file };
      $("basisInfo").hidden = false;
      $("basisInfo").textContent = `${file.name} ready (applying after load)…`;
      return;
    }
    setCustomBasis(basis.name, basis.text, file);
    status(`${file.name} loaded as the basis set`);
  } catch (error) {
    if (gen !== basisGeneration) return;
    pendingDeferredBasis = null;
    restoreBasisInfo();
    $("basisInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: customBasis?.file ? [customBasis.file] : [], cancelPending: true } }));
    status(error.message, true);
  } finally {
    if (activeBasisReadGen === gen) activeBasisReadGen = null;
    updateRunButton();
  }
}
$("basisInput").addEventListener("nd-replace", () => {
  basisGeneration += 1;
  pendingDeferredBasis = null;
  updateRunButton();
  if (syncQueuedImport) {
    syncQueuedImport.basis = { clear: true };
    return;
  }
  if (syncImportController) {
    pendingDroppedBasis = { controller: syncImportController, clear: true };
    return;
  }
  if (busy && !importAbort) return;
  const entry = { clear: true };
  syncDroppedBasis = entry;
  queueMicrotask(() => {
    if (syncDroppedBasis !== entry) return;
    syncDroppedBasis = null;
    if (!syncQueuedImport && !syncImportController && !busy) clearCustomBasis({ notify: true });
  });
});
$("basisInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  basisGeneration += 1;
  pendingDeferredBasis = null;
  updateRunButton();
  if (syncQueuedImport) {
    syncQueuedImport.basis = { file };
    return;
  }
  if (syncImportController) {
    pendingDroppedBasis = { controller: syncImportController, file };
    return;
  }
  if (busy && !importAbort) return;
  const entry = { file };
  syncDroppedBasis = entry;
  queueMicrotask(() => {
    if (syncDroppedBasis !== entry) return;
    syncDroppedBasis = null;
    if (!busy) void loadBasisFile(file);
  });
});
bindFileDrop($("basisDrop"), async (files) => loadBasisFile((await files)[0]));
function commitParsedEvents(name, events, file = null) {
  eventsGeneration += 1;
  pendingDeferredEvents = null;
  fmrsEvents = { name, events, file };
  const conds = [...new Set(events.map((e) => e.condition))];
  $("eventsInfo").hidden = false;
  $("eventsInfo").textContent = `${name}: ${events.length} events (${conds.join(", ")})`;
  $("clearEventsBtn").hidden = false;
  $("eventsDrop").classList.add("has-files");
  clearFmrsResult();
  if (file) {
    $("eventsInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
  }
  updateRunButton();
}

async function loadEventsFile(file) {
  if (!file || busy) return;
  // Invalidate any previously loaded schedule and block Run across all modes
  // (including sliding) until THIS read settles or is superseded by a newer generation.
  clearEvents({ notify: false });
  const gen = eventsGeneration;
  activeEventsReadGen = gen;
  $("eventsInfo").hidden = false;
  $("eventsInfo").textContent = `Reading ${file.name}…`;
  $("clearEventsBtn").hidden = false;
  updateRunButton();
  const ownerSession = spectraSessionId;
  try {
    const text = await file.text();
    if (gen !== eventsGeneration) return;
    if (spectraSessionId !== ownerSession) {
      clearEvents({ notify: true });
      return;
    }
    const events = parseEventsText(text);
    if (busy) {
      // An overlapping non-replacing operation (e.g. standalone T1 import or water attachment)
      // is busy on the same spectrum: defer committing until setBusy(false) drains deferred reads.
      pendingDeferredEvents = { gen, name: file.name, events, file, ownerSession };
      $("eventsInfo").hidden = false;
      $("eventsInfo").textContent = `${file.name} ready (applying after load)…`;
      return;
    }
    commitParsedEvents(file.name, events, file);
    status(`${file.name} loaded (${events.length} stimulus events)`);
  } catch (error) {
    if (gen !== eventsGeneration) return;
    clearEvents({ notify: true });
    status(error.message, true);
  } finally {
    if (activeEventsReadGen === gen) activeEventsReadGen = null;
    updateRunButton();
  }
}
$("eventsInput").addEventListener("nd-replace", () => {
  pendingDeferredEvents = null;
  if (syncQueuedImport) {
    syncQueuedImport.events = { clear: true };
    return;
  }
  if (syncImportController) {
    pendingDroppedEvents = { controller: syncImportController, clear: true };
    return;
  }
  if (busy && !importAbort) return;
  // Defer clearing by one microtask so a combined drop arriving as [events, spectra/water]
  // lets loadFiles or a busy-import Undo queue claim the events file (or Undo's clear) without
  // clearing the resident schedule if a replacement spectrum is invalid.
  const entry = { clear: true };
  syncDroppedEvents = entry;
  queueMicrotask(() => {
    if (syncDroppedEvents !== entry) return;
    syncDroppedEvents = null;
    if (!syncQueuedImport && !syncImportController && !busy) clearEvents({ notify: true });
  });
});
function rejectAmbiguousEvents(count) {
  const residentEvents = fmrsEvents?.file ? [fmrsEvents.file] : [];
  $("eventsInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: residentEvents, cancelPending: true } }));
  status(`Choose one stimulus events file (.tsv or .csv), not ${count}.`, true);
}
$("eventsInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (!files.length) return;
  if (syncQueuedImport) {
    // Undo or replacement drop while a prior import is aborting: pair with the queued import.
    syncQueuedImport.events = { files };
    return;
  }
  if (syncImportController) {
    // Combined page drop (spectra/water first, events second) in the same synchronous turn.
    pendingDroppedEvents = { controller: syncImportController, files };
    return;
  }
  if (busy && !importAbort) return;
  // Combined page drop (events first, spectra/water second) or Undo replay while busy:
  // defer standalone loading by one microtask so a same-turn spectrum/water drop or
  // queued Undo import can claim it.
  const entry = { files };
  syncDroppedEvents = entry;
  queueMicrotask(() => {
    if (syncDroppedEvents !== entry) return;
    syncDroppedEvents = null;
    if (busy) return;
    if (files.length > 1) rejectAmbiguousEvents(files.length);
    else void loadEventsFile(files[0]);
  });
});
$("clearEventsBtn").addEventListener("click", () => {
  clearEvents({ notify: true, cancelPending: true });
  status("Stimulus events cleared");
});
bindFileDrop($("eventsDrop"), async (promised) => {
  const files = await promised;
  if (files.length > 1) rejectAmbiguousEvents(files.length);
  else if (files[0]) void loadEventsFile(files[0]);
});
$("fmrsMode").addEventListener("change", updateFmrsControls);
fmrsPanelSelect.addEventListener("change", () => showView("fmrs"));
fmrsMetabSelect.addEventListener("change", () => showView("fmrs"));
$("editedToggle").addEventListener("change", () => {
  const ds = input.datasets[input.index];
  ds.editOverride = $("editedToggle").checked;
  // The stored fit and any fMRS analysis used the other reading of the transients.
  fits.delete(input.index);
  clearFmrsResult();
  clearResults();
  showDataset();
  renderGroup();
});
$("basisSelect").addEventListener("change", () => {
  showBasisAdvice();
  showMacromoleculeModel();
});
$("mmModel").addEventListener("change", showMacromoleculeModel);
$("datasetSelect").addEventListener("change", () => selectDataset(Number($("datasetSelect").value), { keepView: true }));
groupShow.addEventListener("change", renderGroup);
for (const id of ["hzpppmInput", "dwellInput"]) $(id).addEventListener("input", () => {
  recommend();
  updateRunButton();
});
$("concColumn").addEventListener("change", () => {
  if (fit) renderConcentrations();
});
$("runButton").addEventListener("click", () => void (fmrsActive() ? runFmrs() : datasetCount() > 1 ? runGroup() : run()));
$("runSelectedButton").addEventListener("click", () => void run());

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  scope: $("inputSection"),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    customBasis = null;
    $("basisDrop").classList.remove("has-files");
    // The structural image goes to the tissue section, the rest to FID-A.
    const isT1 = (k) => example.files[k].role === "t1";
    tissue.reset();
    await loadFiles({ kind: "import", files: files.filter((_, k) => !isT1(k)) }, signal);
    assertCurrent();
    const t1 = files.filter((_, k) => isT1(k));
    if (t1.length) await loadT1Files(t1, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);
recommend();

// ---------------------------------------------------------------------------
// Typed automation: the same load and fit, with parameters applied to the controls.
// ---------------------------------------------------------------------------

/** Load the inputs and set the controls from the parameters, as a user would. */
async function prepareAutomation({ inputs, parameters, signal, progress: report }) {
  exampleControl.cancel();
  report("Reading the spectroscopy data");
  try {
    await loadFiles({ kind: "fit-request", inputs, parameters }, signal);
  } catch (error) {
    const message = error.name === "AbortError" ? "Cancelled" : error.message;
    progress.end(message, { success: false });
    status(message, error.name !== "AbortError");
    throw error;
  }
}

/** While an automation run is active, its signal works like the footer ×. */
async function whileCancellable(signal, work) {
  signal.throwIfAborted();
  const abort = () => {
    runAbort?.abort();
    tissue.cancel();
    cancelWorker();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await work();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function fitOperation(context) {
  const { signal, progress: report } = context;
  await prepareAutomation(context);
  const choice = $("basisSelect").value;
  checkBasis(currentHeader(), choice, bases());
  report("Preprocessing and fitting");
  const completed = await whileCancellable(signal, () => run({ throwOnError: true }));
  const entry = currentEntry();
  const artifacts = Object.entries(resultFiles(entry)).map(([role, item]) => ({ role, file: item.file ?? item.make() }));
  if (context.inputs.t1?.length && !completed.correction) throw new Error($("tissueAdvice").textContent || "The tissue correction could not be applied to these data.");
  return { artifacts, ...fitSummary(entry, choice === CUSTOM ? customBasis.name : choice) };
}

async function fitGroupOperation(context) {
  const { parameters: p, signal, progress: report } = context;
  await prepareAutomation(context);
  if (input.kind !== "fida") throw new Error("fit-group fits raw spectroscopy data; fit an LCModel .RAW with the fit operation.");
  const settings = settingsFrom(p);
  report(`Fitting ${input.datasets.length} datasets`);
  const outcome = await whileCancellable(signal, () => runGroup({ settings, explicitBasis: Boolean(p.basisSet && p.basisSet !== "auto"), throwOnError: true }));
  const { records } = groupRecords();
  const csv = (name, body) => new File([body], name, { type: "text/csv" });
  const artifacts = [
    { role: "groupTable", file: csv("lcmodel_group.csv", groupCsvLong(records)) },
    { role: "groupWide", file: csv("lcmodel_group_wide.csv", groupCsvWide(records)) },
  ];
  for (const entry of [...fits.values()].sort((a, b) => a.index - b.index)) {
    if (entry.status === STATUS.fitted) artifacts.push({ role: "reports", file: reportFile(entry) });
  }
  return {
    artifacts,
    measurements: { datasets: groupMeasurements(records) },
    provenance: {
      basisSelection: outcome.plan.mode,
      basisNote: outcome.plan.description,
      lineBroadening: settings.lineBroadening,
      macromoleculeModel: settings.mmModel,
      fitted: outcome.fitted,
      failed: outcome.failed,
    },
  };
}

async function fitFmrsOperation(context) {
  const { inputs, parameters: p, signal, progress: report } = context;
  await prepareAutomation(context);
  if (input.kind !== "fida") throw new Error("fit-fmrs requires unaveraged raw spectroscopy data.");
  if (input.datasets.length !== 1) {
    throw new Error(`fit-fmrs fits one multi-transient dataset at a time, not ${input.datasets.length} datasets.`);
  }
  const ownerInput = input;
  clearEvents({ notify: true, cancelPending: true });
  const gen = eventsGeneration;
  if (inputs.events?.length) {
    signal?.throwIfAborted();
    const text = await inputs.events[0].text();
    signal?.throwIfAborted();
    if (gen !== eventsGeneration || busy || input !== ownerInput) {
      throw new Error("Spectroscopy input or stimulus events changed while reading automation events.");
    }
    commitParsedEvents(inputs.events[0].name, parseEventsText(text), inputs.events[0]);
  }
  $("fmrsMode").value = p.fmrsMode ?? "sliding";
  $("fmrsWindow").value = String(p.fmrsWindow ?? 4);
  $("fmrsStep").value = p.fmrsStep ? String(p.fmrsStep) : "";
  $("matchLinewidth").checked = Boolean(p.matchLinewidth);
  $("dynamicGlm").checked = p.dynamicGlm ?? true;
  updateFmrsControls();
  const choice = $("basisSelect").value;
  checkBasis(currentHeader(), choice, bases());
  report("Running functional MRS analysis");
  const result = await whileCancellable(signal, () => runFmrs({ throwOnError: true }));
  const artifacts = Object.entries(fmrsFiles()).map(([role, item]) => ({ role, file: item.file ?? item.make() }));
  return {
    artifacts,
    measurements: {
      mode: result.mode,
      windows: result.windows.map((w) => ({
        id: w.id,
        label: w.label,
        condition: w.condition,
        midTimeS: w.midTimeS,
        averagesKept: w.averagesKept,
        status: w.status,
        qcStatus: w.qc?.status ?? null,
        fwhmPpm: w.fwhmPpm ?? null,
        lwHz: w.lwHz ?? null,
        broadeningAppliedHz: w.broadeningAppliedHz ?? 0,
        linewidthMatchStatus: w.linewidthMatchStatus ?? "off",
        snr: w.lcmSnr ?? null,
      })),
      conditionSummary: result.conditionSummary,
      windowedStats: result.windowedStats,
      dynamicGlm: result.dynamicGlm
        ? {
            aligned: result.dynamicGlm.aligned,
            alignmentRms: result.dynamicGlm.alignmentRms ?? null,
            error: result.dynamicGlm.error ?? null,
            seMethod: result.dynamicGlm.seMethod ?? null,
            transientsUsed: result.dynamicGlm.transientsUsed,
            degreesOfFreedom: result.dynamicGlm.degreesOfFreedom,
            baseline: result.dynamicGlm.baseline,
            metabolites: result.dynamicGlm.metabolites,
            boldLinewidth: result.dynamicGlm.boldLinewidth?.contrasts ?? null,
            freqShift: result.dynamicGlm.freqShift?.contrasts ?? null,
          }
        : null,
    },
    provenance: {
      basisSet: choice === CUSTOM ? customBasis.name : choice,
      mode: result.mode,
      matchLinewidth: result.matchLinewidth,
      targetLinewidthHz: result.targetLinewidthHz,
    },
  };
}

// T1 DICOM inputs arrive converted, through the shared dcm2niix import.
registerAppAutomation({ app: APP.id, convertDicom: runDcm2niix, operations: { fit: fitOperation, "fit-group": fitGroupOperation, "fit-fmrs": fitFmrsOperation } });

window.addEventListener("pagehide", () => {
  importAbort?.abort();
  exampleControl.destroy();
  tissue.cancel();
  cancelWorker();
});

export default Object.freeze({ workspace, toolbar, log, info, results, app: APP });
