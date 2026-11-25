// Brain Tumour Report: native-space T1c MRI (or DICOM series) in; Raidionics v1.3
// brain & tumour-core masks, per-lesion native morphometry, and optional MNI152 RADS
// anatomical & surgical characterization out. Inference and Greedy MNI registration
// run in src/worker.js; this page owns the inputs, viewer, report view and downloads.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createFileField,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { createElement } from "@neurodesk/webapp-components/core";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { readNiftiVolumeAsync } from "@neurodesk/webapp-components/file-io/nifti-volume";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { createNiivueAdapter, registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { caseName } from "@neurodesk/tumour-report/results";
import {
  APP,
  TUMOUR_TYPE_LABELS,
  brainColormap,
  formatRegionName,
  formatTractName,
  geometryMatches,
  modeHint,
  runButtonLabel,
  statusSummary,
  tumourColormap,
} from "./config.js";
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
let shownBase = null;
let activeView = "multiplanar";

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

function setViewMode(id) {
  if (id === "results" && !lastReport) return;
  activeView = id;
  const isResults = id === "results";
  $("resultsReport").hidden = !isResults;
  toolbar.setActive(id);
  if (!isResults && viewer) {
    layouts[id]();
    viewer.drawScene();
  }
}

const toolbar = createViewerToolbar({
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: "multiplanar", label: "3-Plane", active: true },
    { id: "axial", label: "Axial" },
    { id: "coronal", label: "Coronal" },
    { id: "sagittal", label: "Sagittal" },
    { id: "results", label: "Results", buttonId: "resultsTab", disabled: true },
  ].map((view) => ({
    ...view,
    onClick: () => setViewMode(view.id),
  })),
});
$("viewer").prepend(toolbar);

let overlayOpacity = 0.6;
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;

const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);

const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const maskField = createFileField({
  id: "maskInput",
  rootId: "maskDrop",
  kind: "mask",
  multiple: false,
  text: "Drop an optional tumour mask (.nii / .nii.gz)",
  label: "Choose an optional binary tumour mask NIfTI",
});
$("maskField").querySelector("label").after(maskField);

// Loaded scan and optional binary mask: { file, description, summary }.
let t1cInput = null;
let maskInput = null;
let outputs = {};
let lastReport = null;
const view = { base: "t1c", overlay: null };
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running") return;
    if (stage === "t1c") {
      view.base = "t1c";
    } else if (stage === "tumourMask" || stage === "brainMask") {
      view.overlay = view.overlay === stage ? null : stage;
    } else if (stage === "tumourMaskMni") {
      view.base = "tumourMaskMni";
      view.overlay = null;
    }
    if (activeView === "results") setViewMode("multiplanar");
    void show();
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function refreshControls() {
  const busy = job !== null;
  exampleControl.setDisabled(busy);
  $("imageInput").disabled = busy;
  maskField.disabled = busy;
  $("clearMaskButton").disabled = busy;
  $("clearMaskButton").hidden = !maskInput;
  $("tumourType").disabled = busy;
  $("computeMniReport").disabled = busy;
  $("skullStripped").disabled = busy;
  $("deformableMni").disabled = busy || !$("computeMniReport").checked;
  $("backend").disabled = busy;
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !t1cInput;
  $("runButton").textContent = runButtonLabel({ hasMask: Boolean(maskInput) });
  $("modeHint").textContent = modeHint({
    hasT1c: Boolean(t1cInput),
    hasMask: Boolean(maskInput),
    computeMniReport: $("computeMniReport").checked,
    skullStripped: $("skullStripped").checked,
  });
  const resultsTab = $("resultsTab");
  if (resultsTab) resultsTab.disabled = !lastReport;
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

function inputRows() {
  const rows = {};
  if (t1cInput) rows.t1c = { description: "Input T1c", file: t1cInput.file };
  if (maskInput) rows.suppliedMask = { description: "Supplied mask", file: maskInput.file, viewable: false };
  return rows;
}

function renderInputs() {
  $("fileInfo").hidden = !t1cInput;
  $("fileInfo").textContent = t1cInput ? t1cInput.summary : "";
  $("dropZone").classList.toggle("has-files", Boolean(t1cInput));
  $("maskInfo").hidden = !maskInput;
  $("maskInfo").textContent = maskInput ? maskInput.summary : "";
  maskField.setHasFiles(Boolean(maskInput));
  $("emptyState").hidden = Boolean(t1cInput);
  refreshControls();
}

function renderOutputs() {
  results.render(outputs);
  $("outputSection").open = Boolean(lastReport);
  if (lastReport) {
    const notice = $("resultNotice");
    if (lastReport.warnings?.length) {
      notice.textContent = lastReport.warnings[0];
      notice.className = "nd-message warning";
      notice.hidden = false;
    } else if (lastReport.morphometry.lesionCount === 0) {
      notice.textContent = "No lesions segmented. Verify contrast sequence and skull-stripped setting.";
      notice.className = "nd-message info";
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }
  } else {
    $("resultNotice").hidden = true;
  }
  for (const [index, key] of Object.keys(outputs).entries()) {
    const active = key === view.base || key === view.overlay;
    $("resultList").children[index]?.querySelector(".nd-view-btn")?.classList.toggle("active", active);
  }
}

function clearResults() {
  lastReport = null;
  outputs = inputRows();
  view.base = t1cInput ? "t1c" : null;
  view.overlay = null;
  $("resultsReport").replaceChildren();
  if (activeView === "results") setViewMode("multiplanar");
  renderOutputs();
  refreshControls();
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
    automation.registerViewer("main", createNiivueAdapter(viewer, {
      tabs: {
        list: () => ["multiplanar", "axial", "coronal", "sagittal", ...(lastReport ? ["results"] : [])].map((id) => ({
          id,
          label: id === "multiplanar" ? "3-Plane" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
          active: activeView === id,
        })),
        select: (id) => setViewMode(id),
      },
    }));
    return viewer;
  })();
  return viewerReady;
}

