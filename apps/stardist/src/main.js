// StarDist: 2D and 3D nucleus segmentation with the pretrained StarDist models
// (2D_versatile_fluo, 2D_versatile_he, 2D_paper_dsb2018, 3D_demo). The numerics live in
// src/stardist.js and src/stardist3d.js; src/worker.js runs them with ONNX Runtime Web.
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
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import workerUrl from "./worker.js?worker&url";
import { APP, MODEL_IDS, MODELS, resolveModel } from "./config.js";
import { interleaveRgb, nucleiCsv, nucleiCsv3D, readImage, writeLabelsTiff } from "./image-io.js";
import { automaticTiles } from "./stardist.js";
import { automaticTiles3D } from "./stardist3d.js";
import { labelColormap, outputName, segmentationSettings } from "./settings.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "2D and 3D nucleus segmentation",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
let display = "filled";
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = SLICE_TYPE.AXIAL;
    viewer.isLegendVisible = false;
    // A microscopy image has no patient axes: no orientation letters.
    viewer.crosshairWidth = 0;
    viewer.isOrientationTextVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
  });
  return attached;
}
const toolbar = createViewerToolbar({
  views: [
    { id: "filled", label: "Filled", active: true },
    { id: "outlines", label: "Outlines" },
    { id: "image", label: "Image" },
  ],
  viewsLabel: "Labels",
  window: false,
  colormap: false,
  download: false,
  screenshot: false,
});
$("viewer").prepend(toolbar);
const log = createConsole({
  id: "technicalLog",
  resizable: true,
  channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }],
});
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// Populate the model selector from the manifest so labels stay in sync.
$("model").replaceChildren(...MODEL_IDS.map((id) => new Option(MODELS[id].label, id)));

// The loaded image ({ file, width, height, depth, format, planes, isRgb, stack, is3dHint }),
// abort controllers of a load or run in progress, and the last run's outputs.
let input = null;
let loading = null;
let running = null;
let outputs = {};
let opacity = 0.5;

function currentModel() {
  return resolveModel($("model").value);
}

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function selectedChannelIndex() {
  return Number($("channel").value) || 0;
}

function plane() {
  return input.planes[Math.min(selectedChannelIndex(), input.planes.length - 1)];
}

function stackChannel() {
  const channels = input.stack.channels;
  return channels[Math.min(selectedChannelIndex(), channels.length - 1)];
}

function syncChannelControl() {
  const model = currentModel();
  if (!input) {
    $("channel").replaceChildren();
    $("channelField").hidden = true;
    return;
  }
  if (model.ndim === 3) {
    const channels = input.stack?.channels ?? [];
    $("channel").replaceChildren(...channels.map((item, index) => new Option(item.label, String(index))));
    $("channelField").hidden = channels.length < 2;
    return;
  }
  if (model.channels === 3) {
    $("channel").replaceChildren();
    $("channelField").hidden = true;
    return;
  }
  $("channel").replaceChildren(...input.planes.map((item, index) => new Option(item.label, String(index))));
  $("channelField").hidden = input.planes.length < 2;
}

function applyModelDefaults(model) {
  $("probThresh").value = String(model.thresholds.prob);
  $("nmsThresh").value = String(model.thresholds.nms);
}

