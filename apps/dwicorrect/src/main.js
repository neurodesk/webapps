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
import { assertImageValues, createNiftiFromData, decodeNiftiBuffer, downloadFile, extractNiftiHeader, parseNiftiHeader, readNiftiFrames, sameNiftiGrid } from "@neurodesk/webapp-components/file-io";
import { readBidsDiffusion } from "@neurodesk/webapp-components/file-io/bids";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { brainMask, mindgrab } from "@neurodesk/runtime-support/mindgrab";
import { estimateMemory, fitsInMemory, MEMORY_LIMIT } from "@neurodesk/shoreline";
import { APP } from "./config.js";
import { correctionFiles } from "./automation.js";
import {
  meanB0Data,
  SESSION,
  acqpRow,
  classifyInputs,
  confoundsTsv,
  defaultSettings,
  withMultiband,
  inputSummary,
  describeSeries,
  fieldmapSidecar,
  motionSummary,
  numbers,
  outliersTsv,
  outputNames,
  preprocSidecar,
  readGradients,
  shorelineArgs,
} from "./pipeline.js";
import { renderMotionReport } from "./report.js";
import { axialSlices, previewSlice } from "./frames.js";
import { beforeAfterGif, previewVolumes } from "./before-after-gif.js";
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
    ["multiplanar", "3-Plane"],
    ["axial", "Axial"],
    ["coronal", "Coronal"],
    ["sagittal", "Sagittal"],
  ]
    .map(([id, label], index) => ({ id, label, active: index === 0, onClick: () => showLayout(id) }))
    .concat({ id: "motion", label: "Motion", hidden: true, onClick: () => showReport() }),
});
$("viewer").prepend(toolbar);
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
/** The object URL of the preview GIF on display. */
let previewUrl = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    if (loading || running) return;
    if (result.preview) showPreview(result.preview, result.description);
    else void show(result.file, result.description).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

/** The preview image off; the NiiVue canvas back. */
function hidePreview() {
  $("preview").hidden = true;
  $("gl1").hidden = false;
}

let showing = Promise.resolve();
/** Shows one 3D image (a File) in NiiVue. */
function show(file, label) {
  showing = showing.catch(() => {}).then(async () => {
    await viewerReady;
    await viewer.loadVolumes([{ url: file, name: file.name, colormap: "gray" }]);
    $("emptyState").hidden = true;
    $("motionReport").hidden = true;
    hidePreview();
    toolbar.setActive("multiplanar");
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    $("imageLabel").textContent = label;
  });
  return showing;
}

/** Shows the before/after GIF (a File) in place of the canvas. */
function showPreview(file, label) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $("preview").src = previewUrl;
  $("preview").hidden = false;
  $("gl1").hidden = true;
  $("emptyState").hidden = true;
  $("motionReport").hidden = true;
  toolbar.setActive(null);
  $("imageLabel").textContent = `${label}: a diffusion-weighted slice of each volume, before and after`;
}

function showLayout(id) {
  $("motionReport").hidden = true;
  hidePreview();
  toolbar.setActive(id);
  viewer.sliceType = LAYOUTS[id] ?? SLICE_TYPE.MULTIPLANAR;
}

function motionTab(visible) {
  const tab = toolbar.viewTabs.querySelector('[data-view="motion"]');
  if (tab) tab.hidden = !visible;
}

function showReport() {
  if (!outputs) return;
  renderMotionReport($("motionReport"), outputs.summary);
  hidePreview();
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
  for (const id of ["fieldSource", "replaceOutliers", "model", "eddyCurrents", "iterations", "phaseEncoding", "readoutTime", "multiband"]) {
    $(id).disabled = busy || !input;
  }
  $("outlierType").disabled = busy || !input || !$("replaceOutliers").checked;
  $("sliceToVolume").disabled = busy || !input?.series.sliceTiming;
  $("runButton").disabled = busy || !input || !multibandValid();
  $("zipButton").disabled = busy || !outputs;
  if (input) {
    for (const option of $("fieldSource").options) {
      option.disabled = (option.value === "reverse" && !input.reverse) || (option.value === "upload" && !input.field);
    }
  }
}