function show() {
  const revision = ++viewRevision;
  renderOutputs();
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision) return;
    const base = outputs[view.base]?.file;
    if (!base) return;
    const nv = await ensureViewer();
    const layers = [{ url: base, name: base.name }];
    const overlayKey = view.base === "t1c" ? view.overlay : null;
    const overlayFile = overlayKey && outputs[overlayKey]?.file;
    if (overlayFile) {
      layers.push({
        url: overlayFile,
        name: overlayFile.name,
        opacity: overlayOpacity,
        isColorbarVisible: false,
      });
    }
    const crosshair = shownBase === base && nv.getCrosshairPos();
    await nv.loadVolumes(layers);
    if (overlayFile) {
      await nv.setColormapLabel(1, overlayKey === "brainMask" ? brainColormap() : tumourColormap());
    }
    if (crosshair) nv.setCrosshairPos(crosshair);
    shownBase = base;
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `Visualization unavailable. ${error.message}. Downloads remain available.`;
    log.log(error.message, "error");
  });
  return viewQueue;
}

function jumpToLesion(lesion) {
  view.base = "t1c";
  if (outputs.tumourMask) view.overlay = "tumourMask";
  setViewMode("multiplanar");
  void show().then(() => {
    if (!viewer) return;
    viewer.setCrosshairPos(lesion.centroidMm);
    viewer.drawScene();
    status(`Focused lesion #${lesion.id} (${lesion.volumeMl.toFixed(2)} mL) at RAS ${lesion.centroidMm.map((v) => v.toFixed(1)).join(", ")} mm`);
  });
}

toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  viewQueue = viewQueue.then(async () => {
    if (viewer?.volumes.length > 1) await viewer.setVolume(1, { opacity: overlayOpacity });
  }).catch((error) => log.log(error.message, "error"));
});

// Build the structured report view in #resultsReport using shared .nd-report-* & .nd-data-table classes.
function makeSection(heading, children) {
  return createElement("section", { "aria-label": heading }, [
    createElement("div", { className: "nd-report-heading" }, [
      createElement("h3", { text: heading }),
    ]),
    ...children,
  ]);
}

function makeTable(headers, rows, { numericColumns = new Set() } = {}) {
  const thead = createElement("thead", {}, [
    createElement("tr", {}, headers.map((label, idx) => createElement("th", {
      className: numericColumns.has(idx) ? "nd-numeric" : "",
      text: label,
    }))),
  ]);
  const tbody = createElement("tbody", {}, rows);
  return createElement("div", { className: "nd-table-scroll" }, [
    createElement("table", { className: "nd-data-table" }, [thead, tbody]),
  ]);
}

