// BrkRaw in the browser: Bruker ParaVision ZIP or folder in, NIfTI-1 (.nii.gz) +
// privacy-scrubbed JSON sidecar out, matching BrkRaw v0.5.7.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from "@niivue/niivue";
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
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import appPackage from "../package.json";
import examples from "../examples.json";
import {
  APP,
  defaultRecoOf,
  normalizeSpace,
  normalizeSubjectPose,
  normalizeSubjectType,
  outputStem,
  parseRecoKey,
  recoKey,
  scanMetaSummary,
  scanOptionLabel,
} from "./config.js";

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

const layouts = {
  multiplanar: () => {
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.showRender = SHOW_RENDER.ALWAYS;
  },
  axial: () => { viewer.sliceType = SLICE_TYPE.AXIAL; },
  coronal: () => { viewer.sliceType = SLICE_TYPE.CORONAL; },
  sagittal: () => { viewer.sliceType = SLICE_TYPE.SAGITTAL; },
};

const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: "multiplanar", label: "3-Plane", active: true },
    { id: "axial", label: "Axial" },
    { id: "coronal", label: "Coronal" },
    { id: "sagittal", label: "Sagittal" },
  ].map((view) => ({
    ...view,
    onClick: () => {
      if (!viewer) return;
      layouts[view.id]();
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
$("viewer").prepend(toolbar);

const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let worker = null;
let workerStudyLoaded = false;
let loadedSourcePayload = null;
let requestSeq = 0;
let studySummary = null;
let outputs = {};
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, entry) => {
    if (job?.kind === "running") return;
    if (entry?.file) void show(entry.file);
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function allRecos() {
  return (studySummary?.scans ?? []).flatMap((s) => s.recos);
}

function allConvertibleRecos() {
  return allRecos().filter((r) => r.convertible);
}

function selectedReco() {
  const parsed = parseRecoKey($("scanSelect").value);
  if (!parsed) return null;
  return allConvertibleRecos().find((r) => r.scanId === parsed.scanId && r.recoId === parsed.recoId) ?? null;
}

function syncOrientationControls() {
  const busy = job !== null;
  const allowOverrides = $("space").value === "subject_ras";
  $("subjectType").disabled = busy || !allowOverrides;
  $("subjectPose").disabled = busy || !allowOverrides;
}

function syncSlicePackControl() {
  const reco = selectedReco();
  const packSelect = $("slicePackSelect");
  packSelect.innerHTML = "";
  if (!reco) {
    $("scanMeta").hidden = true;
    $("slicePackField").hidden = true;
    packSelect.disabled = true;
    return;
  }
  $("scanMeta").hidden = false;
  $("scanMeta").textContent = scanMetaSummary(reco);
  if (reco.numSlicePacks > 1) {
    for (let i = 0; i < reco.numSlicePacks; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      const orient = reco.sliceOrientations?.[i] ? ` (${reco.sliceOrientations[i]})` : "";
      const slices = reco.numSlices?.[i] ? ` · ${reco.numSlices[i]} ${reco.numSlices[i] === 1 ? "slice" : "slices"}` : "";
      opt.textContent = `Pack ${i}${orient}${slices}`;
      packSelect.append(opt);
    }
    $("slicePackField").hidden = false;
    packSelect.disabled = job !== null;
  } else {
    $("slicePackField").hidden = true;
    packSelect.disabled = true;
  }
}

function refreshControls() {
  const busy = job !== null;
  const reco = selectedReco();
  exampleControl.setDisabled(busy);
  $("studyInput").disabled = busy;
  $("folderInput").disabled = busy;
  $("folderButton").disabled = busy;
  $("scanSelect").disabled = busy || !studySummary || allConvertibleRecos().length === 0;
  $("space").disabled = busy;
  syncOrientationControls();
  if (!$("slicePackField").hidden) $("slicePackSelect").disabled = busy;
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !reco;
}

function populateScanSelect(summary) {
  const select = $("scanSelect");
  select.innerHTML = "";
  const recos = (summary?.scans ?? []).flatMap((s) => s.recos);
  const convertible = recos.filter((r) => r.convertible);
  if (!convertible.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = recos.length
      ? "No convertible scans within browser limits"
      : "No convertible 2dseq scans found";
    select.append(opt);
    syncSlicePackControl();
    return;
  }
  for (const reco of recos) {
    const opt = document.createElement("option");
    opt.value = recoKey(reco.scanId, reco.recoId);
    opt.textContent = scanOptionLabel(reco);
    opt.disabled = !reco.convertible;
    if (reco.error) opt.title = reco.error;
    select.append(opt);
  }
  const preferred = defaultRecoOf(summary);
  if (preferred) select.value = recoKey(preferred.scanId, preferred.recoId);
  syncSlicePackControl();
}

function clearResults() {
  outputs = {};
  results.render(outputs);
  $("outputSection").open = false;
}

function begin(kind, message) {
  const controller = new AbortController();
  job = { kind, controller };
  progress.begin(message);
  status(message);
  refreshControls();
  return job;
}

function end(current, message, { success = true, error = false, value } = {}) {
  if (job !== current) return false;
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

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return worker;
}

function resetWorker() {
  workerStudyLoaded = false;
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function runWorkerRequest(payload, { signal, onProgress = () => {} } = {}) {
  const id = ++requestSeq;
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      w.removeEventListener("messageerror", onMsgError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resetWorker();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") {
        onProgress(data.value, data.message);
      } else if (data.type === "error") {
        cleanup();
        reject(new Error(data.message));
      } else {
        cleanup();
        resolve(data);
      }
    };
    const onError = (event) => {
      event.preventDefault?.();
      cleanup();
      resetWorker();
      reject(new Error(event.message || "The BrkRaw worker failed. Reload the page and try again."));
    };
    const onMsgError = () => {
      cleanup();
      resetWorker();
      reject(new Error("The BrkRaw worker returned an unreadable message."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.addEventListener("messageerror", onMsgError);
    w.postMessage({ ...payload, id });
  });
}

async function ensureViewer() {
  viewerReady ??= (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false });
    await viewer.attachTo("gl1");
    layouts.multiplanar();
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
    return viewer;
  })();
  return viewerReady;
}

function show(file) {
  const revision = ++viewRevision;
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision) return;
    if (!file) return;
    const nv = await ensureViewer();
    await nv.loadVolumes([{ url: file, name: file.name }]);
    $("emptyState").hidden = true;
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `Visualization unavailable. ${error.message}. Downloads remain available.`;
    log.log(error.message, "error");
  });
  return viewQueue;
}

