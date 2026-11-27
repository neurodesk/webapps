// InstanSeg in the browser: bounded 2D RGB brightfield histology in, calibrated 16/32-bit instance
// label TIFF and per-nucleus morphometry CSV out.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
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
import { createNiftiFromVolume, downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { DEFAULTS } from "@neurodesk/instanseg";
import { DEFAULT_MODEL_ID } from "@neurodesk/instanseg/models";
import { readBrightfieldImage, stemName, writeLabelsTiff } from "@neurodesk/instanseg/image-io";
import { nucleiCsv } from "@neurodesk/instanseg/results";
import { APP, displayLabels, labelColormap, normalizeSettings, outputName } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  controlsContract: { privacy: "#privacyBtn" },
});

let viewer;
let viewerReady;
let viewQueue = Promise.resolve();
let viewRevision = 0;
let display = "filled";
let overlayOpacity = 0.55;

const toolbar = createViewerToolbar({
  views: [
    { id: "filled", label: "Filled", active: true },
    { id: "outlines", label: "Outlines" },
    { id: "image", label: "Image" },
  ],
  viewsLabel: "Labels",
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
});
$("viewer").prepend(toolbar);
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;

const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let input = null; // { file, width, height, format, rgbChw, planes, pixelSize }
let outputs = {};
let lastLabels = null; // { data: Int32Array, count: number, width, height, pixelSize }
let job = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function refreshControls() {
  const busy = job !== null;
  exampleControl.setDisabled(busy);
  for (const id of ["imageInput", "pixelSize", "seedThreshold", "maskThreshold", "overlapThreshold", "tileSize", "backend", "resetSettings"]) {
    $(id).disabled = busy;
  }
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !input;
}

function begin(kind, message) {
  const controller = new AbortController();
  job = { kind, controller, worker: null };
  progress.begin(message);
  status(message);
  refreshControls();
  return job;
}

function end(current, message, { success = true, error = false, value } = {}) {
  if (job !== current) return false;
  current.worker?.terminate();
  job = null;
  progress.end(message, { success });
  status(message, error);
  refreshControls();
  if (current.completion) {
    if (success) current.completion.resolve(value);
    else current.completion.reject(current.controller.signal.aborted ? current.controller.signal.reason : new Error(message));
  }
  return true;
}

function spacingFor(image, pixelSize) {
  const um = pixelSize || image.pixelSize;
  const mm = um && um > 0 ? um * 1e-3 : 1;
  return [mm, mm, 1];
}

function niftiFile(image, data, name, spacing) {
  const { width, height } = image;
  const [sx, sy, sz] = spacing;
  const affine = [[sx, 0, 0, 0], [0, -sy, 0, (height - 1) * sy], [0, 0, sz, 0], [0, 0, 0, 1]];
  const buffer = createNiftiFromVolume({
    dims: [width, height, 1],
    img: data,
    hdr: { dims: [3, width, height, 1, 1, 1, 1, 1], pixDims: [1, sx, sy, sz, 1, 1, 1, 1], affine },
  });
  return new File([buffer], name, { type: "application/octet-stream" });
}

function rgbaNiftiFile(image, spacing) {
  const { width, height, planes } = image;
  const [sx, sy] = spacing;
  const count = width * height;
  const [r, g, b] = planes.map((item) => item.data);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    if (r[i] > peak) peak = r[i];
    if (g[i] > peak) peak = g[i];
    if (b[i] > peak) peak = b[i];
  }
  const scale = peak > 255 ? 255 / peak : peak > 0 && peak <= 1 ? 255 : 1;
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[4 * i] = Math.round(Math.max(0, r[i]) * scale);
    rgba[4 * i + 1] = Math.round(Math.max(0, g[i]) * scale);
    rgba[4 * i + 2] = Math.round(Math.max(0, b[i]) * scale);
    rgba[4 * i + 3] = 255;
  }
  const affine = [[sx, 0, 0, 0], [0, -sy, 0, (height - 1) * sy], [0, 0, 1, 0], [0, 0, 0, 1]];
  const template = createNiftiFromVolume({
    dims: [width, height, 1],
    img: new Uint8Array(count),
    hdr: { dims: [3, width, height, 1, 1, 1, 1, 1], pixDims: [1, sx, sy, 1, 1, 1, 1, 1], affine },
  });
  const out = new Uint8Array(352 + rgba.length);
  out.set(new Uint8Array(template, 0, 352));
  const view = new DataView(out.buffer);
  view.setInt16(70, 2304, true); // DT_RGBA32
  view.setInt16(72, 32, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setFloat32(116, 0, true);
  view.setFloat32(124, 0, true);
  view.setFloat32(128, 0, true);
  out.set(rgba, 352);
  return new File([out], "image.nii", { type: "application/octet-stream" });
}

async function ensureViewer() {
  viewerReady ??= (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false });
    await viewer.attachTo("gl1");
    viewer.sliceType = SLICE_TYPE.AXIAL;
    viewer.isLegendVisible = false;
    viewer.crosshairWidth = 0;
    viewer.isOrientationTextVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
    return viewer;
  })();
  return viewerReady;
}