function renderReportView(report) {
  const stack = createElement("div", { className: "nd-report-stack" });
  stack.append(createElement("p", {
    className: "nd-report-notes",
    text: report.notice,
  }));

  for (const warning of report.warnings || []) {
    stack.append(createElement("p", { className: "nd-message warning", text: warning }));
  }

  const m = report.morphometry;
  const summaryRows = [
    ["Tumour type", TUMOUR_TYPE_LABELS[report.tumourType] || report.tumourType],
    ["Status", m.lesionCount === 0 ? "No lesions segmented" : (m.multifocal ? `Multifocal (${m.multifocalCount} foci ≥ 0.1 mL)` : "Unifocal")],
    ["Lesion count (26-CC)", String(m.lesionCount)],
    ["Total tumour volume", `${m.totalVolumeMl.toFixed(2)} mL`],
  ];
  if (m.brainVolumeMl !== null) {
    summaryRows.push(["Brain volume", `${m.brainVolumeMl.toFixed(1)} mL`]);
  }
  if (m.brainPercentage !== null) {
    summaryRows.push(["Tumour / brain ratio", `${m.brainPercentage.toFixed(2)} %`]);
  }
  if (m.maxMinFociDistanceMm >= 0) {
    summaryRows.push(["Max min-foci distance", `${m.maxMinFociDistanceMm.toFixed(1)} mm`]);
  }
  if (m.largestDiameters) {
    const d = m.largestDiameters;
    summaryRows.push(["Largest 3D diameter", `${d.maxDiameter3dMm.toFixed(1)} mm`]);
    summaryRows.push(["Largest axial bidimensional", `${d.axialLongMm.toFixed(1)} × ${d.axialShortMm.toFixed(1)} mm (${d.axialCrossProductMm2.toFixed(0)} mm²)`]);
  }
  if (report.rads) {
    const lat = report.rads.laterality;
    summaryRows.push(["Hemispheric laterality (MNI)", `Left ${lat.leftPct.toFixed(1)}% · Right ${lat.rightPct.toFixed(1)}%${lat.midlineCrossing ? " · Midline crossing" : ""}`]);
  }

  stack.append(makeSection("Summary", [
    makeTable(
      ["Metric", "Value"],
      summaryRows.map(([k, v]) => createElement("tr", {}, [
        createElement("td", { text: k }),
        createElement("td", { className: "nd-numeric", text: v }),
      ])),
      { numericColumns: new Set([1]) },
    ),
  ]));

  if (m.lesions.length > 0) {
    const lesionRows = m.lesions.map((lesion) => {
      const ax = lesion.axialBidimensional;
      const focusTrigger = createElement("span", {
        role: "button",
        tabindex: "0",
        text: `#${lesion.id} · View`,
        title: `Jump viewer to lesion #${lesion.id}`,
      });
      focusTrigger.addEventListener("click", () => jumpToLesion(lesion));
      focusTrigger.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          jumpToLesion(lesion);
        }
      });
      return createElement("tr", { dataset: ax.measurable10x10mm ? { flag: "measurable" } : {} }, [
        createElement("td", {}, [focusTrigger]),
        createElement("td", { className: "nd-numeric", text: lesion.volumeMl.toFixed(2) }),
        createElement("td", { className: "nd-numeric", text: lesion.maxDiameter3dMm.toFixed(1) }),
        createElement("td", { className: "nd-numeric", text: `${ax.longAxisMm.toFixed(1)} × ${ax.shortAxisMm.toFixed(1)}` }),
        createElement("td", { text: ax.measurable10x10mm ? "Yes" : "No" }),
        createElement("td", { className: "nd-numeric", text: lesion.sphericity.toFixed(3) }),
        createElement("td", { className: "nd-numeric", text: lesion.centroidMm.map((v) => v.toFixed(1)).join(", ") }),
      ]);
    });
    stack.append(makeSection("Per-lesion native morphometry", [
      createElement("p", { className: "nd-report-notes", text: "Select a lesion to jump the 3-plane viewer to its RAS centroid. Measurable rows are ≥ 10 × 10 mm on an axial slice." }),
      makeTable(
        ["Lesion", "Volume (mL)", "3D Ø (mm)", "Axial L × S (mm)", "≥ 10×10", "Sphericity", "RAS centroid (mm)"],
        lesionRows,
        { numericColumns: new Set([1, 2, 3, 5, 6]) },
      ),
    ]));
  } else {
    stack.append(makeSection("Per-lesion native morphometry", [
      createElement("p", { className: "nd-report-lead", text: "No contrast-enhancing lesions were segmented." }),
    ]));
  }

  if (report.rads?.resectability) {
    const r = report.rads.resectability;
    stack.append(makeSection("Glioblastoma resectability (Kommers et al., 2021)", [
      createElement("p", { className: "nd-report-notes", text: "Atlas-derived population probability estimate for adult glioblastoma only. Research use; not for surgical planning." }),
      makeTable(
        ["Metric", "Estimate"],
        [
          ["Resectability index", r.resectabilityIndex.toFixed(3)],
          ["Expected resectable volume", `${r.expectedResectableMl.toFixed(2)} mL`],
          ["Expected residual volume", `${r.expectedResidualMl.toFixed(2)} mL`],
          ["Hemisphere probability map", r.hemisphereMap === "left" ? "Left" : "Right"],
        ].map(([k, v]) => createElement("tr", {}, [
          createElement("td", { text: k }),
          createElement("td", { className: "nd-numeric", text: v }),
        ])),
        { numericColumns: new Set([1]) },
      ),
    ]));
  }

  if (report.rads?.cortical) {
    const lobes = report.rads.cortical.mniLobes?.involved || [];
    if (lobes.length) {
      stack.append(makeSection("MNI cortical lobes", [
        makeTable(
          ["Region", "Tumour overlap (%)"],
          lobes.map((item) => createElement("tr", {}, [
            createElement("td", { text: formatRegionName(item.name) }),
            createElement("td", { className: "nd-numeric", text: item.overlapPct.toFixed(1) }),
          ])),
          { numericColumns: new Set([1]) },
        ),
      ]));
    }
    const schaefer7 = report.rads.cortical.schaefer7?.involved || [];
    if (schaefer7.length) {
      stack.append(makeSection("Schaefer 7 functional networks", [
        makeTable(
          ["Network", "Tumour overlap (%)"],
          schaefer7.map((item) => createElement("tr", {}, [
            createElement("td", { text: formatRegionName(item.name) }),
            createElement("td", { className: "nd-numeric", text: item.overlapPct.toFixed(1) }),
          ])),
          { numericColumns: new Set([1]) },
        ),
      ]));
    }
  }

  if (report.rads?.subcortical) {
    const { overlapping, nearby } = report.rads.subcortical;
    const rows = [
      ...overlapping.map((t) => createElement("tr", { dataset: { flag: "overlap" } }, [
        createElement("td", { text: formatTractName(t.name) }),
        createElement("td", { text: "Overlap" }),
        createElement("td", { className: "nd-numeric", text: `${t.overlapPct.toFixed(1)} %` }),
        createElement("td", { className: "nd-numeric", text: "0.0" }),
      ])),
      ...nearby.slice(0, 12).map((t) => createElement("tr", {}, [
        createElement("td", { text: formatTractName(t.name) }),
        createElement("td", { text: "Nearby" }),
        createElement("td", { className: "nd-numeric", text: "0.0 %" }),
        createElement("td", { className: "nd-numeric", text: t.minDistanceMm.toFixed(1) }),
      ])),
    ];
    stack.append(makeSection("Subcortical white-matter tracts (BCB 64-tract atlas)", [
      rows.length
        ? makeTable(
          ["Tract", "Relation", "Overlap", "Min distance (mm)"],
          rows,
          { numericColumns: new Set([2, 3]) },
        )
        : createElement("p", { className: "nd-report-notes", text: "No BCB white-matter tracts within 15 mm of the MNI tumour mask." }),
    ]));
  }

  $("resultsReport").replaceChildren(stack);
}

