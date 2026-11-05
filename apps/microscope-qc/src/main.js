// Microscope QC: PSF from bead z-stacks and field illumination, with MetroloJ_QC's definitions.
// Numerics live in src/core and run in a module worker; this file is the workflow, the report
// and the viewer.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
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
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { ANALYSES, APP, SettingsError, boxHalfWidth, provenance, readSettings, saturationLevel, suggestedAnalysis } from "./config.js";
import { MICROSCOPES } from "./core/optics.js";
import { maxProjection } from "./core/psf.js";
import {
  beadRecords,
  beadStatus,
  beadsCsv,
  fieldMetricsCsv,
  fieldPointsCsv,
  fieldProfileLegend,
  fieldProfileSvg,
  fieldProfilesCsv,
  outputStem,
  profilesCsv,
  psfSummaryCsv,
  reportJson,
} from "./outputs.js";
import { BEAD_COLORMAP, beadOverlay, displayNifti, displaySpacing, zoneColormap, zoneLabels } from "./display.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const OPTIC_IDS = ["microscope", "na", "refractiveIndex", "emission", "excitation", "pixelX", "pixelY", "zStep"];
const PSF_ADVANCED = ["boxRadius", "prominence", "minR2"];
const FIELD_ADVANCED = ["step"];
const SETTING_IDS = ["analysis", ...OPTIC_IDS, ...PSF_ADVANCED, ...FIELD_ADVANCED];
const CHECK_IDS = ["excludeSaturated", "blur", "referenceZone"];
const ADVANCED = new Set([...PSF_ADVANCED, ...FIELD_ADVANCED]);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "PSF and field illumination quality control",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  views: [
    { id: "image", label: "Image", active: true },
    { id: "report", label: "Report" },
  ],
  window: false,
  colormap: false,
  download: false,
  screenshot: false,
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true, channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }] });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      const vox = event.detail.vox;
      const value = event.detail.values?.[0]?.value;
      $("location").textContent = vox && input ? `x ${Math.round(vox[0])}, y ${Math.round(vox[1])} px${Number.isFinite(value) ? ` · ${Number(value.toPrecision(6))}` : ""}` : "";
    });
  });
  return attached;
}

// State: the loaded image, the last result, and the operation in progress.
let input = null;
let run = null;
let loading = null;
let running = null;
let runCount = 0;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", "analysis");
}

function technical(message) {
  log.log(message, "info", "technical");
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => void show(stage).catch(report),
  onDownload: (_stage, result) => downloadFile(result.file),
});

function updateAnalysisFields() {
  const field = $("analysis").value === "field";
  $("psfFields").hidden = field;
  $("psfAdvanced").hidden = field;
  $("fieldAdvanced").hidden = !field;
  const excitation = $("microscope").value === "confocal" || $("microscope").value === "multiphoton";
  $("excitation").required = excitation;
  $("emission").required = !excitation;
}
$("analysis").addEventListener("change", updateAnalysisFields);
$("microscope").addEventListener("change", updateAnalysisFields);

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["imageInput", ...SETTING_IDS, ...CHECK_IDS]) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin(message);
  status(message);
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  progress.stopTimer();
  progress.setCancellable(false);
}

/** One task in a fresh module worker; aborting terminates it. */
function callWorker(message, { signal, onProgress, transfer = [] } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) {
        onProgress?.(data.progress);
        return;
      }
      stop();
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.postMessage(message, transfer);
  });
}

function clearRun() {
  run = null;
  results.render();
  $("outputSection").open = false;
  $("report").replaceChildren();
  setView("image");
}

function setValue(id, value) {
  if (value !== null && value !== undefined) $(id).value = String(Number(Number(value).toPrecision(8)));
}

