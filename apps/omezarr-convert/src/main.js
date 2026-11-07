// OME-Zarr Converter: a microscopy image to a multiscale OME-Zarr (NGFF 0.4 or 0.5). Reading,
// the pyramid and the writer are @neurodesk/omezarr-convert; this file is the interface, the
// archive or folder the chunks go to, and the preview read back from what was written.
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
  renderInfoIcon,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { formatBytes } from "@neurodesk/webapp-components/file-io/input-limits";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { archiveName, conversionPlan, openSource, withMetadata, writeOmeZarr, zipStore } from "@neurodesk/omezarr-convert";
import { mapStore, openImage, openLevel, readVolume } from "@neurodesk/omezarr-convert/readback";
import { ARCHIVE_MAX_BYTES, APP, archiveRefusal, conversionReport, describeSource, displayUnit, formSettings, metadataOverrides, noteLine, outputStem } from "./config.js";
import { channelColormap, channelNifti, displayGeometry, previewLevel, readSourcePreview, trueMicrometres, voxelMillimetres } from "./preview.js";
import { ARRAY_TYPES } from "@neurodesk/omezarr-convert/pyramid";
import { directoryStore } from "./directory-store.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Microscopy images to OME-Zarr",
  controlsContract: { privacy: "#privacyBtn" },
});

const SLICE_TYPES = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const viewer = new NiiVue({ isDragDropEnabled: false });
let layout = SLICE_TYPE.MULTIPLANAR;
let attached = null;
// The displayed volumes' scaling (see displayGeometry), units and channel labels.
let geometry = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = layout;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", ({ detail }) => {
      if (!geometry) return;
      // Without a unit the scale was drawn as millimetres, so undo trueMicrometres' factor of 1000.
      const perUnit = geometry.units === "µm" ? 1 : 1e-3;
      const position = trueMicrometres(detail.mm, geometry).map((value) => (value * perUnit).toPrecision(4)).join(", ");
      const values = detail.values.map((value, c) => `${geometry.labels[c] ?? ""} ${Number(value.value?.toPrecision?.(5) ?? value.value)}`.trim());
      $("location").textContent = `${position} ${geometry.units} · ${values.join(" · ")}`;
    });
  });
  return attached;
}
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

if (typeof window.showDirectoryPicker === "function") $("destinationField").hidden = false;

// What the reader assumed, changed or left out, as one line under the file description with
// the full text in its tooltip (and each note in the console).
function showNotes(notes) {
  const line = noteLine(notes);
  const element = $("fileNotes");
  element.hidden = !line;
  element.replaceChildren();
  if (!line) return;
  const text = document.createElement("span");
  text.textContent = line.text;
  element.append(text, renderInfoIcon(line.detail, { label: "What the conversion changes" }));
  bindInfoTooltips(element);
}

