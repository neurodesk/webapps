// DWI Correct: eddy-like correction of a diffusion series (shoreline in WebAssembly), in this browser.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { SLICE_TYPE } from "@niivue/niivue";
import { zipSync } from "fflate";
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
import { createNiftiFromData, decodeNiftiBuffer, downloadFile, parseNiftiHeader, readNiftiFrames, sameNiftiGrid } from "@neurodesk/webapp-components/file-io";
import { readBidsDiffusion } from "@neurodesk/webapp-components/file-io/bids";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { brainMask, mindgrab } from "@neurodesk/runtime-support/mindgrab";
import { estimateMemory, fitsInMemory, MEMORY_LIMIT } from "@neurodesk/shoreline";
import { APP } from "./config.js";
import {
  B0_MAX,
  SESSION,
  acqpRow,
  classifyInputs,
  confoundsTsv,
  defaultSettings,
  describeSeries,
  motionSummary,
  outliersTsv,
  outputNames,
  preprocSidecar,
  readGradients,
  shorelineArgs,
} from "./pipeline.js";
import { renderMotionReport } from "./report.js";
import { createBeforeAfter } from "./animation.js";
import { axialSlices } from "./frames.js";
import { correctSeries, estimateField } from "./workers.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "DWI Correct",
  subtitle: "Motion, eddy-current and susceptibility correction",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const LAYOUTS = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
};
const viewer = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
const viewerReady = viewer.attachTo("gl1").then(() => {
  viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
  viewer.isLegendVisible = false;
  viewer.createExtensionContext().on("locationChange", ({ detail }) => {
    const value = detail.values[0]?.value;
    $("location").textContent = `${detail.mm.map(Math.round).join("×")} mm  ${value == null ? "" : Number(value).toPrecision(4)}`;
  });
});
const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    ["compare", "Before/after"],
    ["multiplanar", "3-Plane"],
    ["axial", "Axial"],
    ["coronal", "Coronal"],
    ["sagittal", "Sagittal"],
  ]
    .map(([id, label], index) => ({ id, label, active: index === 0, onClick: () => showLayout(id) }))
    .concat({ id: "motion", label: "Motion", hidden: true, onClick: () => showReport() }),
});
$("viewer").prepend(toolbar);
const animation = createBeforeAfter({
  grid: $("compareGrid"),
  before: $("beforeCanvas"),
  after: $("afterCanvas"),
  afterPanel: $("afterPanel"),
  titles: [$("beforeTitle"), $("afterTitle")],
  onFrame: (volume, count) => {
    $("volumeField").hidden = false;
    $("volume").max = String(count - 1);
    $("volume").value = String(volume);
    $("volumeLabel").textContent = `${volume + 1} of ${count}`;
    const b = input?.bvals?.[volume];
    $("imageLabel").textContent = `Volume ${volume + 1} of ${count}${b === undefined ? "" : ` · b = ${Math.round(b)}`}`;
  },
});
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About DWI Correct", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

/** The loaded inputs: the series, its gradients and sidecar, a reverse b0 and a field map. */
let input = null;
let loading = null;
let running = null;
/** The last run: result rows, the summary for the report, and the files for the zip. */
let outputs = null;
/** The 4D image on display, for the volume slider. */
let displayed = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    if (loading || running) return;
    void show(result.file, result.description, { frames: result.frames }).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

let showing = Promise.resolve();
/** Shows one image (a File), 4D series at the slider's volume. */
function show(file, label, { frames = 1, background = false } = {}) {
  showing = showing.catch(() => {}).then(async () => {
    await viewerReady;
    await viewer.loadVolumes([{ url: file, name: file.name, colormap: "gray" }]);
    $("emptyState").hidden = true;
    $("motionReport").hidden = true;
    if (!background) {
      animation.hide();
      toolbar.setActive("multiplanar");
    }
    $("imageLabel").textContent = label;
    displayed = frames > 1 ? { frames } : null;
    $("volumeField").hidden = !displayed;
    if (displayed) {
      const volume = Math.min(Number($("volume").value), frames - 1);
      $("volume").max = String(frames - 1);
      $("volume").value = String(volume);
      await setVolume(volume);
    }
  });
  return showing;
}

