import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { StageResultList, bindFileDrop, createInfoDialog, renderCommand, renderConsole, renderViewerToolbar } from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles } from "@neurodesk/runtime-support/dcm2niix-client";
import { MOVING_EXAMPLES, STATIONARY_EXAMPLES } from "./config.js";
import { extractBrain } from "./brain-extraction.js";

const $ = (id) => document.getElementById(id);
const slots = {
  moving: { file: null, files: [], brainExtracted: false, input: $("movingInput"), select: $("movingExample"), info: $("movingInfo"), drop: $("movingDropZone"), series: $("movingSeries"), seriesField: $("movingSeriesField") },
  stationary: { file: null, files: [], brainExtracted: false, input: $("stationaryInput"), select: $("stationaryExample"), info: $("stationaryInfo"), drop: $("stationaryDropZone"), series: $("stationarySeries"), seriesField: $("stationarySeriesField") },
};
const viewers = {
  moving: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  stationary: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  resliced: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let output = null;
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
  title: "Greedy",
  subtitle: "Browser-native affine and deformable MRI registration",
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
  for (const slot of Object.values(slots)) {
    slot.input.disabled = disabled;
    slot.select.disabled = disabled;
    slot.series.disabled = disabled;
  }
  $("method").disabled = disabled;
  $("extractButton").disabled = disabled || !slots.moving.file || slots.moving.brainExtracted;
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

async function loadSlot(name, file, brainExtracted = false) {
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
  $("emptyState").hidden = true;
  slot.file = file;
  slot.brainExtracted = brainExtracted;
  slot.info.hidden = false;
  slot.info.textContent = `${file.name}${brainExtracted ? " · brain extracted" : " · brain extraction required"}`;
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
  await runTask(`Reading ${name} image · converting DICOM if needed…`, async () => {
    const images = await readImageFiles(await filesPromise);
    if (!images.length) throw new Error("Choose NIfTI files or a complete DICOM series.");
    const slot = slots[name];
    slot.files = images;
    slot.series.replaceChildren(...images.map((file, index) => new Option(file.name, String(index))));
    slot.seriesField.hidden = images.length < 2;
    slot.select.value = "";
    await loadSlot(name, images[0]);
    status(`${images[0].name} loaded. It will be brain extracted before registration.`);
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

async function fetchExample(item) {
  const response = await fetch(item.url);
  if (!response.ok) throw new Error(`Example download failed (${response.status}).`);
  return new File([await response.blob()], item.filename);
}

function addExamples(name, examples) {
  const select = slots[name].select;
  for (const item of examples) select.add(new Option(item.label, item.url));
  select.value = examples[0].url;
  select.onchange = () => {
    const item = examples.find((candidate) => candidate.url === select.value);
    if (!item) return;
    const previous = examples.find((candidate) => candidate.filename === slots[name].file?.name)?.url ?? "";
    void runTask(`Downloading ${item.label}…`, async () => {
      let file;
      try {
        file = await fetchExample(item);
      } catch (error) {
        select.value = previous;
        throw error;
      }
      await loadSlot(name, file, item.brainExtracted);
    });
  };
}

addExamples("moving", MOVING_EXAMPLES);
addExamples("stationary", STATIONARY_EXAMPLES);

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

const results = new StageResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: () => downloadFile(output),
});

function runRegistration(fixed, moving, mode, onProgress) {
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
      reject(new Error(event.error instanceof Error ? event.error.message : event.message || "Greedy worker failed to start."));
    };
    worker.onmessageerror = () => {
      if (closed) return;
      close();
      reject(new Error("Greedy worker could not exchange registration data."));
    };
    cancelRegistration = () => {
      close();
      reject(new Error("Cancelled"));
    };
    $("cancelButton").hidden = false;
    Promise.all([fixed.arrayBuffer(), moving.arrayBuffer()]).then(([fixedBytes, movingBytes]) => {
      if (closed) return;
      worker.postMessage({ fixed: fixedBytes, moving: movingBytes, mode }, [fixedBytes, movingBytes]);
    }).catch((error) => {
      if (closed) return;
      close();
      reject(error);
    });
  });
}

async function register() {
  if (!slots.moving.file || !slots.stationary.file) return;
  for (const name of ["moving", "stationary"]) {
    if (!slots[name].brainExtracted) await brainExtract(name);
  }
  const fixed = slots.stationary.file;
  const moving = slots.moving.file;
  const started = performance.now();
  let phase = "Starting Greedy registration";
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    $("statusText").textContent = phase;
  }, 1000);
  $("progress").removeAttribute("value");
  try {
    const data = await runRegistration(fixed, moving, $("method").value, (next) => {
      phase = next;
      status(next);
    });
    output = new File([data.image], `${moving.name.replace(/\.nii(\.gz)?$/i, "")}_registered.nii.gz`);
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    results.render({ registered: { description: "Registered moving image" } });
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

$("extractButton").onclick = () => void runTask("Starting brain extraction…", () => brainExtract("moving"));
$("runButton").onclick = () => void runTask("Starting registration…", async () => {
  await clearOutput();
  await register();
});
$("method").onchange = () => void runTask("Changing registration method…", clearOutput);
$("cancelButton").onclick = () => {
  status("Cancelling registration…");
  cancelRegistration?.();
};

async function init() {
  if (!navigator.gpu) {
    setBusy(false);
    status("WebGPU is unavailable. Greedy needs a recent desktop browser for visualization and brain extraction.", true);
    return;
  }
  await runTask("Loading default moving and stationary images…", async () => {
    try {
      await attachViewers();
    } catch (error) {
      destroyViewers();
      $("viewerError").hidden = false;
      $("viewerError").textContent = `Visualization unavailable: ${errorMessage(error)}`;
      throw error;
    }
    const [moving, stationary] = await Promise.all([
      fetchExample(MOVING_EXAMPLES[0]),
      fetchExample(STATIONARY_EXAMPLES[0]),
    ]);
    await loadSlot("moving", moving, true);
    await loadSlot("stationary", stationary, true);
    await register();
  });
}

window.addEventListener("pagehide", () => {
  clearInterval(timer);
  registrationWorker?.terminate();
  destroyViewers();
});

void init();

export default Object.freeze({ toolbar, log, info, results });