/** Copies what the header records into the form; fields it does not record keep their value. */
function applyMetadata(decoded) {
  const { pixelSize } = decoded.metadata;
  setValue("pixelX", pixelSize?.x);
  setValue("pixelY", pixelSize?.y ?? pixelSize?.x);
  setValue("zStep", pixelSize?.z);
  const { optics } = decoded;
  if (optics.type) $("microscope").value = optics.type;
  setValue("na", optics.na);
  setValue("refractiveIndex", optics.refractiveIndex);
  setValue("emission", optics.emission);
  setValue("excitation", optics.excitation);
  $("analysis").value = suggestedAnalysis(decoded.pages);
  updateAnalysisFields();
  return Object.entries({ pixel: pixelSize?.x, "z step": pixelSize?.z, NA: optics.na, "refractive index": optics.refractiveIndex, emission: optics.emission, excitation: optics.excitation, type: optics.type }).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k);
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  setBusy(true);
  progress.setCancellable(true);
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    if (files.length !== 1) throw new Error(`Choose one TIFF image; this selection has ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    if (!/\.tiff?$/i.test(file.name)) throw new Error(`${file.name} is not a TIFF (.tif, .tiff or .ome.tif) image.`);
    const buffer = await file.arrayBuffer();
    current.throwIfAborted();
    const decoded = await callWorker({ type: "decode", buffer }, {
      signal: current,
      transfer: [buffer],
      onProgress: (fraction) => progress.setProgress(fraction * 0.9, "Reading image…"),
    });
    current.throwIfAborted();
    const dims = { width: decoded.width, height: decoded.height, planes: decoded.pages, dtype: decoded.dtype, metadataKind: decoded.metadata.kind };
    input = { file, dims, data: decoded.data, display: null };
    clearRun();
    const recorded = applyMetadata(decoded);
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${dims.width} × ${dims.height} · ${dims.planes} plane${dims.planes > 1 ? "s" : ""} · ${dims.dtype}`;
    $("dropZone").classList.add("has-files");
    technical(`Decoded ${decoded.metadata.kind} TIFF: ${dims.planes} pages of ${dims.width} × ${dims.height} ${dims.dtype}; header records ${recorded.join(", ") || "no optics or voxel size"}`);
    await show("input");
    progress.setProgress(0);
    status(recorded.length ? `${file.name} loaded` : `${file.name} loaded · enter the optics and voxel size`);
  } finally {
    loading = null;
    finish(operation);
    setBusy(false);
  }
}

function formValues() {
  const values = Object.fromEntries(SETTING_IDS.map((id) => [id, $(id).value]));
  for (const id of CHECK_IDS) values[id] = $(id).checked;
  return values;
}

function showSettings(settings) {
  for (const id of SETTING_IDS) if (settings[id] !== undefined && settings[id] !== null) $(id).value = String(settings[id]);
  for (const id of CHECK_IDS) if (settings[id] !== undefined) $(id).checked = settings[id];
  updateAnalysisFields();
}

function textFile(text, name, type) {
  return new File([text], name, { type });
}

const formatNumber = (value, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? "–" : Number(value).toFixed(digits));

function table(caption, header, rows, { numeric = [] } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "nd-table-scroll";
  const element = document.createElement("table");
  element.className = "nd-data-table";
  const title = document.createElement("caption");
  title.textContent = caption;
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const name of header) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = name;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const { cells, flag } of rows) {
    const tr = document.createElement("tr");
    if (flag) tr.dataset.flag = flag;
    cells.forEach((value, k) => {
      const td = document.createElement("td");
      if (numeric.includes(k)) td.className = "nd-numeric";
      td.textContent = value;
      tr.append(td);
    });
    body.append(tr);
  }
  element.append(title, head, body);
  wrapper.append(element);
  return wrapper;
}

