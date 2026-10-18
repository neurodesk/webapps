// fastprep webapp: load one BIDS subject (folder or example), run the pipeline in a worker, view the HTML report
// and download the derivatives. The interface is the shared workspace vocabulary; the science is in the worker.
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
import { zipSync } from "fflate";
import { APP, datasetPaths, reportWithLinks } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const base = new URL(import.meta.env.BASE_URL, location.href).href;

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.id,
  subtitle: "fMRI preprocessing in your browser",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});
$("viewer").prepend(createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false }));
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);
const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.id}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let dataset = null; // [[relative path, File]]
let label = null; // the first subject's label, the one processed
let outputs = null; // [[relative path, Uint8Array]]
let active = null; // { worker, reject, cleanup } of the run in progress
let reportUrls = [];

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const zipFile = () => new File([zipSync(Object.fromEntries(outputs.map(([p, b]) => [`fastprep/${p}`, b])), { level: 1 })], "fastprep.zip");
const results = createResultList({
  element: $("resultList"),
  onView: () => showReport(),
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearReport() {
  reportUrls.forEach((u) => URL.revokeObjectURL(u));
  reportUrls = [];
  $("viewer").querySelector(".nd-viewer-canvas-wrapper iframe")?.remove();
}

function showReport() {
  const html = outputs.find(([p]) => /^sub-[^_/]+\.html$/.test(p)); // sub-<label>.html, not a task page
  if (!html) return;
  clearReport();
  const toUrl = (bytes, type) => {
    reportUrls.push(URL.createObjectURL(new Blob([bytes], { type })));
    return reportUrls.at(-1);
  };
  const frame = document.createElement("iframe");
  frame.title = "fastprep report";
  frame.src = toUrl(reportWithLinks(html[0], outputs, toUrl), "text/html");
  frame.style.cssText = "border:0;width:100%;height:100%;background:#fff";
  $("gl1").hidden = true;
  $("emptyState").hidden = true;
  $("viewer").querySelector(".nd-viewer-canvas-wrapper").append(frame);
}

function setDataset(files) {
  const paths = datasetPaths(files.map((f) => f.webkitRelativePath || f.name));
  const subjects = new Set(paths.map((p) => p.split("/")[0]).filter((s) => s.startsWith("sub-")));
  if (!subjects.size) throw new Error("No sub-* folders found. Choose the BIDS dataset folder.");
  if (active) fail("Cancelled", false);
  dataset = files.map((f, i) => [paths[i], f]);
  label = [...subjects][0].slice(4);
  outputs = null;
  clearReport();
  results.render();
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = `${files.length} files · ${[...subjects].join(", ")}`;
  $("dropZone").classList.add("has-files");
  $("emptyState").hidden = true;
  $("runButton").disabled = false;
  status(subjects.size > 1 ? "Several subjects: only the first is processed here." : "Dataset loaded");
  $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function finish(message, success = false) {
  active.cleanup();
  active.worker.terminate();
  active = null;
  progress.end(message, { success });
  $("runButton").disabled = !dataset;
}

function fail(message, error = true) {
  const { reject } = active;
  finish(message);
  status(message, error);
  reject(new Error(message));
}

function run(signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (!dataset) return reject(new Error("Load a BIDS dataset first."));
    if (active) return reject(new Error("fastprep is already running."));
    $("runButton").disabled = true;
    progress.begin("Preprocessing…");
    const worker = new Worker(new URL("./pipeline-worker.js", import.meta.url), { type: "module" });
    const current = { worker, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
    const abort = () => {
      if (active === current) fail("Cancelled", false);
    };
    active = current;
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      if (active === current) fail(event.message || "The pipeline worker failed to start.");
    };
    worker.onmessage = ({ data }) => {
      if (active !== current) return;
      if (data.log) log.log(data.log, "info");
      if (data.step) $("statusText").textContent = `Running ${data.step}…`;
      if (data.error) return fail(data.error);
      if (data.done) {
        finish("fastprep finished", true);
        try {
          outputs = data.done;
          const zip = zipFile(); // one large allocation: can throw for big runs
          results.render({ report: { description: "Preprocessing report and derivatives (zip)", file: zip } });
          $("outputSection").open = true;
          status(`fastprep finished: ${outputs.length} files`);
          showReport();
          resolve(zip);
        } catch (error) {
          status(error.message, true);
          reject(error);
        }
      }
    };
    worker.postMessage({ base, dataset, options: { labels: [label], synthsr: $("synthsr").value } });
  });
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  if (active) fail("Cancelled", false);
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  try {
    if (files.length) setDataset(files);
  } catch (error) {
    status(error.message, true);
  }
});
bindFileDrop($("dropZone"), async (filesPromise) => {
  try {
    setDataset(await filesPromise);
  } catch (error) {
    status(error.message, true);
  }
});
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    setDataset(files);
  },
});
$("exampleControl").append(exampleControl);
$("runButton").addEventListener("click", () => run().catch(() => {}));

registerAppAutomation({
  app: APP.id,
  operations: {
    preprocess: async ({ inputs, signal }) => {
      signal?.throwIfAborted();
      setDataset(inputs.dataset);
      const zip = await run(signal);
      return { artifacts: [{ role: "results", file: zip }], provenance: { method: "fastprep", scientificProcessing: true } };
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  active?.worker.terminate();
  clearReport();
});

export default Object.freeze({ workspace, log, info, results });
