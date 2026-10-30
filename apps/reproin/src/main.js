// ReproIn DICOM → BIDS: dcm2niix (WASM worker) then the reproin-rs post-pass, all on-device.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { MULTIPLANAR_TYPE, SLICE_TYPE } from "@niivue/niivue";
import { convertToBids, zip } from "@niivue/reproin";
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
import { APP, conversionOptions, resultRows, DATASET } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "ReproIn",
  subtitle: "ReproIn DICOM to BIDS, on-device",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
// Attached on the first View, so the empty canvas shows only the drop hint until then.
let attached;
let layout = "multiplanar";
const viewer = () => (attached ??= nv.attachTo("gl1").then(() => {
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID;
  nv.sliceType = layouts[layout];
}));
const layouts = { multiplanar: SLICE_TYPE.MULTIPLANAR, axial: SLICE_TYPE.AXIAL, coronal: SLICE_TYPE.CORONAL, sagittal: SLICE_TYPE.SAGITTAL };
const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [["multiplanar", "3-Plane"], ["axial", "Axial"], ["coronal", "Coronal"], ["sagittal", "Sagittal"]].map(([id, label], index) => ({
    id,
    label,
    active: index === 0,
    onClick: () => {
      layout = id;
      if (attached) nv.sliceType = layouts[id];
      toolbar.setActive(id);
    },
  })),
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About ReproIn", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: async (_path, result) => {
    await viewer();
    await nv.loadVolumes([{ url: result.file, name: result.file.name }]);
    $("emptyState").hidden = true;
    $("location").textContent = result.path;
  },
  onDownload: (_path, result) => downloadFile(result.file),
});

let dicom = [];
let running = null;

function setInputs(files) {
  dicom = files;
  running?.abort();
  results.render();
  $("outputSection").open = false;
  $("fileInfo").hidden = !files.length;
  $("fileInfo").textContent = `${files.length} DICOM file${files.length === 1 ? "" : "s"}`;
  $("dropZone").classList.toggle("has-files", files.length > 0);
  $("runButton").disabled = !files.length;
  progress.reset();
  status(`${files.length} files ready`);
}

function setBusy(busy) {
  for (const id of ["dicomInput", "runButton", "subject", "session", "anonymize", "shiftDates", "keepDerivatives"]) $(id).disabled = busy;
  exampleControl.setDisabled(busy);
  if (!busy) $("runButton").disabled = !dicom.length;
}

function formOptions() {
  return conversionOptions({
    subject: $("subject").value,
    session: $("session").value,
    anonymize: $("anonymize").checked,
    shiftDates: $("shiftDates").checked,
    keepDerivatives: $("keepDerivatives").checked,
  });
}

async function convertSession(files, options, signal) {
  if (!files.length) throw new Error("Choose a DICOM session first.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  results.render();
  progress.begin("Converting DICOM…");
  log.log(`dcm2niix ${files.length} files: ${JSON.stringify(options)}`);
  try {
    const out = await convertToBids(files, {
      ...options,
      signal: controller.signal,
      onLog: (line) => log.log(line),
      onProgress: (fraction) => progress.setProgress(fraction, "Applying BIDS post-pass…"),
    });
    for (const line of out.log ?? []) log.log(line);
    for (const failure of out.failures ?? []) log.log(JSON.stringify(failure), "warning");
    if (out.fatal) throw new Error(`Post-pass failed: ${typeof out.fatal === "string" ? out.fatal : JSON.stringify(out.fatal)}`);
    const dataset = new File([await zip(out.files, `${DATASET}/`)], `${DATASET}.zip`, { type: "application/zip" });
    const rows = resultRows(out.files, dataset);
    results.render(rows);
    $("outputSection").open = true;
    const warn = out.failures?.length ? ` · ${out.failures.length} series failed, see console` : "";
    progress.end(`BIDS dataset ready: ${out.files.size} files${warn}`);
    log.log(`BIDS dataset ready: ${out.files.size} files, ${out.ops.length} operations${warn}`);
    return { dataset, files: out.files };
  } catch (error) {
    const cancelled = controller.signal.aborted;
    progress.end(cancelled ? "Conversion cancelled" : error.message, { success: false });
    if (!cancelled) {
      $("statusText").classList.add("error");
      log.log(error.message, "error");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    running = null;
    setBusy(false);
  }
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  running?.abort();
};
$("dicomInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  exampleControl.cancel();
  if (files.length) setInputs(files);
});
bindFileDrop($("dropZone"), async (files) => {
  exampleControl.cancel();
  setInputs(Array.from(await files));
});
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    setInputs(files);
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  for (const id of ["subject", "session"]) {
    if (!$(id).checkValidity()) {
      $("optionsSection").open = true;
      $(id).reportValidity();
      return;
    }
  }
  convertSession(dicom, formOptions()).catch(() => {});
});

registerAppAutomation({
  app: APP.id,
  operations: {
    "convert-to-bids": async ({ inputs, parameters, signal }) => {
      const { dataset } = await convertSession(inputs.dicom, conversionOptions(parameters), signal);
      return {
        artifacts: [{ role: "dataset", file: dataset }],
        provenance: { method: "dcm2niix -f %H + reproin-rs post-pass", options: conversionOptions(parameters) },
      };
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
