import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import { register as registerFireants } from "@fireants/fireants";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createResultList, bindFileDrop, createInfoDialog, createConsole, createViewerToolbar } from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles } from "@neurodesk/runtime-support/dcm2niix-client";
import { extractBrain } from "./brain-extraction.js";
import { formatBytes, startMemorySampler } from "./memory.js";

const $ = (id) => document.getElementById(id);
const slots = {
  moving: { file: null, files: [], brainExtracted: false, input: $("movingInput"), info: $("movingInfo"), drop: $("movingDropZone"), series: $("movingSeries"), seriesField: $("movingSeriesField"), extract: $("movingExtractButton") },
  stationary: { file: null, files: [], brainExtracted: false, input: $("stationaryInput"), info: $("stationaryInfo"), drop: $("stationaryDropZone"), series: $("stationarySeries"), seriesField: $("stationarySeriesField"), extract: $("stationaryExtractButton") },
};
const viewers = {
  moving: new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  stationary: new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  resliced: new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let output = null;
let busy = false;
let viewersReady = false;
let viewersDestroyed = false;
let registrationController = null;
let timer;

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "FireANTs",
  subtitle: "CPU and WebGPU diffeomorphic MRI registration",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

function applyLayout(id) {
  if (!viewersReady) return;
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
  ].map(([id, label], index) => ({ id, label, active: index === 0, onClick: () => { applyLayout(id); toolbar.setActive(id); } })),
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog" });
$("viewer").append(log);
const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About FireANTs", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown error");
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function setBusy(value) {
  busy = value;
  const disabled = value || !viewersReady;
  exampleControl.setDisabled(disabled);
  for (const slot of Object.values(slots)) {
    slot.input.disabled = disabled;
    slot.series.disabled = disabled;
    slot.extract.disabled = disabled || !slot.file || slot.brainExtracted;
  }
  $("useGpu").disabled = disabled || !navigator.gpu;
  $("useSyn").disabled = disabled;
  $("runButton").disabled = disabled || !slots.moving.file || !slots.stationary.file;
  if (!value) {
    clearInterval(timer);
    $("elapsed").textContent = "";
    $("cancelButton").hidden = true;
  }
}

function fmtIntensity(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function fmtMm(mm = []) {
  return mm.map((value) => Math.round(value)).join("×");
}

let stationaryValue = null;
let reslicedValue = null;
let yokedMm = [];

function renderYokedLocation() {
  $("location").textContent = `${fmtMm(yokedMm)} mm  Stationary ${fmtIntensity(stationaryValue)} · Resliced ${fmtIntensity(reslicedValue)}`;
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
  viewer.meshXRay = 0.08;
  const context = viewer.createExtensionContext();
  context.on("locationChange", (event) => onLocation(event.detail));
  contexts.push(context);
}

async function attachViewers() {
  await configureViewer("moving", "glMoving", (detail) => {
    $("location").textContent = `${fmtMm(detail.mm)} mm  Moving ${fmtIntensity(detail.values[0]?.value)}`;
  });
  await configureViewer("stationary", "glStationary", (detail) => {
    stationaryValue = detail.values[0]?.value ?? null;
    yokedMm = detail.mm;
    renderYokedLocation();
  });
  await configureViewer("resliced", "glResliced", (detail) => {
    reslicedValue = detail.values[0]?.value ?? null;
    yokedMm = detail.mm;
    renderYokedLocation();
  });
  viewers.stationary.broadcastTo([viewers.resliced]);
  viewers.resliced.broadcastTo([viewers.stationary]);
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

async function clearOutput() {
  output = null;
  reslicedValue = null;
  $("outputSection").open = false;
  $("resultList").replaceChildren();
  $("progress").value = 0;
  await viewers.resliced.removeAllVolumes();
}

async function loadSlot(name, file, brainExtracted = false, signal) {
  if (!file) return;
  await clearOutput();
  const slot = slots[name];
  slot.file = null;
  slot.brainExtracted = false;
  slot.info.hidden = true;
  slot.info.textContent = "";
  slot.drop.classList.remove("has-files");
  try {
    await viewers[name].loadVolumes([{ url: file, name: file.name }]);
  } catch (error) {
    await viewers[name].removeAllVolumes();
    throw error;
  }
  signal?.throwIfAborted();
  $("emptyState").hidden = true;
  slot.file = file;
  slot.brainExtracted = brainExtracted;
  slot.info.hidden = false;
  slot.info.textContent = `${file.name}${brainExtracted ? " · brain extracted" : " · not brain extracted"}`;
  slot.drop.classList.add("has-files");
  status(`${file.name} loaded as ${name}`);
}

async function runTask(message, task) {
  if (busy) return;
  setBusy(true);
  status(message);
  try {
    await task();
  } catch (error) {
    status(errorMessage(error), true);
  } finally {
    setBusy(false);
  }
}

async function importSlot(name, filesPromise) {
  exampleControl.cancel();
  await runTask(`Reading ${name} image · converting DICOM if needed…`, async () => {
    const images = await readImageFiles(await filesPromise);
    if (!images.length) throw new Error("Choose NIfTI files or a complete DICOM series.");
    const slot = slots[name];
    slot.files = images;
    slot.series.replaceChildren(...images.map((file, index) => new Option(file.name, String(index))));
    slot.seriesField.hidden = images.length < 2;
    await loadSlot(name, images[0]);
    status(`${images[0].name} loaded. Brain extract it before registering if it still includes scalp.`);
  });
}

for (const [name, slot] of Object.entries(slots)) {
  slot.input.onchange = () => {
    const files = Array.from(slot.input.files);
    slot.input.value = "";
    if (files.length) void importSlot(name, Promise.resolve(files));
  };
  bindFileDrop(slot.drop, (files) => void importSlot(name, files));
  slot.series.onchange = () => void runTask(`Loading ${name} series…`, () => loadSlot(name, slot.files[Number(slot.series.value)]));
  slot.extract.onclick = () => void runTask(`Brain extracting ${name} image…`, () => brainExtract(name));
}

const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const [moving, stationary] = await fetchFiles();
    assertCurrent();
    if (!viewersReady) throw new Error('The image viewers are not ready. Try again after initialization.');
    setBusy(true);
    try {
      await loadSlot('moving', moving, true, signal);
      assertCurrent();
      await loadSlot('stationary', stationary, true, signal);
      assertCurrent();
    } finally {
      setBusy(false);
    }
  },
  onStatus: status,
});
$('inputSection').querySelector('.nd-section-content').prepend(exampleControl);


