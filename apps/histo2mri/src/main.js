// Histology to MRI: register 2D histology sections to an MRI volume with Greedy (NMI). The
// pipeline (src/core) runs in one module worker per run (src/worker.js); this page reads the
// inputs, shows them in NiiVue and lists the outputs.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createFileField,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { decodeNiftiBuffer, downloadFile } from "@neurodesk/webapp-components/file-io";
import { parseNiftiVolume } from "@neurodesk/webapp-components/file-io/nifti";
import { assertNiftiDecodedSize, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { readTiffImage } from "@neurodesk/webapp-components/file-io/tiff";
import { decodeRasterImage } from "@neurodesk/webapp-components/file-io/raster-image";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { axisPlanes } from "./core/plane.js";
import { apply, invert } from "./core/matrix.js";
import { APP, classifyFiles, runSettings } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Histology section to MRI registration",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const SLICE_TYPES = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
};
const viewer = new NiiVue({ isDragDropEnabled: false });
let layout = SLICE_TYPE.MULTIPLANAR;
let overlayOpacity = 0.5;
let attached = null;
// The viewer attaches to its canvas with the first image, so an empty canvas shows only #emptyState.
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = layout;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
  });
  return attached;
}

const toolbar = createViewerToolbar({ window: false, overlay: true, colormap: false, download: false, screenshot: false });
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  if (attached && viewer.volumes.length > 1) void viewer.setVolume(1, { opacity: overlayOpacity });
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const sectionField = createFileField({ id: "sectionInput", label: "Histology sections", kind: "image", text: "Drop TIFF, PNG or JPEG sections" });
$("sectionField").append(sectionField);

// The loaded MRI ({ file, volume }), the sections ([{ file, image }]), the controller of a load
// or run in progress, and the last run's result rows.
let mri = null;
let sections = [];
let loading = null;
let running = null;
let outputs = {};

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

async function showVolumes(base, overlay = null) {
  await viewerReady();
  const volumes = [{ url: base, name: base.name, colormap: "gray" }];
  if (overlay) volumes.push({ url: overlay, name: overlay.name, opacity: overlayOpacity });
  await viewer.loadVolumes(volumes);
  $("emptyState").hidden = true;
}

// Moves the crosshair to the chosen slice's centre, through the shown volume's fraction frame.
function showSlice() {
  if (!mri || !attached || !viewer.volumes.length) return;
  const index = Number($("sliceIndex").value);
  const axis = Number($("axis").value);
  if (!Number.isFinite(index)) return;
  const voxel = mri.volume.dims.map((size) => (size - 1) / 2);
  voxel[axis] = index;
  const frac2mm = viewer.volumes[0].frac2mm;
  if (!frac2mm) return;
  // gl-matrix column-major to rows.
  const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => frac2mm[c * 4 + r]));
  const fraction = apply(invert(rows), apply(mri.volume.affine, voxel));
  viewer.crosshairPos = fraction.map((value) => Math.min(1, Math.max(0, value)));
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    log.log(`Showing ${result.file.name}`, "info");
    void showVolumes(result.base, result.file).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function updateRunButton() {
  $("runButton").disabled = Boolean(loading || running) || !mri || !sections.length;
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["mriInput", "axis", "sliceIndex", "sliceStep", "contrast", "orientation", "pixelSize", "tiltA", "tiltB", "refinePlane", "searchOffset", "searchTilt", "deformable"]) $(id).disabled = busy;
  sectionField.disabled = busy;
  exampleControl?.setDisabled(busy);
  updateRunButton();
}

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

// One load or run at a time: `begin` claims the slot and links the caller's signal; `finish`
// releases it whatever happened.
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

function arrayBuffer(bytes) {
  return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function readMri(file, signal) {
  if (!file.size) throw new Error(`${file.name} is empty.`);
  await assertNiftiDecodedSize(file);
  const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
  signal.throwIfAborted();
  const parsed = parseNiftiVolume(buffer);
  if (parsed.dims.filter((size) => size > 1).length < 3) throw new Error(`${file.name} is not a 3D volume.`);
  const data = parsed.imageData;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`${file.name} has NaN or infinite voxels; replace them (for example with 0) and load it again.`);
  }
  return { dims: parsed.dims, affine: Array.from(parsed.affine, (row) => Array.from(row)), data };
}

/** A section as interleaved samples ({ width, height, channels, data, maxValue, pixelSize }). */
async function readSection(file, signal) {
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (/\.tiff?$/i.test(file.name)) return readTiffImage(await file.arrayBuffer(), { signal, maxBytes: MAX_INPUT_BYTES / 4 });
  const { width, height, data } = await decodeRasterImage(file, { signal, maxBytes: MAX_INPUT_BYTES / 4 });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) rgb.set(data.subarray(i, i + 3), j);
  return { width, height, channels: 3, bitsPerSample: 8, maxValue: 255, data: rgb, pixelSize: null };
}

