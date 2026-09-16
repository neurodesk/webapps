import examples from '../examples.json';
import { renderExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { StageResultList, bindFileDrop, createInfoDialog, renderCommand, renderConsole, renderViewerToolbar } from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles } from "@neurodesk/runtime-support/dcm2niix-client";
import { extractBrain } from "./brain-extraction.js";

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
let output = null;
let outputs = {};
let busy = false;
let viewersReady = false;
let viewersDestroyed = false;
let registrationWorker = null;
let cancelRegistration = null;
let timer;

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "ANTs",
  subtitle: "Browser-native SyN registration with ANTs",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn", standalone: "#standaloneBtn" },
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

const toolbar = renderViewerToolbar({
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
$("viewer").prepend(toolbar.root);
const log = renderConsole({ id: "technicalLog" });
$("viewer").append(log.root);
const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About ANTs", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));
$("standaloneBtn").onclick = () => {
  info.open("Run ANTs in a terminal", $("standaloneContent"));
  info.body.append(renderCommand({
    id: "antsStandaloneCommands",
    command: [
      "antsRegistration --dimensionality 3 --float 1 --random-seed 42 \\",
      "  -r [fixed.nii.gz,moving.nii.gz,1] \\",
      "  --metric mattes[fixed.nii.gz,moving.nii.gz,1,32,regular,0.2] --transform Affine[0.25] \\",
      "  --convergence 2100x1200x1200x0 --smoothing-sigmas 3x2x1x0 --shrink-factors 4x2x2x1 \\",
      "  --metric mattes[fixed.nii.gz,moving.nii.gz,1,32] --transform SyN[0.2,3,0] \\",
      "  --convergence [40x20x0,1e-7,8] --smoothing-sigmas 2x1x0 --shrink-factors 4x2x1 \\",
      "  -u 0 -z 1 --output [result-,registered.nii.gz]",
      "antsApplyTransforms -d 3 -i moving.nii.gz -r fixed.nii.gz -o registered.nii.gz \\",
      "  -t result-1Warp.nii.gz -t result-0GenericAffine.mat",
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
  outputs = {};
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

const exampleControl = renderExampleSelector({
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
$('inputSection').querySelector('.nd-section-content').prepend(exampleControl.root);


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

const RESULTS = {
  registered: { description: "Registered moving image" },
  affine: { description: "Affine transform (.mat)" },
  warp: { description: "Forward warp" },
  inverseWarp: { description: "Inverse warp" },
};
const results = new StageResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: (stage) => downloadFile(outputs[stage]),
});

function runRegistration(fixed, moving, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./registration-worker.js", import.meta.url), { type: "module" });
    registrationWorker = worker;
    let closed = false;
    const close = () => {
      closed = true;
      worker.terminate();
      if (registrationWorker === worker) {
        registrationWorker = null;
        cancelRegistration = null;
        $("cancelButton").hidden = true;
      }
    };
    worker.onmessage = ({ data }) => {
      if (closed) return;
      if (data.log) {
        log.log(data.log);
        return;
      }
      if (data.phase) {
        onProgress(data.phase);
        return;
      }
      close();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => {
      if (closed) return;
      close();
      reject(new Error(event.error instanceof Error ? event.error.message : event.message || "ANTs worker failed to start."));
    };
    worker.onmessageerror = () => {
      if (closed) return;
      close();
      reject(new Error("ANTs worker could not exchange registration data."));
    };
    cancelRegistration = () => {
      close();
      reject(new Error("Cancelled"));
    };
    $("cancelButton").hidden = false;
    Promise.all([fixed.arrayBuffer(), moving.arrayBuffer()]).then(([fixedBytes, movingBytes]) => {
      if (closed) return;
      worker.postMessage({ fixed: fixedBytes, moving: movingBytes }, [fixedBytes, movingBytes]);
    }).catch((error) => {
      if (closed) return;
      close();
      reject(error);
    });
  });
}

async function register() {
  if (!slots.moving.file || !slots.stationary.file) return;
  // Extraction is the user's call; a scalp-bearing input is only flagged, not forced.
  for (const name of ["moving", "stationary"]) {
    if (!slots[name].brainExtracted) log.log(`The ${name} image is not brain extracted; scalp can distort the registration.`);
  }
  const fixed = slots.stationary.file;
  const moving = slots.moving.file;
  const started = performance.now();
  let phase = "Starting ANTs registration";
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    $("statusText").textContent = phase;
  }, 1000);
  $("progress").removeAttribute("value");
  try {
    const data = await runRegistration(fixed, moving, (next) => {
      phase = next;
      status(next);
    });
    const stem = moving.name.replace(/\.nii(\.gz)?$/i, "");
    output = new File([data.image], `${stem}_registered.nii.gz`);
    outputs = {
      registered: output,
      affine: new File([data.transforms["0GenericAffine.mat"]], `${stem}_0GenericAffine.mat`),
      warp: new File([data.transforms["1Warp.nii.gz"]], `${stem}_1Warp.nii.gz`),
      inverseWarp: new File([data.transforms["1InverseWarp.nii.gz"]], `${stem}_1InverseWarp.nii.gz`),
    };
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    results.render(RESULTS);
    $("outputSection").open = true;
    $("progress").value = 1;
    status(`Registration complete in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    $("progress").value = 0;
    if (errorMessage(error) === "Cancelled") {
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
$("cancelButton").onclick = () => {
  status("Cancelling registration…");
  cancelRegistration?.();
};

async function init() {
  if (!navigator.gpu) {
    setBusy(false);
    status("WebGPU is unavailable. ANTs needs a recent desktop browser for visualization and brain extraction.", true);
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
  registrationWorker?.terminate();
  destroyViewers();
});

void init();

export default Object.freeze({ toolbar, log, info, results });