async function readSingle3dImage(files, label, signal) {
  const images = await readImageFiles(files, { signal });
  signal?.throwIfAborted();
  if (images.length !== 1) {
    throw new Error(`Choose one ${label} NIfTI image or one DICOM series at a time.`);
  }
  const [file] = images;
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const volume = await readNiftiVolumeAsync(await file.arrayBuffer());
  signal?.throwIfAborted();
  const spacingMm = [0, 1, 2].map((axis) => Math.hypot(
    volume.affine[0][axis],
    volume.affine[1][axis],
    volume.affine[2][axis],
  ));
  const fullDescription = { dims: volume.dims, affine: volume.affine, spacingMm };
  const summary = `${file.name} · ${volume.dims.join(" × ")} · ${spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm`;
  return { file, description: fullDescription, summary };
}

async function loadT1c(chosen, signal, { clearMask = false, beforeCommit = null, afterCommit = null } = {}) {
  if (job) throw new Error("Wait for the current step to finish or cancel it, then retry.");
  const current = begin("loading", "Reading T1c scan…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!chosen.length) throw new Error("Choose a post-contrast T1 NIfTI or DICOM series.");
    const parsed = await readSingle3dImage(chosen, "T1c", current.controller.signal);
    current.controller.signal.throwIfAborted();
    beforeCommit?.();
    t1cInput = parsed;
    if (maskInput && (clearMask || !geometryMatches(t1cInput.description, maskInput.description))) {
      maskInput = null;
      maskField.input.dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [] } }));
    }
    afterCommit?.();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [t1cInput.file] } }));
    renderInputs();
    clearResults();
    end(current, `Loaded ${t1cInput.summary}`);
    await show();
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Loading cancelled" : error.message, { success: false, error: !cancelled });
    if (signal) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function loadMask(chosen, signal) {
  if (job) throw new Error("Wait for the current step to finish or cancel it, then retry.");
  const current = begin("loading", "Reading tumour mask…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!chosen.length) {
      maskInput = null;
      maskField.input.dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [] } }));
      renderInputs();
      clearResults();
      end(current, "Optional tumour mask removed");
      return;
    }
    const [raw] = chosen;
    if (!/\.nii(\.gz)?$/i.test(raw.name)) {
      throw new Error(`${raw.name} is not a NIfTI mask (.nii or .nii.gz).`);
    }
    const parsed = await readSingle3dImage([raw], "tumour mask", current.controller.signal);
    current.controller.signal.throwIfAborted();
    if (t1cInput && !geometryMatches(t1cInput.description, parsed.description)) {
      throw new Error(`Mask (${parsed.description.dims.join(" × ")}) is not aligned to the T1c voxel-to-RAS grid (${t1cInput.description.dims.join(" × ")}).`);
    }
    maskInput = parsed;
    maskField.input.dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [maskInput.file] } }));
    renderInputs();
    clearResults();
    end(current, `Mask loaded · ${maskInput.summary}`);
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Loading cancelled" : error.message, { success: false, error: !cancelled });
    if (signal) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function importT1c(filesPromise) {
  exampleControl.cancel();
  return Promise.resolve(filesPromise)
    .then((chosen) => loadT1c(Array.from(chosen)))
    .catch((error) => status(error.message, true));
}

