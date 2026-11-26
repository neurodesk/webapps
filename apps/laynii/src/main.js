// LayNii cortical layering (LN2_LAYERS) and laminar profiling (LN2_PROFILE) in WebAssembly.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./laynii.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createNiivueVolumePreview,
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
import { describeNiftiFile } from "@neurodesk/webapp-components/file-io/nifti";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { imageFiles, registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import {
  gridMismatchRefusal,
  inspectNiftiHeader,
  inspectRimHeader,
  inspectRimValues,
  inspectSignalCaveats,
  readRawNiftiVoxels,
} from "@neurodesk/laynii";
import layniiWorkerUrl from "@neurodesk/laynii/worker?worker&url";
import {
  APP,
  layniiSettings,
  outputFileName,
  profileSourceLabel,
  provenance,
  renderProfileSvg,
  stemName,
  volumeRefusal,
} from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Cortical layers and laminar profiles",
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
let showingReport = false;

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

const toolbar = createViewerToolbar({
  views: [
    { id: "multiplanar", label: "Multi", active: true },
    { id: "axial", label: "Axial" },
    { id: "coronal", label: "Coronal" },
    { id: "sagittal", label: "Sagittal" },
    { id: "render", label: "3D" },
    { id: "profile", label: "Profile", hidden: true },
  ],
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
});

function setReportVisible(visible) {
  showingReport = visible;
  $("profileReport").hidden = !visible;
  $("gl1").hidden = visible;
  if (visible) {
    $("emptyState").hidden = true;
  } else {
    $("emptyState").hidden = Boolean(rim);
    if (attached) void attached.then(() => { viewer.sliceType = layout; viewer.drawScene?.(); });
  }
}

function setProfileTabEnabled(enabled) {
  const tab = toolbar.querySelector('.nd-view-tab[data-view="profile"]');
  if (tab) tab.hidden = !enabled;
}
setProfileTabEnabled(false);

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  if (detail.value === "profile") {
    setReportVisible(true);
    return;
  }
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  setReportVisible(false);
});
$("viewer").prepend(toolbar);

const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const signalField = createFileField({
  id: "signalInput",
  label: "Signal map",
  kind: "image",
  text: "Drop a matched 3D signal map for LN2_PROFILE",
});
$("signalField").append(signalField);

let rim = null;
let signal = null;
let loading = null;
let running = null;
let outputs = {};
let lastProfile = null;
let loadQueue = Promise.resolve();