function buildInspectPayload(chosen) {
  if (!chosen.length) throw new Error("Choose a Bruker ParaVision .zip archive or study folder.");
  if (chosen.length === 1 && /\.zip$/i.test(chosen[0].name)) {
    return { type: "inspect", zipFile: chosen[0] };
  }
  const entries = chosen.map((file) => ({
    path: file._webkitRelativePath || file.webkitRelativePath || file.name,
    file,
  }));
  return { type: "inspect", entries };
}

async function loadStudy(chosen, signal) {
  if (job) throw new Error("Wait for the current operation to finish or cancel it, then retry.");
  const current = begin("loading", "Inspecting Bruker study…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const payload = buildInspectPayload(chosen);
    resetWorker();
    const response = await runWorkerRequest(payload, {
      signal: current.controller.signal,
      onProgress: (val, msg) => progress.setProgress(val, msg),
    });
    current.controller.signal.throwIfAborted();
    studySummary = response.summary;
    loadedSourcePayload = payload;
    workerStudyLoaded = true;

    const total = allRecos();
    const convertible = allConvertibleRecos();
    const skipped = total.filter((r) => !r.convertible);
    for (const warning of studySummary.warnings ?? []) {
      log.log(warning, "warn");
    }
    for (const reco of skipped) {
      log.log(`Scan ${reco.scanId} reco ${reco.recoId} unavailable: ${reco.error || "unsupported"}`, "warn");
    }
    if (!convertible.length) {
      throw new Error(
        skipped[0]?.error || "No convertible Bruker 2dseq reconstructions were found in this study.",
      );
    }

    $("studyInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: chosen } }));
    $("dropZone").classList.add("has-files");
    const pv = studySummary.softwareVersion ? `ParaVision ${studySummary.softwareVersion}` : "ParaVision";
    const skippedNote = skipped.length ? ` · ${skipped.length} unavailable` : "";
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${pv} · ${convertible.length} ${convertible.length === 1 ? "scan" : "scans"}${skippedNote}`;
    populateScanSelect(studySummary);
    clearResults();
    log.log(`Loaded Bruker study (${pv}, ${convertible.length} convertible reconstructions; subject ${studySummary.subjectType || "unspecified"}, ${studySummary.subjectPosition || "Head_Supine"})`);
    end(current, `Bruker study loaded (${convertible.length} ${convertible.length === 1 ? "scan" : "scans"})`);
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
    log.log("Wait for the current operation to finish or cancel it before loading another study.", "warn");
    return Promise.resolve();
  }
  exampleControl.cancel();
  return Promise.resolve(filesPromise)
    .then((chosen) => loadStudy(Array.from(chosen)))
    .catch((error) => status(error.message, true));
}

$("studyInput").addEventListener("change", (event) => {
  const chosen = Array.from(event.target.files);
  event.target.value = "";
  if (chosen.length) void importFiles(chosen);
});
$("folderButton").addEventListener("click", () => $("folderInput").click());
$("folderInput").addEventListener("change", (event) => {
  const chosen = Array.from(event.target.files);
  event.target.value = "";
  if (chosen.length) void importFiles(chosen);
});
bindFileDrop($("dropZone"), importFiles);

$("scanSelect").addEventListener("change", () => {
  syncSlicePackControl();
  clearResults();
  refreshControls();
});
$("slicePackSelect").addEventListener("change", clearResults);
$("space").addEventListener("change", () => {
  syncOrientationControls();
  clearResults();
});
$("subjectType").addEventListener("change", clearResults);
$("subjectPose").addEventListener("change", clearResults);

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    await loadStudy(fetched, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

const gzip = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

async function convert(onProgress = () => {}) {
  const reco = selectedReco();
  if (!studySummary || !reco || job) {
    throw new Error("Load a Bruker ParaVision study and choose a scan before converting.");
  }
  const slicePackIndex = $("slicePackField").hidden ? 0 : Number.parseInt($("slicePackSelect").value, 10) || 0;
  const space = normalizeSpace($("space").value);
  const overrideSubjectType = space === "subject_ras" ? normalizeSubjectType($("subjectType").value) : "";
  const overrideSubjectPose = space === "subject_ras" ? normalizeSubjectPose($("subjectPose").value) : "";

  clearResults();
  const current = begin("running", `Converting scan ${reco.scanId}…`);
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});

  log.log(`BrkRaw converting scan ${reco.scanId} reco ${reco.recoId} (pack ${slicePackIndex}, space ${space})`);
  try {
    // Recover seamlessly if a previous cancel or worker crash terminated the worker.
    if (!workerStudyLoaded) {
      if (!loadedSourcePayload) {
        throw new Error("Load a Bruker ParaVision study before converting.");
      }
      progress.setProgress(0.1, "Reloading Bruker study…");
      onProgress({ value: 0.1, message: "Reloading Bruker study…" });
      await runWorkerRequest(loadedSourcePayload, {
        signal: current.controller.signal,
        onProgress: (value, message) => {
          progress.setProgress(value * 0.2, message);
          onProgress({ value: value * 0.2, message });
        },
      });
      current.controller.signal.throwIfAborted();
      workerStudyLoaded = true;
    }

    const data = await runWorkerRequest(
      {
        type: "convert",
        scanId: reco.scanId,
        recoId: reco.recoId,
        slicePackIndex,
        space,
        overrideSubjectType,
        overrideSubjectPose,
        converterVersion: appPackage.version,
      },
      {
        signal: current.controller.signal,
        onProgress: (value, message) => {
          progress.setProgress(value, message);
          onProgress({ value, message });
        },
      },
    );
    current.controller.signal.throwIfAborted();
    progress.setProgress(0.8, "Compressing NIfTI-1 volume…");
    onProgress({ value: 0.8, message: "Compressing NIfTI-1 volume…" });

    const stem = outputStem({
      scanId: data.scanId,
      recoId: data.recoId,
      slicePackIndex: data.slicePackIndex,
      slicePackCount: data.slicePackCount,
    });
    const gzBytes = await gzip(new Uint8Array(data.niftiBuffer));
    if (job !== current) return current.completion.promise;

    const niftiFile = new File([gzBytes], `${stem}.nii.gz`, { type: "application/gzip" });
    const sidecarFile = new File([data.sidecarJson], `${stem}.json`, { type: "application/json" });

    outputs = {
      nifti: { description: "NIfTI volume", file: niftiFile },
      sidecar: { description: "Scrubbed metadata (JSON)", file: sidecarFile, viewable: false },
    };
    results.render(outputs);
    $("outputSection").open = true;
    $("resultList").children[0]?.querySelector(".nd-view-btn")?.classList.add("active");

    log.log(`Converted ${niftiFile.name} · [${data.shape.join(" × ")}] · ${data.zooms.map((z) => z.toFixed(3)).join(" × ")} mm (${data.kind}, slope ${data.sclSlope})`);
    if (data.perFrameScalingApplied) {
      log.log("Applied per-frame VisuCoreDataSlope/Offs scaling into float32.");
    }
    end(
      current,
      `Converted scan ${data.scanId} · ${data.shape.join(" × ")} · ${data.zooms.map((z) => z.toFixed(3)).join(" × ")} mm`,
      {
        value: {
          artifacts: [
            { role: "nifti", file: niftiFile },
            { role: "sidecar", file: sidecarFile },
          ],
          measurements: {
            scanId: data.scanId,
            recoId: data.recoId,
            slicePackIndex: data.slicePackIndex,
            shape: data.shape,
            voxelSizeMm: data.zooms.map((z) => Number(z.toFixed(6))),
            dtype: data.kind,
            sclSlope: data.sclSlope,
            sclInter: data.sclInter,
          },
          provenance: {
            upstream: "BrkRaw v0.5.7 (5664cef2)",
            softwareVersion: studySummary.softwareVersion,
            space,
            subjectType: data.sidecar.SubjectType,
            subjectPosition: data.sidecar.SubjectPosition,
          },
        },
      },
    );
    await show(niftiFile);
    return current.completion.promise;
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Conversion cancelled" : error.message, { success: false, error: !cancelled });
    return current.completion.promise;
  }
}

$("runButton").addEventListener("click", () => {
  void convert().catch((error) => {
    if (error.name !== "AbortError") status(error.message, true);
  });
});

function cancel() {
  exampleControl.cancel();
  if (!job) return;
  const current = job;
  current.controller.abort();
  end(current, current.kind === "running" ? "Conversion cancelled" : "Loading cancelled", { success: false });
}
$("cancelButton").onclick = cancel;

registerAppAutomation({
  app: APP.id,
  operations: {
    convert: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      const chosen = inputs.study ?? [];
      await loadStudy(chosen, signal);
      signal.throwIfAborted();
      if (parameters.scanId !== undefined) {
        const target = recoKey(Number(parameters.scanId), Number(parameters.recoId ?? 1));
        if (!allConvertibleRecos().some((r) => recoKey(r.scanId, r.recoId) === target)) {
          throw new Error(`Scan ${parameters.scanId} (reco ${parameters.recoId ?? 1}) not found or not convertible in study.`);
        }
        $("scanSelect").value = target;
        syncSlicePackControl();
      }
      const activeReco = selectedReco();
      if (parameters.slicePackIndex !== undefined) {
        const packIdx = Number(parameters.slicePackIndex);
        const packCount = activeReco?.numSlicePacks ?? 1;
        if (!Number.isInteger(packIdx) || packIdx < 0 || packIdx >= packCount) {
          throw new RangeError(`Slice pack ${parameters.slicePackIndex} out of range (available: 0..${packCount - 1}).`);
        }
        if (!$("slicePackField").hidden) {
          $("slicePackSelect").value = String(packIdx);
        }
      }
      $("space").value = normalizeSpace(parameters.space ?? "subject_ras");
      syncOrientationControls();
      $("subjectType").value = normalizeSubjectType(parameters.subjectType ?? "auto");
      $("subjectPose").value = normalizeSubjectPose(parameters.subjectPose ?? "auto");
      return runAbortable(signal, () => convert(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
  resetWorker();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
