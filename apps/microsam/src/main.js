// micro-sam: interactive 2D and 3D Z-stack segmentation of light and electron microscopy images
// with Segment Anything for Microscopy. src/preprocess.js and src/segmentation.js hold the
// numerics; src/worker.js caches slice embeddings and runs the prompt decoder per change.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./microsam.css";
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
import workerUrl from "./worker.js?worker&url";
import { APP, DEFAULT_MODEL_ID, modelById } from "./config.js";
import { writeLabelTiff, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { channelChoices, readImage } from "./image-io.js";
import { channelToUint8, encoderTensor, resizedChannels, threeChannels } from "./preprocess.js";
import {
  boxFromCorners,
  boxFromMask,
  clickPixel,
  commitObject,
  commitObject3D,
  hasPrompt,
  maskIou,
  maskRuns,
  measureObjects,
  measureObjects3D,
  objectsCsv,
  objectsCsv3D,
  parsePrompts,
  uncommitObject,
} from "./segmentation.js";
import { baseRgba, overlayRgba } from "./display.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const DRAG_PIXELS = 4;

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Interactive microscopy segmentation",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  views: [
    { id: "filled", label: "Filled", active: true },
    { id: "outlines", label: "Outlines" },
    { id: "image", label: "Image" },
  ],
  viewsLabel: "Objects",
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

// The loaded image ({ file, width, height, depth, format, planes, slices, choices }), the active
// slice, the worker session holding cached slice embeddings, accepted objects and pending prompt.
let input = null;
let currentSlice = 0;
let loading = null;
let embedding = null;
let embedRun = null;
let propagateRun = null;
let labels = null;
let objects = [];
let nextId = 1;
let prompt = { points: [], box: null };
let promptOrder = [];
let pending = null;
let pending3D = null;
let promptVersion = 0;
let decoding = null;
let negativeTool = false;
let display = "filled";
let opacity = 0.5;
let outputs = {};

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function report(error) {
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

function choice() {
  return input?.choices.find((item) => item.id === $("channel").value) ?? input?.choices[0];
}

function selectedModel() {
  return modelById($("model").value || DEFAULT_MODEL_ID);
}

function is3D() {
  return Boolean(input && input.depth > 1);
}

function sliceLabels(z = currentSlice) {
  if (!labels || !input) return null;
  const planeSize = input.width * input.height;
  return labels.subarray(z * planeSize, (z + 1) * planeSize);
}

// ---------------------------------------------------------------------------------------------
// Viewer: the current slice as micro-sam sees it, the objects, the pending mask and the prompts.

const canvas = $("canvas");
const context = canvas.getContext("2d");
const layers = { base: document.createElement("canvas"), overlay: document.createElement("canvas") };
let view = { scale: 1, x: 0, y: 0 };
let drag = null;

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paintLayer(layer, pixels) {
  layer.width = input.width;
  layer.height = input.height;
  layer.getContext("2d").putImageData(new ImageData(pixels, input.width, input.height), 0, 0);
}

function refreshBase() {
  const planes = threeChannels(choice().planesAt(currentSlice)).map((plane) => channelToUint8(plane.data));
  paintLayer(layers.base, baseRgba(planes, input.width, input.height));
}

function previewMaskForSlice(z) {
  if (pending3D?.masks.has(z)) return pending3D.masks.get(z);
  if (pending && pending.slice === z) return pending.mask;
  return null;
}

function refreshOverlay() {
  paintLayer(layers.overlay, overlayRgba({
    labels: sliceLabels(currentSlice),
    width: input.width,
    height: input.height,
    mode: display,
    opacity,
    preview: previewMaskForSlice(currentSlice),
    previewId: nextId,
  }));
}

function toImage(event) {
  const rect = canvas.getBoundingClientRect();
  const ratio = canvas.width / rect.width;
  return [((event.clientX - rect.left) * ratio - view.x) / view.scale, ((event.clientY - rect.top) * ratio - view.y) / view.scale];
}

function drawMarker(x, y, positive, ratio) {
  const cx = view.x + (x + 0.5) * view.scale;
  const cy = view.y + (y + 0.5) * view.scale;
  context.beginPath();
  context.arc(cx, cy, 5 * ratio, 0, 2 * Math.PI);
  context.fillStyle = token(positive ? "--nd-color-primary" : "--nd-color-error");
  context.fill();
  context.lineWidth = 1.5 * ratio;
  context.strokeStyle = token("--nd-color-bg");
  context.stroke();
}

function drawBox([x0, y0, x1, y1], ratio, dashed) {
  context.setLineDash(dashed ? [4 * ratio, 3 * ratio] : []);
  context.lineWidth = 2 * ratio;
  context.strokeStyle = token("--nd-color-primary");
  context.strokeRect(view.x + x0 * view.scale, view.y + y0 * view.scale, (x1 - x0) * view.scale, (y1 - y0) * view.scale);
  context.setLineDash([]);
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!input) return;
  const scale = Math.min(canvas.width / input.width, canvas.height / input.height);
  view = { scale, x: (canvas.width - input.width * scale) / 2, y: (canvas.height - input.height * scale) / 2 };
  context.imageSmoothingEnabled = false;
  context.drawImage(layers.base, view.x, view.y, input.width * scale, input.height * scale);
  context.drawImage(layers.overlay, view.x, view.y, input.width * scale, input.height * scale);
  if (!pending3D || pending?.slice === currentSlice) {
    if (prompt.box) drawBox(prompt.box, ratio, false);
    if (drag?.moved) {
      const box = boxFromCorners(drag.start, drag.end, input.width, input.height);
      if (box) drawBox(box, ratio, true);
    }
    for (const [x, y, label] of prompt.points) drawMarker(x, y, label === 1, ratio);
  }
}

