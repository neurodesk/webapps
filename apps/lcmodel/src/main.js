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
import manifest from "../../../models/lcmodel.manifest.json" with { type: "json" };
import lcmodelPackage from "../../../packages/lcmodel/package.json" with { type: "json" };
import examples from "../examples.json" with { type: "json" };
import { APP, basisLibrary } from "./config.js";
import { rankBases, assessBasis, parseBasisHeader, recommendBasis } from "./basis-select.js";
import { buildControl, parseCoord, fillGaps, parseTable, concentrationsCsv, presentRows, FILES } from "./lcmodel-io.js";
import { sortInputs, textHead, parseRaw, parseControl } from "./inputs.js";
import { spectrumSvg, fitSeries, metaboliteSeries } from "./spectrum-plot.js";
import { STATUS, groupRecord, groupCsvLong, groupCsvWide, planBases, uniqueNames, fileStem } from "./group.js";
import { buildReport, formatConc } from "./report.js";
import { renderGroupTable } from "./group-view.js";
import { createTissuePanel } from "./tissue-panel.js";

const $ = (id) => document.getElementById(id);
const CUSTOM = "custom";
const VERSIONS = Object.freeze({
  app: APP.version,
  lcmodel: `6.3-1N, Rust port (@neurodesk/lcmodel ${lcmodelPackage.version})`,
  fida: `Rust port (@neurodesk/lcmodel ${lcmodelPackage.version})`,
});

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
  { id: "voxel", label: "Voxel" },
  { id: "group", label: "Group" },
];
// The group table shows concentrations or ratios; how it is displayed belongs in the toolbar.
const groupShow = document.createElement("select");
groupShow.id = "groupShow";
groupShow.setAttribute("aria-label", "Group table values");
groupShow.hidden = true;
groupShow.append(new Option("Concentrations", "concentration"), new Option("Ratios", "ratio"), new Option("Tissue-corrected", "tissue"));
const toolbar = createViewerToolbar({
  views: VIEWS.map((v) => ({ ...v, disabled: true, onClick: () => showView(v.id) })),
  viewsLabel: "Plot",
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [groupShow],
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
});

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About LCModel", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const library = basisLibrary(manifest);
const results = createResultList({
  element: $("resultList"),
  onView: (stage, result) => {
    if (stage === "fitReport") openReport(result);
    else if (stage.startsWith("group")) showView("group");
    else showView(stage === "preprocessing" ? "preprocessing" : stage === "voxelMask" ? "voxel" : "fit");
  },
  onDownload: (_stage, result) => result && downloadFile(result.file ?? result.make()),
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The loaded input: FID-A datasets or an LCModel .RAW (direct). */
let input = null;
let customBasis = null; // { name, text, header, sha256? }
/** Each dataset's last fit, fitted, failed or cancelled, by dataset index. */
const fits = new Map();
let processed = null; // FID-A result shown in the viewer
let fit = null; // parsed LCModel output shown in the viewer
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
let jobId = 0;
const pending = new Map();
let workerProgress = null; // a group run maps each dataset's progress into its share

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./lcmodel-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.type === "progress") {
      if (workerProgress) workerProgress(data.fraction, data.text);
      else progress.setProgress(data.fraction, data.text);
      return;
    }
    pending.delete(data.id);
    if (data.type === "done") job.resolve(data.result);
    else job.reject(Object.assign(new Error(data.message), { trap: data.name === "RuntimeError" }));
  };
  worker.onerror = (event) => {
    for (const job of pending.values()) job.reject(new Error(event.message || "The processing worker failed."));
    pending.clear();
  };
  return worker;
}

function runJob(job, transfer = []) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ ...job, id }, transfer);
  });
}

function cancelWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const job of pending.values()) {
    const error = new Error("Cancelled");
    error.name = "AbortError";
    job.reject(error);
  }
  pending.clear();
  // The module's loaded datasets went with the worker; ensureLoaded reads them again.
  if (input?.kind === "fida") input.stale = true;
}

