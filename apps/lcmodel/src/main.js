// LCModel webapp: FID-A preprocessing and LCModel fitting of single-voxel MRS,
// both in a worker (see lcmodel-worker.js). The page sorts the dropped files,
// recommends a basis set, and shows the fit, the metabolite table and the
// preprocessing quality checks.
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
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import manifest from "../../../models/lcmodel.manifest.json" with { type: "json" };
import examples from "../examples.json" with { type: "json" };
import { APP, basisLibrary } from "./config.js";
import { rankBases, assessBasis, parseBasisHeader } from "./basis-select.js";
import { buildControl, parseCoord, parseTable, concentrationsCsv, FILES } from "./lcmodel-io.js";
import { sortInputs, textHead, parseRaw, parseControl } from "./inputs.js";
import { spectrumSvg, fitSeries, metaboliteSeries } from "./spectrum-plot.js";

const $ = (id) => document.getElementById(id);
const CUSTOM = "custom";

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
];
const toolbar = createViewerToolbar({
  views: VIEWS.map((v) => ({ ...v, disabled: true, onClick: () => showView(v.id) })),
  viewsLabel: "Plot",
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog" });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About LCModel", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const library = basisLibrary(manifest);
const results = createResultList({
  element: $("resultList"),
  onView: (stage) => showView(stage === "preprocessing" ? "preprocessing" : "fit"),
  onDownload: (_stage, result) => result?.file && downloadFile(result.file),
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The loaded input: FID-A datasets or an LCModel .RAW (direct). */
let input = null;
let customBasis = null; // { name, text, header }
let processed = null; // FID-A result for the current dataset
let fit = null; // parsed LCModel output
let view = "fit";
let busy = false;

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

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./lcmodel-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.type === "progress") {
      progress.setProgress(data.fraction, data.text);
      return;
    }
    pending.delete(data.id);
    if (data.type === "done") job.resolve(data.result);
    else job.reject(new Error(data.message));
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
  // The module's loaded datasets went with the worker.
  if (input?.kind === "fida") input.stale = true;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function setBusy(value) {
  busy = value;
  $("dataInput").disabled = value;
  $("basisInput").disabled = value;
  exampleControl.setDisabled(value);
  updateRunButton();
}

function updateRunButton() {
  const acquisitionOk = input?.kind !== "raw" || (acquisitionFromFields().hzpppm > 0 && acquisitionFromFields().deltat > 0);
  const basisOk = $("basisSelect").value !== CUSTOM || Boolean(customBasis);
  $("runButton").disabled = busy || !input || !acquisitionOk || !basisOk;
}

function clearResults() {
  processed = null;
  fit = null;
  results.render();
  $("outputSection").open = false;
  $("concTable").hidden = true;
  $("fitSummary").hidden = true;
  $("plot").replaceChildren();
  $("viewerNotice").hidden = true;
  $("plotLabel").textContent = "";
  for (const v of VIEWS) setViewEnabled(v.id, false);
}

async function loadFiles(files, signal) {
  if (busy) throw new Error("Files are still loading. Wait or cancel, then retry.");
  setBusy(true);
  clearResults();
  progress.begin("Reading files…");
  status(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  const abort = () => cancelWorker();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const read = await Promise.all(files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { name: file.webkitRelativePath || file.name, bytes, head: textHead(bytes) };
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
    $("fileInfo").textContent = files.map((f) => f.name).join(", ");
    $("dropZone").classList.add("has-files");
    $("emptyState").textContent = "Data loaded. Check the basis set, then preprocess and fit.";
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
  if (!loaded.datasets.length) {
    const first = loaded.errors[0];
    throw new Error(first ? `${first.file}: ${first.error}` : "No readable spectroscopy data found.");
  }
  return { kind: "fida", datasets: loaded.datasets, index: 0, files: files.map((f) => f.name) };
}

function currentHeader() {
  if (!input) return null;
  if (input.kind === "raw") {
    const a = acquisitionFromFields();
    return { hzpppm: a.hzpppm, teMs: input.header.teMs, sequence: input.header.sequence };
  }
  const ds = input.datasets[input.index];
  const sequence = isEdited() ? "MEGA-PRESS" : ds.header.family || ds.header.sequence;
  return { hzpppm: ds.header.hzpppm, teMs: ds.header.teMs, sequence };
}

function acquisitionFromFields() {
  const hz = Number($("hzpppmInput").value);
  const dwellMs = Number($("dwellInput").value);
  return { hzpppm: hz > 0 ? hz : null, deltat: dwellMs > 0 ? dwellMs / 1000 : null };
}

/** Edited MEGA-PRESS data: LCModel fits their difference spectrum. GE and
 * Philips files do not say; the worker compares alternate transients
 * (header.editing) and the user can override it. */
function isEdited() {
  if (input?.kind !== "fida") return false;
  const ds = input.datasets[input.index];
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
  const ds = input.datasets[input.index];
  return `${ds.name} (${ds.format})`;
}

function showDataset() {
  const multi = input?.kind === "fida" && input.datasets.length > 1;
  $("datasetField").hidden = !multi;
  if (multi) {
    $("datasetSelect").replaceChildren(...input.datasets.map((d, k) => new Option(`${d.name} (${d.format})`, String(k))));
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
  // LCModel's MEGA-PRESS analysis (sptype mega-press-3) fits 4.2-1.95 ppm.
  const range = isEdited() ? ["4.2", "1.95"] : ["4.0", "0.2"];
  const editedRange = ["4.2", "1.95"];
  const plainRange = ["4.0", "0.2"];
  const current = [$("ppmStart").value, $("ppmEnd").value];
  const untouched = [editedRange, plainRange].some((r) => r[0] === current[0] && r[1] === current[1]);
  if (untouched) [$("ppmStart").value, $("ppmEnd").value] = range;
  const water = hasWater();
  $("waterScaling").disabled = !water;
  $("waterScaling").checked = water;
  $("ecc").disabled = !water;
  $("preprocessingSettings").hidden = input?.kind === "raw";
  recommend();
  updateRunButton();
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

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function preprocessingOptions() {
  const sd = Number($("badSd").value);
  return {
    removeBadAverages: $("removeBad").checked,
    badAverageSd: sd > 0 ? sd : undefined,
    driftCorrection: $("driftCorrection").checked,
    phaseAndReference: $("phaseReference").checked,
    edited: input.datasets[input.index].header.editing ? isEdited() : undefined,
  };
}

async function run({ throwOnError = false } = {}) {
  if (!input || busy) {
    if (throwOnError) throw new Error(busy ? "Another job is running." : "No spectroscopy data loaded.");
    return null;
  }
  setBusy(true);
  clearResults();
  progress.begin("Preparing…");
  const started = performance.now();
  try {
    if (input.kind === "fida" && input.stale) {
      throw new Error("Processing was cancelled, which released the loaded data. Load the files again.");
    }
    let lcm;
    if (input.kind === "fida") {
      status("Preprocessing with FID-A…");
      processed = await runJob({ type: "process", dataset: input.index, options: preprocessingOptions() });
      for (const w of processed.report.warnings ?? []) log.log(w, "warning");
      for (const w of processed.lcmodel.warnings ?? []) log.log(w, "warning");
      log.log(`FID-A: ${summarizeReport(processed.report)}`);
      lcm = processed.lcmodel;
      setViewEnabled("preprocessing", true);
    } else {
      const a = acquisitionFromFields();
      lcm = { raw: input.text, h2o: input.water, nunfil: input.points, deltat: a.deltat, hzpppm: a.hzpppm, teMs: input.header.teMs };
    }
    const water = $("waterScaling").checked && Boolean(lcm.h2o);
    const control = buildControl({
      nunfil: lcm.nunfil,
      deltat: lcm.deltat,
      hzpppm: lcm.hzpppm,
      teMs: lcm.teMs,
      water,
      ecc: $("ecc").checked,
      ppmStart: Number($("ppmStart").value),
      ppmEnd: Number($("ppmEnd").value),
      title: describeInput(),
      sptype: lcm.edited ? "mega-press-3" : "",
    });
    const files = { [FILES.raw]: lcm.raw };
    if (water) files[FILES.h2o] = lcm.h2o;
    const choice = $("basisSelect").value;
    const basis = choice === CUSTOM
      ? { name: FILES.basis, text: customBasis.text }
      : { name: FILES.basis, library: library.find((b) => b.id === choice).library };
    status("Fitting with LCModel…");
    const out = await runJob({ type: "fit", control, files, basis, fdate: new Date().toString() });
    fit = { coord: parseCoord(out.outputs[FILES.coord] ?? ""), table: out.outputs[FILES.table] ?? "", outputs: out.outputs, control, lcm, water };
    showResults();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    progress.end(`Fit done in ${seconds} s`);
    status(`Fit done in ${seconds} s`);
    return fit;
  } catch (error) {
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
  }
  return null;
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

function showResults() {
  const { coord } = fit;
  const table = parseTable(fit.table);
  const rows = table.rows.length ? table.rows : coord.rows;
  const ratioTo = table.ratioTo ?? coord.ratioTo;
  $("concHeader").textContent = fit.water ? "Conc. (mM)" : "Conc. (a.u.)";
  $("ratioHeader").textContent = ratioTo ? `/${ratioTo}` : "Ratio";
  $("concBody").replaceChildren(...rows.map((r) => {
    const tr = document.createElement("tr");
    if (r.combination) tr.className = "lcm-combination";
    if (r.sdPercent > 20) tr.classList.add("lcm-uncertain");
    for (const text of [r.name, formatConc(r.concentration), `${r.sdPercent}%`, r.ratio == null ? "" : formatConc(r.ratio)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));
  $("concTable").hidden = false;
  const s = coord.summary;
  $("fitSummary").hidden = false;
  $("fitSummary").textContent = [s.fwhmPpm != null && `FWHM ${s.fwhmPpm} ppm`, s.snr != null && `S/N ${s.snr}`, s.shiftPpm != null && `shift ${s.shiftPpm} ppm`, coord.diagnostics.length && `${coord.diagnostics.length} LCModel messages`].filter(Boolean).join(" · ");
  for (const d of coord.diagnostics) log.log(`LCModel: ${d}`, "info");
  setViewEnabled("fit", true);
  setViewEnabled("metabolites", coord.metabolites.length > 0);
  const entries = resultFiles(rows, ratioTo);
  results.render(entries);
  $("outputSection").open = true;
  $("emptyState").hidden = true;
  showView("fit");
}

/** The fit's downloads, keyed by result stage (also the automation artifact roles). */
function resultFiles(rows, ratioTo) {
  const stem = (describeInput().split(" ")[0] || "lcmodel").replace(/\.[^.]+$/, "");
  const text = (name, body, type = "text/plain") => new File([body], name, { type });
  const entries = {
    concentrations: { description: "Concentrations (.csv)", file: text(`${stem}_concentrations.csv`, concentrationsCsv(rows, ratioTo), "text/csv"), viewable: false },
    table: { description: "LCModel table (.table)", file: text(`${stem}.table`, fit.table), viewable: false },
    coord: { description: "LCModel fit curves (.coord)", file: text(`${stem}.coord`, fit.outputs[FILES.coord] ?? "") },
    raw: { description: fit.lcm.edited ? "Difference spectrum for LCModel (.RAW)" : "Spectrum for LCModel (.RAW)", file: text(`${stem}.RAW`, fit.lcm.raw), viewable: false },
    control: { description: "LCModel control file", file: text(`${stem}.control`, fit.control), viewable: false },
  };
  if (fit.lcm.editOff) entries.editOff = { description: "Edit-OFF spectrum for LCModel (.RAW)", file: text(`${stem}_edit_off.RAW`, fit.lcm.editOff), viewable: false };
  if (fit.water) entries.h2o = { description: "Water reference for LCModel (.H2O)", file: text(`${stem}.H2O`, fit.lcm.h2o), viewable: false };
  if (processed) entries.preprocessing = { description: "FID-A report (.json)", file: text(`${stem}_fida.json`, JSON.stringify(processed.report, null, 2), "application/json") };
  return entries;
}

function formatConc(x) {
  if (x === 0) return "0";
  return Math.abs(x) >= 0.01 && Math.abs(x) < 1000 ? x.toPrecision(3) : x.toExponential(2);
}

function showView(id) {
  view = id;
  toolbar.setActive(id);
  const plot = $("plot");
  const notice = $("viewerNotice");
  notice.hidden = true;
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
    plot.innerHTML = spectrumSvg({ ppm: fit.coord.ppm, series: metaboliteSeries(fit.coord), range, height: 560, ariaLabel: "Fitted metabolite spectra" });
    $("plotLabel").textContent = "Each fitted metabolite's contribution, largest at the bottom";
  } else if (fit) {
    plot.innerHTML = spectrumSvg({ ppm: fit.coord.ppm, series: fitSeries(fit.coord), range, ariaLabel: "LCModel fit: data, fit, baseline and residual" });
    $("plotLabel").textContent = "Data (grey), LCModel fit (coloured), baseline (dashed), residual (top)";
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
  exampleControl.cancel();
  cancelWorker();
};
$("dataInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(files);
});
bindFileDrop($("dropZone"), async (files) => importFiles(await files));
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
  clearResults();
  showDataset();
});
$("basisSelect").addEventListener("change", showBasisAdvice);
$("datasetSelect").addEventListener("change", () => {
  input.index = Number($("datasetSelect").value);
  clearResults();
  showDataset();
});
for (const id of ["hzpppmInput", "dwellInput"]) $(id).addEventListener("input", () => {
  recommend();
  updateRunButton();
});
$("runButton").addEventListener("click", () => void run());

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  scope: $("inputSection"),
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    customBasis = null;
    $("basisDrop").classList.remove("has-files");
    await loadFiles(files, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);
recommend();

// Typed automation: the same load and fit, with parameters applied to the controls.
async function fitOperation({ inputs, parameters, signal, progress: report }) {
  exampleControl.cancel();
  customBasis = null;
  $("basisDrop").classList.remove("has-files");
  const p = parameters;
  if (p.frequencyMHz) $("hzpppmInput").value = String(p.frequencyMHz);
  if (p.dwellTimeMs) $("dwellInput").value = String(p.dwellTimeMs);
  $("removeBad").checked = p.removeBadAverages ?? true;
  $("badSd").value = p.badAverageSd ? String(p.badAverageSd) : "";
  $("driftCorrection").checked = p.driftCorrection ?? true;
  $("phaseReference").checked = p.phaseAndReference ?? true;
  report("Reading the spectroscopy data");
  await loadFiles([...inputs.spectra, ...(inputs.basis ?? [])], signal);
  if (!input) throw new Error("No spectroscopy data found among the files.");
  if (typeof p.edited === "boolean" && input.kind === "fida" && input.datasets[input.index].header.editing) {
    input.datasets[input.index].editOverride = p.edited;
    showDataset();
  }
  const edited = isEdited();
  $("ppmStart").value = String(p.ppmStart ?? (edited ? 4.2 : 4.0));
  $("ppmEnd").value = String(p.ppmEnd ?? (edited ? 1.95 : 0.2));
  if (!$("waterScaling").disabled) $("waterScaling").checked = p.waterScaling ?? true;
  if (!$("ecc").disabled) $("ecc").checked = p.eddyCurrentCorrection ?? true;
  if (!inputs.basis?.length && p.basisSet && p.basisSet !== "auto") {
    $("basisSelect").value = p.basisSet;
    showBasisAdvice();
  }
  const choice = $("basisSelect").value;
  if (choice !== CUSTOM && !library.some((b) => b.id === choice)) throw new Error("No usable basis set for these data; supply a .BASIS file.");
  const assessment = currentHeader() && assessBasis(currentHeader(), choice === CUSTOM ? { id: CUSTOM, ...customBasis.header } : library.find((b) => b.id === choice));
  if (assessment?.level === "error") throw new Error(`Basis set ${choice} does not fit these data: ${assessment.notes.map((n) => n.text).join(" ")}`);
  signal.throwIfAborted();
  const abort = () => cancelWorker();
  signal.addEventListener("abort", abort, { once: true });
  report("Preprocessing and fitting");
  let completed;
  try {
    completed = await run({ throwOnError: true });
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const table = parseTable(completed.table);
  const rows = table.rows.length ? table.rows : completed.coord.rows;
  const ratioTo = table.ratioTo ?? completed.coord.ratioTo;
  const artifacts = Object.entries(resultFiles(rows, ratioTo)).map(([role, entry]) => ({ role, file: entry.file }));
  return {
    artifacts,
    measurements: {
      unit: completed.water ? "mM" : "a.u.",
      ratioTo: ratioTo ?? null,
      metabolites: Object.fromEntries(rows.map((r) => [r.name, { concentration: r.concentration, sdPercent: r.sdPercent, ratio: r.ratio ?? null }])),
      ...completed.coord.summary,
    },
    provenance: {
      basisSet: choice === CUSTOM ? customBasis.name : choice,
      pipeline: processed?.report.pipeline ?? "LCModel .RAW, no preprocessing",
      sptype: completed.lcm.edited ? "mega-press-3" : null,
      control: completed.control,
    },
  };
}

registerAppAutomation({ app: APP.id, operations: { fit: fitOperation } });

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancelWorker();
});

export default Object.freeze({ workspace, toolbar, log, info, results, app: APP });
