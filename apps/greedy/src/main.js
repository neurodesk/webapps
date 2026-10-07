import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createResultList, bindFileDrop, createInfoDialog, renderCommand, createConsole, createViewerToolbar } from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, registerViewer, createNiivueAdapter } from "@neurodesk/webapp-components/automation";
import { extractBrain } from "./brain-extraction.js";
import { createRegistrationRunner } from "./registration-runner.js";

const $ = (id) => document.getElementById(id);
const slots = {
  moving: { file: null, files: [], brainExtracted: false, input: $("movingInput"), info: $("movingInfo"), drop: $("movingDropZone"), series: $("movingSeries"), seriesField: $("movingSeriesField"), extract: $("movingExtractButton") },
  stationary: { file: null, files: [], brainExtracted: false, input: $("stationaryInput"), info: $("stationaryInfo"), drop: $("stationaryDropZone"), series: $("stationarySeries"), seriesField: $("stationarySeriesField"), extract: $("stationaryExtractButton") },
};
const viewers = {
  moving: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  stationary: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  resliced: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let currentLayout = "multiplanar";
let output = null;
let busy = false;
let viewersReady = false;
let viewersDestroyed = false;
let timer;

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Greedy",
  subtitle: "Browser-native affine and deformable MRI registration",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn", standalone: "#standaloneBtn" },
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
$("aboutBtn").onclick = () => info.open("About Greedy", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));
$("standaloneBtn").onclick = () => {
  info.open("Run Greedy in a terminal", $("standaloneContent"));
  info.body.append(renderCommand({
    id: "greedyStandaloneCommands",
    command: [
      "git clone https://github.com/neurodesk/webapps",
      "cd webapps/exes/greedy",
      "cargo build --release -p greedy-rs",
      "./target/release/greedy-rs -d 3 -a -m NMI -i fixed.nii.gz moving.nii.gz -o affine.mat -ia-image-centers -n 100x50x10",
      "./target/release/greedy-rs -d 3 -rf fixed.nii.gz -rm moving.nii.gz registered.nii.gz -r affine.mat",
    ].join("\n"),
  }).root);
};

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
  $("method").disabled = disabled;
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
    status(`${images[0].name} loaded.`);
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

const registration = createRegistrationRunner({
  createWorker: () => new Worker(new URL("./registration-worker.js", import.meta.url), { type: "module" }),
  onActiveChange: (active) => { $("cancelButton").hidden = !active; },
});

async function register({
  moving = slots.moving.file,
  fixed = slots.stationary.file,
  method = $("method").value,
  signal,
  progress = () => {},
} = {}) {
  if (!moving || !fixed) throw new Error("Choose both moving and fixed images.");
  signal?.throwIfAborted();
  // Extraction is the user's call; a scalp-bearing input is only flagged, not forced.
  for (const name of ["moving", "stationary"]) {
    if (!slots[name].brainExtracted) log.log(`The ${name} image is not brain extracted; scalp can distort the registration.`);
  }
  const started = performance.now();
  let phase = "Starting Greedy registration";
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    $("statusText").textContent = phase;
  }, 1000);
  $("progress").removeAttribute("value");
  try {
    const data = await registration.run(fixed, moving, method, (next) => {
      phase = next;
      status(next);
      progress({ message: next });
    }, signal);
    signal?.throwIfAborted();
    output = new File([data.image], `${moving.name.replace(/\.nii(\.gz)?$/i, "")}_registered.nii.gz`);
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    signal?.throwIfAborted();
    results.render({ registered: { description: "Registered moving image" } });
    $("outputSection").open = true;
    $("progress").value = 1;
    status(`Registration complete in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    const stem = moving.name.replace(/\.nii(\.gz)?$/i, "");
    return {
      artifacts: [
        { role: "registered", file: output },
        { role: "affine", file: new File([data.matrix], `${stem}_affine.mat`, { type: "text/plain" }) },
        ...(data.warp ? [{ role: "warp", file: new File([data.warp], `${stem}_warp.nii.gz`) }] : []),
      ],
      provenance: { algorithm: "Greedy", implementation: "greedy-rs-wasm", method, metric: "NMI", iterations: "100x50x10", elapsedMs: performance.now() - started },
    };
  } catch (error) {
    $("progress").value = 0;
    signal?.throwIfAborted();
    if (error?.name === "AbortError" || errorMessage(error) === "Cancelled") {
      status("Registration cancelled. Your images are unchanged.");
      return;
    }
    throw new Error(`Registration failed: ${errorMessage(error)}`);
  }
}

$("runButton").onclick = () => void runTask("Starting registration…", async () => {
  await clearOutput();
  await register();
});
$("method").onchange = () => void runTask("Changing registration method…", clearOutput);
$("cancelButton").onclick = () => {
  status("Cancelling registration…");
  registration.cancel();
};

async function init() {
  if (!navigator.gpu) {
    setBusy(false);
    status("WebGPU is unavailable. Greedy needs a recent desktop browser.", true);
    return;
  }
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
  registration.terminate();
  destroyViewers();
});

const initialization = init();

registerAppAutomation({
  app: "greedy",
  convertDicom: runDcm2niix,
  operations: {
    register: async ({ inputs, parameters, signal, progress }) => {
      await initialization;
      signal.throwIfAborted();
      if (!viewersReady) throw new Error("The image viewers are unavailable.");
      if (busy) throw new Error("Wait for the current operation to finish.");
      exampleControl.cancel();
      setBusy(true);
      try {
        await loadSlot("moving", inputs.moving[0], false, signal);
        await loadSlot("stationary", inputs.fixed[0], false, signal);
        $("method").value = parameters.method;
        const result = await register({ moving: inputs.moving[0], fixed: inputs.fixed[0], method: parameters.method, signal, progress });
        signal.throwIfAborted();
        if (!result) throw new DOMException("Registration cancelled", "AbortError");
        return result;
      } finally {
        setBusy(false);
      }
    },
  },
});

for (const [id, viewer] of Object.entries(viewers)) {
  registerViewer(id, createNiivueAdapter(viewer, {
    tabs: {
      list: () => ["multiplanar", "axial", "coronal", "sagittal", "render"].map((id) => ({ id, label: id, active: id === currentLayout })),
      select: (id) => { applyLayout(id); toolbar.setActive(id); },
    },
  }));
}

export default Object.freeze({ toolbar, log, info, results });