function paragraph(className, text) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function renderPsfReport() {
  const { summary, beads, settings, halfBox, prominence } = run;
  const lead = paragraph("nd-report-lead", `${summary.used} of ${summary.beads} beads used · lateral ${formatNumber(summary.x.mean)} / ${formatNumber(summary.y.mean)} µm, axial ${formatNumber(summary.z.mean)} µm (FWHM, mean)`);
  const axes = [["x", "Lateral x"], ["y", "Lateral y"], ["z", "Axial z"]];
  const summaryTable = table("FWHM summary (µm)", ["Axis", "Beads", "Mean", "SD", "Median", "Theory", "Mean / theory"], axes.map(([axis, label]) => {
    const s = summary[axis];
    return { cells: [label, String(s.n), formatNumber(s.mean), formatNumber(s.sd), formatNumber(s.median), formatNumber(s.theoretical), formatNumber(s.ratio, 2)], flag: s.ratio > 1.5 ? "above 1.5 × theory" : undefined };
  }).concat([{ cells: ["Lateral asymmetry", String(summary.lar.n), formatNumber(summary.lar.mean, 2), formatNumber(summary.lar.sd, 2), formatNumber(summary.lar.median, 2), "1", ""] }]), { numeric: [1, 2, 3, 4, 5, 6] });
  const beadTable = table("Beads", ["Bead", "Status", "x, y, z (px)", "FWHM x", "FWHM y", "FWHM z", "R² x", "R² y", "R² z"], beads.map((bead) => ({
    cells: [String(bead.id), beadStatus(bead), bead.z === undefined ? `${bead.peakX}, ${bead.peakY}` : `${bead.x}, ${bead.y}, ${bead.z}`, formatNumber(bead.fwhm?.x), formatNumber(bead.fwhm?.y), formatNumber(bead.fwhm?.z), formatNumber(bead.r2?.x), formatNumber(bead.r2?.y), formatNumber(bead.r2?.z)],
    flag: bead.rejection || !bead.goodFit ? "excluded" : undefined,
  })), { numeric: [3, 4, 5, 6, 7, 8] });
  const notes = paragraph("nd-report-notes", `${MICROSCOPES[settings.microscope]}, NA ${settings.na}, n ${settings.refractiveIndex}, theory ${formatNumber(settings.theory.lateral)} µm lateral and ${formatNumber(settings.theory.axial)} µm axial. Box ±${halfBox} px, prominence ${formatNumber(prominence, 1)}, minimum R² ${settings.minR2}. Bold rows are flagged or left out.`);
  $("report").replaceChildren(lead, summaryTable, beadTable, notes);
}

function renderFieldReport() {
  const { field } = run;
  const lead = paragraph("nd-report-lead", `Uniformity ${formatNumber(field.uniformity, 1)} % · field uniformity ${formatNumber(field.fieldUniformity, 1)} % · centering accuracy ${formatNumber(field.centeringAccuracy, 1)} %`);
  const metrics = table("Field illumination", ["Metric", "Value (%)"], [
    { cells: ["Uniformity", formatNumber(field.uniformity, 1)], flag: field.uniformity < 50 ? "below 50 %" : undefined },
    { cells: ["Field uniformity", formatNumber(field.fieldUniformity, 1)] },
    { cells: ["Centering accuracy", formatNumber(field.centeringAccuracy, 1)], flag: field.centeringAccuracy < 50 ? "below 50 %" : undefined },
  ], { numeric: [1] });
  const points = table("Reference points", ["Point", "x, y (px)", "Intensity", "Relative", "To centre (px)"], field.points.map((point) => ({
    cells: [point.name, `${formatNumber(point.x, 1)}, ${formatNumber(point.y, 1)}`, formatNumber(point.intensity, 1), formatNumber(point.relative, 3), formatNumber(point.distanceToCentre, 1)],
  })), { numeric: [2, 3, 4] });
  const figure = document.createElement("figure");
  figure.className = "nd-chart-figure";
  const caption = document.createElement("figcaption");
  caption.textContent = "Intensity profiles, relative to the maximum";
  figure.append(caption);
  figure.insertAdjacentHTML("beforeend", fieldProfileSvg(field));
  const legend = document.createElement("ul");
  legend.className = "nd-chart-legend";
  for (const { label, dash } of fieldProfileLegend()) {
    const item = document.createElement("li");
    item.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 18 10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" stroke="currentColor" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/></svg>`);
    item.append(label);
    legend.append(item);
  }
  figure.append(legend);
  const notes = paragraph("nd-report-notes", `${run.settings.blur ? "Gaussian blur σ = 2 px. " : ""}Reference: ${run.settings.referenceZone ? `${100 - run.settings.step}–100 % zone, ${field.referencePixels} pixels` : "brightest pixel"}. Bold rows are below MetroloJ_QC's 50 % tolerance.${field.saturatedPixels ? ` ${field.saturatedPixels} pixels are saturated.` : ""}`);
  $("report").replaceChildren(lead, metrics, figure, legend, points, notes);
}

function setView(view) {
  toolbar.setActive(view);
  const showReport = view === "report" && Boolean(run);
  $("report").hidden = !showReport;
  $("gl1").hidden = showReport;
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  if (detail.value === "report" && !run) {
    status("Run quality control to see the report");
    toolbar.setActive("image");
    return;
  }
  setView(detail.value);
});