new ResizeObserver(() => draw()).observe(canvas);

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  display = detail.value;
  if (input) refreshOverlay();
  draw();
});
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  opacity = detail.value;
  if (input) refreshOverlay();
  draw();
});

// ---------------------------------------------------------------------------------------------
// Controls and outputs.

const results = createResultList({
  element: $("resultList"),
  onView: () => {
    display = display === "image" ? "filled" : display;
    refreshOverlay();
    draw();
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function sliceEmbedded(z = currentSlice) {
  return Boolean(
    embedding
    && embedding.choice === choice()?.id
    && embedding.modelId === selectedModel().id
    && embedding.slices.has(z)
    && !embedRun
    && !propagateRun,
  );
}

function ready() {
  return sliceEmbedded(currentSlice);
}

function updateControls() {
  const busy = Boolean(loading || embedRun || propagateRun || decoding);
  const prompting = ready();
  const stack = is3D();
  $("imageInput").disabled = busy;
  $("channel").disabled = busy;
  $("model").disabled = busy;
  $("backend").disabled = busy;
  $("sliceSlider").disabled = busy || !stack;
  $("iouThreshold").disabled = busy;
  $("boxExtension").disabled = busy;
  $("sliceField").hidden = !stack;
  $("propagateButton").hidden = !stack;
  $("iouField").hidden = !stack;
  $("boxExtField").hidden = !stack;
  if (stack) {
    $("sliceSlider").max = String(input.depth - 1);
    $("sliceSlider").value = String(currentSlice);
    $("sliceLabel").textContent = `${currentSlice + 1} / ${input.depth}`;
  }
  exampleControl?.setDisabled(busy);
  $("embedButton").disabled = busy || !input || prompting;
  $("positiveTool").disabled = !prompting;
  $("negativeTool").disabled = !prompting;
  $("acceptButton").disabled = !prompting || (!pending && !pending3D) || decoding !== null;
  $("propagateButton").disabled = !stack || !prompting || !pending || decoding !== null;
  $("clearButton").disabled = !hasPrompt(prompt) && !pending3D;
  $("undoButton").disabled = !hasPrompt(prompt) && !pending3D && !objects.length;
  $("positiveTool").setAttribute("aria-pressed", String(!negativeTool));
  $("negativeTool").setAttribute("aria-pressed", String(negativeTool));
  $("objectInfo").hidden = !input;
  $("objectInfo").textContent = `${objects.length} ${objects.length === 1 ? "object" : "objects"} accepted`;
}

function baseName() {
  return input.file.name.replace(/\.(ome\.)?(tiff?|png)$/i, "");
}

function refreshOutputs() {
  if (!objects.length) {
    outputs = {};
    results.render();
    $("outputSection").open = false;
    return;
  }
  const selected = choice();
  const planes0 = selected.planesAt(0);
  let labelBytes;
  if (is3D()) {
    let maxLabel = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
    labelBytes = writeTiffStack({
      width: input.width,
      height: input.height,
      data: maxLabel <= 0xffff ? Uint16Array.from(labels) : Uint32Array.from(labels),
      description: `ImageJ=1.54f\nimages=${input.depth}\nslices=${input.depth}\n`,
    });
  } else {
    labelBytes = writeLabelTiff(labels, input.width, input.height);
  }
  const labelsFile = new File([labelBytes], `${baseName()}_microsam-labels.tif`, { type: "image/tiff" });
  const csv = is3D()
    ? objectsCsv3D(measureObjects3D(labels, input.width, input.height, input.depth, (z) => selected.planesAt(z), objects), planes0)
    : objectsCsv(measureObjects(labels, input.width, planes0, objects), planes0);
  const tableFile = new File([csv], `${baseName()}_microsam-objects.csv`, { type: "text/csv" });
  outputs = {
    labels: { description: `Object labels · ${objects.length} ${objects.length === 1 ? "object" : "objects"}`, file: labelsFile },
    table: { description: "Object table · CSV", file: tableFile, viewable: false },
  };
  results.render(outputs);
  $("outputSection").open = true;
}

function resetPrompt() {
  prompt = { points: [], box: null };
  promptOrder = [];
  pending = null;
  pending3D = null;
  promptVersion++;
}

function resetEmbeddings() {
  embedRun?.abort();
  propagateRun?.abort();
  stopWorker(embedding?.worker);
  embedding = null;
  resetPrompt();
}

function resetSession() {
  resetEmbeddings();
  objects = [];
  nextId = 1;
  currentSlice = 0;
  labels = input ? new Uint32Array(input.depth * input.width * input.height) : null;
  refreshOutputs();
}

// ---------------------------------------------------------------------------------------------
// Loading.

function begin(message, signal) {
  if (loading || embedRun || propagateRun) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin(message);
  status(message, false, "technical");
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  progress.stopTimer();
  progress.setCancellable(false);
  updateControls();
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  updateControls();
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    current.throwIfAborted();
    if (files.length !== 1) throw new Error(`Choose one image or Z-stack; this selection has ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const image = await readImage(file.name, await file.arrayBuffer());
    current.throwIfAborted();
    const choices = channelChoices(image);
    input = null;
    resetSession();
    input = { file, ...image, choices };
    currentSlice = image.depth > 1 ? Math.floor(image.depth / 2) : 0;
    labels = new Uint32Array(image.depth * image.width * image.height);
    $("channel").replaceChildren(...choices.map((item) => new Option(item.label, item.id)));
    $("channelField").hidden = choices.length < 2;
    refreshBase();
    refreshOverlay();
    $("emptyState").hidden = true;
    draw();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    const dims = image.depth > 1 ? `${image.width} × ${image.height} × ${image.depth}` : `${image.width} × ${image.height}`;
    $("fileInfo").textContent = `${file.name} · ${dims} · ${image.format}${image.planes.length > 1 ? ` · ${image.planes.length} channels` : ""}`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded · compute embeddings to start prompting`);
    log.log(`${file.name}: ${dims}, ${image.format}, ${image.planes.map((plane) => plane.label).join(", ")}`, "info", "analysis");
  } finally {
    loading = null;
    finish(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// The worker: one per image/model/channel session, caching slice embeddings.

let messageId = 0;
const replies = new Map();

/** Terminates a session's worker, rejecting what it still owes so no prompt waits on it. */
function stopWorker(worker) {
  if (!worker) return;
  worker.terminate();
  for (const [id, reply] of replies) {
    if (reply.worker !== worker) continue;
    replies.delete(id);
    reply.reject(new DOMException("The image session ended", "AbortError"));
  }
  decoding = null;
}

function startWorker() {
  const worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      if (embedRun) progress.setProgress(data.value, data.message);
      return;
    }
    if (data.type === "log") {
      log.log(data.message, "info", "technical");
      return;
    }
    const reply = replies.get(data.id);
    if (!reply) return;
    replies.delete(data.id);
    if (data.type === "error") reply.reject(new Error(data.message));
    else reply.resolve(data);
  };
  worker.onerror = (event) => {
    for (const [id, reply] of replies) {
      if (reply.worker !== worker) continue;
      replies.delete(id);
      reply.reject(new Error(event.message || "The micro-sam worker failed."));
    }
  };
  return worker;
}

function call(worker, message, transfer = [], signal = null) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    replies.set(id, { worker, resolve, reject });
    signal?.addEventListener("abort", () => {
      replies.delete(id);
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    }, { once: true });
    worker.postMessage({ ...message, id }, transfer);
  });
}

