// micro-sam: interactive 2D segmentation of light-microscopy images with Segment Anything for
// Microscopy. src/preprocess.js and src/segmentation.js hold the numerics; src/worker.js runs the
// ONNX encoder once per image and the prompt decoder once per prompt change.
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
import { APP, MODEL } from "./config.js";
import { channelChoices, readImage, writeLabelTiff } from "./image-io.js";
import { channelToUint8, encoderTensor, resizedChannels, threeChannels } from "./preprocess.js";
import {
  boxFromCorners,
  clickPixel,
  commitObject,
  hasPrompt,
  maskRuns,
  measureObjects,
  objectsCsv,
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

// The loaded image ({ file, width, height, format, planes, choices }), the model input chosen
// from it, the worker holding its embedding, the objects accepted so far and the pending prompt.
let input = null;
let loading = null;
let embedding = null;
let embedRun = null;
let labels = null;
let objects = [];
let nextId = 1;
let prompt = { points: [], box: null };
let promptOrder = [];
let pending = null;
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

// ---------------------------------------------------------------------------------------------
// Viewer: the image as micro-sam sees it, the objects, the pending mask and the prompts.

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
  const planes = threeChannels(choice().planes).map((plane) => channelToUint8(plane.data));
  paintLayer(layers.base, baseRgba(planes, input.width, input.height));
}