// A 2D or 3D scalar image as NIfTI whose rows run down the screen, as in the source file.
function niftiFile(data, name, depth = 1) {
  const { width, height } = input;
  const affine = [[1, 0, 0, 0], [0, -1, 0, height - 1], [0, 0, 1, 0], [0, 0, 0, 1]];
  const buffer = createNiftiFromVolume({
    dims: [width, height, depth],
    img: data,
    hdr: { dims: [3, width, height, depth, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine },
  });
  return new File([buffer], name, { type: "application/octet-stream" });
}

// A 2D RGB image as RGBA32 NIfTI (datatype 2304, bitpix 32) so H&E histology displays in colour.
function rgbaNiftiFile(planes, name) {
  const { width, height } = input;
  const count = width * height;
  const [r, g, b] = planes.map((item) => item.data);
  let peak = 255;
  for (let i = 0; i < count; i++) {
    if (r[i] > peak) peak = r[i];
    if (g[i] > peak) peak = g[i];
    if (b[i] > peak) peak = b[i];
  }
  const scale = peak > 255 ? 255 / peak : 1;
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[4 * i] = Math.round(Math.max(0, r[i]) * scale);
    rgba[4 * i + 1] = Math.round(Math.max(0, g[i]) * scale);
    rgba[4 * i + 2] = Math.round(Math.max(0, b[i]) * scale);
    rgba[4 * i + 3] = 255;
  }
  const affine = [[1, 0, 0, 0], [0, -1, 0, height - 1], [0, 0, 1, 0], [0, 0, 0, 1]];
  const template = createNiftiFromVolume({
    dims: [width, height, 1],
    img: new Uint8Array(count),
    hdr: { dims: [3, width, height, 1, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine },
  });
  const out = new Uint8Array(352 + rgba.length);
  out.set(new Uint8Array(template, 0, 352));
  const view = new DataView(out.buffer);
  view.setInt16(70, 2304, true);
  view.setInt16(72, 32, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setFloat32(116, 0, true);
  view.setFloat32(124, 0, true);
  view.setFloat32(128, 0, true);
  out.set(rgba, 352);
  return new File([out], name, { type: "application/octet-stream" });
}

function applyDisplay() {
  if (viewer.volumes.length < 2) return Promise.resolve();
  return viewer.setVolume(1, { opacity: display === "image" ? 0 : opacity, atlasOutline: display === "outlines" ? 1 : 0 });
}

let shown = Promise.resolve();
function show(labels) {
  shown = shown.catch(() => {}).then(async () => {
    if (!input) return;
    await viewerReady();
    const model = currentModel();
    const is3d = model.ndim === 3 && Boolean(input.stack);
    viewer.sliceType = is3d ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.AXIAL;
    viewer.crosshairWidth = is3d ? 1 : 0;
    let baseVolume;
    if (is3d) {
      baseVolume = { url: niftiFile(Float32Array.from(stackChannel().data), "image.nii", input.stack.depth), name: "image.nii", colormap: "gray" };
    } else if (model.channels === 3 && input.planes.length >= 3) {
      baseVolume = { url: rgbaNiftiFile(input.planes.slice(0, 3), "image.nii"), name: "image.nii" };
    } else {
      baseVolume = { url: niftiFile(Float32Array.from(plane().data), "image.nii", 1), name: "image.nii", colormap: "gray" };
    }
    const volumes = [baseVolume];
    if (labels) {
      volumes.push({ url: niftiFile(labels.data, "labels.nii", labels.depth ?? 1), name: "labels.nii", opacity });
    }
    await viewer.loadVolumes(volumes);
    if (labels) {
      await viewer.setColormapLabel(1, labelColormap(labels.count));
      await applyDisplay();
    }
    $("emptyState").hidden = true;
  });
  return shown;
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  display = detail.value;
  void applyDisplay().catch(report);
});
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  opacity = detail.value;
  void applyDisplay().catch(report);
});

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (stage === "labels" && outputs.labels) void show(outputs.labels.view).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["imageInput", "channel", "model", "probThresh", "nmsThresh", "tiles", "resetSettings"]) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(true);
  progress.begin(message);
  status(message, false, "technical");
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

function selectModelForImage(image, preferredModel) {
  const current = $("model").value;
  let target = current;
  if (preferredModel) {
    // Preserve 2D_paper_dsb2018 when loading the 2D fluorescence example.
    if (!(preferredModel === "2D_versatile_fluo" && current === "2D_paper_dsb2018")) {
      target = preferredModel;
    }
  } else {
    const model = resolveModel(current);
    if (image.is3dHint && model.ndim !== 3) target = "3D_demo";
    else if (!image.stack && model.ndim === 3) target = image.isRgb ? "2D_versatile_he" : "2D_versatile_fluo";
    else if (model.channels === 3 && image.planes.length < 3) target = "2D_versatile_fluo";
  }
  if (target !== current) {
    $("model").value = target;
    applyModelDefaults(resolveModel(target));
  }
}