// The opened source and its files, the controllers of a load or conversion in progress, the
// last conversion's output ({ store, version, archive, report, folder }) and its result rows.
let input = null;
let loading = null;
let running = null;
let output = null;
let metadataEdited = false;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: () => {
    if (output) void showOutput(output).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutput() {
  output = null;
  results.render();
  $("outputSection").open = false;
}

const FORM_IDS = ["imageInput", "ngffVersion", "method", "sizeX", "sizeY", "sizeZ", "sizeUnit", "chunkSize", "compression", "destination"];
function setBusy(busy) {
  results.inert = busy;
  for (const id of FORM_IDS) $(id).disabled = busy;
  for (const field of $("channelNames").querySelectorAll("input")) field.disabled = busy;
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
  status(message);
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

// Voxel sizes are shown in one unit; the file's own sizes and units stay unless the user edits them.
function showMetadata(source) {
  const unit = displayUnit(source);
  $("sizeUnit").value = unit.name;
  for (const axis of ["x", "y", "z"]) $(`size${axis.toUpperCase()}`).value = unit.values[axis] ?? "";
  metadataEdited = false;
  const names = $("channelNames");
  names.replaceChildren();
  source.channels.forEach((channel, index) => {
    const field = document.createElement("div");
    field.className = "nd-field";
    const label = document.createElement("label");
    label.htmlFor = `channelName${index}`;
    label.textContent = `Channel ${index + 1} name`;
    const text = document.createElement("input");
    text.id = `channelName${index}`;
    text.type = "text";
    text.value = channel.label ?? "";
    text.placeholder = `Channel ${index}`;
    field.append(label, text);
    names.append(field);
  });
  // A file without a voxel size needs one from the user, so the section opens.
  if (!unit.complete) $("metadataSettings").open = true;
}

for (const id of ["sizeX", "sizeY", "sizeZ", "sizeUnit"]) $(id).addEventListener("input", () => { metadataEdited = true; });

// The example's attribution travels with its provenance however its file arrives (the example
// menu, a drop, automation): a file of the example's name and size is hashed and compared.
async function exampleAttribution(files) {
  if (files.length !== 1) return null;
  const [file] = files;
  for (const example of examples) {
    const pinned = example.files.find(({ name, bytes }) => name === file.name && bytes === file.size);
    if (!pinned || !example.attribution) continue;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
    if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") === pinned.sha256) return example.attribution;
  }
  return null;
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    const source = await openSource(files, { signal: current });
    current.throwIfAborted();
    // Reading every plane for the preview also proves the file decodes before it is admitted.
    await showSource(source, current);
    current.throwIfAborted();
    input = { source, files, attribution: await exampleAttribution(files) };
    clearOutput();
    showMetadata(source);
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = describeSource(source, files);
    showNotes(source.notes);
    $("dropZone").classList.add("has-files");
    log.log(`${source.format}: ${describeSource(source, files)}`, "info");
    for (const { detail } of source.notes) log.log(detail, "warning");
    progress.setProgress(0);
    status(`${files.length === 1 ? files[0].name : `${files.length} files`} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

function settingsFromForm() {
  return formSettings({
    version: $("ngffVersion").value,
    method: $("method").value,
    chunk: Number($("chunkSize").value),
    compressionLevel: $("compression").valueAsNumber,
    destination: $("destination").value,
  });
}

function metadataFromForm() {
  return metadataOverrides({
    edited: metadataEdited,
    sizes: { x: $("sizeX").value, y: $("sizeY").value, z: $("sizeZ").value },
    unit: $("sizeUnit").value,
    labels: [...$("channelNames").querySelectorAll("input")].map((field) => field.value),
  });
}

// One NiiVue layer per channel: the first in its colour (grey for one channel), the others
// over it with values below 2 % of their window transparent. Min-is-white channels are drawn
// with the colormap inverted, as omero's `inverted` asks.
async function showChannels(shape, spacing, channels, units, signal) {
  const display = displayGeometry(shape, spacing);
  const volumes = channels.map(({ data, label, color, inverted, range: [low, high] }, c) => ({
    url: channelNifti(data, shape, display.spacing, `${label}.nii`),
    name: label,
    colormap: channels.length === 1 ? "gray" : channelColormap(color),
    calMin: c === 0 ? low : low + (high - low) * 0.02,
    calMax: high > low ? high : low + 1,
    opacity: c === 0 ? 1 : 0.8,
    isColormapInverted: inverted === true,
  }));
  signal?.throwIfAborted();
  await viewerReady();
  geometry = { ...display, units, labels: channels.map(({ label }) => label) };
  $("location").textContent = "";
  await viewer.loadVolumes(volumes);
  $("emptyState").hidden = true;
}

async function showNoPreview(message) {
  if (attached) await viewer.removeAllVolumes();
  geometry = null;
  $("emptyState").hidden = false;
  $("emptyState").textContent = message;
}

async function showSource(source, signal) {
  const preview = await readSourcePreview(source, { signal, onPlane: (fraction) => progress.setProgress(fraction, "Reading image for the preview…") });
  if (!preview) {
    await showNoPreview("Too large to preview before conversion; convert to view the pyramid.");
    return;
  }
  const channels = source.channels.map((channel, c) => ({ data: preview.volumes[c].data, label: channel.label ?? `Channel ${c}`, color: channel.color, inverted: channel.inverted, range: preview.volumes[c].range }));
  await showChannels(preview.shape, preview.spacing, channels, source.units.x ? "µm" : "(no unit)", signal);
  log.log(`Viewing the input${preview.stride > 1 ? `, every ${preview.stride}th pixel in Y and X` : ""}`, "info");
}

async function showOutput({ store, version }, signal) {
  const image = await openImage(store);
  const plan = await Promise.all(image.multiscales.datasets.map((_, level) => openLevel(image, level)));
  const level = previewLevel(plan.map((array) => array.shape), ARRAY_TYPES[plan[0].dtype]?.BYTES_PER_ELEMENT ?? 8);
  if (level < 0) {
    await showNoPreview("The OME-Zarr was written; even its smallest level is too large to preview here.");
    log.log("No preview: every level of the output is above the 1 GB preview limit", "info");
    return;
  }
  const array = plan[level];
  const [, count, depth, height, width] = array.shape;
  const spacing = voxelMillimetres(image.multiscales.axes, image.multiscales.datasets[level].coordinateTransformations[0].scale);
  const channels = [];
  for (let c = 0; c < count; c += 1) {
    signal?.throwIfAborted();
    const { label, color, window, inverted } = image.omero.channels[c];
    channels.push({ data: await readVolume(array, 0, c), label, color, inverted, range: [window.start, window.end] });
  }
  const unit = image.multiscales.axes.find(({ name }) => name === "x")?.unit;
  await showChannels([depth, height, width], spacing, channels, unit ? "µm" : "(no unit)", signal);
  log.log(`Viewing level ${level} (${height} × ${width} × ${depth}) of the ${version === "0.5" ? ".ozx" : "Zarr v2"} output, read back from what was written`, "info");
}

async function convert(signal, settings = settingsFromForm(), overrides = metadataFromForm(), folder = null) {
  if (!input) throw new Error("Load an image before converting it.");
  const source = withMetadata(input.source, overrides);
  // An archive is assembled in memory: refuse it from its worst-case size before any work.
  const refusal = folder ? null : archiveRefusal(source, settings);
  if (refusal) throw new Error(refusal);
  const operation = begin(`Converting ${source.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  clearOutput();
  let store = null;
  try {
    const stem = outputStem(source);
    const map = new Map();
    store = folder ? await directoryStore(folder, `${stem}.ome.zarr`) : { set: (key, value) => map.set(key, value), get: async (key) => map.get(key.replace(/^\//, "")) };
    const plan = conversionPlan(source.shape, settings);
    log.log(`OME-Zarr ${settings.version}, ${settings.method} pyramid of ${plan.length} levels (${plan.map(({ shape }) => `${shape[3]} × ${shape[4]}`).join(", ")}), chunks ${settings.chunk} px, compression ${settings.compressionLevel}`, "info");
    const started = performance.now();
    const written = await writeOmeZarr(source, store, settings, {
      signal: current,
      maxBytes: folder ? Infinity : ARCHIVE_MAX_BYTES,
      onProgress: (fraction, { t, z }) => progress.setProgress(fraction, `Converting… plane ${z + 1} of ${source.shape.z}${source.shape.t > 1 ? `, time ${t + 1}` : ""}`),
    });
    const seconds = (performance.now() - started) / 1000;
    const report = conversionReport({ source, files: input.files.map((file) => file.name), settings, written, seconds, attribution: input.attribution });
    const reportFile = new File([JSON.stringify(report, null, 2)], `${stem}.conversion.json`, { type: "application/json" });
    const rows = {};
    let archive = null;
    if (!folder) {
      progress.setProgress(1, "Building the archive…");
      archive = new File([await zipStore(map, settings.version, { signal: current })], archiveName(stem, settings.version), { type: "application/zip" });
      rows.archive = { description: `OME-Zarr ${settings.version} · ${plan.length} level${plan.length === 1 ? "" : "s"} · ${formatBytes(archive.size)}`, file: archive };
    }
    rows.report = { description: "Conversion report", file: reportFile, viewable: false };
    output = { store: folder ? store : mapStore(map), version: settings.version, archive, report: reportFile, folder: folder ? `${stem}.ome.zarr` : null };
    results.render(rows);
    $("outputSection").open = true;
    log.log(`Wrote ${written.chunksWritten} chunks (${formatBytes(written.bytesWritten)}) in ${seconds.toFixed(1)} s${folder ? ` to ${folder.name}/${stem}.ome.zarr` : ""}`, "info");
    // The store is complete from here: a preview that fails or is cancelled keeps the outputs.
    try {
      await showOutput(output, current);
    } catch (error) {
      const cancelled = error.name === "AbortError";
      log.log(`The written OME-Zarr was not previewed: ${cancelled ? "cancelled" : error.message}`, cancelled ? "info" : "error");
      // The viewer must not go on showing the input as if it were the output.
      await showNoPreview(`The OME-Zarr was written; its preview was ${cancelled ? "cancelled" : "not possible"}.`).catch(() => {});
    }
    const done = folder ? `Saved to ${folder.name}/${stem}.ome.zarr` : "OME-Zarr ready";
    progress.end(done);
    status(done);
    return {
      artifacts: [...(archive ? [{ role: "archive", file: archive }] : []), { role: "summary", file: reportFile }],
      provenance: report,
    };
  } catch (error) {
    clearOutput();
    // A folder conversion that did not finish leaves nothing behind, so the folder takes a retry.
    if (folder && store?.discard) {
      await store.discard().catch((cleanup) => log.log(`Could not remove ${folder.name}/${store.name}: ${cleanup.message}`, "error"));
    }
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

$("runButton").addEventListener("click", async () => {
  let settings;
  let overrides;
  try {
    settings = settingsFromForm();
    overrides = metadataFromForm();
  } catch (error) {
    $(error.field === "metadata" ? "metadataSettings" : "advancedSettings").open = true;
    report(error);
    return;
  }
  let folder = null;
  if (settings.destination === "folder") {
    try {
      // The picker must open within the click, before any other await.
      folder = await window.showDirectoryPicker({ id: "omezarr-convert", mode: "readwrite" });
    } catch (error) {
      report(error.name === "AbortError" ? new Error("No folder chosen") : error);
      return;
    }
  }
  void convert(undefined, settings, overrides, folder).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    convert: async ({ inputs, parameters, signal }) => {
      const settings = formSettings({ ...parameters, destination: "archive" });
      await loadFiles(Promise.resolve(inputs.image), signal);
      $("ngffVersion").value = settings.version;
      $("method").value = settings.method;
      return convert(signal, settings, metadataFromForm());
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, output: () => output });