async function resolveBackend(requested) {
  if (requested !== "auto") return requested;
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  return adapter ? "webgpu" : "wasm";
}

function ensureSessionWorker(selectedChoice, model) {
  if (embedding && embedding.choice === selectedChoice.id && embedding.modelId === model.id) return embedding;
  stopWorker(embedding?.worker);
  embedding = {
    worker: startWorker(),
    choice: selectedChoice.id,
    modelId: model.id,
    backend: null,
    seconds: 0,
    summary: null,
    slices: new Map(),
  };
  return embedding;
}

async function embedOneSlice(session, selectedChoice, model, sliceIndex, backend, signal) {
  if (session.slices.has(sliceIndex)) return session.slices.get(sliceIndex);
  const resized = resizedChannels(selectedChoice.planesAt(sliceIndex).map((plane) => plane.data), input.width, input.height);
  const tensor = encoderTensor(resized);
  const result = await call(session.worker, { type: "embed", modelId: model.id, slice: sliceIndex, tensor, backend }, [tensor.buffer], signal);
  signal?.throwIfAborted();
  for (const evicted of result.evicted ?? []) session.slices.delete(evicted);
  const info = { backend: result.backend, seconds: result.seconds, summary: result.summary };
  session.slices.set(sliceIndex, info);
  session.backend = result.backend;
  session.seconds = result.seconds;
  session.summary = result.summary;
  return info;
}

