// Cellpose: 2D and 3D generalist cell and nucleus segmentation with pretrained Cellpose 3
// models (cyto3 and nuclei). The numerics live in src/cellpose.js; src/worker.js runs the
// ONNX U-Net on ONNX Runtime WebAssembly.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
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
import { cellsCsv, cellsCsv3D, readImage, writeLabelsTiff } from "./image-io.js";
import { normalize99 } from "./cellpose.js";
import { labelColormap, outputName, segmentationSettings } from "./settings.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "2D and 3D cell segmentation",
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

function activeChannels(image = input, is3d = $("do3D").checked) {
  if (!image) return [];
  if (is3d && image.stack) return image.stack.channels;
  return image.planes;
}

function selectedChannelIndex(image = input, is3d = $("do3D").checked) {
  const channels = activeChannels(image, is3d);
  const idx = Number($("channel").value) || 0;
  return Math.min(Math.max(0, idx), Math.max(0, channels.length - 1));
}

function selectedNuclearIndex(image = input, model = currentModel(), is3d = $("do3D").checked) {
  if (!model.supportsNuclearChannel) return -1;
  const raw = Number($("nuclearChannel").value) || 0;
  if (raw <= 0) return -1;
  const channels = activeChannels(image, is3d);
  return raw <= channels.length ? raw - 1 : -1;
}

function currentAnisotropy() {
  const val = $("anisotropy").valueAsNumber;
  return Number.isFinite(val) && val >= 0.1 && val <= 20 ? val : 1;
}

function currentSnapshot() {
  if (!input) return null;
  const model = currentModel();
  const is3d = Boolean($("do3D").checked && input.stack);
  return {
    image: input,
    is3d,
    primaryIndex: selectedChannelIndex(input, is3d),
    nuclearIndex: selectedNuclearIndex(input, model, is3d),
    anisotropy: currentAnisotropy(),
  };
}

function syncModeControls(image = input) {
  const can3D = Boolean(image?.stack && image.stack.depth >= 2);
  $("do3D").disabled = Boolean(loading || running) || !can3D;
  if (!can3D && $("do3D").checked) $("do3D").checked = false;
  $("anisotropyField").hidden = !$("do3D").checked;
}

function syncChannelControls(image = input, model = currentModel()) {
  if (!image) {
    $("channel").replaceChildren();
    $("nuclearChannel").replaceChildren();
    $("channelField").hidden = true;
    $("nuclearChannelField").hidden = true;
    syncModeControls(image);
    return;
  }
  syncModeControls(image);
  const channels = activeChannels(image, $("do3D").checked);
  const prevPrimary = $("channel").value;
  const prevNuclear = $("nuclearChannel").value;
  $("channel").replaceChildren(...channels.map((item, index) => new Option(item.label, String(index))));
  if (prevPrimary !== "" && Number(prevPrimary) < channels.length) $("channel").value = prevPrimary;
  $("channelField").hidden = channels.length < 2;

  $("nuclearChannel").replaceChildren(
    new Option("None", "0"),
    ...channels.map((item, index) => new Option(item.label, String(index + 1))),
  );
  if (prevNuclear !== "" && Number(prevNuclear) <= channels.length) $("nuclearChannel").value = prevNuclear;
  $("nuclearChannelField").hidden = !model.supportsNuclearChannel || channels.length < 2;
}

function applyModelDefaults(model) {
  $("diameter").value = String(model.defaults.diameter);
  $("flowThresh").value = String(model.defaults.flowThresh);
  $("cellprobThresh").value = String(model.defaults.cellprobThresh);
  $("minSize").value = String(model.defaults.minSize);
}

/**
 * Physical voxel spacing `[sx, sy, sz]` for NIfTI display and label TIFF export.
 * Explicit run anisotropy overrides Z spacing ratio when different from 1 or uncalibrated.
 */
function resolveVoxelSpacing(image, is3d, anisotropy = 1) {
  const sp = image.spacing;
  const sx = sp?.x && sp.x > 0 ? sp.x : 1;
  const sy = sp?.y && sp.y > 0 ? sp.y : 1;
  let sz = 1;
  if (is3d) {
    if (anisotropy !== 1) sz = anisotropy * sx;
    else if (sp?.z && sp.z > 0) sz = sp.z;
    else sz = sx;
  }
  return [sx, sy, sz];
}

function exportSpacingFor(image, is3d, anisotropy) {
  if (!is3d) return image.spacing ?? null;
  const [sx, sy, sz] = resolveVoxelSpacing(image, true, anisotropy);
  if (image.spacing?.x && image.spacing?.y) {
    return { x: sx, y: sy, z: sz, unit: image.spacing.unit ?? "micron" };
  }
  return { x: null, y: null, z: sz, unit: null };
}