function describeSections() {
  $("sectionInfo").hidden = !sections.length;
  $("sectionInfo").textContent = sections.map(({ file, image }) => `${file.name} · ${image.width} × ${image.height}${image.channels === 3 ? " RGB" : ""}`).join("; ");
  $("stepField").hidden = sections.length < 2;
  sectionField.setText(sections.length ? `${sections.length} section${sections.length > 1 ? "s" : ""}` : "Drop TIFF, PNG or JPEG sections");
  sectionField.setHasFiles(sections.length > 0);
}

function nameAxes() {
  const planes = axisPlanes(mri.volume.affine);
  for (const option of $("axis").options) {
    const axis = Number(option.value);
    option.textContent = `${"ijk"[axis]} · ${planes[axis]} (${mri.volume.dims[axis]})`;
  }
}

/** Loads an MRI, sections or both; files of one kind leave the other input as it was. */
async function loadInputs(filesPromise, signal, { parameters = null } = {}) {
  const operation = begin("Reading inputs…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const { mri: mriFile, sections: sectionFiles } = classifyFiles(await filesPromise);
    if (!mriFile && !sectionFiles.length) throw new Error("Choose a NIfTI MRI or TIFF, PNG or JPEG sections.");
    const nextMri = mriFile ? { file: mriFile, volume: await readMri(mriFile, current) } : mri;
    const nextSections = [];
    for (const file of sectionFiles) {
      current.throwIfAborted();
      status(`Reading ${file.name}…`);
      nextSections.push({ file, image: await readSection(file, current) });
    }
    current.throwIfAborted();
    if (mriFile) await showVolumes(mriFile);
    current.throwIfAborted();
    if (mriFile) {
      mri = nextMri;
      syncInputFiles("mriInput", [mriFile]);
      $("mriInfo").hidden = false;
      $("mriInfo").textContent = `${mriFile.name} · ${mri.volume.dims.join(" × ")}`;
      $("dropZone").classList.add("has-files");
      nameAxes();
      $("sliceIndex").max = String(mri.volume.dims[Number($("axis").value)] - 1);
      if (!parameters) $("sliceIndex").value = String(Math.round((mri.volume.dims[Number($("axis").value)] - 1) / 2));
    }
    if (sectionFiles.length) {
      sections = nextSections;
      syncInputFiles("sectionInput", sectionFiles);
      describeSections();
    }
    if (parameters) {
      $("axis").value = String(parameters.axis);
      $("sliceIndex").value = String(parameters.index);
    }
    if (mriFile) showSlice();
    clearOutputs();
    progress.setProgress(0);
    status(mri && sections.length ? "Ready to register" : mri ? `${mri.file.name} loaded; add histology sections` : "Sections loaded; add the MRI");
  } finally {
    loading = null;
    finish(operation);
  }
}

function importFiles(files) {
  exampleControl.cancel();
  return loadInputs(files).catch((error) => status(
    error.name === "AbortError" ? "Loading cancelled" : error.message,
    error.name !== "AbortError",
  ));
}

function formValues() {
  return {
    axis: $("axis").value,
    index: $("sliceIndex").value,
    step: $("sliceStep").value,
    tiltA: $("tiltA").value,
    tiltB: $("tiltB").value,
    contrast: $("contrast").value,
    orientation: $("orientation").value,
    pixelSize: $("pixelSize").value,
    refinePlane: $("refinePlane").checked,
    searchOffset: $("searchOffset").value,
    searchTilt: $("searchTilt").value,
    deformable: $("deformable").checked,
  };
}

function fileFrom(bytes, name) {
  return new File([bytes], name, { type: name.endsWith(".json") ? "application/json" : name.endsWith(".mat") ? "text/plain" : "application/gzip" });
}

/** Runs the registration in a new worker; aborting terminates it. Resolves with the result rows. */
function runWorker(message, signal, onMessage) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      reject(signal.reason ?? new DOMException("Registration cancelled", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
    const done = () => {
      signal.removeEventListener("abort", stop);
      worker.terminate();
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(event.message || "The registration worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "error") {
        done();
        reject(new Error(data.message));
      } else if (data.type === "done") {
        done();
        onMessage(data);
        resolve();
      } else {
        onMessage(data);
      }
    };
    const volume = { ...mri.volume, data: mri.volume.data.slice() };
    worker.postMessage(message({ volume }), [volume.data.buffer]);
  });
}