function enqueueLoad(task) {
  const next = loadQueue.catch(() => {}).then(task);
  loadQueue = next.catch(() => {});
  return next;
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const preview = createNiivueVolumePreview({ viewer, ready: Promise.resolve(), emptyState: $("emptyState") });

async function showVolume(volume, options) {
  setReportVisible(false);
  const activeTab = toolbar.querySelector('.nd-view-tab[aria-pressed="true"]');
  if (activeTab?.dataset.view === "profile") {
    toolbar.querySelector('.nd-view-tab[data-view="multiplanar"]')?.click();
  }
  await viewerReady();
  return preview(volume, options);
}

async function showOverlayOnBase(baseFile, overlayFile, options = {}, abortSignal = undefined) {
  return showVolume({ file: baseFile, overlay: { file: overlayFile } }, { ...options, signal: abortSignal });
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage, result) => {
    if (stage === "profile") {
      toolbar.querySelector('.nd-view-tab[data-view="profile"]')?.click();
      return;
    }
    log.log(`Showing ${result.file.name}`, "info");
    if (result.overlayOn) {
      void showOverlayOnBase(result.overlayOn, result.file, result.overlayOptions).catch((error) => status(error.message, true));
    } else {
      void showVolume({ file: result.file }).catch((error) => status(error.message, true));
    }
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearProfileView() {
  lastProfile = null;
  setProfileTabEnabled(false);
  $("profileSummary").textContent = "";
  $("profileChart").innerHTML = "";
  $("profileBody").innerHTML = "";
  if (showingReport) setReportVisible(false);
}

function renderProfileView(profile, signalName, csvFile) {
  lastProfile = { ...profile, file: csvFile };
  const totalVoxels = profile.rows.reduce((sum, row) => sum + row.voxels, 0);
  const label = profileSourceLabel(profile.layerSource);
  const warningText = profile.warnings?.length ? ` Note: ${profile.warnings.join(" ")}` : "";
  $("profileSummary").textContent = `${signalName} across ${profile.rows.length} ${label} layers (${totalVoxels.toLocaleString()} GM voxels).${warningText}`;
  $("profileChart").innerHTML = renderProfileSvg(profile.rows);
  const tbody = $("profileBody");
  tbody.innerHTML = "";
  for (const row of profile.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.layer}</td><td>${row.mean.toFixed(4)}</td><td>${row.std.toFixed(4)}</td><td>${row.voxels.toLocaleString()}</td>`;
    tbody.append(tr);
  }
  setProfileTabEnabled(true);
}

function clearOutputs() {
  outputs = {};
  results.render();
  clearProfileView();
  $("outputSection").open = false;
}

function updateRunButtonLabel() {
  $("runButton").textContent = signal ? "Compute layers & profile" : "Compute layers";
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of [
    "imageInput",
    "nrLayers",
    "equivol",
    "iterSmooth",
    "thickness",
    "curvature",
    "inclBorders",
    "equalCounts",
    "noSmooth",
    "clearSignal",
  ]) {
    $(id).disabled = busy;
  }
  signalField.disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !rim;
}

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function clearSignal() {
  signal = null;
  signalField.setText("Drop a matched 3D signal map for LN2_PROFILE");
  signalField.setHasFiles(false);
  $("clearSignal").hidden = true;
  syncInputFiles("signalInput", []);
  updateRunButtonLabel();
}

function begin(message, abortSignal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  abortSignal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(abortSignal.reason);
  abortSignal?.addEventListener("abort", abort, { once: true });
  setBusy(true);
  progress.begin(message);
  status(message);
  return { controller, release: () => abortSignal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

function loadRimFiles(filesPromise, abortSignal) {
  return enqueueLoad(async () => {
    const operation = begin("Reading rim volume…", abortSignal);
    loading = operation.controller;
    const current = operation.controller.signal;
    try {
      const files = await filesPromise;
      const images = await readImageFiles(files, { signal: current });
      current.throwIfAborted();
      if (images.length !== 1) throw new Error(`Choose one 3D rim NIfTI volume; this selection has ${images.length}.`);
      const [file] = images;
      if (!file.size) throw new Error(`${file.name} is empty.`);
      const description = await describeNiftiFile(file);
      const refusal = volumeRefusal(description, "Rim image");
      if (refusal) throw new Error(refusal);
      const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
      const header = inspectNiftiHeader(buffer);
      const headerCheck = inspectRimHeader(header);
      if (!headerCheck.valid) throw new Error(headerCheck.reason);
      const rawValues = readRawNiftiVoxels(buffer, header);
      const rimCheck = inspectRimValues(rawValues);
      if (!rimCheck.valid) throw new Error(rimCheck.reason);
      current.throwIfAborted();
      await showVolume({ file }, { signal: current });
      current.throwIfAborted();
      rim = { file, buffer, description, header, counts: rimCheck };
      if (signal) {
        const mismatch = gridMismatchRefusal(header, signal.header, "Signal image");
        if (mismatch) {
          log.log(`Cleared previous signal map: ${mismatch}`, "info");
          clearSignal();
        }
      }
      clearOutputs();
      syncInputFiles("imageInput", files);
      $("fileInfo").hidden = false;
      $("fileInfo").textContent = `${file.name} · ${description.dims.join(" × ")} · ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm · ${rimCheck.total.toLocaleString()} rim voxels`;
      $("dropZone").classList.add("has-files");
      updateRunButtonLabel();
      progress.setProgress(0);
      status(`${file.name} loaded`);
    } catch (error) {
      progress.reset();
      throw error;
    } finally {
      loading = null;
      finish(operation);
    }
  });
}

function loadSignalFiles(filesPromise, abortSignal) {
  return enqueueLoad(async () => {
    const operation = begin("Reading signal map…", abortSignal);
    loading = operation.controller;
    const current = operation.controller.signal;
    try {
      const files = await filesPromise;
      const images = await readImageFiles(files, { signal: current });
      current.throwIfAborted();
      if (images.length !== 1) throw new Error(`Choose one 3D signal NIfTI volume; this selection has ${images.length}.`);
      const [file] = images;
      if (!file.size) throw new Error(`${file.name} is empty.`);
      const description = await describeNiftiFile(file);
      const refusal = volumeRefusal(description, "Signal image");
      if (refusal) throw new Error(refusal);
      const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
      const header = inspectNiftiHeader(buffer);
      if (rim) {
        const mismatch = gridMismatchRefusal(rim.header, header, "Signal image");
        if (mismatch) throw new Error(mismatch);
      }
      const rawValues = readRawNiftiVoxels(buffer, header);
      const caveats = inspectSignalCaveats(header, rawValues);
      for (const warning of caveats.warnings) log.log(`Warning: ${warning}`, "info");
      current.throwIfAborted();
      signal = { file, buffer, description, header, caveats };
      clearOutputs();
      signalField.setText(`${file.name} · ${description.dims.join(" × ")}`);
      signalField.setHasFiles(true);
      $("clearSignal").hidden = false;
      syncInputFiles("signalInput", [file]);
      updateRunButtonLabel();
      progress.setProgress(0);
      status(`Signal map ${file.name} loaded`);
    } catch (error) {
      progress.reset();
      throw error;
    } finally {
      loading = null;
      finish(operation);
    }
  });
}

/** Run LayNii in a fresh dedicated worker; aborting terminates it immediately, freeing WASM memory. */
function runLayniiInWorker(message, transfer, abortSignal) {
  abortSignal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(layniiWorkerUrl, { type: "module" });
    const stop = () => {
      abortSignal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(abortSignal.reason);
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The LayNii worker failed to start."));
    };
    worker.onmessageerror = () => {
      stop();
      reject(new Error("The LayNii worker returned an unreadable message."));
    };
    worker.onmessage = ({ data }) => {
      stop();
      for (const line of data.log ?? []) log.log(line, "info");
      if (data.heapBytes) log.log(`LayNii WASM heap: ${Math.round(data.heapBytes / 2 ** 20)} MiB`, "info");
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve({ outputs: data.outputs, profile: data.profile });
    };
    worker.postMessage({ id: 1, ...message }, transfer);
  });
}

function formSettings() {
  return layniiSettings({
    nrLayers: $("nrLayers").valueAsNumber,
    equivol: $("equivol").checked,
    iterSmooth: $("iterSmooth").valueAsNumber,
    thickness: $("thickness").checked,
    curvature: $("curvature").checked,
    inclBorders: $("inclBorders").checked,
    equalCounts: $("equalCounts").checked,
    noSmooth: $("noSmooth").checked,
  });
}

function showSettings(settings) {
  $("nrLayers").value = String(settings.nrLayers);
  $("equivol").checked = settings.equivol;
  $("iterSmooth").value = String(settings.iterSmooth);
  $("thickness").checked = settings.thickness;
  $("curvature").checked = settings.curvature;
  $("inclBorders").checked = settings.inclBorders;
  $("equalCounts").checked = settings.equalCounts;
  $("noSmooth").checked = settings.noSmooth;
}

async function computeLayers(abortSignal, settings = formSettings()) {
  if (!rim) throw new Error("Load a rim volume before running LayNii.");
  const rimHeaderCheck = inspectRimHeader(rim.header);
  if (!rimHeaderCheck.valid) throw new Error(rimHeaderCheck.reason);
  const rimCheck = inspectRimValues(readRawNiftiVoxels(rim.buffer, rim.header));
  if (!rimCheck.valid) throw new Error(rimCheck.reason);
  if (signal) {
    const mismatch = gridMismatchRefusal(rim.header, signal.header, "Signal image");
    if (mismatch) throw new Error(mismatch);
  }

  const taskLabel = signal ? `Computing ${settings.nrLayers} layers & profile…` : `Computing ${settings.nrLayers} cortical layers…`;
  const operation = begin(taskLabel, abortSignal);
  running = operation.controller;
  const current = operation.controller.signal;
  clearOutputs();
  try {
    const started = performance.now();
    const rimCopy = rim.buffer.slice(0);
    const sigCopy = signal ? signal.buffer.slice(0) : null;
    const transfer = sigCopy ? [rimCopy, sigCopy] : [rimCopy];
    const { outputs: raw, profile } = await runLayniiInWorker(
      { rim: rimCopy, signal: sigCopy, ...settings },
      transfer,
      current,
    );
    const seconds = (performance.now() - started) / 1000;
    const artifacts = [];
    const resultRows = {
      input_rim: { description: "Input rim", file: rim.file },
    };
    if (signal) {
      resultRows.input_signal = { description: "Input signal", file: signal.file };
    }

    const specs = [
      ["layers_equidist", raw.layersEquidist, `Equidistant layers (${settings.nrLayers})`, "layers_equidist", true],
      ["metric_equidist", raw.metricEquidist, "Equidistant depth metric", "metric_equidist", false],
      ["midgm_equidist", raw.midGmEquidist, "Equidistant mid-GM", "midGM_equidist", true],
      ["layers_equivol", raw.layersEquivol, `Equivolume layers (${settings.nrLayers})`, "layers_equivol", true],
      ["metric_equivol", raw.metricEquivol, "Equivolume depth metric", "metric_equivol", false],
      ["midgm_equivol", raw.midGmEquivol, "Equivolume mid-GM", "midGM_equivol", true],
      ["layers_equicount", raw.layersEquicount, `Equal-count layers (${settings.nrLayers})`, "layers_equicount", true],
      ["thickness", raw.thickness, "Cortical thickness (mm)", "thickness", false],
      ["curvature", raw.curvature, "Cortical curvature", "curvature", false],
    ];

    for (const [role, bytes, description, suffix, isDiscrete] of specs) {
      if (!bytes) continue;
      const file = await gzipFile(bytes, outputFileName(rim.file.name, suffix), current);
      artifacts.push({ role, file });
      resultRows[role] = {
        description,
        file,
        overlayOn: signal && isDiscrete ? signal.file : null,
        overlayOptions: isDiscrete ? { colormap: "plasma", opacity: 0.65, calMin: 0.5 } : undefined,
      };
    }

    if (profile) {
      for (const warning of profile.warnings ?? []) log.log(`Warning: ${warning}`, "info");
      const csvFile = new File([profile.csv], `${stemName(signal.file.name)}_profile.csv`, { type: "text/csv" });
      artifacts.push({ role: "profile", file: csvFile });
      resultRows.profile = {
        description: "Laminar profile (CSV)",
        file: csvFile,
      };
      renderProfileView(profile, signal.file.name, csvFile);
    }

    const primaryLayerKey = resultRows.layers_equivol ? "layers_equivol" : "layers_equidist";
    const primaryLayer = resultRows[primaryLayerKey];
    if (primaryLayer.overlayOn) {
      await showOverlayOnBase(primaryLayer.overlayOn, primaryLayer.file, primaryLayer.overlayOptions, current);
    } else {
      await showVolume({ file: primaryLayer.file }, { signal: current });
    }
    current.throwIfAborted();

    outputs = resultRows;
    results.render(resultRows);
    $("outputSection").open = true;

    const runProvenance = provenance({
      rimName: rim.file.name,
      signalName: signal?.file.name ?? null,
      settings,
      profileSource: profile?.layerSource ?? null,
    });
    log.log(`Completed in ${seconds.toFixed(1)} s. Native equivalent: ${runProvenance.nativeCommand}`, "info");
    const doneMessage = profile ? "Layers and profile ready" : "Cortical layers ready";
    progress.end(doneMessage);
    status(doneMessage);
    return {
      artifacts,
      provenance: {
        ...runProvenance,
        seconds: Number(seconds.toFixed(1)),
        profileRows: profile?.rows ?? null,
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

function importRim(files) {
  exampleControl.cancel();
  return loadRimFiles(files).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};

$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importRim(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importRim);

signalField.onFiles((files) => {
  void loadSignalFiles(files).catch((error) => {
    syncInputFiles("signalInput", signal ? [signal.file] : []);
    report(error);
  });
});

$("clearSignal").onclick = () => {
  clearSignal();
  clearOutputs();
  status("Signal map removed");
};

$("downloadProfileCsv").onclick = () => {
  if (lastProfile?.file) downloadFile(lastProfile.file);
};

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal: abortSignal }) => {
    const files = await fetchFiles();
    assertCurrent();
    const rimFiles = [];
    const sigFiles = [];
    for (let i = 0; i < example.files.length; i++) {
      if (example.files[i].role === "signal") sigFiles.push(files[i]);
      else rimFiles.push(files[i]);
    }
    await loadRimFiles(Promise.resolve(rimFiles), abortSignal);
    assertCurrent();
    if (sigFiles.length) {
      await loadSignalFiles(Promise.resolve(sigFiles), abortSignal);
      assertCurrent();
    } else {
      clearSignal();
    }
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
  void computeLayers(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    layers: async ({ inputs, inputDetails, parameters, signal: abortSignal }) => {
      const settings = layniiSettings(parameters);
      showSettings(settings);
      await loadRimFiles(Promise.resolve(imageFiles(inputs, inputDetails)), abortSignal);
      if (inputs.signal?.length) {
        await loadSignalFiles(Promise.resolve(inputs.signal), abortSignal);
      } else {
        clearSignal();
      }
      return computeLayers(abortSignal, settings);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