function applyDisplay() {
  if (!viewer || viewer.volumes.length < 2) return Promise.resolve();
  return viewer.setVolume(1, {
    opacity: display === "image" ? 0 : overlayOpacity,
    atlasOutline: display === "outlines" ? 1 : 0,
  });
}

function show() {
  const revision = ++viewRevision;
  const snapInput = input;
  const snapLabels = lastLabels;
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision || !snapInput) return;
    const nv = await ensureViewer();
    const spacing = spacingFor(snapInput, snapLabels?.pixelSize);
    const layers = [{ url: rgbaNiftiFile(snapInput, spacing), name: "image.nii" }];
    if (snapLabels) {
      layers.push({
        url: niftiFile(snapInput, displayLabels(snapLabels.data), "labels.nii", spacing),
        name: "labels.nii",
        opacity: display === "image" ? 0 : overlayOpacity,
      });
    }
    await nv.loadVolumes(layers);
    if (snapLabels) {
      await nv.setColormapLabel(1, labelColormap(snapLabels.count));
      await applyDisplay();
    }
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `Visualization unavailable. ${error.message}. Downloads remain available.`;
    log.log(error.message, "error");
  });
  return viewQueue;
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  display = detail.value;
  viewQueue = viewQueue.then(() => applyDisplay()).catch((error) => log.log(error.message, "error"));
});
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  viewQueue = viewQueue.then(() => applyDisplay()).catch((error) => log.log(error.message, "error"));
});

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running") return;
    if (stage === "labels") {
      display = display === "image" ? "filled" : "image";
      toolbar.setActive(display);
      viewQueue = viewQueue.then(() => applyDisplay()).catch((error) => log.log(error.message, "error"));
    }
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

function clearOutputs() {
  lastLabels = null;
  outputs = {};
  results.render(outputs);
  $("outputSection").open = false;
}