function importMask(filesPromise) {
  return Promise.resolve(filesPromise)
    .then((chosen) => loadMask(Array.from(chosen)))
    .catch((error) => status(error.message, true));
}

$("imageInput").addEventListener("change", (event) => {
  const chosen = Array.from(event.target.files);
  event.target.value = "";
  if (chosen.length) void importT1c(chosen);
});

maskField.onFiles(importMask);
$("clearMaskButton").addEventListener("click", () => {
  if (job) return;
  maskInput = null;
  maskField.input.dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [], cancelPending: true } }));
  renderInputs();
  clearResults();
  status("Optional tumour mask removed");
});

for (const id of ["tumourType", "computeMniReport", "skullStripped", "deformableMni"]) {
  $(id).addEventListener("change", () => refreshControls());
}

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    const params = example.automation?.parameters;
    await loadT1c(fetched, signal, {
      clearMask: true,
      beforeCommit: assertCurrent,
      afterCommit: () => {
        if (params?.tumourType) $("tumourType").value = params.tumourType;
        if (typeof params?.skullStripped === "boolean") $("skullStripped").checked = params.skullStripped;
      },
    });
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

const gzip = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

async function analyze(onProgress = () => {}) {
  if (!t1cInput || job) throw new Error("Load a T1c scan and wait for the current step to finish.");
  clearResults();
  const current = begin("running", maskInput ? "Characterizing tumour mask…" : "Starting tumour segmentation…");
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});
  const label = caseName(t1cInput.file.name);
  const tumourType = $("tumourType").value;
  const computeMniReport = $("computeMniReport").checked;
  const deformableMni = computeMniReport && $("deformableMni").checked;
  const skullStripped = $("skullStripped").checked;
  const backend = $("backend").value;

  log.log(`Brain Tumour Report (${tumourType}, MNI=${computeMniReport}, skullStripped=${skullStripped}) on ${t1cInput.file.name}`);
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
      void finish(current, data).catch((error) => end(current, error.message, { success: false, error: true }));
    }
  };
  current.worker.onerror = (event) => {
    event.preventDefault?.();
    end(current, event.message || "The Brain Tumour Report worker failed. Reload the page and try again.", { success: false, error: true });
  };
  current.worker.postMessage({
    caseLabel: label,
    t1cFile: t1cInput.file,
    maskFile: maskInput?.file ?? null,
    tumourType,
    computeMniReport,
    deformableMni,
    skullStripped,
    backend,
  });
  return current.completion.promise;
}