function refreshOverlay() {
  paintLayer(layers.overlay, overlayRgba({
    labels, width: input.width, height: input.height, mode: display, opacity, preview: pending?.mask ?? null, previewId: nextId,
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
  if (prompt.box) drawBox(prompt.box, ratio, false);
  if (drag?.moved) {
    const box = boxFromCorners(drag.start, drag.end, input.width, input.height);
    if (box) drawBox(box, ratio, true);
  }
  for (const [x, y, label] of prompt.points) drawMarker(x, y, label === 1, ratio);
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

function ready() {
  return Boolean(embedding && embedding.choice === choice()?.id && !embedRun);
}

function updateControls() {
  const busy = Boolean(loading || embedRun || decoding);
  const prompting = ready();
  $("imageInput").disabled = busy;
  $("channel").disabled = busy;
  $("backend").disabled = busy;
  exampleControl?.setDisabled(busy);
  $("embedButton").disabled = busy || !input || prompting;
  $("positiveTool").disabled = !prompting;
  $("negativeTool").disabled = !prompting;
  $("acceptButton").disabled = !prompting || !pending || decoding !== null;
  $("clearButton").disabled = !hasPrompt(prompt);
  $("undoButton").disabled = !hasPrompt(prompt) && !objects.length;
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
  const planes = choice().planes;
  const rows = measureObjects(labels, input.width, planes, objects);
  const labelsFile = new File([writeLabelTiff(labels, input.width, input.height)], `${baseName()}_microsam-labels.tif`, { type: "image/tiff" });
  const tableFile = new File([objectsCsv(rows, planes)], `${baseName()}_microsam-objects.csv`, { type: "text/csv" });
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
  promptVersion++;
}

function resetSession() {
  embedRun?.abort();
  stopWorker(embedding?.worker);
  embedding = null;
  resetPrompt();
  objects = [];
  nextId = 1;
  labels = input ? new Uint32Array(input.width * input.height) : null;
  refreshOutputs();
}

// ---------------------------------------------------------------------------------------------
// Loading.

function begin(message, signal) {
  if (loading || embedRun) throw new Error("Wait for the current operation to finish, or cancel it.");
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
    if (files.length !== 1) throw new Error(`Choose one 2D image; this selection has ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const image = await readImage(file.name, await file.arrayBuffer());
    current.throwIfAborted();
    const choices = channelChoices(image);
    input = null;
    resetSession();
    input = { file, ...image, choices };
    labels = new Uint32Array(image.width * image.height);
    $("channel").replaceChildren(...choices.map((item) => new Option(item.label, item.id)));
    $("channelField").hidden = choices.length < 2;
    refreshBase();
    refreshOverlay();
    $("emptyState").hidden = true;
    draw();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${image.width} × ${image.height} · ${image.format}${image.planes.length > 1 ? ` · ${image.planes.length} channels` : ""}`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded · compute embeddings to start prompting`);
    log.log(`${file.name}: ${image.width} × ${image.height}, ${image.format}, ${image.planes.map((plane) => plane.label).join(", ")}`, "info", "analysis");
  } finally {
    loading = null;
    finish(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// The worker: one per image session, terminated to cancel the embedding.

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

async function computeEmbedding(signal, requested = $("backend").value) {
  if (!input) throw new Error("Load an image before computing its embedding.");
  const operation = begin(`Computing the embedding of ${input.file.name}…`, signal);
  embedRun = operation.controller;
  const current = operation.controller.signal;
  const selected = choice();
  stopWorker(embedding?.worker);
  embedding = null;
  resetPrompt();
  refreshOverlay();
  draw();
  updateControls();
  const worker = startWorker();
  const abort = () => stopWorker(worker);
  current.addEventListener("abort", abort, { once: true });
  try {
    const backend = await resolveBackend(requested);
    const resized = resizedChannels(selected.planes.map((plane) => plane.data), input.width, input.height);
    const tensor = encoderTensor(resized);
    log.log(`micro-sam ${MODEL.name} on ${selected.label} of ${input.file.name}, resized to ${resized.width} × ${resized.height}`, "info", "analysis");
    const result = await call(worker, { type: "embed", tensor, backend }, [tensor.buffer], current);
    current.throwIfAborted();
    embedding = { worker, choice: selected.id, backend: result.backend, seconds: result.seconds, summary: result.summary };
    progress.end("Embeddings ready · click or drag on the image");
    status(`Embeddings ready in ${result.seconds.toFixed(1)} s · click or drag on the image`);
    return embedding;
  } catch (error) {
    stopWorker(worker);
    progress.reset(input ? "Ready" : undefined);
    throw error;
  } finally {
    current.removeEventListener("abort", abort);
    embedRun = null;
    finish(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// Prompting: every change decodes the latest prompt; older answers are dropped.

async function decode(snapshot) {
  const result = await call(embedding.worker, { type: "decode", prompt: snapshot, height: input.height, width: input.width });
  return { mask: result.mask, score: result.score, token: result.token, prompt: structuredClone(snapshot) };
}

function promptChanged() {
  const version = ++promptVersion;
  if (!hasPrompt(prompt)) {
    pending = null;
    refreshOverlay();
    draw();
    updateControls();
    return Promise.resolve(null);
  }
  draw();
  const snapshot = structuredClone(prompt);
  const run = (decoding ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (version !== promptVersion || !ready()) return null;
    const result = await decode(snapshot);
    log.log(`Decoded ${JSON.stringify(snapshot)}: ${result.mask.reduce((sum, value) => sum + value, 0)} px, token ${result.token}, predicted IoU ${result.score.toFixed(3)}`, "info", "technical");
    if (version !== promptVersion) return null;
    pending = result;
    refreshOverlay();
    draw();
    return result;
  });
  decoding = run;
  updateControls();
  // A decode outrun by a newer prompt or ended with its session is not the user's error.
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

async function accept() {
  if (decoding) await decoding.catch(() => null);
  if (!pending || !ready()) return null;
  const id = nextId;
  const claimed = commitObject(labels, pending.mask, id);
  if (!claimed.length) throw new Error("This mask lies inside accepted objects; prompt a new object or undo one.");
  nextId++;
  const digest = await crypto.subtle.digest("SHA-256", pending.mask);
  const object = {
    id,
    claimed,
    score: pending.score,
    token: pending.token,
    prompt: pending.prompt,
    area: pending.mask.reduce((sum, value) => sum + value, 0),
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    runs: maskRuns(pending.mask),
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

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerdown", (event) => {
  if (!ready() || (event.button !== 0 && event.button !== 2)) return;
  canvas.setPointerCapture(event.pointerId);
  const start = toImage(event);
  drag = { start, end: start, screen: [event.clientX, event.clientY], moved: false, negative: event.button === 2 || event.shiftKey };
});
canvas.addEventListener("pointermove", (event) => {
  if (input) {
    const pixel = clickPixel(...toImage(event), input.width, input.height);
    $("location").textContent = pixel ? `x ${pixel[0]} · y ${pixel[1]}${labels[pixel[1] * input.width + pixel[0]] ? ` · object ${labels[pixel[1] * input.width + pixel[0]]}` : ""}` : "";
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

$("positiveTool").onclick = () => {
  negativeTool = false;
  updateControls();
};
$("negativeTool").onclick = () => {
  negativeTool = true;
  updateControls();
};
$("acceptButton").onclick = () => void accept().catch(report);
$("clearButton").onclick = clearPrompt;
$("undoButton").onclick = undo;
document.addEventListener("keydown", (event) => {
  if (event.target.closest?.("input, select, textarea, dialog") || !input) return;
  if (event.key === "Enter" && pending) {
    event.preventDefault();
    void accept().catch(report);
  } else if (event.key === "Escape" && hasPrompt(prompt)) {
    clearPrompt();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  }
});

$("embedButton").onclick = () => void computeEmbedding().catch(report);
$("channel").addEventListener("change", () => {
  stopWorker(embedding?.worker);
  embedding = null;
  resetPrompt();
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
      selectChannel(parameters.channel);
      const prompts = parsePrompts(parameters.prompts, input.width, input.height);
      await computeEmbedding(signal, parameters.backend);
      for (const item of prompts) {
        signal?.throwIfAborted();
        prompt = structuredClone(item);
        promptOrder = [...prompt.points.map(() => "point"), ...(prompt.box ? ["box"] : [])];
        await promptChanged();
        if (!(await accept())) throw new Error("The decoder returned no mask.");
      }
      return {
        artifacts: [{ role: "labels", file: outputs.labels.file }, { role: "table", file: outputs.table.file }],
        provenance: {
          method: "micro-sam interactive segmentation",
          model: MODEL.name,
          encoderSha256: MODEL.encoder.sha256,
          decoderSha256: MODEL.decoder.sha256,
          channel: choice().label,
          backend: embedding.backend,
          embeddingSeconds: Number(embedding.seconds.toFixed(2)),
          embedding: embedding.summary,
          objects: objects.map(({ id, token, score, area, sha256, runs, prompt: used, claimed }) => ({ id, token, score, area, claimed: claimed.length, sha256, runs, prompt: used })),
        },
      };
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  embedRun?.abort();
  stopWorker(embedding?.worker);
});

updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results });