async function brainExtract(name) {
  const slot = slots[name];
  if (!slot.file || slot.brainExtracted) return;
  const source = slot.file;
  status(`Brain extracting ${source.name} with MindGrab…`);
  $("progress").removeAttribute("value");
  const result = await extractBrain({
    file: source,
    assetPath: `${import.meta.env.BASE_URL}brainchop/`,
    onLog: (message) => log.log(message),
  });
  await loadSlot(name, result.file, true);
  status(`${source.name} brain extracted in ${(result.elapsedMs / 1000).toFixed(1)} s (${result.backend}).`);
  $("progress").value = 0;
}

const results = createResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: () => downloadFile(output),
});

async function runRegistration(fixed, moving, backend, transform, onProgress) {
  const controller = new AbortController();
  registrationController = controller;
  $("cancelButton").hidden = false;
  try {
    const [fixedBytes, movingBytes] = await Promise.all([fixed.arrayBuffer(), moving.arrayBuffer()]);
    return await registerFireants(fixedBytes, movingBytes, {
      assetPath: `${import.meta.env.BASE_URL}cfireants/`,
      backend,
      transform,
      worker: true,
      signal: controller.signal,
      gzip: true,
      verbose: 2,
      onLog: (line) => {
        log.log(line);
        const message = line.trim();
        if (/^(Rigid|Affine|Greedy|SyN)(?: GPU)?(?: scale|:)/i.test(message)) onProgress(message);
      },
    });
  } finally {
    if (registrationController === controller) registrationController = null;
    $("cancelButton").hidden = true;
  }
}

function logMemory(backend, memory) {
  if (!memory) {
    log.log(`Peak sampled page RAM (${backend}): unavailable in this browser.`);
    return;
  }
  let message = `Peak sampled page RAM (${backend}): ${formatBytes(memory.bytes)}`;
  if (backend === "webgpu") {
    message += memory.gpuBytes
      ? ` · GPU-attributed memory: ${formatBytes(memory.gpuBytes)}`
      : " · GPU-attributed memory: unavailable";
  }
  log.log(message);
}

async function register() {
  if (!slots.moving.file || !slots.stationary.file) return;
  // Extraction is the user's call; a scalp-bearing input is only flagged, not forced.
  for (const name of ["moving", "stationary"]) {
    if (!slots[name].brainExtracted) log.log(`The ${name} image is not brain extracted; scalp can distort the registration.`);
  }
  const fixed = slots.stationary.file;
  const moving = slots.moving.file;
  const backend = $("useGpu").checked ? "webgpu" : "cpu";
  const transform = $("useSyn").checked ? "syn" : "greedy";
  const started = performance.now();
  let phase = `Starting ${transform} registration on ${backend}`;
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    $("statusText").textContent = phase;
  }, 1000);
  $("progress").removeAttribute("value");
  const stopMemorySampler = startMemorySampler();
  try {
    const data = await runRegistration(fixed, moving, backend, transform, (next) => {
      phase = next;
      status(next);
    });
    output = new File([data.image], `${moving.name.replace(/\.nii(\.gz)?$/i, "")}_registered.nii.gz`);
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    results.render({ registered: { description: "Registered moving image" } });
    $("outputSection").open = true;
    $("progress").value = 1;
    const endToEnd = ((performance.now() - started) / 1000).toFixed(1);
    const engine = (data.elapsedMs / 1000).toFixed(1);
    const execution = data.variant === "mt" ? `${data.threads} CPU threads` : data.variant === "gpu" ? "WebGPU" : "1 CPU thread";
    status(`Registration complete in ${endToEnd} s end to end · ${engine} s engine · ${execution}`);
  } catch (error) {
    $("progress").value = 0;
    if (error?.code === "aborted") {
      status("Registration cancelled. Your images are unchanged.");
      return;
    }
    throw new Error(`Registration failed: ${errorMessage(error)}`);
  } finally {
    logMemory(backend, await stopMemorySampler());
  }
}

$("runButton").onclick = () => void runTask("Starting registration…", async () => {
  await clearOutput();
  await register();
});
$("useGpu").onchange = () => void runTask("Changing registration backend…", clearOutput);
$("useSyn").onchange = () => void runTask("Changing registration algorithm…", clearOutput);
$("cancelButton").onclick = () => {
  status("Cancelling registration…");
  registrationController?.abort();
};

async function init() {
  await runTask("Initializing image viewers…", async () => {
    try {
      await attachViewers();
    } catch (error) {
      destroyViewers();
      $("viewerError").hidden = false;
      $("viewerError").textContent = `Visualization unavailable: ${errorMessage(error)}`;
      throw error;
    }
    status("Ready · choose an example or upload images, then register.");
  });
}

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  clearInterval(timer);
  registrationController?.abort();
  destroyViewers();
});

void init();

export default Object.freeze({ toolbar, log, info, results });