async function load(chosen, signal) {
  if (job) throw new Error("Wait for the current operation to finish or cancel it, then retry.");
  const current = begin("loading", "Reading microscopy image…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (chosen.length !== 1) throw new Error("Choose one 2D RGB TIFF, OME-TIFF or PNG image.");
    const [file] = chosen;
    const buffer = await file.arrayBuffer();
    current.controller.signal.throwIfAborted();
    const parsed = await readBrightfieldImage(file.name, buffer);
    current.controller.signal.throwIfAborted();
    input = { file, ...parsed };
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    $("dropZone").classList.add("has-files");
    $("fileInfo").hidden = false;
    const calText = parsed.pixelSize ? ` · ${parsed.pixelSize.toFixed(3)} µm/px` : "";
    $("fileInfo").textContent = `${file.name} · ${parsed.width} × ${parsed.height} · ${parsed.format}${calText}`;
    $("pixelSize").placeholder = parsed.pixelSize ? `Metadata (${parsed.pixelSize.toFixed(3)} µm)` : "Auto (0.50 µm)";
    $("emptyState").hidden = true;
    clearOutputs();
    end(current, `${file.name} loaded`);
    await show();
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Loading cancelled" : error.message, { success: false, error: !cancelled });
    if (signal) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function importFiles(filesPromise) {
  if (job) {
    log.log("Wait for the current operation to finish or cancel it before loading another image.", "warn");
    return Promise.resolve();
  }
  exampleControl.cancel();
  return Promise.resolve(filesPromise)
    .then((chosen) => load(Array.from(chosen)))
    .catch((error) => status(error.message, true));
}

$("imageInput").addEventListener("change", (event) => {
  const chosen = Array.from(event.target.files);
  event.target.value = "";
  if (chosen.length) void importFiles(chosen);
});
bindFileDrop($("dropZone"), importFiles);

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    await load(fetched, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("resetSettings").addEventListener("click", () => {
  $("pixelSize").value = "";
  $("seedThreshold").value = String(DEFAULTS.seedThreshold);
  $("maskThreshold").value = String(DEFAULTS.maskThreshold);
  $("overlapThreshold").value = String(DEFAULTS.overlapThreshold);
  $("tileSize").value = String(DEFAULTS.tileSize);
  $("backend").value = "auto";
});

function readFormSettings() {
  return normalizeSettings(
    {
      pixelSize: $("pixelSize").value.trim(),
      seedThreshold: $("seedThreshold").value,
      maskThreshold: $("maskThreshold").value,
      overlapThreshold: $("overlapThreshold").value,
      tileSize: $("tileSize").value,
      backend: $("backend").value,
    },
    input?.pixelSize ?? null,
  );
}

async function segment(onProgress = () => {}) {
  if (!input || job) throw new Error("Load a 2D RGB brightfield image and wait for the current step to finish.");
  const settings = readFormSettings();
  clearOutputs();
  const current = begin("running", "Starting InstanSeg segmentation…");
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});
  const snapInput = input;
  const stem = stemName(snapInput.file.name);
  log.log(`InstanSeg ${DEFAULT_MODEL_ID} on ${snapInput.file.name} (${snapInput.width} × ${snapInput.height})`);
  current.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  current.worker.onmessage = ({ data }) => {
    if (job !== current) return;
    if (data.type === "progress") {
      progress.setProgress(data.value, data.message);
      onProgress({ message: data.message, value: data.value });
    } else if (data.type === "log") {
      log.log(data.message);
    } else if (data.type === "error") {
      end(current, data.message, { success: false, error: true });
    } else if (data.type === "result") {
      void finish(current, data, stem, settings).catch((error) => end(current, error.message, { success: false, error: true }));
    }
  };
  current.worker.onerror = (event) => {
    event.preventDefault?.();
    end(current, event.message || "The InstanSeg worker failed. Reload the page and try again.", { success: false, error: true });
  };
  current.worker.onmessageerror = () => {
    end(current, "The InstanSeg worker returned an unreadable message.", { success: false, error: true });
  };
  // Send a copy of rgbChw so the page retains input.rgbChw for re-runs with different thresholds.
  const copy = snapInput.rgbChw.slice();
  current.worker.postMessage(
    {
      rgbChw: copy,
      width: snapInput.width,
      height: snapInput.height,
      modelId: DEFAULT_MODEL_ID,
      settings,
    },
    [copy.buffer],
  );
  return current.completion.promise;
}

async function finish(current, data, stem, settings) {
  const tiffBytes = writeLabelsTiff(data.labels, data.width, data.height, settings.pixelSize);
  const labelFile = new File([tiffBytes], outputName(stem, "labels.tif"), { type: "image/tiff" });
  const csvText = nucleiCsv(data.nuclei);
  const tableFile = new File([csvText], outputName(stem, "nuclei.csv"), { type: "text/csv" });
  if (job !== current) return;

  lastLabels = {
    data: data.labels,
    count: data.nuclei.length,
    width: data.width,
    height: data.height,
    pixelSize: settings.pixelSize,
  };
  outputs = {
    labels: { description: `Nuclei labels (${data.nuclei.length})`, file: labelFile },
    table: { description: "Nuclei morphometry (CSV)", file: tableFile, viewable: false },
  };
  results.render(outputs);
  $("outputSection").open = true;
  if (display === "image") {
    display = "filled";
    toolbar.setActive("filled");
  }
  log.log(`Detected ${data.nuclei.length} nuclei in ${data.provenance.seconds} s (${data.provenance.backend}, ${data.provenance.tiles} ${data.provenance.tiles === 1 ? "tile" : "tiles"})`);
  log.log(`Run: ${JSON.stringify(data.provenance)}`);

  const areas = data.nuclei.map((n) => n.areaUm2 ?? n.areaPx);
  const medianArea = areas.length ? [...areas].sort((a, b) => a - b)[Math.floor(areas.length / 2)] : 0;
  const areaUnit = settings.pixelSize ? `${medianArea.toFixed(1)} µm²` : `${Math.round(medianArea)} px`;
  const summary = data.nuclei.length
    ? `Segmented ${data.nuclei.length} ${data.nuclei.length === 1 ? "nucleus" : "nuclei"} · median area ${areaUnit}`
    : "Segmentation complete · 0 nuclei detected";

  end(current, summary, {
    value: {
      artifacts: [
        { role: "labels", file: labelFile },
        { role: "table", file: tableFile },
      ],
      measurements: {
        nucleiCount: data.nuclei.length,
        medianAreaPx: data.nuclei.length ? [...data.nuclei].sort((a, b) => a.areaPx - b.areaPx)[Math.floor(data.nuclei.length / 2)].areaPx : 0,
        pixelSizeUm: settings.pixelSize,
      },
      provenance: data.provenance,
    },
  });
  await show();
}

$("runButton").addEventListener("click", () => {
  void segment().catch((error) => {
    if (error.name !== "AbortError") status(error.message, true);
  });
});

function cancel() {
  exampleControl.cancel();
  if (!job) return;
  const current = job;
  current.controller.abort();
  end(current, current.kind === "running" ? "Segmentation cancelled" : "Loading cancelled", { success: false });
}
$("cancelButton").onclick = cancel;

registerAppAutomation({
  app: APP.id,
  operations: {
    segment: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      const chosen = inputs.image ?? [];
      await load(chosen, signal);
      signal.throwIfAborted();
      const normalized = normalizeSettings(parameters, input?.pixelSize ?? null);
      $("pixelSize").value = parameters.pixelSize != null && parameters.pixelSize !== "" ? String(normalized.pixelSize) : "";
      $("seedThreshold").value = String(normalized.seedThreshold);
      $("maskThreshold").value = String(normalized.maskThreshold);
      $("overlapThreshold").value = String(normalized.overlapThreshold);
      $("tileSize").value = String(normalized.tileSize);
      $("backend").value = normalized.backend;
      return runAbortable(signal, () => segment(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