/** Read the files into a fresh worker after Cancel, or after a WebAssembly trap. */
async function ensureLoaded() {
  if (input?.kind !== "fida" || !input.stale) return;
  progress.setIndeterminate("Reading the data again…");
  const payload = await Promise.all(input.sources.map(async (s) => ({ name: s.name, bytes: await s.file.arrayBuffer() })));
  const loaded = await runJob({ type: "load", files: payload }, payload.map((f) => f.bytes));
  if (loaded.datasets.length !== input.datasets.length) throw new Error("The files changed since they were loaded. Load them again.");
  input.stale = false;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function setBusy(value) {
  busy = value;
  $("dataInput").disabled = value;
  $("folderInput").disabled = value;
  $("basisInput").disabled = value;
  $("editedToggle").disabled = value;
  tissue.setDisabled(value);
  exampleControl.setDisabled(value);
  updateRunButton();
}

function datasetCount() {
  return input?.kind === "fida" ? input.datasets.length : 0;
}

function updateRunButton() {
  const acquisitionOk = input?.kind !== "raw" || (acquisitionFromFields().hzpppm > 0 && acquisitionFromFields().deltat > 0);
  const basisOk = $("basisSelect").value !== CUSTOM || Boolean(customBasis);
  const disabled = busy || !input || !acquisitionOk || !basisOk;
  const many = datasetCount() > 1;
  $("runButton").disabled = disabled;
  $("runButton").textContent = many ? `Fit all ${datasetCount()} datasets` : "Preprocess and fit";
  $("runSelectedButton").hidden = !many;
  $("runSelectedButton").disabled = disabled;
}

/** Clear the fit shown in the viewer and sidebar (stored fits stay). */
function clearResults() {
  processed = null;
  fit = null;
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
  for (const v of VIEWS) if (v.id !== "group" && v.id !== "voxel") setViewEnabled(v.id, false);
  renderResultList();
  $("outputSection").open = hasGroup();
  if (view === "group" && !hasGroup()) showView("fit");
}

async function loadFiles(files, signal) {
  if (busy) throw new Error("Files are still loading. Wait or cancel, then retry.");
  setBusy(true);
  fits.clear();
  renderGroup();
  clearResults();
  progress.begin("Reading files…");
  status(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  const abort = () => cancelWorker();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const read = await Promise.all(files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // A folder keeps its relative paths (picker: webkitRelativePath; drop: bindFileDrop's
      // _webkitRelativePath), so subjects with the same file names pair within their folders.
      return { name: file.webkitRelativePath || file._webkitRelativePath || file.name, bytes, head: textHead(bytes), file };
    }));
    signal?.throwIfAborted();
    const sorted = sortInputs(read);
    if (sorted.basis.length) {
      const text = new TextDecoder().decode(sorted.basis[0].bytes);
      setCustomBasis(sorted.basis[0].name, text);
    }
    const control = sorted.control.length ? parseControl(new TextDecoder().decode(sorted.control[0].bytes)) : null;
    if (sorted.raw.length) {
      input = loadRaw(sorted, control);
    } else if (sorted.other.length) {
      input = await loadWithFida(sorted.other, signal);
    } else if (sorted.water.length) {
      throw new Error("Only a water reference was found; add the water-suppressed spectrum.");
    } else if (sorted.basis.length) {
      input = null;
      status("Basis set loaded; add spectroscopy data.");
      progress.end("Basis set loaded");
      return;
    } else {
      throw new Error("No spectroscopy data found among the files.");
    }
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = files.length > 6 ? `${files.length} files` : files.map((f) => f.name).join(", ");
    $("dropZone").classList.add("has-files");
    $("emptyState").textContent = datasetCount() > 1
      ? "Data loaded. Check the basis set, then fit all datasets."
      : "Data loaded. Check the basis set, then preprocess and fit.";
    $("emptyState").hidden = false;
    showDataset();
    progress.end("Data loaded");
    status(`${describeInput()} loaded`);
  } catch (error) {
    input = null;
    showDataset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    setBusy(false);
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

function loadRaw(sorted, control) {
  const text = new TextDecoder().decode(sorted.raw[0].bytes);
  const raw = parseRaw(text);
  const water = sorted.water.length ? new TextDecoder().decode(sorted.water[0].bytes) : null;
  if (water && parseRaw(water).points !== raw.points) throw new Error("The water .RAW file has a different number of points from the spectrum.");
  const header = {
    hzpppm: raw.hzpppm ?? control?.hzpppm ?? null,
    teMs: raw.teMs ?? control?.teMs ?? null,
    deltat: raw.deltat ?? control?.deltat ?? null,
    sequence: raw.sequence,
  };
  $("hzpppmInput").value = header.hzpppm ?? "";
  $("dwellInput").value = header.deltat ? +(header.deltat * 1000).toPrecision(6) : "";
  return { kind: "raw", name: sorted.raw[0].name, waterName: sorted.water[0]?.name ?? null, text, water, points: raw.points, header };
}

async function loadWithFida(files, signal) {
  progress.setIndeterminate("Reading the data with FID-A…");
  const payload = files.map((f) => ({ name: f.name, bytes: f.bytes.buffer }));
  const loaded = await runJob({ type: "load", files: payload }, payload.map((f) => f.bytes));
  signal?.throwIfAborted();
  for (const e of loaded.errors) log.log(`${e.file}: ${e.error}`, "warning");
  for (const e of loaded.ignored) log.log(`${e.file}: ${e.reason}`, "info");
  for (const name of loaded.unpairedWater ?? []) log.log(`${name}: a water reference with no spectrum to pair it with`, "warning");
  if (!loaded.datasets.length) {
    const first = loaded.errors[0];
    throw new Error(first ? `${first.file}: ${first.error}` : "No readable spectroscopy data found.");
  }
  // Subjects in their own folders may share file names; label them by folder.
  const labels = uniqueNames(loaded.datasets);
  loaded.datasets.forEach((d, k) => {
    d.label = labels[k];
  });
  if (loaded.datasets.length > 1) log.log(`${loaded.datasets.length} datasets: ${loaded.datasets.map((d) => `${d.label}${d.water ? ` + ${d.water}` : ""}`).join(", ")}`);
  // The worker took the bytes; the File objects let it read them again.
  return {
    kind: "fida",
    datasets: loaded.datasets,
    index: 0,
    files: files.map((f) => f.name),
    sources: files.map((f) => ({ name: f.name, file: f.file })),
    // Files FID-A could not read: failed rows of a group table.
    loadErrors: loaded.errors,
  };
}

/** What the basis set is matched against, for dataset `k`. */
function headerFor(k = input?.index) {
  if (!input) return null;
  if (input.kind === "raw") {
    const a = acquisitionFromFields();
    return { hzpppm: a.hzpppm, teMs: input.header.teMs, sequence: input.header.sequence };
  }
  const ds = input.datasets[k];
  const sequence = isEdited(k) ? "MEGA-PRESS" : ds.header.family || ds.header.sequence;
  return { hzpppm: ds.header.hzpppm, teMs: ds.header.teMs, sequence };
}

const currentHeader = () => headerFor();

function acquisitionFromFields() {
  const hz = Number($("hzpppmInput").value);
  const dwellMs = Number($("dwellInput").value);
  return { hzpppm: hz > 0 ? hz : null, deltat: dwellMs > 0 ? dwellMs / 1000 : null };
}

/** Edited MEGA-PRESS data: LCModel fits their difference spectrum. GE and
 * Philips files do not say; the worker compares alternate transients
 * (header.editing) and the user can override it. */
function isEdited(k = input?.index) {
  if (input?.kind !== "fida") return false;
  const ds = input.datasets[k];
  if (ds.header.editing) return ds.editOverride ?? ds.header.editing.detected;
  return ds.header.family === "MEGA-PRESS";
}

function hasWater() {
  if (!input) return false;
  return input.kind === "raw" ? Boolean(input.water) : Boolean(input.datasets[input.index].water);
}

function describeInput() {
  if (!input) return "";
  if (input.kind === "raw") return `${input.name} (LCModel .RAW, ${input.points} points)`;
  if (input.datasets.length > 1) return `${input.datasets.length} datasets`;
  return describeDataset(0);
}

function describeDataset(k) {
  if (input.kind === "raw") return `${input.name} (LCModel .RAW, ${input.points} points)`;
  const ds = input.datasets[k];
  return `${ds.label} (${ds.format})`;
}

const datasetLabel = (k) => (input.kind === "raw" ? input.name : input.datasets[k].label);

// Fit ranges, ppm. With the co-edited macromolecule model a MEGA-PRESS
// difference spectrum is fitted down to 0.5 ppm (buildControl leaves out
// 1.2-1.95 ppm) so that the co-edited MM at 0.915 ppm constrains MM3co under
// GABA (Zöllner et al. 2022); without it, LCModel's mega-press-3 preset
// range, 4.2 to 1.95 ppm.
const RANGES = Object.freeze({ plain: ["4.0", "0.2"], "co-edited": ["4.2", "0.5"], none: ["4.2", "1.95"] });

/**
 * The macromolecule model a MEGA-PRESS fit with basis `choice` uses: the
 * requested `model`, except that MM-suppressed editing leaves no co-edited MM
 * to model and a user's own basis that already has an MM3co spectrum must not
 * get a second one.
 */
function macromoleculeModel(choice = $("basisSelect").value, model = $("mmModel").value) {
  if (library.find((b) => b.id === choice)?.mmSuppressed) return "none";
  if (choice === CUSTOM && customBasis?.header.metabolites.some((m) => /^MM3/i.test(m))) return "none";
  return model;
}

const defaultRangeText = (k, choice, model) => (isEdited(k) ? RANGES[macromoleculeModel(choice, model)] : RANGES.plain);

/** LCModel's fit range for dataset `k` fitted with basis `choice` when the user has not set one. */
const defaultRange = (k, choice, model) => defaultRangeText(k, choice, model).map(Number);

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
    if (h.coils > 1) parts.push(`${h.coils} coils`);
    if (h.averages > 1) parts.push(`${split ? h.averages / 2 : h.averages} averages`);
    if (h.subspectra > 1 || split) parts.push(`${split ? 2 : h.subspectra} subspectra`);
    parts.push(input.datasets[input.index].water ? "with water" : "no water reference");
    summary.hidden = false;
    summary.textContent = parts.join(", ");
  }
  showEditing();
  const water = hasWater();
  $("waterScaling").disabled = !water;
  $("waterScaling").checked = water;
  $("ecc").disabled = !water;
  $("preprocessingSettings").hidden = input?.kind === "raw";
  tissue.setDataset(input?.kind === "fida" ? input.datasets[input.index].header : null);
  recommend();
  showMacromoleculeModel();
  updateRunButton();
}

