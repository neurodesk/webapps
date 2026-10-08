// Canonical Neurodesk webapp entry. The interface is assembled entirely from
// the shared workspace vocabulary; only the scientific logic is app-owned.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
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
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { APP } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

// 1. Shell: shared app bar, sidebar, viewer and status regions.
const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.id,
  subtitle: "Browser-native Neurodesk webapp",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// 2. Viewer chrome: layout tabs above the canvas, technical log below it.
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
// Status footer: message, progress, elapsed time and the × that shows only while cancellable.
const progress = new ProgressManager();
bindInfoTooltips(document);

// 3. Information dialog: About and Privacy open from the shared app bar; Cite comes from the registry.
const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.id}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// 4. Workflow: input → run → results. Replace the bodies with the science.
const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => status(`${result.file.name} · unchanged input copy`),
  onDownload: (_stage, result) => downloadFile(result.file),
});
let source = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

let loading = null;
async function loadFiles(filesPromise, signal) {
  if (loading) throw new Error("An image is still loading. Wait or cancel, then retry.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  $("imageInput").disabled = true;
  exampleControl.setDisabled(true);
  $("runButton").disabled = true;
  progress.begin("Loading image…");
  status("Loading image…");
  try {
    const files = await filesPromise;
    controller.signal.throwIfAborted();
    if (files.length !== 1 || !files[0].size) throw new Error("Choose one nonempty image for the pass-through demonstration.");
    await files[0].arrayBuffer();
    controller.signal.throwIfAborted();
    source = files[0];
    results.render();
    $("outputSection").open = false;
    progress.setProgress(0);
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = source.name;
    $("dropZone").classList.add("has-files");
    $("emptyState").hidden = true;
    status(`${source.name} loaded`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    $("imageInput").disabled = false;
    exampleControl.setDisabled(false);
    $("runButton").disabled = !source;
    progress.stopTimer();
    progress.setCancellable(false);
  }
}
function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(error => status(
    error.name === "AbortError" ? "Loading cancelled" : error.message,
    error.name !== "AbortError",
  ));
}
$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
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

function copyInput(signal) {
  signal?.throwIfAborted();
  if (!source || loading) throw new Error("Load an image before copying it.");
  // Replace this explicit pass-through demonstration with the app's method.
  results.render({ output: { description: "Unchanged input copy", file: source } });
  $("outputSection").open = true;
  progress.end("Input copy ready");
  status("Input copy ready · no scientific processing applied");
  return {
    artifacts: [{ role: "output", file: source }],
    provenance: { method: "unchanged-input-copy", scientificProcessing: false },
  };
}
$("runButton").addEventListener("click", () => {
  if (source && !loading) copyInput();
});
registerAppAutomation({
  app: APP.id,
  operations: {
    "copy-input": async ({ inputs, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      return copyInput(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