async function register(signal, values = formValues()) {
  if (!mri || !sections.length) throw new Error("Load an MRI and at least one section first.");
  const settings = runSettings(values, mri.volume.dims, sections.length);
  const grey = sections.find(({ image }) => image.channels !== 3);
  if (settings.options.contrast !== "auto" && grey) throw new Error(`Colour deconvolution needs an RGB image; ${grey.file.name} is greyscale.`);
  const operation = begin("Registering…", signal);
  running = operation.controller;
  const current = running.signal;
  progress.setCancellable(true);
  clearOutputs();
  const rows = {};
  const reports = [];
  const artifacts = [];
  const axisName = axisPlanes(mri.volume.affine)[settings.plane.axis];
  try {
    await runWorker(({ volume }) => ({
      volume,
      sections: sections.map(({ file, image }) => ({ name: file.name, image })),
      plane: settings.plane,
      options: settings.options,
      version: APP.version,
      axisName,
    }), current, (data) => {
      if (data.type === "progress") {
        progress.setProgress(data.value, data.message);
        log.log(data.message, "info");
        return;
      }
      if (data.type === "section") {
        const { report } = data;
        reports.push(report);
        const plane = data.files.find((file) => file.kind === "plane");
        const planeFile = fileFrom(plane.bytes, plane.name);
        for (const file of data.files) {
          const output = fileFrom(file.bytes, file.name);
          artifacts.push({ role: file.kind, file: output });
          const label = { warped: "Warped section", plane: "MRI on the section plane", section: "Section contrast", affine: "Greedy affine", warp: "Greedy warp", report: "Registration report" }[file.kind];
          rows[`${data.index}:${file.kind}`] = {
            description: sections.length > 1 ? `${label} · ${data.name}` : label,
            file: output,
            base: file.kind === "warped" ? planeFile : output,
            viewable: ["warped", "plane", "section"].includes(file.kind),
          };
        }
        if (report.deformableRejected) log.log(`${data.name}: the deformable warp lowered NMI and was not kept`, "warning");
        log.log(`${data.name}: slice ${report.plane.index.toFixed(1)}, offset ${report.plane.offsetMm.toFixed(2)} mm, tilt ${report.plane.tiltDegrees.join("°, ")}°, NMI ${report.nmi.initial.toFixed(3)} → ${report.nmi.final.toFixed(3)}`, "info");
        return;
      }
      const [volumeFile] = data.files;
      const output = fileFrom(volumeFile.bytes, volumeFile.name);
      artifacts.push({ role: "volume", file: output });
      outputs = { volume: { description: "Sections in the MRI grid", file: output, base: mri.file, viewable: true }, ...rows };
      log.log(`${data.written} MRI voxels take a section's colour`, "info");
    });
    current.throwIfAborted();
    results.render(outputs);
    $("outputSection").open = true;
    await showVolumes(mri.file, outputs.volume.file);
    progress.end("Registration complete");
    status(`Registered ${sections.length} section${sections.length > 1 ? "s" : ""}; NMI ${reports.map((report) => report.nmi.final.toFixed(3)).join(", ")}`);
    return {
      artifacts,
      provenance: { app: APP.id, version: APP.version, method: "Greedy NMI rigid, affine and deformable registration in the section plane", reports },
    };
  } finally {
    running = null;
    finish(operation);
  }
}

$("runButton").addEventListener("click", () => {
  if (loading || running) return;
  register().catch((error) => {
    clearOutputs();
    progress.setProgress(0);
    status(error.name === "AbortError" ? "Registration cancelled" : error.message, error.name !== "AbortError");
  });
});
$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};
$("axis").addEventListener("change", () => {
  if (mri) $("sliceIndex").max = String(mri.volume.dims[Number($("axis").value)] - 1);
  showSlice();
});
$("sliceIndex").addEventListener("change", showSlice);
$("mriInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
// The section field reports its files (a promise) with nd-files; the page's own nd-files (syncInputFiles,
// dispatched on the input inside it) only tells the page drop which slots are filled.
sectionField.addEventListener("nd-files", (event) => {
  if (event.target === sectionField) void importFiles(Promise.resolve(event.detail.files));
});
bindFileDrop($("dropZone"), importFiles);

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadInputs(Promise.resolve(files), signal, { parameters: example.parameters });
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

registerAppAutomation({
  app: APP.id,
  operations: {
    register: async ({ inputs, parameters, signal }) => {
      await loadInputs(Promise.resolve([...(inputs.mri ?? []), ...(inputs.sections ?? [])]), signal, { parameters: { axis: parameters.axis ?? 2, index: parameters.index } });
      return register(signal, { ...formValues(), ...parameters });
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