/** The image the viewer shows: a single plane as it is, a z-stack as its maximum projection. */
function inputDisplay() {
  if (!input.display) {
    const { width, height, planes } = input.dims;
    const spacing = displaySpacing({ x: Number($("pixelX").value) || 1, y: Number($("pixelY").value) || 1, z: Number($("zStep").value) || 1 });
    const image = planes > 1 ? Float32Array.from(maxProjection(input.data, width, height, planes)) : input.data;
    input.display = { spacing, file: displayNifti(planes > 1 ? "projection.nii" : "input.nii", image, { width, height, planes: 1, spacing }) };
  }
  return input.display;
}

/** Shows the input, with the bead boxes or iso-intensity zones over it once a run exists. */
async function show(stage) {
  if (stage !== "input" && stage !== "overlay") {
    setView("report");
    return;
  }
  setView("image");
  await viewerReady();
  const base = inputDisplay();
  const volumes = [{ url: base.file, name: base.file.name, colormap: "gray" }];
  if (stage === "overlay" && run) volumes.push({ url: run.overlay, name: run.overlay.name, opacity: 0.8 });
  await viewer.loadVolumes(volumes);
  if (stage === "overlay" && run) await viewer.setColormapLabel(1, run.analysis === "psf" ? BEAD_COLORMAP : zoneColormap(run.settings.step));
  viewer.sliceType = SLICE_TYPE.AXIAL;
  $("emptyState").hidden = true;
}