function voxelSizes(affine) {
  return [0, 1, 2].map((j) => Math.hypot(affine[0][j], affine[1][j], affine[2][j]));
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
      read.push({ ...entry, buffer, frames, intent: header.intentCode });
    }
    // Every check before anything is committed: a refused selection leaves the loaded series as it was.
    const found = classifyInputs(read, { sameGrid: (entry, dwi) => entry !== dwi && sameNiftiGrid(entry.buffer, dwi.buffer, 0.01) });
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
    assertImageValues(frames.data, { subject: dwi.image.name });
    const meanB0 = meanB0Data(frames.data, voxels, frames.frames, bvals);
    const sliceZ = previewSlice(meanB0, frames.dims);
    const beforeSlices = axialSlices(frames.data, frames.dims, frames.frames, sliceZ);
    const sizes = voxelSizes(frames.header.affine);
    const first = frames.data.subarray(0, voxels);
    let reverse = null;
    if (found.reverse) {
      const r = readNiftiFrames(found.reverse.buffer);
      const name = found.reverse.image.name;
      // Only the b-values matter here (the b = 0 mean); a bvec is not needed.
      const rBvals = found.reverse.bval ? numbers(await found.reverse.bval.text()) : null;
      if (rBvals && (rBvals.length !== r.frames || rBvals.some((b) => !Number.isFinite(b)))) {
        throw new Error(`The bval of ${name} has ${rBvals.length} values for ${r.frames} volumes.`);
      }
      assertImageValues(r.data, { subject: name });
      reverse = { name, sidecar: found.reverse.sidecar, mean: meanB0Data(r.data, voxels, r.frames, rBvals) };
    }
    let field = null;
    if (found.field) {
      const { entry, kind, scale, units } = found.field;
      field = { kind, name: entry.image.name, file: entry.image, units };
      if (kind === "hz") {
        const values = readNiftiFrames(entry.buffer).data;
        // A constant field is a uniform shift along the phase encoding: valid.
        assertImageValues(values, { subject: entry.image.name, allowConstant: true });
        if (scale !== 1) {
          const hz = Float32Array.from(values, (value) => value * scale);
          field.file = new File([await gzipBytes(createNiftiFromData(hz, entry.buffer, { dims: frames.dims }))], entry.image.name.replace(/(\.nii)?(\.gz)?$/i, "_hz.nii.gz"), { type: "application/gzip" });
        }
      }
    }
    const firstFile = new File([await gzipBytes(createNiftiFromData(Float32Array.from(first), dwi.buffer, { dims: frames.dims }))], "first_volume.nii.gz");
    controller.signal.throwIfAborted();
    const loaded = {
      name: dwi.image.name,
      file: dwi.image,
      headerBytes: extractNiftiHeader(dwi.buffer),
      header: frames.header,
      dims: frames.dims,
      frames: frames.frames,
      bvalText,
      bvecText,
      bvals,
      beforeSlices,
      sliceZ,
      aspect: sizes[1] / sizes[0],
      sidecar,
      series,
      meanB0,
      reverse,
      field,
    };
    input = loaded;
    clearOutputs();
    $("multiband").value = "1";
    applyDefaults();
    renderInput();
    await show(firstFile, "Input, volume 1");
    controller.signal.throwIfAborted();
    $("dropZone").classList.add("has-files");
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    progress.setProgress(0);
    status(`${input.name} loaded: ${series.volumes} volumes`);
  } catch (error) {
    if (!input) $("emptyState").hidden = false;
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

/** The series as corrected: the sidecar's description, with the multiband factor entered if it has none. */
const effectiveSeries = () => withMultiband(input.series, $("multiband").value);

/** Whether the multiband factor entered divides the slices. */
function multibandValid() {
  try {
    effectiveSeries();
    return true;
  } catch {
    return false;
  }
}

function applyDefaults() {
  const fieldSource = input.field ? "upload" : input.reverse ? "reverse" : "none";
  const settings = defaultSettings(effectiveSeries(), fieldSource);
  $("fieldSource").value = settings.field.value;
  $("model").value = settings.model.value;
  $("model").options[0].disabled = input.series.dwi < 72;
  $("replaceOutliers").checked = true;
  applyOutlierDefault();
  $("sliceToVolume").checked = settings.sliceToVolume.value;
  $("eddyCurrents").value = settings.eddyCurrents.value;
  $("iterations").value = String(settings.iterations.value);
  const missingPe = !input.series.phaseEncodingDirection;
  const missingReadout = input.series.totalReadoutTime === null;
  $("phaseEncodingField").hidden = !missingPe;
  $("readoutField").hidden = !missingReadout;
  $("multibandField").hidden = input.series.multibandKnown;
  $("acquisitionFields").hidden = !missingPe && !missingReadout && input.series.multibandKnown;
}

/** The outlier groups that suit the multiband factor, and the choices it allows. */
function applyOutlierDefault() {
  if (!multibandValid()) return;
  const series = effectiveSeries();
  $("outlierType").value = defaultSettings(series, "none").outliers.value;
  $("outlierType").options[0].disabled = series.multiband < 2;
  $("outlierType").options[2].disabled = series.multiband < 2;
}

function renderInput() {
  const entered = { pe: $("phaseEncoding").value, readout: Number($("readoutTime").value), multiband: Number($("multiband").value) };
  const lines = inputSummary({ name: input.name, series: input.series, reverse: input.reverse?.name, field: input.field?.name, entered });
  $("inputInfo").hidden = false;
  ["fileInfo", "seriesInfo", "acquisitionInfo", "fieldInfo"].forEach((id, k) => {
    $(id).hidden = !lines[k];
    $(id).textContent = lines[k] ?? "";
  });
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
    // Before the brain mask and the field: a multiband factor that does not divide the slices fails here.
    const series = effectiveSeries();
    const names = outputNames(input.name);
    const voxels = input.dims[0] * input.dims[1] * input.dims[2];

    progress.begin("Extracting the brain from the mean b0 with MindGrab…");
    progress.setCancellable(true);
    status("Extracting the brain from the mean b0 with MindGrab");
    const meanB0 = createNiftiFromData(Float32Array.from(input.meanB0), input.headerBytes, { dims: input.dims });
    const extracted = await brainMask(new Uint8Array(meanB0), { assetPath: `${import.meta.env.BASE_URL}mindgrab/`, signal: controller.signal });
    const maskData = Uint8Array.from(readNiftiFrames(extracted.mask).data, (value) => (value > 0 ? 1 : 0));
    const maskVoxels = maskData.reduce((sum, v) => sum + v, 0);
    if (!maskVoxels) throw new Error("MindGrab found no brain in the mean b0; check the b0 volumes.");
    const maskSource = `mindgrab-${mindgrab.version}-${extracted.backend}`;
    log.log(`MindGrab ${mindgrab.version} brain mask on ${extracted.backend}: ${maskVoxels} voxels`, "info");
    const maskNifti = createNiftiFromData(maskData, input.headerBytes, { dims: input.dims });

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
    let fieldSidecarFile = null;
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
      const fieldNifti = createNiftiFromData(Float32Array.from(out.field), input.headerBytes, { dims: input.dims });
      files[SESSION.field] = fieldNifti.slice(0);
      fieldFile = new File([await gzipBytes(fieldNifti)], names.field, { type: "application/gzip" });
      fieldSidecarFile = textFile(`${JSON.stringify(fieldmapSidecar({ pe, readout, reverse: input.reverse.name, version: APP.version }), null, 2)}\n`, names.fieldSidecar, "application/json");
      field = "estimated";
    } else if (source === "upload" && input.field) {
      const bytes = await input.field.file.arrayBuffer();
      if (input.field.kind === "topup") files[`${SESSION.topup}_fieldcoef.nii.gz`] = bytes;
      else files[SESSION.field] = bytes;
      field = input.field.kind;
    }
    controller.signal.throwIfAborted();

    const args = shorelineArgs({ settings, series, field });
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
    const fieldUnits = field === "hz" && input.field.units !== "Hz" ? `${input.field.units}, divided by 2π to Hz` : null;
    const sidecar = preprocSidecar({ input: { ...input.sidecar, PhaseEncodingDirection: pe, TotalReadoutTime: readout, MultibandAccelerationFactor: series.multiband }, settings, args, field, fieldUnits, threads, seconds, mask: maskSource, version: APP.version });
    const rows = {
      dwi: { description: "Corrected series", file: new File([run.outputs[`${SESSION.out}.nii.gz`]], names.dwi, { type: "application/gzip" }) },
      bval: { description: "b-values", file: textFile(text("bvals"), names.bval), viewable: false },
      bvec: { description: "Rotated b-vectors", file: textFile(text("rotated_bvecs"), names.bvec), viewable: false },
      sidecar: { description: "Sidecar", file: textFile(`${JSON.stringify(sidecar, null, 2)}\n`, names.sidecar, "application/json"), viewable: false },
      confounds: { description: "Movement per volume", file: textFile(confoundsTsv({ parameters, movementRms, outlierMap }), names.confounds, "text/tab-separated-values"), viewable: false },
      ...(outlierMap ? { outliers: { description: "Outlier slices", file: textFile(outliersTsv(outlierMap, input.dims[2]), names.outliers, "text/tab-separated-values"), viewable: false } } : {}),
      mask: { description: "Brain mask (MindGrab)", file: new File([await gzipBytes(maskNifti)], names.mask, { type: "application/gzip" }) },
      ...(fieldFile ? { field: { description: "Field map (Hz)", file: fieldFile } } : {}),
      ...(fieldSidecarFile ? { fieldSidecar: { description: "Field map JSON", file: fieldSidecarFile, viewable: false } } : {}),
      log: { description: "Log", file: textFile(text("log") ?? "", names.log), viewable: false },
    };
    const corrected = readNiftiFrames(await decodeNiftiBuffer(await rows.dwi.file.arrayBuffer()));
    const correctedB0 = meanB0Data(corrected.data, voxels, corrected.frames, input.bvals);
    rows["mean-b0"] = {
      description: "Corrected mean b0",
      file: new File([await gzipBytes(createNiftiFromData(Float32Array.from(correctedB0), input.headerBytes, { dims: corrected.dims }))], names.meanB0, { type: "application/gzip" }),
    };
    controller.signal.throwIfAborted();
    const summary = motionSummary({ parameters, movementRms, outlierMap });
    outputs = { rows, summary, names };
    results.render(rows);
    // Not cancellable: the run is done, and the preview takes a moment.
    progress.begin("Making the before/after preview…", { cancellable: false });
    const gif = beforeAfterGif({
      before: input.beforeSlices,
      after: axialSlices(corrected.data, corrected.dims, corrected.frames, input.sliceZ),
      dims: input.dims,
      aspect: input.aspect,
      volumes: previewVolumes(input.bvals),
    });
    rows.dwi.preview = new File([gif], names.preview, { type: "image/gif" });
    showPreview(rows.dwi.preview, rows.dwi.description);
    $("outputSection").open = true;
    motionTab(true);
    const replaced = summary.reduce((sum, row) => sum + row.outlierSlices.length, 0);
    progress.end("Series corrected");
    status(`Corrected in ${Math.round(seconds)} s on ${threads} thread${threads === 1 ? "" : "s"}; ${replaced} outlier slice${replaced === 1 ? "" : "s"} replaced`);
    return {
      artifacts: Object.entries(rows).map(([role, row]) => ({ role, file: row.file })),
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
    if (row.preview) entries[row.preview.name] = [new Uint8Array(await row.preview.arrayBuffer()), { level: 0 }];
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
for (const id of ["fieldSource", "replaceOutliers", "model", "outlierType", "sliceToVolume", "eddyCurrents", "iterations"]) {
  $(id).addEventListener("change", () => clearOutputs());
}
for (const id of ["phaseEncoding", "readoutTime"]) {
  $(id).addEventListener("input", () => {
    clearOutputs();
    if (input) renderInput();
  });
}
$("multiband").addEventListener("input", () => {
  clearOutputs();
  if (!input) return;
  $("runButton").disabled = Boolean(loading || running) || !multibandValid();
  if (!multibandValid()) {
    try {
      effectiveSeries();
    } catch (error) {
      status(error.message, true);
    }
    return;
  }
  if ($("statusText").classList.contains("error")) status(`${input.name} loaded: ${input.frames} volumes`);
  applyOutlierDefault();
  renderInput();
});
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
    correct: async ({ inputs, inputDetails, parameters, signal }) => {
      await loadFiles(correctionFiles(inputs, inputDetails, parameters), signal);
      if (inputs.reverse?.length && !input.reverse) throw new Error("The reverse image must have opposite phase encoding and share the diffusion grid.");
      if (parameters.multiband !== undefined && input.dims[2] % parameters.multiband) throw new Error(`The multiband factor ${parameters.multiband} does not divide the ${input.dims[2]} slices.`);
      if (parameters.sliceToVolume && !input.series.sliceTiming) throw new Error("Slice-to-volume correction requires valid SliceTiming for every slice.");
      for (const [key, id] of Object.entries({ model: "model", eddyCurrents: "eddyCurrents", iterations: "iterations", outliers: "outlierType" })) {
        if (parameters[key] !== undefined) $(id).value = String(parameters[key]);
      }
      for (const key of ["replaceOutliers", "sliceToVolume"]) {
        if (parameters[key] !== undefined) $(key).checked = parameters[key];
      }
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