function formatFileInfo(file, image) {
  if (image.is3dHint && image.stack) {
    const ch = image.stack.channels.length > 1 ? ` · ${image.stack.channels.length} channels` : "";
    return `${file.name} · ${image.width} × ${image.height} × ${image.stack.depth} · ${image.format}${ch}`;
  }
  if (image.isRgb) return `${file.name} · ${image.width} × ${image.height} · ${image.format} · RGB`;
  return `${file.name} · ${image.width} × ${image.height} · ${image.format}${image.planes.length > 1 ? ` · ${image.planes.length} channels` : ""}`;
}

async function loadFiles(filesPromise, signal, { preferredModel } = {}) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    current.throwIfAborted();
    if (files.length !== 1) throw new Error(`Choose one 2D image or 3D TIFF stack; this selection has ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const image = await readImage(file.name, await file.arrayBuffer());
    current.throwIfAborted();
    input = { file, ...image };
    clearOutputs();
    selectModelForImage(image, preferredModel);
    syncChannelControl();
    await show(null);
    current.throwIfAborted();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = formatFileInfo(file, image);
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

function segmentInWorker(job, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    const stop = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The StarDist worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") progress.setProgress(data.value, data.message);
      else if (data.type === "log") log.log(data.message, "info", "technical");
      else {
        stop();
        if (data.type === "error") reject(new Error(data.message));
        else resolve(data);
      }
    };
    worker.postMessage(job);
  });
}

function formSettings() {
  const model = currentModel();
  return segmentationSettings({
    model: model.name,
    channel: Number($("channel").value || 0) + 1,
    probThresh: $("probThresh").valueAsNumber,
    nmsThresh: $("nmsThresh").valueAsNumber,
    tiles: Number($("tiles").value),
  }, model);
}

function showSettings(settings, model) {
  $("model").value = model.name;
  syncChannelControl();
  $("probThresh").value = String(settings.probThresh);
  $("nmsThresh").value = String(settings.nmsThresh);
  $("tiles").value = String(settings.tiles);
  if (input && model.channels === 1) {
    const count = model.ndim === 3 ? (input.stack?.channels.length ?? 0) : input.planes.length;
    if (count > 0 && settings.channel > count) {
      throw new Error(`${input.file.name} has ${count} channels; channel ${settings.channel} does not exist.`);
    }
    if (count > 0) $("channel").value = String(settings.channel - 1);
  }
}

function prepareInputForModel(model, settings) {
  if (model.ndim === 3) {
    if (!input.stack || input.stack.depth < 5) {
      throw new Error(`${model.name} requires a 3D multi-page TIFF stack (at least 5 slices); ${input.file.name} has ${input.depth}.`);
    }
    const source = input.stack.channels[settings.channel - 1];
    if (!source) {
      throw new Error(`${input.file.name} has ${input.stack.channels.length} channels; channel ${settings.channel} does not exist.`);
    }
    const nTiles = settings.tiles ? [settings.tiles, settings.tiles, settings.tiles] : automaticTiles3D(input.stack.depth, input.height, input.width);
    return {
      image: source.data,
      depth: input.stack.depth,
      channelLabel: source.label,
      nTiles,
    };
  }
  if (model.channels === 3) {
    if (input.planes.length < 3) {
      throw new Error(`${model.name} requires a 3-channel RGB image; ${input.file.name} has ${input.planes.length} channel.`);
    }
    const rgb = interleaveRgb(input.planes.slice(0, 3));
    const nTiles = settings.tiles ? [settings.tiles, settings.tiles] : automaticTiles(input.height, input.width);
    return {
      image: rgb,
      depth: 1,
      channelLabel: "RGB",
      nTiles,
    };
  }
  const source = input.planes[settings.channel - 1];
  if (!source) {
    throw new Error(`${input.file.name} has ${input.planes.length} channels; channel ${settings.channel} does not exist.`);
  }
  const nTiles = settings.tiles ? [settings.tiles, settings.tiles] : automaticTiles(input.height, input.width);
  return {
    image: source.data,
    depth: 1,
    channelLabel: source.label,
    nTiles,
  };
}

async function runSegmentation(signal, settings = formSettings()) {
  if (!input) throw new Error("Load an image before segmenting it.");
  const model = resolveModel(settings.model);
  const prepared = prepareInputForModel(model, settings);
  const operation = begin(`Segmenting ${input.file.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  progress.setCancellable(true);
  clearOutputs();
  try {
    log.log(
      `StarDist ${model.name} on ${prepared.channelLabel} of ${input.file.name}: probability ${settings.probThresh}, overlap ${settings.nmsThresh}, ${prepared.nTiles.join(" × ")} tiles`,
      "info",
      "analysis",
    );
    const result = await segmentInWorker({
      model: model.name,
      image: prepared.image,
      depth: prepared.depth,
      width: input.width,
      height: input.height,
      probThresh: settings.probThresh,
      nmsThresh: settings.nmsThresh,
      nTiles: prepared.nTiles,
    }, current);
    current.throwIfAborted();
    log.log(`Normalized to the ${model.normalization.pmin}st and ${model.normalization.pmax}th percentiles: ${result.normalization.low} to ${result.normalization.high}`, "info", "analysis");
    const base = input.file.name.replace(/\.(ome\.)?(tiff?|png)$/i, "");
    const labelsFile = new File([writeLabelsTiff(result.labels, input.width, input.height, prepared.depth)], outputName(base, "labels.tif"), { type: "image/tiff" });
    const csvText = model.ndim === 3 ? nucleiCsv3D(result.nuclei) : nucleiCsv(result.nuclei);
    const tableFile = new File([csvText], outputName(base, "nuclei.csv"), { type: "text/csv" });
    outputs = {
      labels: {
        description: `Nucleus labels · ${result.count} nuclei`,
        file: labelsFile,
        view: { data: result.labels, count: result.count, depth: prepared.depth },
      },
      table: { description: "Nucleus table · CSV", file: tableFile, viewable: false },
    };
    await show(outputs.labels.view);
    current.throwIfAborted();
    results.render(outputs);
    $("outputSection").open = true;
    const seconds = result.seconds.toFixed(1);
    const shapeWord = model.ndim === 3 ? "polyhedra" : "polygons";
    log.log(`${result.count} nuclei from ${result.candidates} candidate ${shapeWord}`, "info", "analysis");
    log.log(`Segmented in ${seconds} s`, "info", "technical");
    progress.end(`${result.count} nuclei segmented`);
    status(`${result.count} nuclei segmented`);
    return {
      artifacts: [{ role: "labels", file: labelsFile }, { role: "table", file: tableFile }],
      provenance: {
        method: model.ndim === 3 ? "StarDist 3D" : "StarDist 2D",
        model: model.name,
        modelSha256: model.sha256,
        channel: prepared.channelLabel,
        ...settings,
        nTiles: prepared.nTiles,
        normalization: { pmin: model.normalization.pmin, pmax: model.normalization.pmax, ...result.normalization },
        nuclei: result.count,
        seconds: Number(seconds),
      },
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

function report(error) {
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
$("channel").addEventListener("change", () => {
  clearOutputs();
  void show(null).catch(report);
});
$("model").addEventListener("change", () => {
  applyModelDefaults(currentModel());
  clearOutputs();
  syncChannelControl();
  if (input) void show(null).catch(report);
});
$("resetSettings").onclick = () => {
  const model = currentModel();
  showSettings({ ...segmentationSettings({}, model), channel: Number($("channel").value || 0) + 1 }, model);
};
const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal, { preferredModel: example.parameters?.model });
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = formSettings();
  } catch (error) {
    $("advancedSettings").open = true;
    report(error);
    return;
  }
  void runSegmentation(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    segment: async ({ inputs, parameters, signal }) => {
      const model = resolveModel(parameters.model);
      const settings = segmentationSettings(parameters, model);
      await loadFiles(Promise.resolve(inputs.image), signal, { preferredModel: model.name });
      showSettings(settings, model);
      await show(null);
      return runSegmentation(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