async function runQc(signal, settings) {
  if (!input) throw new Error("Load an image before running quality control.");
  const { width, height, planes, dtype } = input.dims;
  if (settings.analysis === "psf" && planes < 3) throw new SettingsError("analysis", `PSF needs a bead z-stack; ${input.file.name} has ${planes} plane${planes > 1 ? "s" : ""}. Choose Field illumination for a single image.`);
  if (settings.analysis === "field" && planes !== 1) throw new SettingsError("analysis", `Field illumination needs one image; ${input.file.name} has ${planes} planes. Save one plane, or choose PSF from beads.`);
  const operation = begin(`Running ${ANALYSES[settings.analysis].toLowerCase()}…`, signal);
  running = operation.controller;
  setBusy(true);
  progress.setCancellable(true);
  const current = operation.controller.signal;
  clearRun();
  try {
    const started = performance.now();
    const stem = outputStem(input.file.name);
    const saturation = saturationLevel(dtype);
    let next;
    if (settings.analysis === "psf") {
      input.display = null;
      const spacing = { x: settings.pixelX, y: settings.pixelY, z: settings.zStep };
      const halfBox = boxHalfWidth(settings);
      const prominence = settings.prominence;
      const result = await callWorker({
        type: "psf",
        data: input.data,
        dims: { nx: width, ny: height, nz: planes, spacing },
        options: { halfBox, prominence, autoProminence: 10, minR2: settings.minR2, saturation: settings.excludeSaturated ? saturation : null },
        theory: settings.theory,
      }, { signal: current, onProgress: (fraction) => progress.setProgress(0.1 + 0.85 * fraction, "Fitting bead profiles…") });
      current.throwIfAborted();
      const record = provenance({ input: input.file, settings, dims: input.dims, extra: { boxHalfWidthPx: halfBox, prominence: result.prominence, background: result.background, summary: result.summary } });
      next = { analysis: "psf", settings, ...result, halfBox, record };
      const overlay = beadOverlay(result.beads, input.dims, halfBox);
      next.overlay = displayNifti("beads.nii", overlay, { width, height, planes: 1, spacing: inputDisplay().spacing, window: [0, 3] });
      next.files = {
        overlay: { description: `Bead boxes on the projection · ${result.summary.used} used`, file: new File([writeTiffStack({ width, height, data: overlay, pixelSize: { x: spacing.x, y: spacing.y } })], `${stem}_beads.tif`, { type: "image/tiff" }) },
        summary: { description: "FWHM summary (CSV)", file: textFile(psfSummaryCsv(result.summary), `${stem}_psf_summary.csv`, "text/csv") },
        beads: { description: "Beads (CSV)", file: textFile(beadsCsv(result.beads, spacing), `${stem}_beads.csv`, "text/csv") },
        profiles: { description: "Profiles and fits (CSV)", file: textFile(profilesCsv(result.beads, spacing), `${stem}_profiles.csv`, "text/csv") },
        provenance: { description: "Report (JSON)", file: textFile(reportJson(record, beadRecords(result.beads)), `${stem}_psf_report.json`, "application/json") },
      };
      log.log(`Beads: ${result.maximaCount} maxima above prominence ${result.prominence.toFixed(1)}; ${result.summary.measured} measured, ${result.summary.used} used`, "info", "analysis");
      log.log(`FWHM (mean ± SD, µm): x ${formatNumber(result.summary.x.mean)} ± ${formatNumber(result.summary.x.sd)}, y ${formatNumber(result.summary.y.mean)} ± ${formatNumber(result.summary.y.sd)}, z ${formatNumber(result.summary.z.mean)} ± ${formatNumber(result.summary.z.sd)}`, "info", "analysis");
    } else {
      const field = await callWorker({ type: "field", data: input.data, dims: { width, height, dtype }, options: { blur: settings.blur, step: settings.step, referenceZone: settings.referenceZone, saturation } }, { signal: current });
      current.throwIfAborted();
      const { zones, profiles: _profiles, smoothed: _smoothed, ...summary } = field;
      const record = provenance({ input: input.file, settings, dims: input.dims, extra: { metrics: { uniformity: field.uniformity, fieldUniformity: field.fieldUniformity, centeringAccuracy: field.centeringAccuracy } } });
      next = { analysis: "field", settings, field, record };
      next.overlay = displayNifti("zones.nii", zoneLabels(zones, settings.step), { ...input.dims, spacing: inputDisplay().spacing, window: [0, Math.round(100 / settings.step) + 1] });
      next.files = {
        overlay: { description: `Iso-intensity zones · ${settings.step} % steps`, file: new File([writeTiffStack({ width, height, data: zones })], `${stem}_zones.tif`, { type: "image/tiff" }) },
        metrics: { description: "Field metrics (CSV)", file: textFile(fieldMetricsCsv(field), `${stem}_field_metrics.csv`, "text/csv") },
        points: { description: "Reference points (CSV)", file: textFile(fieldPointsCsv(field), `${stem}_field_points.csv`, "text/csv") },
        profiles: { description: "Profiles (CSV)", file: textFile(fieldProfilesCsv(field), `${stem}_field_profiles.csv`, "text/csv") },
        provenance: { description: "Report (JSON)", file: textFile(reportJson(record, summary), `${stem}_field_report.json`, "application/json") },
      };
      log.log(`Field: uniformity ${formatNumber(field.uniformity, 2)} %, field uniformity ${formatNumber(field.fieldUniformity, 2)} %, centering accuracy ${formatNumber(field.centeringAccuracy, 2)} %`, "info", "analysis");
    }
    next.id = ++runCount;
    run = next;
    results.render(run.files);
    if (run.analysis === "psf") renderPsfReport();
    else renderFieldReport();
    $("outputSection").open = true;
    await show("overlay");
    current.throwIfAborted();
    const seconds = (performance.now() - started) / 1000;
    technical(`${ANALYSES[settings.analysis]} took ${seconds.toFixed(2)} s`);
    const done = run.analysis === "psf" ? `Quality control complete · ${run.summary.used} beads used` : `Quality control complete · uniformity ${formatNumber(run.field.uniformity, 1)} %`;
    progress.end(done);
    status(done);
    return { artifacts: Object.entries(run.files).map(([role, { file }]) => ({ role, file })), provenance: run.record };
  } catch (error) {
    run = null;
    results.render();
    progress.reset();
    throw error;
  } finally {
    running = null;
    finish(operation);
    setBusy(false);
  }
}

function report(error) {
  if (error instanceof SettingsError) {
    if (ADVANCED.has(error.field)) $("advancedSettings").open = true;
    $(error.field)?.focus();
  }
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);
updateAnalysisFields();

function settingsOrReport() {
  try {
    return readSettings(formValues());
  } catch (error) {
    report(error);
    return null;
  }
}

$("runButton").addEventListener("click", () => {
  const settings = settingsOrReport();
  if (settings) void runQc(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    "run-qc": async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      const settings = readSettings({ ...formValues(), ...parameters });
      showSettings(settings);
      return runQc(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, run: () => run });
