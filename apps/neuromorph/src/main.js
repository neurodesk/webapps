// NeuroMorph: SWC checks, a tube view coloured by neurite type, and NeuroM-defined
// morphometrics with Sholl analysis. The science lives in ./morph; this file is the UI.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindFileDrop,
  bindInfoTooltips,
  LabelLegend,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { writeMz3 } from "@neurodesk/webapp-components/file-io/mesh";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { APP } from "./config.js";
import { writeSwc } from "./morph/swc.js";
import { extent } from "./morph/morphometrics.js";
import { morphologyMesh, TYPE_COLORS, TYPE_LABELS } from "./morph/tubes.js";
import { bifurcationsCsv, morphometricsCsv, shollCsv, summary } from "./morph/outputs.js";
import { renderMorphometricsReport, renderShollReport } from "./report.js";
import { repairedName, stem } from "./names.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const isSwc = (file) => /\.swc$/i.test(file.name);
const basename = (path) => path.slice(path.lastIndexOf("/") + 1);
/** A file's path within a dropped or chosen folder, else its name. */
const relativePath = (file) => file.webkitRelativePath || file._webkitRelativePath || file.name;

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Neuron morphology from SWC reconstructions",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: "render", label: "3D", active: true, onClick: () => showView("render") },
    { id: "morphometrics", label: "Morphometrics", hidden: true, onClick: () => showView("morphometrics") },
    { id: "sholl", label: "Sholl", hidden: true, onClick: () => showView("sholl") },
  ],
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);
const legend = new LabelLegend({ element: $("legend") });

const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = SLICE_TYPE.RENDER;
    viewer.isOrientCubeVisible = false;
    viewer.is3DCrosshairVisible = false;
    viewer.isColorbarVisible = false;
    // Looking down the z axis with y up: NeuroMorpho.Org's standardized files put the
    // principal axis (the apical dendrite of a pyramidal cell) along y.
    viewer.azimuth = 180;
    viewer.elevation = 90;
    // NiiVue frames a mesh by its bounding sphere; zoom out so a long neuron is not clipped.
    viewer.scaleMultiplier = 0.75;
  });
  return attached;
}

/**
 * The loaded reconstructions. `id` is the file's relative path, unique within the batch; it
 * names the neuron in the selector, the tables, the downloads and automation. Each keeps its
 * text so the repair option can be changed without reading the files again.
 * @type {{ id: string, text: string, samples: import("./morph/swc.js").Sample[], issues: import("./morph/swc.js").Issue[], header: string[], morphology: import("./morph/morphometrics.js").Morphology, analysis?: ReturnType<typeof import("./morph/morphometrics.js").analyse> }[]}
 */
let neurons = [];
let selected = 0;
let measured = false;
/** The files the last load could not read ({ id, error }), reported with the measurements. */
let lastSkipped = [];
/** The AbortController of the run in progress (reading or measuring), else null. */
let running = null;

/**
 * Run one job in its own module worker (src/worker.js), terminated when it ends or when
 * `signal` aborts, so cancelling stops even a single long reconstruction.
 */
function runWorker(job, signal, onProgress) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) return onProgress(data.progress);
      stop();
      if (data.error) reject(new Error(data.error));
      else resolve(data.results);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stop();
      reject(new Error(event.message || "The NeuroMorph worker failed."));
    };
    worker.postMessage(job);
  });
}