async function setVolume(volume) {
  $("volumeLabel").textContent = `${volume + 1} of ${displayed.frames}`;
  const id = viewer.volumes.at(-1)?.id;
  if (id !== undefined) await viewer.setFrame4D(id, volume);
}

function showLayout(id) {
  $("motionReport").hidden = true;
  if (id === "compare") {
    if (animation.ready) animation.show();
    return;
  }
  animation.hide();
  viewer.sliceType = LAYOUTS[id] ?? SLICE_TYPE.MULTIPLANAR;
}

/** The Before/after view, playing. */
function showComparison() {
  $("emptyState").hidden = true;
  $("motionReport").hidden = true;
  toolbar.setActive("compare");
  animation.show();
}

function motionTab(visible) {
  const tab = toolbar.viewTabs.querySelector('[data-view="motion"]');
  if (tab) tab.hidden = !visible;
}

function showReport() {
  if (!outputs) return;
  renderMotionReport($("motionReport"), outputs.summary, {
    onVolume: (volume) => {
      showComparison();
      animation.pauseAt(volume);
    },
  });
  animation.hide();
  $("motionReport").hidden = false;
  toolbar.setActive("motion");
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function textFile(text, name, type = "text/plain") {
  return new File([text], name, { type });
}

function clearOutputs() {
  outputs = null;
  results.render();
  $("outputSection").open = false;
  $("zipButton").disabled = true;
  motionTab(false);
  $("motionReport").hidden = true;
}

function setBusy(busy) {
  $("imageInput").disabled = busy;
  $("resultList").inert = busy;
  exampleControl?.setDisabled(busy);
  for (const id of ["fieldSource", "replaceOutliers", "model", "outlierType", "eddyCurrents", "iterations", "phaseEncoding", "readoutTime"]) {
    $(id).disabled = busy || !input;
  }
  $("sliceToVolume").disabled = busy || !input?.series.sliceTiming;
  $("runButton").disabled = busy || !input;
  $("zipButton").disabled = busy || !outputs;
  if (input) {
    for (const option of $("fieldSource").options) {
      option.disabled = (option.value === "reverse" && !input.reverse) || (option.value === "upload" && !input.field);
    }
  }
}

/** The b = 0 mean of a series' frames (Float64), or of every frame without b-values. */
function meanOf(data, voxels, frames, bvals) {
  const keep = Array.from({ length: frames }, (_, k) => k).filter((k) => !bvals || bvals[k] <= B0_MAX);
  if (!keep.length) throw new Error(`The series has no volume with b ≤ ${B0_MAX}.`);
  const out = new Float64Array(voxels);
  for (const k of keep) {
    const offset = k * voxels;
    for (let i = 0; i < voxels; i++) out[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) out[i] /= keep.length;
  return out;
}

function voxelSizes(affine) {
  return [0, 1, 2].map((j) => Math.hypot(affine[0][j], affine[1][j], affine[2][j]));
}

function intentCode(buffer) {
  const view = new DataView(buffer);
  const little = view.getInt32(0, true) === 348;
  return view.getInt16(68, little);
}

/** The selection's series: from a BIDS folder (one DWI run and its fieldmaps), else loose files. */
async function seriesOf(files, signal) {
  const bids = files.some((file) => file.webkitRelativePath || file._webkitRelativePath) ? await readBidsDiffusion(files) : { runs: [] };
  const runs = bids.runs.filter((run) => !run.error);
  if (runs.length > 1) throw new Error(`The folder holds ${runs.length} DWI runs; choose one run's files.`);
  if (runs.length === 1) {
    const [run] = runs;
    return [
      { image: run.dwi, sidecar: run.sidecar, bval: run.bval, bvec: run.bvec },
      ...run.fieldmaps.map((fieldmap) => ({ image: fieldmap.file, sidecar: fieldmap.sidecar, bval: null, bvec: null })),
    ];
  }
  return readDiffusionSeries(files, { signal, anonymizeSidecar: true });
}

async function loadFiles(filesPromise, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading the series…");
  status("Reading the series…");
  try {
    const files = await filesPromise;
    const entries = await seriesOf(files, controller.signal);
    controller.signal.throwIfAborted();
    // Headers first: the DWI series is read once, the others only as far as needed.
    const read = [];
    for (const entry of entries) {
      const buffer = await decodeNiftiBuffer(await entry.image.arrayBuffer());
      controller.signal.throwIfAborted();
      const header = parseNiftiHeader(buffer);
      let frames = 1;
      for (let d = 4; d <= header.dims[0]; d++) frames *= Math.max(1, header.dims[d]);
      read.push({ ...entry, buffer, frames, intent: intentCode(buffer) });
    }
    const dwiGuess = [...read].filter((e) => e.bval && e.bvec).sort((a, b) => b.frames - a.frames)[0];
    for (const entry of read) entry.sameGrid = Boolean(dwiGuess) && entry !== dwiGuess && sameNiftiGrid(entry.buffer, dwiGuess.buffer, 0.01);
    const found = classifyInputs(read);
    const dwi = found.dwi;
    const frames = readNiftiFrames(dwi.buffer);
    const voxels = frames.dims[0] * frames.dims[1] * frames.dims[2];
    const bvalText = await dwi.bval.text();
    const bvecText = await dwi.bvec.text();
    const { bvals } = readGradients(bvalText, bvecText, frames.frames);
    const sidecar = dwi.sidecar ?? {};
    const series = describeSeries({ bvals, sidecar, dims: frames.dims });
    const size = { voxels, volumes: frames.frames, inputBytes: dwi.image.size };
    if (!fitsInMemory(size)) {
      const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
      throw new Error(`This series needs about ${gb(estimateMemory(size))} GB, more than WebAssembly's ${gb(MEMORY_LIMIT)} GB. Use the native shoreline command line (exes/dwi/shoreline).`);
    }
    const meanB0 = meanOf(frames.data, voxels, frames.frames, bvals);
    const beforeSlices = axialSlices(frames.data, frames.dims, frames.frames);
    const sizes = voxelSizes(frames.header.affine);
    let reverse = null;
    if (found.reverse) {
      const r = readNiftiFrames(found.reverse.buffer);
      const rBvals = found.reverse.bval ? readGradients(await found.reverse.bval.text(), await found.reverse.bvec.text(), r.frames).bvals : null;
      reverse = { name: found.reverse.image.name, sidecar: found.reverse.sidecar, mean: meanOf(r.data, voxels, r.frames, rBvals) };
    }
    const meanFile = new File([await gzipBytes(createNiftiFromData(Float32Array.from(meanB0), dwi.buffer, { dims: frames.dims }))], "mean_b0.nii.gz");
    controller.signal.throwIfAborted();
    input = {
      name: dwi.image.name,
      file: dwi.image,
      buffer: dwi.buffer,
      header: frames.header,
      dims: frames.dims,
      frames: frames.frames,
      bvalText,
      bvecText,
      bvals,
      sidecar,
      series,
      meanB0,
      reverse,
      field: found.field && { kind: found.field.kind, name: found.field.entry.image.name, file: found.field.entry.image, sameGrid: found.field.entry.sameGrid },
    };
    if (input.field?.kind === "hz" && !input.field.sameGrid) throw new Error(`${input.field.name} is not on the series' grid; give a field map in Hz on the DWI grid, or topup's _fieldcoef image.`);
    clearOutputs();
    applyDefaults();
    renderInput(found.ignored);
    await show(meanFile, "Mean b0 (input)", { background: true });
    controller.signal.throwIfAborted();
    animation.setBefore(beforeSlices, frames.dims, sizes[1] / sizes[0]);
    showComparison();
    $("dropZone").classList.add("has-files");
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    progress.setProgress(0);
    status(`${input.name} loaded: ${series.volumes} volumes`);
  } catch (error) {
    if (!input) $("emptyState").hidden = false;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

function applyDefaults() {
  const fieldSource = input.field ? "upload" : input.reverse ? "reverse" : "none";
  const settings = defaultSettings(input.series, fieldSource);
  const note = (id, text) => {
    $(id).textContent = `Default: ${text}`;
  };
  $("fieldSource").value = settings.field.value;
  note("fieldDefault", settings.field.rule);
  $("model").value = settings.model.value;
  $("model").options[0].disabled = input.series.dwi < 72;
  note("modelDefault", `${settings.model.rule}; ${settings.shelled.rule}`);
  $("replaceOutliers").checked = true;
  note("replaceDefault", "on");
  $("outlierType").value = settings.outliers.value;
  $("outlierType").options[0].disabled = input.series.multiband < 2;
  $("outlierType").options[2].disabled = input.series.multiband < 2;
  note("outlierDefault", settings.outliers.rule);
  $("sliceToVolume").checked = settings.sliceToVolume.value;
  note("sliceDefault", `off (${settings.sliceToVolume.rule})`);
  $("eddyCurrents").value = settings.eddyCurrents.value;
  note("eddyDefault", settings.eddyCurrents.rule);
  $("iterations").value = String(settings.iterations.value);
  note("iterationDefault", settings.iterations.rule);
  const missingPe = !input.series.phaseEncodingDirection;
  const missingReadout = input.series.totalReadoutTime === null;
  $("acquisitionFields").hidden = !missingPe && !missingReadout;
}

function renderInput(ignored) {
  const s = input.series;
  const shells = s.shells.map((shell) => `b${Math.round(shell.b)}×${shell.count}`).join(", ");
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = `${input.name} · ${input.dims.join("×")} · ${s.volumes} volumes`;
  $("seriesInfo").hidden = false;
  $("seriesInfo").textContent = `${s.b0} b0, ${shells}${s.multiband > 1 ? ` · multiband ${s.multiband}` : ""}${s.phaseEncodingDirection ? ` · PE ${s.phaseEncodingDirection}` : ""}`;
  const extras = [input.reverse && `Reverse-PE b0: ${input.reverse.name}`, input.field && `Field map: ${input.field.name}`, ignored.length && `Not used: ${ignored.join(", ")}`].filter(Boolean);
  $("fieldInfo").hidden = !extras.length;
  $("fieldInfo").textContent = extras.join(" · ");
}

function chosenSettings() {
  return {
    model: $("model").value,
    replaceOutliers: $("replaceOutliers").checked,
    outliers: $("outlierType").value,
    sliceToVolume: $("sliceToVolume").checked,
    eddyCurrents: $("eddyCurrents").value,
    iterations: Math.max(1, Math.round(Number($("iterations").value) || 5)),
  };
}

/** The phase encoding and readout of the series: the sidecar's, else the fields'. */
function acquisition() {
  const pe = input.series.phaseEncodingDirection ?? $("phaseEncoding").value;
  const readout = input.series.totalReadoutTime ?? Number($("readoutTime").value);
  if (!(readout > 0)) throw new Error("Give the series' total readout time in seconds.");
  return { pe, readout };
}

/** Progress of a run from its log: coarse and main iterations, slice-to-volume, resampling. */
function progressFrom(line, plan) {
  if (/iteration \d+ done/.test(line)) plan.done += 1;
  if (/resampling done/.test(line)) plan.done = plan.total - 0.5;
  return Math.min(0.99, plan.done / plan.total);
}

async function correct(signal) {
  if (!input || loading || running) throw new Error("Load a diffusion series before correcting it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  clearOutputs();
  progress.setCancellable(true);
  const started = performance.now();
  try {
    const settings = chosenSettings();
    const { pe, readout } = acquisition();
    const names = outputNames(input.name);
    const voxels = input.dims[0] * input.dims[1] * input.dims[2];

    progress.begin("Extracting the brain from the mean b0 with MindGrab…");
    progress.setCancellable(true);
    status("Extracting the brain from the mean b0 with MindGrab");
    const meanB0 = createNiftiFromData(Float32Array.from(input.meanB0), input.buffer, { dims: input.dims });
    const extracted = await brainMask(new Uint8Array(meanB0), { assetPath: `${import.meta.env.BASE_URL}mindgrab/`, signal: controller.signal });
    const maskData = Uint8Array.from(readNiftiFrames(extracted.mask).data, (value) => (value > 0 ? 1 : 0));
    const maskVoxels = maskData.reduce((sum, v) => sum + v, 0);
    if (!maskVoxels) throw new Error("MindGrab found no brain in the mean b0; check the b0 volumes.");
    const maskSource = `mindgrab-${mindgrab.version}-${extracted.backend}`;
    log.log(`MindGrab ${mindgrab.version} brain mask on ${extracted.backend}: ${maskVoxels} voxels`, "info");
    const maskNifti = createNiftiFromData(maskData, input.buffer, { dims: input.dims });

    const files = {
      [SESSION.series]: await input.file.arrayBuffer(),
      [SESSION.mask]: maskNifti.slice(0),
      [SESSION.bvals]: new TextEncoder().encode(input.bvalText).buffer,
      [SESSION.bvecs]: new TextEncoder().encode(input.bvecText).buffer,
      [SESSION.sidecar]: new TextEncoder().encode(JSON.stringify(input.sidecar)).buffer,
      [SESSION.acqp]: new TextEncoder().encode(`${acqpRow(pe, readout, input.header.affine)}\n`).buffer,
      [SESSION.index]: new TextEncoder().encode(`${Array(input.frames).fill(1).join(" ")}\n`).buffer,
    };
    let field = "none";
    let fieldFile = null;
    const source = $("fieldSource").value;
    if (source === "reverse" && input.reverse) {
      progress.begin("Estimating the susceptibility field from the reverse-PE b0…");
      progress.setCancellable(true);
      status(`Estimating the field from ${input.reverse.name} (PyHySCO)`);
      const out = await estimateField({
        image1: input.meanB0,
        image2: input.reverse.mean,
        dims: input.dims,
        voxel: voxelSizes(input.header.affine),
        options: { phaseEncodingDirection: pe, totalReadoutTime: readout },
        signal: controller.signal,
      });
      log.log(`PyHySCO field: ${out.iterations} Gauss-Newton iterations`, "info");
      const fieldNifti = createNiftiFromData(Float32Array.from(out.field), input.buffer, { dims: input.dims });
      files[SESSION.field] = fieldNifti.slice(0);
      fieldFile = new File([await gzipBytes(fieldNifti)], names.field, { type: "application/gzip" });
      field = "estimated";
    } else if (source === "upload" && input.field) {
      const bytes = await input.field.file.arrayBuffer();
      if (input.field.kind === "topup") files[`${SESSION.topup}_fieldcoef.nii.gz`] = bytes;
      else files[SESSION.field] = bytes;
      field = input.field.kind;
    }
    controller.signal.throwIfAborted();

    const args = shorelineArgs({ settings, series: input.series, field });
    const plan = { done: 0, total: 2 + settings.iterations + (settings.sliceToVolume && input.series.sliceTiming ? 5 : 0) + 1 };
    let threads = 1;
    progress.begin("Correcting the series…");
    progress.setCancellable(true);
    status(`Correcting ${input.frames} volumes`);
    log.log(`shoreline ${args.join(" ")}`, "info");
    const run = await correctSeries({
      files,
      args,
      signal: controller.signal,
      onThreads: (count) => {
        threads = count;
        log.log(`shoreline WebAssembly on ${count} thread${count === 1 ? "" : "s"}`, "info");
      },
      onLog: (line) => {
        log.log(line);
        progress.setProgress(progressFrom(line, plan));
      },
    });
    controller.signal.throwIfAborted();
    const seconds = (performance.now() - started) / 1000;
    const text = (name) => (run.outputs[`${SESSION.out}.${name}`] ? new TextDecoder().decode(run.outputs[`${SESSION.out}.${name}`]) : null);
    const parameters = text("parameters");
    const movementRms = text("movement_rms");
    const outlierMap = text("outlier_map");
    const sidecar = preprocSidecar({ input: input.sidecar, settings, args, field, threads, seconds, mask: maskSource, version: APP.version });
    const rows = {
      dwi: { description: "Corrected series", file: new File([run.outputs[`${SESSION.out}.nii.gz`]], names.dwi, { type: "application/gzip" }), frames: input.frames },
      input: { description: "Input series", file: input.file, frames: input.frames, download: false },
      bval: { description: "b-values", file: textFile(text("bvals"), names.bval), viewable: false },
      bvec: { description: "Rotated b-vectors", file: textFile(text("rotated_bvecs"), names.bvec), viewable: false },
      sidecar: { description: "Sidecar", file: textFile(`${JSON.stringify(sidecar, null, 2)}\n`, names.sidecar, "application/json"), viewable: false },
      confounds: { description: "Movement per volume", file: textFile(confoundsTsv({ parameters, movementRms, outlierMap }), names.confounds, "text/tab-separated-values"), viewable: false },
      ...(outlierMap ? { outliers: { description: "Outlier slices", file: textFile(outliersTsv(outlierMap, input.dims[2]), names.outliers, "text/tab-separated-values"), viewable: false } } : {}),
      mask: { description: "Brain mask (MindGrab)", file: new File([await gzipBytes(maskNifti)], names.mask, { type: "application/gzip" }) },
      ...(fieldFile ? { field: { description: "Field map (Hz)", file: fieldFile } } : {}),
      log: { description: "Log", file: textFile(text("log") ?? "", names.log), viewable: false },
    };
    const summary = motionSummary({ parameters, movementRms, outlierMap });
    outputs = { rows, summary, names };
    results.render(Object.fromEntries(Object.entries(rows).filter(([key]) => key !== "input")));
    const corrected = readNiftiFrames(await decodeNiftiBuffer(await rows.dwi.file.arrayBuffer()));
    animation.setAfter(axialSlices(corrected.data, corrected.dims, corrected.frames));
    await show(rows.dwi.file, rows.dwi.description, { frames: input.frames, background: true });
    showComparison();
    $("outputSection").open = true;
    motionTab(true);
    const replaced = summary.reduce((sum, row) => sum + row.outlierSlices.length, 0);
    progress.end("Series corrected");
    status(`Corrected in ${Math.round(seconds)} s on ${threads} thread${threads === 1 ? "" : "s"}; ${replaced} outlier slice${replaced === 1 ? "" : "s"} replaced`);
    return {
      artifacts: Object.entries(rows).filter(([key]) => key !== "input").map(([role, row]) => ({ role, file: row.file })),
      provenance: sidecar.DwicorrectSettings,
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    running = null;
    setBusy(false);
  }
}

async function downloadAll() {
  if (!outputs) return;
  const entries = {};
  for (const row of Object.values(outputs.rows)) {
    if (row.download === false) continue;
    entries[row.file.name] = [new Uint8Array(await row.file.arrayBuffer()), { level: row.file.name.endsWith(".gz") ? 0 : 6 }];
  }
  downloadFile(new File([zipSync(entries)], outputs.names.zip, { type: "application/zip" }));
}

function report(error) {
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
$("volume").addEventListener("input", () => {
  const volume = Number($("volume").value);
  if (!$("compareGrid").hidden) animation.pauseAt(volume);
  else if (displayed) void setVolume(volume);
});
for (const id of ["fieldSource", "replaceOutliers", "model", "outlierType", "sliceToVolume", "eddyCurrents", "iterations"]) {
  $(id).addEventListener("change", () => clearOutputs());
}
$("replaceOutliers").addEventListener("change", () => {
  $("outlierType").disabled = !$("replaceOutliers").checked || !input;
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

$("runButton").addEventListener("click", () => {
  void correct().catch(report);
});
$("zipButton").addEventListener("click", () => {
  void downloadAll().catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    correct: async ({ inputs, inputDetails, signal }) => {
      const sidecars = inputDetails.images?.sidecars ?? [];
      await loadFiles(Promise.resolve([...inputs.images, ...sidecars, ...(inputs.gradients ?? [])]), signal);
      return correct(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