/** The fit range fields still hold one of the defaults. */
function rangeUntouched([start, end]) {
  return Object.values(RANGES).some((r) => r[0] === start && r[1] === end);
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

function setCustomBasis(name, text) {
  const header = parseBasisHeader(text);
  if (!header.metabolites.length) throw new Error(`${name} is not an LCModel .BASIS file.`);
  customBasis = { name, text, header };
  $("basisInfo").hidden = false;
  $("basisInfo").textContent = `${name}: ${header.metabolites.length} metabolites${header.teMs ? `, TE ${header.teMs} ms` : ""}${header.hzpppm ? `, ${(header.hzpppm / 42.577).toFixed(1)} T` : ""}`;
  $("basisDrop").classList.add("has-files");
  $("basisSelect").value = CUSTOM;
  recommend();
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
  advice.textContent = a.level === "match" ? "Matches the data's field strength, sequence and echo time." : texts.join(" ") || "No mismatch found.";
  updateRunButton();
}

/** The worker's basis input and the report's description of it. */
async function basisFor(choice) {
  if (choice === CUSTOM) {
    customBasis.sha256 ??= await sha256Hex(customBasis.text);
    return {
      job: { name: FILES.basis, text: customBasis.text },
      info: { id: CUSTOM, label: `Your basis set: ${customBasis.name}`, file: customBasis.name, sha256: customBasis.sha256 },
    };
  }
  const basis = library.find((b) => b.id === choice);
  if (!basis) throw new Error("No usable basis set for these data; supply a .BASIS file.");
  return {
    job: { name: FILES.basis, library: basis.library },
    info: { id: basis.id, label: basis.label, file: basis.library.url, sha256: basis.library.sha256 },
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Which basis set each dataset of a group run gets (group.js planBases).
 * `explicit`: the choice was requested, not left at the recommendation.
 */
function basisPlan({ explicit = false } = {}) {
  const choice = $("basisSelect").value;
  const chosen = library.find((b) => b.id === choice);
  const datasets = input.datasets.map((_, k) => {
    const header = headerFor(k);
    return {
      recommended: recommendBasis(header, library)?.basis.id ?? null,
      choiceUsable: Boolean(chosen) && assessBasis(header, chosen).usable,
    };
  });
  const selectedRecommendation = explicit ? null : datasets[input.index].recommended;
  const plan = planBases({ choice, custom: choice === CUSTOM, selectedRecommendation, datasets });
  const label = choice === CUSTOM ? `your basis set ${customBasis.name}` : chosen?.label;
  plan.description = plan.mode === "custom" || plan.mode === "chosen"
    ? `Every dataset is fitted with ${label}.`
    : plan.overridden
      ? `${label} does not suit every dataset, so each is fitted with its recommended basis set.`
      : "Each dataset is fitted with its recommended basis set.";
  return plan;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function preprocessingOptions(k) {
  const sd = Number($("badSd").value);
  return {
    removeBadAverages: $("removeBad").checked,
    badAverageSd: sd > 0 ? sd : undefined,
    driftCorrection: $("driftCorrection").checked,
    phaseAndReference: $("phaseReference").checked,
    edited: input.datasets[k].header.editing ? isEdited(k) : undefined,
  };
}

/**
 * Fit settings shared by the datasets of a run. A null `range` means each
 * dataset uses its default (MEGA-PRESS data a different one); the water
 * switches apply wherever a dataset has a water reference.
 */
function fitSettings() {
  const fields = [$("ppmStart").value, $("ppmEnd").value];
  return {
    scaleWater: $("waterScaling").disabled || $("waterScaling").checked,
    ecc: $("ecc").disabled || $("ecc").checked,
    range: rangeUntouched(fields) ? null : fields.map(Number),
    mmModel: $("mmModel").value,
    lineBroadening: $("lineBroadening").value,
  };
}

/**
 * Preprocess (FID-A) and fit (LCModel) dataset `k`.
 * @returns a fitted entry for `fits`; throws when either step fails.
 */
async function fitDataset(k, { choice, range, settings, onStep }) {
  const generated = new Date();
  const name = datasetLabel(k);
  let fida = null;
  let lcm;
  if (input.kind === "fida") {
    await ensureLoaded();
    onStep("Preprocessing with FID-A…");
    fida = await runJob({ type: "process", dataset: k, options: preprocessingOptions(k) });
    for (const w of fida.report.warnings ?? []) log.log(`${name}: ${w}`, "warning");
    for (const w of fida.lcmodel.warnings ?? []) log.log(`${name}: ${w}`, "warning");
    log.log(`FID-A, ${name}: ${summarizeReport(fida.report)}`);
    lcm = fida.lcmodel;
  } else {
    const a = acquisitionFromFields();
    lcm = { raw: input.text, h2o: input.water, nunfil: input.points, deltat: a.deltat, hzpppm: a.hzpppm, teMs: input.header.teMs };
  }
  const water = settings.scaleWater && Boolean(lcm.h2o);
  const mmModel = lcm.edited ? macromoleculeModel(choice, settings.mmModel) : null;
  const lineBroadening = lcm.edited ? "lcmodel" : settings.lineBroadening;
  const control = buildControl({
    nunfil: lcm.nunfil,
    deltat: lcm.deltat,
    hzpppm: lcm.hzpppm,
    teMs: lcm.teMs,
    water,
    ecc: settings.ecc,
    ppmStart: range[0],
    ppmEnd: range[1],
    title: describeDataset(k),
    sptype: lcm.edited ? "mega-press-3" : "",
    coEditedMM: mmModel === "co-edited",
    lineBroadening,
  });
  const files = { [FILES.raw]: lcm.raw };
  if (water) files[FILES.h2o] = lcm.h2o;
  const basis = await basisFor(choice);
  onStep("Fitting with LCModel…");
  const out = await runJob({ type: "fit", control, files, basis: basis.job, fdate: generated.toString() });
  const parsed = parseCoord(out.outputs[FILES.coord] ?? "");
  const coord = { ...parsed, gaps: fillGaps(parsed, lcm.raw, lcm) };
  const tableText = out.outputs[FILES.table] ?? "";
  const table = parseTable(tableText);
  for (const d of coord.diagnostics) log.log(`LCModel, ${name}: ${d}`, "info");
  return {
    index: k,
    status: STATUS.fitted,
    generated,
    basis: basis.info,
    processed: fida,
    fit: {
      coord,
      table: tableText,
      outputs: out.outputs,
      control,
      lcm,
      water,
      rows: presentRows(table.rows.length ? table.rows : coord.rows),
      ratioTo: table.ratioTo ?? coord.ratioTo,
      unit: water ? "mM" : "a.u.",
      range,
      macromoleculeModel: mmModel,
      lineBroadening,
    },
  };
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
  if (!input || busy) {
    if (throwOnError) throw new Error(busy ? "Another job is running." : "No spectroscopy data loaded.");
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
    if (entry.fit.water && tissue.needsSegmentation) {
      progress.setIndeterminate("Segmenting the T1 image…");
      try {
        await tissue.measure();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        log.log(`Tissue correction skipped: ${error.message}`, "warning");
      }
    }
    fits.set(k, entry);
    showEntry(entry);
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

function failedEntry(k, error, basisId) {
  return { index: k, status: STATUS.failed, error: error.message, basis: basisId ? { id: basisId } : null, generated: new Date() };
}

const cancelledEntry = (k) => ({ index: k, status: STATUS.cancelled, error: "Cancelled before it was fitted.", basis: null, generated: new Date() });

/**
 * Fit every loaded dataset, one after the other, with the current settings.
 * A dataset that fails is recorded and the rest continue; the footer ×
 * stops the run and keeps what was fitted.
 * @param {{settings?: ReturnType<typeof fitSettings>, explicitBasis?: boolean, throwOnError?: boolean}} options
 */
async function runGroup({ settings = fitSettings(), explicitBasis = false, throwOnError = false } = {}) {
  if (!input || busy || input.kind !== "fida") {
    if (throwOnError) throw new Error(busy ? "Another job is running." : "No spectroscopy data loaded.");
    return null;
  }
  const n = input.datasets.length;
  const plan = basisPlan({ explicit: explicitBasis });
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
        if (!basisId) throw new Error("No library basis set suits these data; drop a .BASIS file simulated for them.");
        if (basisId === CUSTOM) {
          const a = assessBasis(headerFor(k), { id: CUSTOM, ...customBasis.header });
          if (!a.usable) throw new Error(`Your basis set does not suit these data: ${a.notes.map((note) => note.text).join(" ")}`);
        }
        const [start, end] = defaultRange(k, basisId, settings.mmModel);
        const range = [settings.range?.[0] ?? start, settings.range?.[1] ?? end];
        const entry = await fitDataset(k, { choice: basisId, range, settings, onStep: (text) => progress.setText(`${prefix}: ${text}`) });
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

function summarizeReport(r) {
  const parts = [];
  const rm = r.rm_bad_averages;
  if (rm) parts.push(`${rm.averages_before - rm.averages_after} of ${rm.averages_before} averages removed`);
  if (r.drift?.total_freq_drift != null) parts.push(`drift ${r.drift.total_freq_drift.toFixed(2)} Hz`);
  if (r.snr != null) parts.push(`SNR ${Math.round(r.snr)}`);
  const lw = r.linewidth_naa ?? r.linewidthHz;
  if (lw != null) parts.push(`NAA linewidth ${lw.toFixed(1)} Hz`);
  return parts.join(", ") || r.pipeline;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function setViewEnabled(id, enabled) {
  const tab = toolbar.viewTabs?.querySelector(`[data-view="${id}"]`) ?? toolbar.viewTabs?.querySelectorAll("button")[VIEWS.findIndex((v) => v.id === id)];
  if (tab) tab.disabled = !enabled;
}

/** Show a stored fit (or why there is none) in the viewer and sidebar. */
function showEntry(entry, { view: next = "fit" } = {}) {
  if (entry?.status === STATUS.fitted) {
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
  $("outputSection").open = true;
  $("emptyState").hidden = true;
  showView(next === "group" && hasGroup() ? "group" : "fit");
}

/** The selected fit's entry in `fits`. */
const currentEntry = () => fits.get(input?.kind === "fida" ? input.index : 0);

/** The fit's downloads, keyed by result stage (also the automation artifact roles). */
function resultFiles(entry) {
  const { fit: f } = entry;
  const stem = fileStem(datasetLabel(entry.index));
  const text = (name, body, type = "text/plain") => new File([body], name, { type });
  const entries = {
    concentrations: { description: "Concentrations (.csv)", file: text(`${stem}_concentrations.csv`, concentrationsCsv(f.rows, f.ratioTo), "text/csv"), viewable: false },
    fitReport: { description: "Report, printable (.html)", make: () => reportFile(entry) },
    table: { description: "LCModel table (.table)", file: text(`${stem}.table`, f.table), viewable: false },
    coord: { description: "LCModel fit curves (.coord)", file: text(`${stem}.coord`, f.outputs[FILES.coord] ?? "") },
    raw: { description: f.lcm.edited ? "Difference spectrum for LCModel (.RAW)" : "Spectrum for LCModel (.RAW)", file: text(`${stem}.RAW`, f.lcm.raw), viewable: false },
    control: { description: "LCModel control file", file: text(`${stem}.control`, f.control), viewable: false },
  };
  if (f.lcm.editOff) entries.editOff = { description: "Edit-OFF spectrum for LCModel (.RAW)", file: text(`${stem}_edit_off.RAW`, f.lcm.editOff), viewable: false };
  if (f.water) entries.h2o = { description: "Water reference for LCModel (.H2O)", file: text(`${stem}.H2O`, f.lcm.h2o), viewable: false };
  if (entry.processed) entries.preprocessing = { description: "FID-A report (.json)", file: text(`${stem}_fida.json`, JSON.stringify(entry.processed.report, null, 2), "application/json") };
  // The panel describes the dataset on display, which is the one whose files these are.
  Object.assign(entries, tissue.resultFiles(f.correction, stem, f.ratioTo));
  return entries;
}

// ---------------------------------------------------------------------------
// Reports and the group table
// ---------------------------------------------------------------------------

function reportHtml(entry) {
  const f = entry.fit;
  const ds = input.kind === "fida" ? input.datasets[entry.index] : null;
  const dataset = ds
    ? { name: ds.label, file: ds.path ?? ds.name, waterFile: ds.water ? (ds.waterPath ?? ds.water) : null, format: ds.format, header: ds.header, edited: Boolean(f.lcm.edited) }
    : { name: input.name, file: input.name, waterFile: input.waterName, format: "LCModel .RAW", header: { hzpppm: f.lcm.hzpppm, teMs: input.header.teMs, sequence: input.header.sequence, points: input.points }, edited: false };
  const p = entry.processed;
  return buildReport({
    generated: `${entry.generated.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    versions: VERSIONS,
    dataset,
    basis: entry.basis,
    control: f.control,
    preprocessing: p?.report ?? null,
    spectra: p ? { processed: p.spectrum, unprocessed: p.unprocessed, editOff: p.editOff } : null,
    fit: f,
  });
}

function reportFile(entry) {
  return new File([reportHtml(entry)], `${fileStem(datasetLabel(entry.index))}_report.html`, { type: "text/html" });
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

/** Group table records, in dataset order. */
function groupRecords() {
  const indices = [...fits.keys()].sort((a, b) => a - b);
  const records = indices.map((k) => {
    const entry = fits.get(k);
    const ds = input.datasets[k];
    const f = entry.fit;
    return groupRecord({
      name: ds.label,
      file: ds.path ?? ds.name,
      format: ds.format,
      status: entry.status,
      error: entry.error,
      basis: entry.basis?.id,
      edited: f ? f.lcm.edited : isEdited(k),
      unit: f?.unit,
      ratioTo: f?.ratioTo,
      preprocessing: entry.processed?.report,
      summary: f?.coord.summary,
      metabolites: f?.rows,
      macromoleculeModel: f?.macromoleculeModel,
      lineBroadening: f?.lineBroadening,
      correction: f?.correction,
    });
  });
  // Unreadable files are failed rows too, with no fit to select.
  for (const e of input.loadErrors ?? []) {
    indices.push(-1);
    records.push(groupRecord({ name: e.file, status: STATUS.failed, error: e.error }));
  }
  return { indices, records };
}

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

function renderResultList() {
  const entry = fit ? currentEntry() : null;
  results.render({ ...groupFiles(), ...(entry?.status === STATUS.fitted ? resultFiles(entry) : {}) });
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
  notice.hidden = true;
  plot.hidden = group;
  $("groupView").hidden = !group;
  groupShow.hidden = !group;
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

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch((error) => {
    status(error.name === "AbortError" ? "Loading cancelled" : error.message, error.name !== "AbortError");
    progress.end(error.name === "AbortError" ? "Loading cancelled" : error.message, { success: false });
  });
}

$("cancelButton").onclick = () => {
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
$("folderInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(files);
});
async function loadBasisFile(file) {
  if (!file || busy) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = /\.gz$/i.test(file.name)
      ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
      : new TextDecoder().decode(bytes);
    setCustomBasis(file.name, text);
    status(`${file.name} loaded as the basis set`);
  } catch (error) {
    status(error.message, true);
  }
}
$("basisInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  void loadBasisFile(file);
});
bindFileDrop($("basisDrop"), async (files) => loadBasisFile((await files)[0]));
$("editedToggle").addEventListener("change", () => {
  const ds = input.datasets[input.index];
  ds.editOverride = $("editedToggle").checked;
  // The stored fit used the other reading of the transients.
  fits.delete(input.index);
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
$("runButton").addEventListener("click", () => void (datasetCount() > 1 ? runGroup() : run()));
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
    await loadFiles(files.filter((_, k) => !isT1(k)), signal);
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
async function prepareAutomation({ inputs, parameters: p, signal, progress: report }) {
  exampleControl.cancel();
  customBasis = null;
  $("basisDrop").classList.remove("has-files");
  if (p.frequencyMHz) $("hzpppmInput").value = String(p.frequencyMHz);
  if (p.dwellTimeMs) $("dwellInput").value = String(p.dwellTimeMs);
  $("removeBad").checked = p.removeBadAverages ?? true;
  $("badSd").value = p.badAverageSd ? String(p.badAverageSd) : "";
  $("driftCorrection").checked = p.driftCorrection ?? true;
  $("phaseReference").checked = p.phaseAndReference ?? true;
  const fractionKeys = ["fractionGM", "fractionWM", "fractionCSF"];
  const given = fractionKeys.filter((k) => typeof p[k] === "number");
  if (given.length && given.length < 3) throw new Error("Give all three tissue fractions (fractionGM, fractionWM, fractionCSF), or none.");
  if (given.length && inputs.t1?.length) throw new Error("Give either a T1 image or tissue fractions, not both.");
  $("metabRelax").checked = p.metaboliteRelaxation ?? true;
  tissue.reset();
  report("Reading the spectroscopy data");
  await loadFiles([...inputs.spectra, ...(inputs.basis ?? [])], signal);
  if (!input) throw new Error("No spectroscopy data found among the files.");
  if (inputs.t1?.length) {
    report("Reading the T1 image");
    await loadT1Files(inputs.t1, signal);
  }
  if (given.length) tissue.setFractions({ gm: p.fractionGM, wm: p.fractionWM, csf: p.fractionCSF });
  if (typeof p.edited === "boolean" && input.kind === "fida") {
    for (const ds of input.datasets) if (ds.header.editing) ds.editOverride = p.edited;
    showDataset();
  }
  $("mmModel").value = p.macromoleculeModel ?? "co-edited";
  $("lineBroadening").value = p.lineBroadening ?? "widened";
  if (!inputs.basis?.length && p.basisSet && p.basisSet !== "auto") {
    $("basisSelect").value = p.basisSet;
    showBasisAdvice();
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
  const { parameters: p, signal, progress: report } = context;
  await prepareAutomation(context);
  const range = defaultRangeText(input.index);
  $("ppmStart").value = String(p.ppmStart ?? range[0]);
  $("ppmEnd").value = String(p.ppmEnd ?? range[1]);
  if (!$("waterScaling").disabled) $("waterScaling").checked = p.waterScaling ?? true;
  if (!$("ecc").disabled) $("ecc").checked = p.eddyCurrentCorrection ?? true;
  const choice = $("basisSelect").value;
  if (choice !== CUSTOM && !library.some((b) => b.id === choice)) throw new Error("No usable basis set for these data; supply a .BASIS file.");
  const assessment = currentHeader() && assessBasis(currentHeader(), choice === CUSTOM ? { id: CUSTOM, ...customBasis.header } : library.find((b) => b.id === choice));
  if (assessment?.level === "error") throw new Error(`Basis set ${choice} does not fit these data: ${assessment.notes.map((n) => n.text).join(" ")}`);
  report("Preprocessing and fitting");
  const completed = await whileCancellable(signal, () => run({ throwOnError: true }));
  const entry = currentEntry();
  const artifacts = Object.entries(resultFiles(entry)).map(([role, item]) => ({ role, file: item.file ?? item.make() }));
  const corrected = completed.correction;
  if (context.inputs.t1?.length && !corrected) throw new Error($("tissueAdvice").textContent || "The tissue correction could not be applied to these data.");
  return {
    artifacts,
    measurements: {
      unit: completed.unit,
      ratioTo: completed.ratioTo ?? null,
      metabolites: Object.fromEntries(completed.rows.map((r) => [r.name, { concentration: r.concentration, sdPercent: r.sdPercent, ratio: r.ratio ?? null, ...(r.note ? { note: r.note } : {}) }])),
      ...completed.coord.summary,
      tissue: corrected
        ? {
          unit: corrected.constants.unit,
          method: corrected.constants.method,
          fractions: corrected.fractions,
          source: corrected.source,
          metaboliteRelaxation: corrected.constants.metaboliteRelaxation,
          metabolites: Object.fromEntries(corrected.rows.map((r) => [r.name, { corrected: r.corrected, alphaCorrected: r.alphaCorrected ?? null }])),
        }
        : null,
    },
    provenance: {
      basisSet: choice === CUSTOM ? customBasis.name : choice,
      pipeline: entry.processed?.report.pipeline ?? "LCModel .RAW, no preprocessing",
      sptype: completed.lcm.edited ? "mega-press-3" : null,
      macromoleculeModel: completed.macromoleculeModel,
      lineBroadening: completed.lineBroadening,
      control: completed.control,
    },
  };
}

async function fitGroupOperation(context) {
  const { parameters: p, signal, progress: report } = context;
  await prepareAutomation(context);
  if (input.kind !== "fida") throw new Error("fit-group fits raw spectroscopy data; fit an LCModel .RAW with the fit operation.");
  const settings = {
    scaleWater: p.waterScaling ?? true,
    ecc: p.eddyCurrentCorrection ?? true,
    range: p.ppmStart == null && p.ppmEnd == null ? null : [p.ppmStart ?? null, p.ppmEnd ?? null],
    mmModel: p.macromoleculeModel ?? "co-edited",
    lineBroadening: p.lineBroadening ?? "widened",
  };
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
    measurements: {
      datasets: records.map((r) => ({
        name: r.name,
        file: r.file,
        status: r.status,
        error: r.error,
        basisSet: r.basis,
        edited: r.edited,
        unit: r.unit,
        ratioTo: r.ratioTo,
        fwhmPpm: r.fwhmPpm,
        snr: r.lcmSnr,
        shiftPpm: r.shiftPpm,
        fidaSnr: r.fidaSnr,
        fidaLinewidthHz: r.fidaLinewidthHz,
        averagesRemoved: r.averagesRemoved,
        macromoleculeModel: r.macromoleculeModel,
        lineBroadening: r.lineBroadening,
        tissueFractions: r.fractionSource ? { gm: r.fractionGM, wm: r.fractionWM, csf: r.fractionCSF, source: r.fractionSource } : null,
        metabolites: Object.fromEntries(r.metabolites.map((m) => [m.name, { concentration: m.concentration, sdPercent: m.sdPercent, ratio: m.ratio, tissueCorrected: m.tissueCorrected, alphaCorrected: m.alphaCorrected }])),
      })),
    },
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

// T1 DICOM inputs arrive converted, through the shared dcm2niix import.
registerAppAutomation({ app: APP.id, convertDicom: runDcm2niix, operations: { fit: fitOperation, "fit-group": fitGroupOperation } });

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  tissue.cancel();
  cancelWorker();
});

export default Object.freeze({ workspace, toolbar, log, info, results, app: APP });