/** Hold the app busy for `work(signal)`, cancellable from the footer × and from `signal`. */
async function exclusive(message, signal, work) {
  if (running) throw new Error("NeuroMorph is busy. Wait or cancel, then retry.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  progress.begin(message);
  try {
    return await work(controller.signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    running = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

/** Read `entries` ({ id, text }) in a worker; returns the neurons and the per-file errors. */
async function readEntries(entries, signal) {
  const results = await runWorker(
    { op: "read", items: entries, repair: $("repair").checked },
    signal,
    (fraction) => progress.setProgress(fraction, "Reading reconstructions…"),
  );
  const loaded = [];
  const failed = [];
  results.forEach((result, k) => {
    if (result.error) failed.push({ id: entries[k].id, error: result.error });
    else loaded.push({ ...entries[k], ...result });
  });
  return { loaded, failed };
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => showView(stage === "sholl" ? "sholl" : "morphometrics"),
  onDownload: (_stage, result) => downloadFile(result.file),
});

function viewTabs(visible) {
  for (const id of ["morphometrics", "sholl"]) {
    const tab = toolbar.viewTabs.querySelector(`[data-view="${id}"]`);
    if (tab) tab.hidden = !visible;
  }
}

function showView(id) {
  const neuron = neurons[selected];
  const report = id !== "render" && measured && neuron?.analysis;
  $("morphometricsReport").hidden = !(report && id === "morphometrics");
  $("shollReport").hidden = !(report && id === "sholl");
  if (report && id === "morphometrics") renderMorphometricsReport($("morphometricsReport"), neuron);
  if (report && id === "sholl") renderShollReport($("shollReport"), neuron);
  toolbar.setActive(report ? id : "render");
}

function clearResults() {
  measured = false;
  for (const neuron of neurons) delete neuron.analysis;
  results.render();
  $("outputSection").open = false;
  viewTabs(false);
  showView("render");
}

function renderChecks() {
  const neuron = neurons[selected];
  const messages = (neuron?.issues ?? []).filter((issue) => issue.severity !== "info");
  $("checks").replaceChildren(...messages.slice(0, 4).map((issue) => Object.assign(document.createElement("p"), {
    className: "nd-message warning",
    textContent: `${issue.repaired ? "Repaired: " : ""}${issue.message}`,
  })));
}

function boundsCentre(vertices) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < vertices.length; k++) {
    low[k % 3] = Math.min(low[k % 3], vertices[k]);
    high[k % 3] = Math.max(high[k % 3], vertices[k]);
  }
  return low.map((value, axis) => (value + high[axis]) / 2);
}

let showing = Promise.resolve();
/** Draw one neuron as tubes coloured by type. */
function showNeuron(index) {
  selected = index;
  renderChecks();
  showing = showing.catch(() => {}).then(async () => {
    const neuron = neurons[index];
    if (!neuron) return;
    await viewerReady();
    const mesh = morphologyMesh(neuron.morphology, 2 * extent(neuron.morphology));
    await viewer.loadMeshes([{ url: new File([writeMz3(mesh.vertices, mesh.faces, mesh.colors)], `${stem(basename(neuron.id))}.mz3`), name: neuron.id }]);
    // Orbit about the middle of the neuron rather than the origin, which is usually the soma.
    viewer.renderPivotMM = boundsCentre(mesh.vertices);
    $("emptyState").hidden = true;
    legend.render(mesh.types.map((type, k) => ({ index: k, name: TYPE_LABELS[type], color: TYPE_COLORS[type] })));
    $("legendSection").open = true;
    const all = neuron.morphology.neurites;
    $("viewLabel").textContent = `${neuron.id} · ${neuron.samples.length} samples · ${all.length} neurite${all.length === 1 ? "" : "s"}`;
    log.log(`Displayed ${neuron.id}: ${mesh.vertices.length / 3} vertices`);
    showView(toolbar.querySelector(".nd-view-tab.active")?.dataset.view ?? "render");
  });
  return showing;
}

function setBusy(busy) {
  $("swcInput").disabled = busy;
  $("runButton").disabled = busy || !neurons.length;
  $("shollStep").disabled = busy;
  $("repair").disabled = busy;
  $("neuronSelect").disabled = busy;
  exampleControl.setDisabled(busy);
}

/** Neurons for the loaded files and the skipped files, shown in the input and the log. */
async function adopt(loaded, failed, others) {
  neurons = loaded;
  clearResults();
  const select = $("neuronSelect");
  select.replaceChildren(...neurons.map((neuron, k) => new Option(neuron.id, String(k))));
  $("neuronField").hidden = neurons.length < 2;
  const notes = [
    others ? ` · ${others} other file${others === 1 ? "" : "s"} skipped` : "",
    failed.length ? ` · ${failed.length} unreadable file${failed.length === 1 ? "" : "s"} skipped` : "",
  ];
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = `${neurons.length === 1 ? neurons[0].id : `${neurons.length} reconstructions`}${notes.join("")}`;
  $("dropZone").classList.add("has-files");
  for (const { error } of failed) log.log(`Skipped ${error}`, "error");
  for (const neuron of neurons) {
    log.log(`${neuron.id}: ${neuron.samples.length} samples, ${neuron.morphology.neurites.length} neurites`);
    for (const issue of neuron.issues) log.log(`${neuron.id}: ${issue.message}${issue.lines.length ? ` (lines ${issue.lines.slice(0, 10).join(", ")})` : ""}`, issue.severity === "info" ? "info" : "warn");
  }
  await showNeuron(0);
  progress.reset();
  const message = `${neurons.length === 1 ? neurons[0].id : `${neurons.length} reconstructions`} loaded`;
  status(failed.length ? `${message}; skipped ${failed.map(({ error }) => error).join(" ")}` : message, failed.length > 0);
}

/** Read the files; ids are their relative paths, made unique if two files share one. */
async function loadFiles(filesPromise, signal) {
  return exclusive("Reading reconstructions…", signal, async (aborted) => {
    const files = await filesPromise;
    const swc = files.filter(isSwc).sort((a, b) => relativePath(a).localeCompare(relativePath(b)));
    if (!swc.length) throw new Error("Choose one or more .swc reconstructions.");
    const ids = new Set();
    const entries = [];
    const unread = [];
    for (const file of swc) {
      let id = relativePath(file);
      for (let n = 2; ids.has(id); n++) id = `${relativePath(file)} (${n})`;
      ids.add(id);
      try {
        entries.push({ id, text: await file.text() });
      } catch (error) {
        unread.push({ id, error: `${id}: ${error.message}` });
      }
      aborted.throwIfAborted();
    }
    const read = entries.length ? await readEntries(entries, aborted) : { loaded: [], failed: [] };
    const loaded = read.loaded;
    const failed = [...unread, ...read.failed];
    if (!loaded.length) throw new Error(failed.map(({ error }) => error).join(" "));
    lastSkipped = failed;
    await adopt(loaded, failed, files.length - swc.length);
  });
}

function report(error) {
  if (error?.name === "AbortError") return status("Cancelled");
  status(error.message, true);
  progress.end(error.message, { success: false });
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("swcInput").addEventListener("change", (event) => {
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

$("neuronSelect").addEventListener("change", () => void showNeuron(Number($("neuronSelect").value)).catch(report));
$("shollStep").addEventListener("input", () => {
  if (measured) clearResults();
});
$("repair").addEventListener("change", () => {
  if (!neurons.length) return;
  const entries = neurons.map(({ id, text }) => ({ id, text }));
  void exclusive("Reading reconstructions…", undefined, async (aborted) => {
    const { loaded, failed } = await readEntries(entries, aborted);
    if (failed.length) throw new Error(failed.map(({ error }) => error).join(" "));
    neurons = loaded;
    clearResults();
    await showNeuron(Math.min(selected, neurons.length - 1));
    progress.reset();
    status(`Reconstructions read ${$("repair").checked ? "with" : "without"} repair`);
  }).catch((error) => {
    $("repair").checked = !$("repair").checked;
    report(error);
  });
});

function shollStep() {
  const step = Number($("shollStep").value);
  if (!(step > 0)) {
    $("taskSection").open = true;
    $("shollStep").reportValidity();
    throw new Error("The Sholl step must be a positive number of µm.");
  }
  return step;
}

function outputName(kind) {
  return `${neurons.length === 1 ? stem(basename(neurons[0].id)) : "neuromorph"}_${kind}.csv`;
}

/** Measure every loaded neuron in a worker, terminated on cancel. */
async function measureAll(signal, step = shollStep()) {
  if (!neurons.length || running) throw new Error("Load SWC reconstructions before measuring them.");
  return exclusive("Measuring…", signal, async (aborted) => {
    const analyses = await runWorker(
      { op: "measure", items: neurons.map(({ id, morphology, repair }) => ({ id, morphology, repair })), step },
      aborted,
      (fraction) => progress.setProgress(fraction, "Measuring…"),
    );
    aborted.throwIfAborted();
    neurons.forEach((neuron, k) => {
      neuron.analysis = analyses[k];
    });
    const measuredNeurons = neurons.map(({ id, analysis }) => ({ name: id, analysis }));
    const files = {
      morphometrics: new File([morphometricsCsv(measuredNeurons)], outputName("morphometrics"), { type: "text/csv" }),
      sholl: new File([shollCsv(measuredNeurons)], outputName("sholl"), { type: "text/csv" }),
      bifurcations: new File([bifurcationsCsv(measuredNeurons)], outputName("bifurcations"), { type: "text/csv" }),
    };
    const rows = {
      morphometrics: { description: "Morphometrics table", file: files.morphometrics },
      sholl: { description: `Sholl intersections · ${step} µm step`, file: files.sholl },
      bifurcations: { description: "Bifurcation angles", file: files.bifurcations, viewable: false },
    };
    const repaired = [];
    const taken = new Set();
    for (const neuron of neurons) {
      if (!neuron.issues.some((issue) => issue.repaired)) continue;
      // The original comments first: NeuroMorpho.Org's carry the CC BY attribution.
      const header = [...neuron.header, `Repaired by NeuroMorph ${APP.version} from ${neuron.id}`];
      const file = new File([writeSwc(neuron.samples, header)], repairedName(neuron.id, taken), { type: "text/plain" });
      rows[`repaired-${repaired.length}`] = { description: `Repaired SWC · ${neuron.id}`, file, viewable: false };
      repaired.push(file);
    }
    measured = true;
    results.render(rows);
    $("outputSection").open = true;
    viewTabs(true);
    showView("morphometrics");
    for (const neuron of neurons) log.log(`${neuron.id}: ${JSON.stringify(summary(neuron.analysis))}`);
    const message = `${neurons.length === 1 ? neurons[0].id : `${neurons.length} reconstructions`} measured`;
    progress.end(message);
    status(message);
    return {
      artifacts: [
        { role: "morphometrics", file: files.morphometrics },
        { role: "sholl", file: files.sholl },
        { role: "bifurcations", file: files.bifurcations },
        ...repaired.map((file) => ({ role: "repaired", file })),
      ],
      provenance: {
        method: "NeuroM 4 morphometrics",
        app: APP.id,
        version: APP.version,
        shollStepUm: step,
        repair: $("repair").checked,
        ...(lastSkipped.length && { skipped: Object.fromEntries(lastSkipped.map(({ id, error }) => [id, error])) }),
      },
      measurements: Object.fromEntries(neurons.map((neuron) => [neuron.id, summary(neuron.analysis)])),
    };
  });
}

$("runButton").addEventListener("click", () => {
  void measureAll().catch((error) => {
    if (error.name === "AbortError") {
      clearResults();
      progress.reset("Measurement cancelled");
      return status("Measurement cancelled");
    }
    report(error);
  });
});
$("cancelButton").onclick = () => {
  exampleControl.cancel();
  running?.abort();
};

registerAppAutomation({
  app: APP.id,
  operations: {
    measure: async ({ inputs, parameters, signal }) => {
      if (parameters.repair !== undefined) $("repair").checked = Boolean(parameters.repair);
      if (parameters.shollStep !== undefined) $("shollStep").value = String(parameters.shollStep);
      await loadFiles(Promise.resolve(inputs.reconstructions), signal);
      return measureAll(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
