import "./pipelines.js";
import examples from "../examples.json";
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import { createWebWorker } from "itk-wasm";
import { defaultParameterMap, elastix } from "@itk-wasm/elastix";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  bindFileDrop,
  bindInfoTooltips,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createResultList,
  createViewerToolbar,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { createNiivueAdapter, registerAppAutomation, registerViewer } from "@neurodesk/webapp-components/automation";
import { APP } from "./config.js";
import {
  abortable,
  readCustomParameters,
  readNiftiFile,
  readSource,
  resetIo,
  writeImageFile,
  writeOmeZarrFile,
  writeTransformFile,
  writeTransformOmeZarrFile,
  writeTransformParameterFiles,
} from "./io.js";
import { assertCompatiblePair, classifySource } from "./sources.js";
import { chainParameterFiles, METHOD_LABELS, presetSettings, sortParameterFiles, stageNames } from "./parameter-maps.js";
import { outputNames } from "./outputs.js";
import { createRegistrationRunner } from "./registration.js";

const $ = (id) => document.getElementById(id);
const slotElements = (name) => ({
  source: null,
  series: [],
  input: $(`${name}Input`),
  info: $(`${name}Info`),
  drop: $(`${name}DropZone`),
  select: $(`${name}Series`),
  seriesField: $(`${name}SeriesField`),
  url: $(`${name}Url`),
});
const slots = { moving: slotElements("moving"), stationary: slotElements("stationary") };
const viewers = {
  moving: new NiiVue({ backend: "webgl2", isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  stationary: new NiiVue({ backend: "webgl2", isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  registered: new NiiVue({ backend: "webgl2", isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let currentLayout = "multiplanar";
let customParameters = null;
let output = null;
let active = null;
let busy = false;
let viewersReady = false;
let viewersDestroyed = false;

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "elastix",
  subtitle: "Rigid, affine and B-spline image registration",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

function applyLayout(id) {
  if (!viewersReady) return;
  currentLayout = id;
  for (const viewer of Object.values(viewers)) {
    if (id === "multiplanar") {
      viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
      viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
      viewer.showRender = SHOW_RENDER.ALWAYS;
    } else {
      viewer.sliceType = {
        axial: SLICE_TYPE.AXIAL,
        coronal: SLICE_TYPE.CORONAL,
        sagittal: SLICE_TYPE.SAGITTAL,
        render: SLICE_TYPE.RENDER,
      }[id];
    }
    viewer.drawScene();
  }
  toolbar.setActive(id);
}

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
    ["render", "3D"],
  ].map(([id, label], index) => ({ id, label, active: index === 0, onClick: () => applyLayout(id) })),
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);
const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About elastix", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown error");
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function complete(message) {
  progress.end(message);
  status(message);
}

function setBusy(value) {
  busy = value;
  const disabled = value || !viewersReady;
  exampleControl.setDisabled(disabled);
  for (const slot of Object.values(slots)) {
    slot.input.disabled = disabled;
    slot.select.disabled = disabled;
    slot.url.disabled = disabled;
  }
  $("urlButton").disabled = disabled;
  $("parameterInput").disabled = disabled;
  $("parameterClear").disabled = disabled;
  for (const id of ["method", "resolutions", "gridSpacing"]) $(id).disabled = disabled || Boolean(customParameters);
  $("runButton").disabled = disabled || !slots.moving.source || !slots.stationary.source;
}

// One step at a time: loading, registering or writing a download. The footer ×
// aborts it; an aborted step leaves the inputs as they were.
async function perform(message, task, { signal } = {}) {
  if (busy) throw new Error("Wait for the current step to finish, or cancel it.");
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", forward, { once: true });
  active = controller;
  setBusy(true);
  progress.begin(message);
  status(message);
  try {
    return await task(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) resetIo();
    const cancelled = controller.signal.aborted || error?.name === "AbortError";
    progress.end(cancelled ? "Cancelled" : errorMessage(error), { success: false });
    throw cancelled && error?.name !== "AbortError" ? new DOMException("Cancelled", "AbortError") : error;
  } finally {
    signal?.removeEventListener("abort", forward);
    active = null;
    setBusy(false);
  }
}

function runTask(message, task, cancelMessage = "Cancelled.") {
  return perform(message, task).catch((error) => {
    if (error?.name === "AbortError") status(cancelMessage);
    else status(errorMessage(error), true);
  });
}

$("cancelButton").onclick = () => {
  status("Cancelling…");
  exampleControl.cancel();
  active?.abort();
};

function fmtIntensity(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function fmtPosition(mm = []) {
  return mm.map((value) => Math.round(value)).join("×");
}

let stationaryValue = null;
let registeredValue = null;
let linkedPosition = [];

function renderLinkedLocation() {
  $("location").textContent = `${fmtPosition(linkedPosition)}  Stationary ${fmtIntensity(stationaryValue)} · Registered ${fmtIntensity(registeredValue)}`;
}

async function configureViewer(name, canvasId, onLocation) {
  const viewer = viewers[name];
  await viewer.attachTo(canvasId);
  viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
  viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
  viewer.showRender = SHOW_RENDER.ALWAYS;
  viewer.crosshairGap = 5;
  viewer.isLegendVisible = false;
  viewer.is3DCrosshairVisible = true;
  const context = viewer.createExtensionContext();
  context.on("locationChange", (event) => onLocation(event.detail));
  contexts.push(context);
}

async function attachViewers() {
  await configureViewer("moving", "glMoving", (detail) => {
    $("location").textContent = `${fmtPosition(detail.mm)}  Moving ${fmtIntensity(detail.values[0]?.value)}`;
  });
  await configureViewer("stationary", "glStationary", (detail) => {
    stationaryValue = detail.values[0]?.value ?? null;
    linkedPosition = detail.mm;
    renderLinkedLocation();
  });
  await configureViewer("registered", "glRegistered", (detail) => {
    registeredValue = detail.values[0]?.value ?? null;
    linkedPosition = detail.mm;
    renderLinkedLocation();
  });
  viewers.stationary.broadcastTo([viewers.registered]);
  viewers.registered.broadcastTo([viewers.stationary]);
  viewersReady = true;
}

function destroyViewers() {
  if (viewersDestroyed) return;
  viewersDestroyed = true;
  viewersReady = false;
  for (const context of contexts.splice(0)) {
    try { context.dispose(); } catch { /* best-effort cleanup */ }
  }
  for (const viewer of Object.values(viewers)) {
    try { viewer.destroy(); } catch { /* best-effort cleanup */ }
  }
}

const results = createResultList({
  element: $("resultList"),
  onView: () => viewers.registered.drawScene(),
  onDownload: (stage) => void runTask(`Preparing ${output?.rows[stage]?.description ?? "download"}…`, (signal) => download(stage, signal)),
});

async function clearOutput() {
  output = null;
  registeredValue = null;
  $("outputSection").open = false;
  $("resultList").replaceChildren();
  if (viewersReady) await viewers.registered.removeAllVolumes();
}

async function setSlot(name, source, signal) {
  const slot = slots[name];
  await clearOutput();
  slot.source = null;
  slot.info.hidden = true;
  slot.drop.classList.remove("has-files");
  try {
    await viewers[name].loadVolumes([{ url: source.displayFile, name: source.displayFile.name }]);
  } catch (error) {
    await viewers[name].removeAllVolumes();
    throw error;
  }
  signal?.throwIfAborted();
  slot.source = source;
  slot.info.hidden = false;
  slot.info.textContent = `${source.name} · ${source.note}`;
  slot.drop.classList.add("has-files");
  $("emptyState").hidden = true;
  if (name === "stationary") applyLayout(source.image.imageType.dimension === 2 ? "axial" : "multiplanar");
  log.log(`${name} image: ${source.name} · ${source.note}`);
}

function showSeries(slot, files) {
  slot.series = files;
  slot.select.replaceChildren(...files.map((file, index) => new Option(file.name, String(index))));
  slot.seriesField.hidden = files.length < 2;
}

async function loadFiles(name, files, signal) {
  const slot = slots[name];
  if (["nifti", "dicom"].includes(classifySource(files))) {
    progress.setText(`Reading ${name} image · converting DICOM if needed…`);
    const images = await abortable(readImageFiles(files), signal);
    if (!images.length) throw new Error("Choose NIfTI files or a complete DICOM series.");
    showSeries(slot, images);
    await setSlot(name, await abortable(readNiftiFile(images[0]), signal), signal);
  } else {
    showSeries(slot, []);
    await setSlot(name, await abortable(readSource(files, { signal }), signal), signal);
  }
}

function importSlot(name, filesPromise) {
  exampleControl.cancel();
  return runTask(`Reading ${name} image…`, async (signal) => {
    const files = await filesPromise;
    await loadFiles(name, files, signal);
    complete(`${slots[name].source.name} loaded as the ${name} image.`);
  });
}

for (const [name, slot] of Object.entries(slots)) {
  slot.input.onchange = () => {
    const files = Array.from(slot.input.files);
    slot.input.value = "";
    if (files.length) void importSlot(name, Promise.resolve(files));
  };
  bindFileDrop(slot.drop, (files) => void importSlot(name, files));
  slot.select.onchange = () => void runTask(`Loading ${name} series…`, async (signal) => {
    await setSlot(name, await abortable(readNiftiFile(slot.series[Number(slot.select.value)]), signal), signal);
    complete(`${slot.source.name} loaded as the ${name} image.`);
  });
}

$("urlButton").onclick = () => {
  exampleControl.cancel();
  void runTask("Opening image URLs…", async (signal) => {
    const urls = Object.entries(slots).filter(([, slot]) => slot.url.value.trim());
    if (!urls.length) throw new Error("Enter a moving or stationary image URL.");
    for (const [name, slot] of urls) {
      const url = slot.url.value.trim();
      if (!/^https?:\/\//i.test(url)) throw new Error(`The ${name} URL must start with https:// or http://.`);
      progress.setText(`Opening the ${name} image URL…`);
      showSeries(slot, []);
      await setSlot(name, await abortable(readSource(url, { signal }), signal), signal);
    }
    complete(`Opened ${urls.map(([name]) => name).join(" and ")} image URL${urls.length > 1 ? "s" : ""}.`);
  });
};

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const [moving, stationary] = await fetchFiles();
    assertCurrent();
    if (!viewersReady) throw new Error("The image viewers are not ready. Try again after initialization.");
    await perform("Loading example images…", async (stepSignal) => {
      await loadFiles("moving", [moving], stepSignal);
      assertCurrent();
      await loadFiles("stationary", [stationary], stepSignal);
      assertCurrent();
      complete("Example loaded · choose a method, then register.");
    }, { signal });
  },
});
$("exampleControl").append(exampleControl);

function showParameters() {
  const parameterInfo = $("parameterInfo");
  parameterInfo.hidden = !customParameters;
  $("parameterClear").hidden = !customParameters;
  $("parameterDropZone").classList.toggle("has-files", Boolean(customParameters));
  if (customParameters) {
    parameterInfo.textContent = `${customParameters.files.length} parameter file${customParameters.files.length > 1 ? "s" : ""} · ${stageNames(customParameters.parameterObject).join(" → ")}`;
  }
  setBusy(busy);
}

async function loadParameterFiles(filesPromise) {
  await runTask("Reading elastix parameter files…", async (signal) => {
    const files = sortParameterFiles(await filesPromise);
    const parameterObject = await abortable(readCustomParameters(files), signal);
    if (!parameterObject.length) throw new Error("The parameter files hold no parameter maps.");
    customParameters = { files, parameterObject };
    await clearOutput();
    showParameters();
    complete(`Registering with ${files.length} parameter file${files.length > 1 ? "s" : ""} instead of the method preset.`);
  });
}

$("parameterInput").onchange = () => {
  const files = Array.from($("parameterInput").files);
  $("parameterInput").value = "";
  if (files.length) void loadParameterFiles(Promise.resolve(files));
};
bindFileDrop($("parameterDropZone"), (files) => void loadParameterFiles(files));
$("parameterClear").onclick = () => {
  customParameters = null;
  showParameters();
  void clearOutput();
  status(`Registering with the ${METHOD_LABELS[$("method").value]} preset.`);
};
for (const id of ["method", "resolutions", "gridSpacing"]) $(id).onchange = () => void clearOutput();

const registration = createRegistrationRunner({
  elastix,
  defaultParameterMap,
  createWebWorker: () => createWebWorker(null),
});

function resultRows(names, parameterNames) {
  return {
    registered: { description: "Registered NIfTI", file: names.nifti },
    omeZarr: { description: "Registered OME-Zarr", file: names.omeZarr, viewable: false },
    transform: { description: "Transform (ITK HDF5)", file: names.transform, viewable: false },
    transformOmeZarr: { description: "Transform (OME-Zarr)", file: names.transformOmeZarr, viewable: false },
    ...Object.fromEntries(parameterNames.map((name, index) => [`parameters${index}`, {
      description: `TransformParameters.${index}.toml`,
      file: name,
      viewable: false,
    }])),
  };
}

async function writeParameters(signal) {
  output.files.parameters ??= await abortable(writeTransformParameterFiles(output.chained.maps, output.chained.names), signal);
  return output.files.parameters;
}

async function outputFile(stage, signal) {
  const { files, names } = output;
  if (stage === "registered") return files.nifti;
  if (stage === "omeZarr") return (files.omeZarr ??= await abortable(writeOmeZarrFile(output.result, names.omeZarr), signal));
  if (stage === "transform") return (files.transform ??= await abortable(writeTransformFile(output.transform, names.transform), signal));
  if (stage === "transformOmeZarr") {
    return (files.transformOmeZarr ??= await abortable(writeTransformOmeZarrFile(output, names.transformOmeZarr), signal));
  }
  return (await writeParameters(signal))[Number(stage.replace("parameters", ""))];
}

async function download(stage, signal) {
  if (!output) throw new Error("Register the images first.");
  const file = await outputFile(stage, signal);
  downloadFile(file);
  complete(`Downloaded ${file.name}`);
}

async function register({
  method = $("method").value,
  resolutions = $("resolutions").value,
  gridSpacing = $("gridSpacing").value,
  signal,
  report = () => {},
} = {}) {
  const moving = slots.moving.source;
  const fixed = slots.stationary.source;
  if (!moving || !fixed) throw new Error("Choose both moving and stationary images.");
  assertCompatiblePair(fixed.image, moving.image);
  const settings = customParameters ? null : presetSettings({ method, resolutions, gridSpacing });
  await clearOutput();
  const started = performance.now();
  const phase = (message) => {
    progress.setText(message);
    log.log(message);
    report({ message });
  };
  const run = await registration.run({
    fixed: fixed.image,
    moving: moving.image,
    settings,
    parameterObject: customParameters?.parameterObject,
    onPhase: phase,
    signal,
  });
  phase("Writing the registered image");
  const names = outputNames(moving.name);
  const nifti = await abortable(writeImageFile(run.result, names.nifti), signal);
  await viewers.registered.loadVolumes([{ url: nifti, name: nifti.name }]);
  signal?.throwIfAborted();
  const chained = chainParameterFiles(run.transformParameterObject, names.stem);
  const rows = resultRows(names, chained.names);
  output = { ...run, fixed: fixed.image, moving: moving.image, names, chained, rows, files: { nifti } };
  results.render(rows);
  $("outputSection").open = true;
  const elapsedMs = performance.now() - started;
  complete(`Registration complete in ${(elapsedMs / 1000).toFixed(1)} s`);
  return {
    stages: stageNames(run.parameterObject),
    numberOfResolutions: settings?.numberOfResolutions ?? null,
    finalGridSpacing: settings?.method === "bspline" ? settings.finalGridSpacing : null,
    parameterSource: customParameters ? "parameter files" : `${METHOD_LABELS[settings.method]} preset`,
    elapsedMs,
  };
}

$("runButton").onclick = () => void runTask("Starting registration…", (signal) => register({ signal }), "Registration cancelled. Your images are unchanged.");

async function init() {
  setBusy(true);
  try {
    await attachViewers();
    status("Ready · choose an example or images, then register.");
  } catch (error) {
    destroyViewers();
    $("viewerError").hidden = false;
    $("viewerError").textContent = `Visualization unavailable: ${errorMessage(error)}`;
    status(`Visualization unavailable: ${errorMessage(error)}`, true);
  } finally {
    setBusy(false);
  }
}

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  registration.cancel();
  resetIo();
  destroyViewers();
});

const initialization = init();

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    register: async ({ inputs, parameters, signal, progress: report }) => {
      await initialization;
      signal.throwIfAborted();
      if (!viewersReady) throw new Error("The image viewers are unavailable.");
      exampleControl.cancel();
      return perform("Registering images…", async (stepSignal) => {
        await loadFiles("moving", inputs.moving, stepSignal);
        await loadFiles("stationary", inputs.fixed, stepSignal);
        $("method").value = parameters.method;
        $("resolutions").value = String(parameters.resolutions);
        $("gridSpacing").value = String(parameters.gridSpacing);
        const provenance = await register({ ...parameters, signal: stepSignal, report });
        const files = output.files;
        files.transform = await abortable(writeTransformFile(output.transform, output.names.transform), stepSignal);
        const parameterFiles = await writeParameters(stepSignal);
        return {
          artifacts: [
            { role: "registered", file: files.nifti },
            { role: "transform", file: files.transform },
            ...parameterFiles.map((file) => ({ role: "parameters", file })),
          ],
          provenance: { algorithm: "elastix", implementation: "@itk-wasm/elastix 2.1.0", ...provenance },
        };
      }, { signal });
    },
  },
});

for (const [id, viewer] of Object.entries(viewers)) {
  registerViewer(id, createNiivueAdapter(viewer, {
    tabs: {
      list: () => ["multiplanar", "axial", "coronal", "sagittal", "render"].map((tab) => ({ id: tab, label: tab, active: tab === currentLayout })),
      select: applyLayout,
    },
  }));
}

export default Object.freeze({ toolbar, log, info, results });