// A 2D or 3D scalar image as NIfTI whose rows run down the screen, honoring physical/anisotropic spacing.
function niftiFile(image, data, name, depth = 1, spacing = [1, 1, 1]) {
  const { width, height } = image;
  const [sx, sy, sz] = spacing;
  const affine = [[sx, 0, 0, 0], [0, -sy, 0, (height - 1) * sy], [0, 0, sz, 0], [0, 0, 0, 1]];
  const buffer = createNiftiFromVolume({
    dims: [width, height, depth],
    img: data,
    hdr: { dims: [3, width, height, depth, 1, 1, 1, 1], pixDims: [1, sx, sy, sz, 1, 1, 1, 1], affine },
  });
  return new File([buffer], name, { type: "application/octet-stream" });
}

// A 2D dual-channel composite as RGBA32 NIfTI (green primary, blue nuclear) for microscopy inspection.
function compositeRgbaNiftiFile(image, primaryData, nuclearData, name, spacing = [1, 1, 1]) {
  const { width, height } = image;
  const [sx, sy] = spacing;
  const count = width * height;
  const normP = normalize99(primaryData, 1, 99).data;
  const normN = normalize99(nuclearData, 1, 99).data;
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const g = Math.max(0, Math.min(255, Math.round(normP[i] * 255)));
    const b = Math.max(0, Math.min(255, Math.round(normN[i] * 255)));
    rgba[4 * i] = Math.round(b * 0.25);
    rgba[4 * i + 1] = g;
    rgba[4 * i + 2] = b;
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
function show(labels, snapshot = null) {
  const target = snapshot ?? currentSnapshot();
  shown = shown.catch(() => {}).then(async () => {
    if (!target?.image) return;
    const { image, is3d, primaryIndex, nuclearIndex, anisotropy } = target;
    await viewerReady();
    const use3d = Boolean(is3d && image.stack);
    const spacing = resolveVoxelSpacing(image, use3d, anisotropy);
    viewer.sliceType = use3d ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.AXIAL;
    viewer.crosshairWidth = use3d ? 1 : 0;
    const channels = use3d ? image.stack.channels : image.planes;
    const primary = channels[Math.min(primaryIndex, channels.length - 1)];
    const nuclear = nuclearIndex >= 0 && nuclearIndex < channels.length ? channels[nuclearIndex] : null;
    let baseVolume;
    if (use3d) {
      baseVolume = { url: niftiFile(image, Float32Array.from(primary.data), "image.nii", image.stack.depth, spacing), name: "image.nii", colormap: "gray" };
    } else if (nuclear && nuclear !== primary) {
      baseVolume = { url: compositeRgbaNiftiFile(image, primary.data, nuclear.data, "image.nii", spacing), name: "image.nii" };
    } else {
      baseVolume = { url: niftiFile(image, Float32Array.from(primary.data), "image.nii", 1, spacing), name: "image.nii", colormap: "gray" };
    }
    const volumes = [baseVolume];
    if (labels) {
      volumes.push({ url: niftiFile(image, labels.data, "labels.nii", labels.depth ?? 1, spacing), name: "labels.nii", opacity });
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
    if (stage === "labels" && outputs.labels) void show(outputs.labels.view, outputs.labels.snapshot).catch((error) => status(error.message, true));
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
  for (const id of ["imageInput", "channel", "nuclearChannel", "model", "diameter", "do3D", "anisotropy", "flowThresh", "cellprobThresh", "minSize", "resetSettings"]) {
    $(id).disabled = busy;
  }
  if (!busy) syncModeControls();
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

function resolveStagedSelection(image, preset) {
  const model = resolveModel(preset?.model ?? $("model").value);
  const can3D = Boolean(image.stack && image.stack.depth >= 2);
  const is3d = preset ? Boolean(preset.do3D && can3D) : Boolean(image.is3dHint && can3D);
  const channels = is3d ? image.stack.channels : image.planes;
  const primaryIndex = preset?.channel !== undefined ? Math.min(Math.max(0, preset.channel - 1), channels.length - 1) : 0;
  const nuclearIndex = preset?.nuclearChannel && model.supportsNuclearChannel && preset.nuclearChannel <= channels.length
    ? preset.nuclearChannel - 1
    : -1;
  const defaultAniso = image.spacing?.z && image.spacing?.x ? Number((image.spacing.z / image.spacing.x).toFixed(3)) : 1;
  const anisotropy = preset?.anisotropy ?? (defaultAniso >= 0.1 && defaultAniso <= 20 ? defaultAniso : 1);
  return { model, is3d, primaryIndex, nuclearIndex, anisotropy, preset };
}

function commitInput(files, nextInput, staged) {
  input = nextInput;
  clearOutputs();
  if (staged.preset) {
    $("model").value = staged.model.name;
    applyModelDefaults(staged.model);
  }
  $("do3D").checked = staged.is3d;
  syncChannelControls(nextInput, staged.model);
  if (staged.preset?.diameter !== undefined) $("diameter").value = String(staged.preset.diameter);
  $("anisotropy").value = String(staged.anisotropy);
  $("channel").value = String(staged.primaryIndex);
  $("nuclearChannel").value = String(staged.nuclearIndex >= 0 ? staged.nuclearIndex + 1 : 0);
  $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = formatFileInfo(nextInput.file, nextInput);
  $("dropZone").classList.add("has-files");
}

function formatFileInfo(file, image) {
  if (image.is3dHint && image.stack) {
    const ch = image.stack.channels.length > 1 ? ` · ${image.stack.channels.length} channels` : "";
    return `${file.name} · ${image.width} × ${image.height} × ${image.stack.depth} · ${image.format}${ch}`;
  }
  return `${file.name} · ${image.width} × ${image.height} · ${image.format}${image.planes.length > 1 ? ` · ${image.planes.length} channels` : ""}`;
}

async function decodeInputFiles(filesPromise, current) {
  const files = await filesPromise;
  current.throwIfAborted();
  if (files.length !== 1) throw new Error(`Choose one 2D image or 3D TIFF stack; this selection has ${files.length} files.`);
  const [file] = files;
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const image = await readImage(file.name, await file.arrayBuffer());
  current.throwIfAborted();
  return { files, nextInput: { file, ...image } };
}

async function loadFiles(filesPromise, signal, { preset } = {}) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  const prevSnapshot = currentSnapshot();
  const prevLabels = outputs.labels?.view ?? null;
  let viewerTouched = false;
  try {
    const { files, nextInput } = await decodeInputFiles(filesPromise, current);
    const staged = resolveStagedSelection(nextInput, preset);
    const previewSnapshot = {
      image: nextInput,
      is3d: staged.is3d,
      primaryIndex: staged.primaryIndex,
      nuclearIndex: staged.nuclearIndex,
      anisotropy: staged.anisotropy,
    };
    viewerTouched = true;
    await show(null, previewSnapshot);
    current.throwIfAborted();
    commitInput(files, nextInput, staged);
    progress.setProgress(0);
    status(`${nextInput.file.name} loaded`);
  } catch (error) {
    if (viewerTouched && prevSnapshot) {
      void show(prevLabels, prevSnapshot).catch(() => {});
    }
    throw error;
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
      reject(new Error(event.message || "The Cellpose worker failed to start."));
    };
    worker.onmessageerror = () => {
      stop();
      reject(new Error("The Cellpose worker returned an unreadable message."));
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
    nuclearChannel: model.supportsNuclearChannel ? Number($("nuclearChannel").value || 0) : 0,
    diameter: $("diameter").valueAsNumber,
    flowThresh: $("flowThresh").valueAsNumber,
    cellprobThresh: $("cellprobThresh").valueAsNumber,
    minSize: $("minSize").valueAsNumber,
    do3D: $("do3D").checked,
    anisotropy: $("anisotropy").valueAsNumber,
  }, model);
}

function showSettings(settings, model, targetInput = input) {
  $("model").value = model.name;
  $("do3D").checked = settings.do3D;
  syncChannelControls(targetInput, model);
  $("diameter").value = String(settings.diameter);
  $("flowThresh").value = String(settings.flowThresh);
  $("cellprobThresh").value = String(settings.cellprobThresh);
  $("minSize").value = String(settings.minSize);
  $("anisotropy").value = String(settings.anisotropy);
  if (targetInput) {
    const channels = settings.do3D ? (targetInput.stack?.channels ?? []) : targetInput.planes;
    if (channels.length > 0 && settings.channel > channels.length) {
      throw new Error(`${targetInput.file.name} has ${channels.length} channels; channel ${settings.channel} does not exist.`);
    }
    if (channels.length > 0 && settings.nuclearChannel > channels.length) {
      throw new Error(`${targetInput.file.name} has ${channels.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
    }
    if (channels.length > 0) $("channel").value = String(settings.channel - 1);
    if (model.supportsNuclearChannel) $("nuclearChannel").value = String(settings.nuclearChannel);
  }
}

function prepareInputForRun(image, model, settings) {
  if (settings.do3D) {
    if (!image.stack || image.stack.depth < 2) {
      throw new Error(`3D segmentation requires a multi-page 3D TIFF stack (at least 2 slices); ${image.file.name} has ${image.depth}.`);
    }
    const primary = image.stack.channels[settings.channel - 1];
    if (!primary) {
      throw new Error(`${image.file.name} has ${image.stack.channels.length} channels; channel ${settings.channel} does not exist.`);
    }
    const nuclear = model.supportsNuclearChannel && settings.nuclearChannel > 0
      ? image.stack.channels[settings.nuclearChannel - 1]
      : null;
    if (model.supportsNuclearChannel && settings.nuclearChannel > 0 && !nuclear) {
      throw new Error(`${image.file.name} has ${image.stack.channels.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
    }
    return {
      primary: primary.data,
      nuclear: nuclear ? nuclear.data : null,
      depth: image.stack.depth,
      channelLabel: nuclear ? `${primary.label} + ${nuclear.label}` : primary.label,
      primaryIndex: settings.channel - 1,
      nuclearIndex: nuclear ? settings.nuclearChannel - 1 : -1,
    };
  }
  const primary = image.planes[settings.channel - 1];
  if (!primary) {
    throw new Error(`${image.file.name} has ${image.planes.length} channels; channel ${settings.channel} does not exist.`);
  }
  const nuclear = model.supportsNuclearChannel && settings.nuclearChannel > 0
    ? image.planes[settings.nuclearChannel - 1]
    : null;
  if (model.supportsNuclearChannel && settings.nuclearChannel > 0 && !nuclear) {
    throw new Error(`${image.file.name} has ${image.planes.length} channels; nuclear channel ${settings.nuclearChannel} does not exist.`);
  }
  return {
    primary: primary.data,
    nuclear: nuclear ? nuclear.data : null,
    depth: 1,
    channelLabel: nuclear ? `${primary.label} + ${nuclear.label}` : primary.label,
    primaryIndex: settings.channel - 1,
    nuclearIndex: nuclear ? settings.nuclearChannel - 1 : -1,
  };
}

async function executeSegmentation(targetInput, model, settings, current) {
  const prepared = prepareInputForRun(targetInput, model, settings);
  const runSnapshot = {
    image: targetInput,
    is3d: settings.do3D,
    primaryIndex: prepared.primaryIndex,
    nuclearIndex: prepared.nuclearIndex,
    anisotropy: settings.anisotropy,
  };
  const modeLabel = settings.do3D ? `3D (anisotropy ${settings.anisotropy})` : "2D";
  log.log(
    `Cellpose ${model.name} (${modeLabel}) on ${prepared.channelLabel} of ${targetInput.file.name}: diameter ${settings.diameter} px, flow ${settings.flowThresh}, cellprob ${settings.cellprobThresh}`,
    "info",
    "analysis",
  );
  const result = await segmentInWorker({
    model: model.name,
    primary: prepared.primary,
    nuclear: prepared.nuclear,
    depth: prepared.depth,
    width: targetInput.width,
    height: targetInput.height,
    diameter: settings.diameter,
    flowThresh: settings.flowThresh,
    cellprobThresh: settings.cellprobThresh,
    minSize: settings.minSize,
    do3D: settings.do3D,
    anisotropy: settings.anisotropy,
  }, current);
  current.throwIfAborted();
  log.log(`Normalized to the ${model.normalization.lower}st and ${model.normalization.upper}th percentiles: ${result.normalization.low.toFixed(1)} to ${result.normalization.high.toFixed(1)}`, "info", "analysis");
  const base = targetInput.file.name.replace(/\.(ome\.)?(tiff?|png)$/i, "");
  const outSpacing = exportSpacingFor(targetInput, settings.do3D, settings.anisotropy);
  const labelsFile = new File([writeLabelsTiff(result.labels, targetInput.width, targetInput.height, prepared.depth, outSpacing)], outputName(base, "labels.tif"), { type: "image/tiff" });
  const csvText = settings.do3D ? cellsCsv3D(result.cells) : cellsCsv(result.cells);
  const tableFile = new File([csvText], outputName(base, "cells.csv"), { type: "text/csv" });
  const noun = model.name === "nuclei" ? (result.count === 1 ? "nucleus" : "nuclei") : (result.count === 1 ? "cell" : "cells");
  const nextOutputs = {
    labels: {
      description: `Instance labels · ${result.count} ${noun}`,
      file: labelsFile,
      view: { data: result.labels, count: result.count, depth: prepared.depth },
      snapshot: runSnapshot,
    },
    table: { description: "Object table · CSV", file: tableFile, viewable: false },
  };
  await show(nextOutputs.labels.view, runSnapshot);
  current.throwIfAborted();
  outputs = nextOutputs;
  results.render(outputs);
  $("outputSection").open = true;
  const seconds = result.seconds.toFixed(1);
  log.log(`${result.count} ${noun} segmented`, "info", "analysis");
  log.log(`Segmented in ${seconds} s`, "info", "technical");
  progress.end(`${result.count} ${noun} segmented`);
  status(`${result.count} ${noun} segmented`);
  return {
    artifacts: [{ role: "labels", file: labelsFile }, { role: "table", file: tableFile }],
    provenance: {
      method: settings.do3D ? "Cellpose 3D" : "Cellpose 2D",
      model: model.name,
      modelSha256: model.sha256,
      channel: prepared.channelLabel,
      ...settings,
      normalization: { lower: model.normalization.lower, upper: model.normalization.upper, ...result.normalization },
      count: result.count,
      seconds: Number(seconds),
    },
  };
}

async function runSegmentation(signal, settings = formSettings()) {
  if (!input) throw new Error("Load an image before segmenting it.");
  const targetInput = input;
  const model = resolveModel(settings.model);
  const prepared = prepareInputForRun(targetInput, model, settings);
  const runSnapshot = {
    image: targetInput,
    is3d: settings.do3D,
    primaryIndex: prepared.primaryIndex,
    nuclearIndex: prepared.nuclearIndex,
    anisotropy: settings.anisotropy,
  };
  const operation = begin(`Segmenting ${targetInput.file.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  progress.setCancellable(true);
  clearOutputs();
  try {
    return await executeSegmentation(targetInput, model, settings, current);
  } catch (error) {
    progress.reset();
    void show(null, runSnapshot).catch(() => {});
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
$("channel").addEventListener("change", () => {
  clearOutputs();
  void show(null).catch(report);
});
$("nuclearChannel").addEventListener("change", () => {
  clearOutputs();
  void show(null).catch(report);
});
$("do3D").addEventListener("change", () => {
  clearOutputs();
  syncChannelControls();
  if (input) void show(null).catch(report);
});
$("anisotropy").addEventListener("change", () => {
  if (input && $("do3D").checked) void show(outputs.labels?.view ?? null).catch(report);
});
$("model").addEventListener("change", () => {
  applyModelDefaults(currentModel());
  clearOutputs();
  syncChannelControls();
  if (input) void show(null).catch(report);
});
$("resetSettings").onclick = () => {
  const model = currentModel();
  showSettings({
    ...segmentationSettings({}, model),
    channel: Number($("channel").value || 0) + 1,
    nuclearChannel: model.supportsNuclearChannel ? Number($("nuclearChannel").value || 0) : 0,
    do3D: $("do3D").checked,
  }, model);
};

const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal, { preset: example.parameters });
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
      const operation = begin("Reading image…", signal);
      running = operation.controller;
      const current = operation.controller.signal;
      progress.setCancellable(true);
      const prevSnapshot = currentSnapshot();
      const prevLabels = outputs.labels?.view ?? null;
      let viewerTouched = false;
      try {
        const { files, nextInput } = await decodeInputFiles(Promise.resolve(inputs.image), current);
        const prepared = prepareInputForRun(nextInput, model, settings);
        const staged = {
          model,
          is3d: settings.do3D,
          primaryIndex: prepared.primaryIndex,
          nuclearIndex: prepared.nuclearIndex,
          anisotropy: settings.anisotropy,
          preset: settings,
        };
        const runSnapshot = {
          image: nextInput,
          is3d: settings.do3D,
          primaryIndex: prepared.primaryIndex,
          nuclearIndex: prepared.nuclearIndex,
          anisotropy: settings.anisotropy,
        };
        viewerTouched = true;
        await show(null, runSnapshot);
        current.throwIfAborted();
        commitInput(files, nextInput, staged);
        showSettings(settings, model, nextInput);
        progress.setProgress(0, `Segmenting ${nextInput.file.name}…`);
        status(`Segmenting ${nextInput.file.name}…`, false, "technical");
        return await executeSegmentation(nextInput, model, settings, current);
      } catch (error) {
        progress.reset();
        if (viewerTouched && prevSnapshot) {
          void show(prevLabels, prevSnapshot).catch(() => {});
        }
        throw error;
      } finally {
        running = null;
        finish(operation);
      }
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