async function computeEmbedding(signal, requested = $("backend").value, sliceIndex = currentSlice) {
  if (!input) throw new Error("Load an image before computing its embedding.");
  const selected = choice();
  const model = selectedModel();
  const label = is3D() ? `slice ${sliceIndex + 1} of ${input.file.name}` : input.file.name;
  const operation = begin(`Computing the embedding of ${label}…`, signal);
  embedRun = operation.controller;
  const current = operation.controller.signal;
  const session = ensureSessionWorker(selected, model);
  resetPrompt();
  refreshOverlay();
  draw();
  updateControls();
  const abort = () => {
    stopWorker(session.worker);
    if (embedding === session) embedding = null;
  };
  current.addEventListener("abort", abort, { once: true });
  try {
    const backend = await resolveBackend(requested);
    const resized = resizedChannels(selected.planesAt(sliceIndex).map((plane) => plane.data), input.width, input.height);
    log.log(`micro-sam ${model.id} on ${selected.label} of ${label}, resized to ${resized.width} × ${resized.height}`, "info", "analysis");
    const result = await embedOneSlice(session, selected, model, sliceIndex, backend, current);
    current.throwIfAborted();
    progress.end("Embeddings ready · click or drag on the image");
    status(`Embeddings ready in ${result.seconds.toFixed(1)} s · click or drag on the image`);
    return embedding;
  } catch (error) {
    abort();
    progress.reset(input ? "Ready" : undefined);
    throw error;
  } finally {
    current.removeEventListener("abort", abort);
    embedRun = null;
    finish(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// Prompting & 3D propagation.

async function decode(snapshot, sliceIndex = currentSlice, signal = null) {
  const result = await call(embedding.worker, { type: "decode", slice: sliceIndex, prompt: snapshot, height: input.height, width: input.width }, [], signal);
  return { slice: sliceIndex, mask: result.mask, score: result.score, token: result.token, prompt: structuredClone(snapshot) };
}

function promptChanged() {
  const version = ++promptVersion;
  pending3D = null;
  if (!hasPrompt(prompt)) {
    pending = null;
    refreshOverlay();
    draw();
    updateControls();
    return Promise.resolve(null);
  }
  draw();
  const snapshot = structuredClone(prompt);
  const sliceIndex = currentSlice;
  const run = (decoding ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (version !== promptVersion || !ready()) return null;
    const result = await decode(snapshot, sliceIndex);
    log.log(`Decoded ${JSON.stringify(snapshot)}: ${result.mask.reduce((sum, value) => sum + value, 0)} px, token ${result.token}, predicted IoU ${result.score.toFixed(3)}`, "info", "technical");
    if (version !== promptVersion) return null;
    pending = result;
    refreshOverlay();
    draw();
    return result;
  });
  decoding = run;
  updateControls();
  run.catch((error) => {
    if (version === promptVersion) report(error);
  }).finally(() => {
    if (decoding === run) decoding = null;
    updateControls();
  });
  return run;
}

function addPoint(x, y, label) {
  prompt.points.push([x, y, label]);
  promptOrder.push("point");
  return promptChanged();
}

function setBox(box) {
  if (!prompt.box) promptOrder.push("box");
  prompt.box = box;
  return promptChanged();
}

function numericInput(id, fallback) {
  const raw = $(id).value.trim();
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Bidirectional 3D slice propagation matching micro-sam's `segment_mask_in_volume` (projection="box"):
 * starting from `seed` on `seed.slice`, projects each slice's bounding box (+ `boxExtension`) to
 * adjacent slices in both directions until the mask is empty or 2D IoU with the previous slice
 * falls below `iouThreshold`.
 */
async function propagate3D(signal, {
  iouThreshold = numericInput("iouThreshold", 0.5),
  boxExtension = numericInput("boxExtension", 0.1),
  requestedBackend = $("backend").value,
} = {}) {
  if (!is3D() || !pending) throw new Error("Prompt an object on one slice before propagating in 3D.");
  if (!pending.mask.some(Boolean)) throw new Error("The current prompt produced an empty mask; prompt an object before propagating in 3D.");
  const seed = pending;
  const selected = choice();
  const model = selectedModel();
  const session = embedding;
  const operation = begin(`Propagating in 3D from slice ${seed.slice + 1}…`, signal);
  propagateRun = operation.controller;
  const current = operation.controller.signal;
  const abort = () => {
    stopWorker(session?.worker);
    if (embedding === session) embedding = null;
  };
  current.addEventListener("abort", abort, { once: true });
  updateControls();
  const masks = new Map([[seed.slice, seed.mask]]);
  const scores = [seed.score];
  const backend = session.backend || await resolveBackend(requestedBackend);
  const totalSteps = input.depth - 1;
  let doneSteps = 0;
  try {
    for (const step of [1, -1]) {
      let prevMask = seed.mask;
      for (let z = seed.slice + step; z >= 0 && z < input.depth; z += step) {
        current.throwIfAborted();
        const box = boxFromMask(prevMask, input.width, input.height, boxExtension);
        if (!box) break;
        doneSteps++;
        progress.setProgress(Math.min(0.99, doneSteps / Math.max(1, totalSteps)), `Propagating · slice ${z + 1} of ${input.depth}`);
        await embedOneSlice(session, selected, model, z, backend, current);
        const decoded = await decode({ points: [], box }, z, current);
        current.throwIfAborted();
        const overlap = maskIou(prevMask, decoded.mask);
        if (overlap < iouThreshold || !decoded.mask.some(Boolean)) {
          log.log(`3D propagation stopped at slice ${z + 1} (IoU ${overlap.toFixed(3)} < ${iouThreshold})`, "info", "technical");
          break;
        }
        masks.set(z, decoded.mask);
        scores.push(decoded.score);
        prevMask = decoded.mask;
      }
    }
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    pending3D = { masks, seedSlice: seed.slice, score: meanScore, token: seed.token, prompt: seed.prompt };
    refreshOverlay();
    draw();
    progress.end(`Propagated across ${masks.size} of ${input.depth} slices · click Accept object`);
    status(`Propagated across ${masks.size} slices · inspect or click Accept object`);
    return pending3D;
  } catch (error) {
    if (current.aborted) abort();
    progress.reset("Ready");
    throw error;
  } finally {
    current.removeEventListener("abort", abort);
    propagateRun = null;
    finish(operation);
  }
}

async function accept() {
  if (decoding) await decoding.catch(() => null);
  if ((!pending && !pending3D) || !ready()) return null;
  const planeSize = input.width * input.height;
  if (pending3D) {
    const id = nextId;
    const claimed = commitObject3D(labels, pending3D.masks, planeSize, id);
    if (!claimed.length) throw new Error("This 3D mask lies inside accepted objects; prompt a new object or undo one.");
    nextId++;
    let area = 0;
    for (const mask of pending3D.masks.values()) for (let i = 0; i < mask.length; i++) if (mask[i]) area++;
    const object = {
      id,
      claimed,
      score: pending3D.score,
      token: pending3D.token,
      prompt: pending3D.prompt,
      area,
      slices: pending3D.masks.size,
      slice: pending3D.seedSlice,
    };
    objects.push(object);
    log.log(`Object ${id}: ${object.claimed.length} vx across ${object.slices} slices (predicted IoU ${object.score.toFixed(3)})`, "info", "analysis");
    resetPrompt();
    refreshOverlay();
    refreshOutputs();
    draw();
    updateControls();
    status(`Object ${id} accepted (${object.slices} slices) · ${objects.length} ${objects.length === 1 ? "object" : "objects"}`);
    return object;
  }
  const candidate = pending;
  const digest = await crypto.subtle.digest("SHA-256", candidate.mask);
  if (!ready() || pending !== candidate) return null;
  const id = nextId;
  const claimed = commitObject(labels, candidate.mask, id, candidate.slice * planeSize);
  if (!claimed.length) throw new Error("This mask lies inside accepted objects; prompt a new object or undo one.");
  nextId++;
  const object = {
    id,
    claimed,
    score: candidate.score,
    token: candidate.token,
    prompt: candidate.prompt,
    area: candidate.mask.reduce((sum, value) => sum + value, 0),
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    runs: maskRuns(candidate.mask),
    slice: candidate.slice,
    slices: 1,
  };
  objects.push(object);
  log.log(`Object ${id}: ${object.claimed.length} px (mask ${object.area} px, token ${object.token}, predicted IoU ${object.score.toFixed(3)})`, "info", "analysis");
  resetPrompt();
  refreshOverlay();
  refreshOutputs();
  draw();
  updateControls();
  status(`Object ${id} accepted · ${objects.length} ${objects.length === 1 ? "object" : "objects"}`);
  return object;
}

function clearPrompt() {
  resetPrompt();
  refreshOverlay();
  draw();
  updateControls();
}

function undo() {
  if (pending3D) {
    pending3D = null;
    refreshOverlay();
    draw();
    updateControls();
    return;
  }
  if (hasPrompt(prompt)) {
    if (promptOrder.pop() === "box") prompt.box = null;
    else prompt.points.pop();
    void promptChanged();
    return;
  }
  const object = objects.pop();
  if (!object) return;
  uncommitObject(labels, object.claimed);
  nextId = object.id;
  refreshOverlay();
  refreshOutputs();
  draw();
  updateControls();
  status(`Object ${object.id} removed`);
}

function setSlice(nextSlice) {
  if (!is3D()) return;
  const clamped = Math.max(0, Math.min(input.depth - 1, nextSlice));
  if (clamped === currentSlice) return;
  currentSlice = clamped;
  if (!pending3D) resetPrompt();
  refreshBase();
  refreshOverlay();
  draw();
  updateControls();
}

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("wheel", (event) => {
  if (!is3D() || loading || embedRun || propagateRun) return;
  event.preventDefault();
  setSlice(currentSlice + (event.deltaY > 0 ? 1 : -1));
}, { passive: false });
canvas.addEventListener("pointerdown", (event) => {
  if (!ready() || (event.button !== 0 && event.button !== 2)) return;
  canvas.setPointerCapture(event.pointerId);
  const start = toImage(event);
  drag = { start, end: start, screen: [event.clientX, event.clientY], moved: false, negative: event.button === 2 || event.shiftKey };
});
canvas.addEventListener("pointermove", (event) => {
  if (input) {
    const pixel = clickPixel(...toImage(event), input.width, input.height);
    const slice = sliceLabels(currentSlice);
    const objId = pixel ? slice[pixel[1] * input.width + pixel[0]] : 0;
    const zPart = is3D() ? ` · z ${currentSlice}` : "";
    $("location").textContent = pixel ? `x ${pixel[0]} · y ${pixel[1]}${zPart}${objId ? ` · object ${objId}` : ""}` : "";
  }
  if (!drag) return;
  drag.end = toImage(event);
  const ratio = window.devicePixelRatio || 1;
  drag.moved ||= Math.hypot(event.clientX - drag.screen[0], event.clientY - drag.screen[1]) * ratio > DRAG_PIXELS * ratio;
  if (drag.moved) draw();
});
canvas.addEventListener("pointerup", (event) => {
  if (!drag) return;
  const { start, moved, negative } = drag;
  drag = null;
  if (moved) {
    const box = boxFromCorners(start, toImage(event), input.width, input.height);
    if (box) void setBox(box);
    else draw();
    return;
  }
  const pixel = clickPixel(...start, input.width, input.height);
  if (pixel) void addPoint(pixel[0], pixel[1], negative || negativeTool ? 0 : 1);
});
canvas.addEventListener("pointercancel", () => {
  drag = null;
  draw();
});

$("sliceSlider").addEventListener("input", () => setSlice(Number($("sliceSlider").value)));
$("positiveTool").onclick = () => {
  negativeTool = false;
  updateControls();
};
$("negativeTool").onclick = () => {
  negativeTool = true;
  updateControls();
};
$("acceptButton").onclick = () => void accept().catch(report);
$("propagateButton").onclick = () => void propagate3D().catch(report);
$("clearButton").onclick = clearPrompt;
$("undoButton").onclick = undo;
document.addEventListener("keydown", (event) => {
  if (event.target.closest?.("input, select, textarea, dialog") || !input) return;
  if (event.key === "Enter" && (pending || pending3D)) {
    event.preventDefault();
    void accept().catch(report);
  } else if (event.key === "Escape" && (hasPrompt(prompt) || pending3D)) {
    clearPrompt();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  } else if (is3D() && (event.key === "[" || event.key === "ArrowDown")) {
    event.preventDefault();
    setSlice(currentSlice - 1);
  } else if (is3D() && (event.key === "]" || event.key === "ArrowUp")) {
    event.preventDefault();
    setSlice(currentSlice + 1);
  }
});

$("embedButton").onclick = () => void computeEmbedding().catch(report);
$("model").addEventListener("change", () => {
  resetEmbeddings();
  if (input) {
    refreshOverlay();
    draw();
    status(`${selectedModel().label} selected · compute embeddings to prompt`);
  }
  updateControls();
});
$("channel").addEventListener("change", () => {
  resetEmbeddings();
  refreshBase();
  refreshOverlay();
  refreshOutputs();
  draw();
  updateControls();
  status(`${choice().label} selected · compute embeddings to prompt it`);
});

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  embedRun?.abort();
  propagateRun?.abort();
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

// ---------------------------------------------------------------------------------------------
// Automation: the same steps with prompts given as JSON.

function selectChannel(index) {
  if (index > input.planes.length) throw new Error(`${input.file.name} has ${input.planes.length} channels; channel ${index} does not exist.`);
  $("channel").value = index === 0 ? input.choices[0].id : String(index - 1);
  refreshBase();
}

registerAppAutomation({
  app: APP.id,
  operations: {
    segment: async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      selectChannel(parameters.channel ?? 0);
      const model = modelById(parameters.model ?? DEFAULT_MODEL_ID);
      $("model").value = model.id;
      const prompts = parsePrompts(parameters.prompts, input.width, input.height, input.depth);
      const backend = parameters.backend ?? "auto";
      for (const item of prompts) {
        signal?.throwIfAborted();
        const slice = item.slice ?? 0;
        if (is3D()) setSlice(slice);
        if (!sliceEmbedded(slice)) await computeEmbedding(signal, backend, slice);
        prompt = { points: structuredClone(item.points), box: item.box ? [...item.box] : null };
        promptOrder = [...prompt.points.map(() => "point"), ...(prompt.box ? ["box"] : [])];
        await promptChanged();
        if (item.propagate && is3D()) {
          await propagate3D(signal, {
            iouThreshold: parameters.iouThreshold ?? 0.5,
            boxExtension: parameters.boxExtension ?? 0.1,
            requestedBackend: backend,
          });
        }
        if (!(await accept())) throw new Error("The decoder returned no mask.");
      }
      return {
        artifacts: [{ role: "labels", file: outputs.labels.file }, { role: "table", file: outputs.table.file }],
        provenance: {
          method: "micro-sam interactive segmentation",
          model: model.name,
          encoderSha256: model.encoder.sha256,
          decoderSha256: model.decoder.sha256,
          channel: choice().label,
          backend: embedding.backend,
          embeddingSeconds: Number(embedding.seconds.toFixed(2)),
          embedding: embedding.summary,
          depth: input.depth,
          objects: objects.map(({ id, token, score, area, sha256, runs, prompt: used, claimed, slices, slice }) => ({
            id,
            token,
            score,
            area,
            claimed: claimed.length,
            ...(sha256 ? { sha256 } : {}),
            ...(runs ? { runs } : {}),
            ...(is3D() ? { slice, slices } : {}),
            prompt: used,
          })),
        },
      };
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  embedRun?.abort();
  propagateRun?.abort();
  stopWorker(embedding?.worker);
});

updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results });