async function finish(current, data) {
  const tumourFile = new File([await gzip(data.tumourMask.bytes)], `${data.tumourMask.name}.gz`, { type: "application/gzip" });
  const brainFile = data.brainMask
    ? new File([await gzip(data.brainMask.bytes)], `${data.brainMask.name}.gz`, { type: "application/gzip" })
    : null;
  const mniFile = data.tumourMaskMni
    ? new File([await gzip(data.tumourMaskMni.bytes)], `${data.tumourMaskMni.name}.gz`, { type: "application/gzip" })
    : null;
  const reportFile = new File([data.reportJson.text], data.reportJson.name, { type: "application/json" });
  const lesionsFile = new File([data.lesionsTsv.text], data.lesionsTsv.name, { type: "text/tab-separated-values" });
  const summaryFile = new File([data.summaryTsv.text], data.summaryTsv.name, { type: "text/tab-separated-values" });
  if (job !== current) return;

  lastReport = data.report;
  outputs = {
    ...inputRows(),
    tumourMask: { description: "Tumour mask (native)", file: tumourFile },
    ...(brainFile ? { brainMask: { description: "Brain mask (native)", file: brainFile } } : {}),
    ...(mniFile ? { tumourMaskMni: { description: "Tumour mask (MNI)", file: mniFile } } : {}),
    reportJson: { description: "Report (JSON)", file: reportFile, viewable: false },
    lesionsTsv: { description: "Lesions table (TSV)", file: lesionsFile, viewable: false },
    summaryTsv: { description: "RADS summary (TSV)", file: summaryFile, viewable: false },
  };
  view.base = "t1c";
  view.overlay = "tumourMask";
  renderReportView(lastReport);

  const artifacts = [
    { role: "tumourMask", file: tumourFile },
    ...(brainFile ? [{ role: "brainMask", file: brainFile }] : []),
    ...(mniFile ? [{ role: "tumourMaskMni", file: mniFile }] : []),
    { role: "reportJson", file: reportFile },
    { role: "lesionsTsv", file: lesionsFile },
    { role: "summaryTsv", file: summaryFile },
  ];

  log.log(`Completed in ${data.report.provenance.seconds} s`);
  end(current, statusSummary(lastReport), {
    value: {
      artifacts,
      measurements: {
        morphometry: lastReport.morphometry,
        rads: lastReport.rads,
      },
      provenance: lastReport.provenance,
    },
  });
  await show();
  if (lastReport.morphometry.lesions.length > 0 && viewer) {
    viewer.setCrosshairPos(lastReport.morphometry.lesions[0].centroidMm);
    viewer.drawScene();
  }
}

$("runButton").addEventListener("click", () => {
  void analyze().catch((error) => {
    if (error.name !== "AbortError") log.log(error.message, "error");
  });
});

function cancel() {
  exampleControl.cancel();
  if (!job) return;
  const current = job;
  current.controller.abort();
  end(current, current.kind === "running" ? "Analysis cancelled" : "Loading cancelled", { success: false });
}
$("cancelButton").onclick = cancel;

const automation = registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    analyze: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      await loadT1c(inputs.t1c ?? [], signal);
      signal.throwIfAborted();
      if (inputs.mask?.length) {
        await loadMask(inputs.mask, signal);
        signal.throwIfAborted();
      } else if (maskInput) {
        await loadMask([], signal);
        signal.throwIfAborted();
      }
      if (parameters.tumourType) $("tumourType").value = parameters.tumourType;
      if (typeof parameters.computeMniReport === "boolean") $("computeMniReport").checked = parameters.computeMniReport;
      if (typeof parameters.deformableMni === "boolean") $("deformableMni").checked = parameters.deformableMni;
      if (typeof parameters.skullStripped === "boolean") $("skullStripped").checked = parameters.skullStripped;
      if (parameters.backend) $("backend").value = parameters.backend;
      refreshControls();
      return runAbortable(signal, () => analyze(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
