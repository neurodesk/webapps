import examples from '../examples.json';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import { Niimath } from "@niivue/niimath";
import { OUTPUT_DATA_TYPE, registeredName, registrationChain } from "@neurodesk/edgereg";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createResultList, bindFileDrop, createInfoDialog, createConsole, createViewerToolbar } from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, registerViewer, createNiivueAdapter } from "@neurodesk/webapp-components/automation";

const $ = (id) => document.getElementById(id);
const slots = {
  moving: { file: null, files: [], input: $("movingInput"), info: $("movingInfo"), drop: $("movingDropZone"), series: $("movingSeries"), seriesField: $("movingSeriesField") },
  stationary: { file: null, files: [], input: $("stationaryInput"), info: $("stationaryInfo"), drop: $("stationaryDropZone"), series: $("stationarySeries"), seriesField: $("stationarySeriesField") },
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
let cancelled = false;
let viewersReady = false;
let viewersDestroyed = false;
let niimath = new Niimath();
let niimathReady;
let timer;

niimath.setOutputDataType(OUTPUT_DATA_TYPE);

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "EdgeReg",
  subtitle: "Browser-native affine MRI registration",
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
$("aboutBtn").onclick = () => info.open("About EdgeReg", $("aboutContent"));
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
  }
  $("robustFov").disabled = disabled;
  $("runButton").disabled = disabled || !slots.moving.file || !slots.stationary.file;
  $("cancelButton").hidden = true;
  if (!value) {
    clearInterval(timer);
    $("elapsed").textContent = "";
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

function resetNiimath() {
  niimath.dispose();
  niimath = new Niimath();
  niimath.setOutputDataType(OUTPUT_DATA_TYPE);
  niimathReady = undefined;
}

async function clearOutput() {
  output = null;
  reslicedValue = null;
  $("outputSection").open = false;
  $("resultList").replaceChildren();
  $("progress").value = 0;
  await viewers.resliced.removeAllVolumes();
}

async function loadSlot(name, file, registerAfter = false, signal) {
  if (!file) return;
  await clearOutput();
  const slot = slots[name];
  slot.file = null;
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
  slot.info.hidden = false;
  slot.info.textContent = file.name;
  slot.drop.classList.add("has-files");
  status(`${file.name} loaded as ${name}`);
  if (registerAfter && slots.moving.file && slots.stationary.file) await register();
}

async function runTask(message, task) {
  if (busy) return;
  cancelled = false;
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
}

const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const [moving, stationary] = await fetchFiles();
    assertCurrent();
    if (!viewersReady) throw new Error('The image viewers are not ready. Try again after initialization.');
    setBusy(true);
    try {
      await loadSlot('moving', moving, false, signal);
      assertCurrent();
      await loadSlot('stationary', stationary, false, signal);
      assertCurrent();
    } finally {
      setBusy(false);
    }
  },
  onStatus: status,
});
$('inputSection').querySelector('.nd-section-content').prepend(exampleControl);


const results = createResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: () => downloadFile(output),
});

async function register({
  moving = slots.moving.file,
  fixed = slots.stationary.file,
  robustFov = $("robustFov").checked,
  signal,
  progress = () => {},
} = {}) {
  if (!moving || !fixed) throw new Error("Choose both moving and fixed images.");
  signal?.throwIfAborted();
  const abort = () => { cancelled = true; resetNiimath(); };
  signal?.addEventListener("abort", abort, { once: true });
  const started = performance.now();
  timer = setInterval(() => { $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`; }, 1000);
  status("Registering moving image to stationary image…");
  progress({ message: "Registering moving image to stationary image" });
  $("progress").removeAttribute("value");
  $("cancelButton").hidden = false;
  try {
    niimathReady ||= niimath.init();
    await niimathReady;
    signal?.throwIfAborted();
    if (cancelled) return;
    const blob = await registrationChain(niimath.image(moving), fixed, { robustFov }).run("registered.nii");
    signal?.throwIfAborted();
    if (cancelled) return;
    output = new File([blob], registeredName(moving.name));
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    signal?.throwIfAborted();
    if (cancelled) {
      await clearOutput();
      return;
    }
    results.render({ registered: { description: "Registered moving image" } });
    $("outputSection").open = true;
    $("progress").value = 1;
    status("Registration complete");
    return {
      artifacts: [{ role: "registered", file: output }],
      provenance: { algorithm: "niimath allineate", robustFov, elapsedMs: performance.now() - started },
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (cancelled) return;
    resetNiimath();
    $("progress").value = 0;
    throw new Error(`Registration failed: ${errorMessage(error)}`);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function reregister() {
  await clearOutput();
  await register();
}

$("runButton").onclick = () => void runTask("Starting registration…", reregister);
$("robustFov").onchange = () => void runTask("Updating registration…", reregister);

$("cancelButton").onclick = () => {
  cancelled = true;
  resetNiimath();
  $("cancelButton").hidden = true;
  $("progress").value = 0;
  status("Registration cancelled. Your images are unchanged.");
};

async function init() {
  if (!navigator.gpu) {
    setBusy(false);
    status("WebGPU is unavailable. EdgeReg needs a recent desktop browser.", true);
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
  niimath.dispose();
  destroyViewers();
});

const initialization = init();

registerAppAutomation({
  app: "edgereg",
  convertDicom: runDcm2niix,
  operations: {
    register: async ({ inputs, parameters, signal, progress }) => {
      await initialization;
      signal.throwIfAborted();
      if (!viewersReady) throw new Error("The image viewers are unavailable.");
      if (busy) throw new Error("Wait for the current operation to finish.");
      exampleControl.cancel();
      cancelled = false;
      setBusy(true);
      try {
        await loadSlot("moving", inputs.moving[0], false, signal);
        await loadSlot("stationary", inputs.fixed[0], false, signal);
        $("robustFov").checked = parameters.robustFov;
        const result = await register({ moving: inputs.moving[0], fixed: inputs.fixed[0], robustFov: parameters.robustFov, signal, progress });
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
