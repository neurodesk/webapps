// Tile stitching: approximate layout, pairwise phase correlation in module workers, global
// optimisation and linear-blending fusion. Numerics live in src/core, output files in
// src/outputs.js and src/ome-zarr.js; this file is the workflow and the viewer.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { DRAG_MODE, SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createElement } from "@neurodesk/webapp-components/core";
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
import { APP, DEFAULT_VALUES, LAYOUTS, MAX_FUSED_PIXELS, MAX_TILE_BYTES, SettingsError, guessGrid, readSettings } from "./config.js";
import { checkPixelSizes, compareNames, gridPositions, parseTileConfiguration, positionsFromConfiguration, positionsFromStage } from "./core/tile-layout.js";
import { planPairs } from "./core/pipeline.js";
import { optimisePositions } from "./core/global.js";
import { fusedGeometry } from "./core/fusion.js";
import { checkFusionMemory, checkSolverMemory, registrationWorkers } from "./core/memory.js";
import { linksCsv, outputStem, provenance, registeredConfiguration, summarise } from "./outputs.js";
import { readTileFiles } from "./input.js";
import { displayNifti, displaySpacing, displayWindow } from "./display.js";
import { displayFrame, largestMove, placeInFrame, tileOutlinePolygons } from "./frame.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const SETTING_IDS = ["layout", "columns", "rows", "overlap", "gridType", "gridStart", "peaks", "threshold", "maxRatio", "maxAbsolute"];
const ADVANCED = new Set(["peaks", "threshold", "maxRatio", "maxAbsolute"]);
const TIFF = /\.tiff?$/i;
const LAYOUT_FILE = /\.txt$/i;
// Cross-origin isolated pages decode tiles into SharedArrayBuffers that every worker reads
// without a copy.
const SHARED = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === "function";

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Microscopy tile stitching",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// Tile outlines are image annotations, coloured like overlay colormaps rather than interface
// tokens: cyan at the layout positions, orange where stitching placed the tiles (a pair that
// stays distinct with red-green colour blindness), as NiiVue RGBA in 0-1.
const OUTLINES = {
  layout: { rgba: [0, 0.8, 1, 1], colour: "cyan", label: "layout" },
  registered: { rgba: [1, 0.6, 0, 1], colour: "orange", label: "stitched" },
};
let outlinesVisible = true;
const outlineToggle = createElement("button", {
  type: "button",
  className: "nd-tool-btn",
  text: "Outlines",
  title: "Show or hide the tile outlines: cyan at the layout positions, orange where stitching placed them",
  "aria-pressed": "true",
  hidden: true,
  onClick: () => void setOutlinesVisible(!outlinesVisible).catch(report),
});
const toolbar = createViewerToolbar({
  views: [
    { id: "layout", label: "Layout", active: true },
    { id: "stitched", label: "Stitched" },
    { id: "pairs", label: "Pairs" },
  ],
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [outlineToggle],
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true, channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }] });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// Right-drag pans and the wheel zooms at the pointer, as in slide viewers, so a seam can be
// inspected closely.
const viewer = new NiiVue({ isDragDropEnabled: false, secondaryDragMode: DRAG_MODE.pan, wheelZoomAnchor: "pointer" });
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string ?? "";
    });
  });
  return attached;
}

// State: the loaded tiles, the layout file, the last run, the layout preview (the tiles fused
// at their layout positions), the images the viewer shows and the operation in progress.
let tiles = null;
let layoutFile = null;
let run = null;
let preview = null;
let scene = null;
let shown = null;
let wanted = null;
let rendering = null;
let busy = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", "analysis");
}

function technical(message) {
  log.log(message, "info", "technical");
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => void show(stage).catch(report),
  onDownload: (_stage, result) => downloadFile(result.file),
});

function updateButtons() {
  const idle = !busy;
  $("runButton").disabled = !idle || !tiles;
  $("previewButton").disabled = !idle || !tiles;
}

function setBusy(operation) {
  busy = operation;
  results.inert = Boolean(operation);
  for (const id of ["tileInput", "layoutInput", ...SETTING_IDS]) $(id).disabled = Boolean(operation);
  exampleControl?.setDisabled(Boolean(operation));
  updateButtons();
}

/** Starts an operation that the footer × (or `signal`) cancels. */
async function operation(message, signal, work, { cancellable = true } = {}) {
  if (busy) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(controller);
  progress.begin(message);
  progress.setCancellable(cancellable);
  status(message);
  try {
    return await work(controller.signal);
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    progress.stopTimer();
    progress.setCancellable(false);
    setBusy(null);
  }
}

/** One task in a fresh module worker; aborting terminates it. */
function callWorker(message, { signal, onProgress, transfer = [] } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) {
        onProgress?.(data.progress);
        return;
      }
      stop();
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.postMessage(message, transfer);
  });
}

function clearRun() {
  run = null;
  scene = null;
  results.render();
  $("outputSection").open = false;
  $("linkReport").replaceChildren();
}

function dims() {
  return tiles[0].shape.length;
}

function tileSummary() {
  const [first] = tiles;
  const size = first.shape.join(" × ");
  const pixel = first.pixelSize?.x ? ` · ${Number(first.pixelSize.x.toPrecision(3))} µm` : "";
  return `${tiles.length} tiles · ${size} · ${first.dtype}${pixel}`;
}

/** Loads tiles (and a TileConfiguration.txt among them) through the normal input path. */
async function loadTiles(files, signal) {
  const layouts = files.filter((file) => LAYOUT_FILE.test(file.name));
  const tiffs = files.filter((file) => TIFF.test(file.name)).sort((a, b) => compareNames(a.name, b.name));
  const others = files.filter((file) => !TIFF.test(file.name) && !LAYOUT_FILE.test(file.name));
  if (tiffs.length < 2) throw new Error(tiffs.length ? `Only one TIFF tile (${tiffs[0].name}); stitching needs at least two.` : "Choose the TIFF tiles of one mosaic.");
  const names = tiffs.map((file) => file.name);
  if (new Set(names).size !== names.length) throw new Error("Two tiles have the same file name; tiles are matched to the layout by name.");
  if (layouts.length > 1) throw new Error("Choose at most one TileConfiguration file with the tiles.");
  const empty = tiffs.find((file) => !file.size);
  if (empty) throw new Error(`${empty.name} is empty.`);
  await operation("Reading tiles…", signal, async (current) => {
    const buffers = await readTileFiles(tiffs, current);
    current.throwIfAborted();
    const decoded = await callWorker({ type: "decode", files: buffers, maxBytes: MAX_TILE_BYTES, shared: SHARED }, {
      signal: current,
      transfer: buffers.map((entry) => entry.buffer),
      onProgress: (fraction) => progress.setProgress(fraction * 0.6, "Reading tiles…"),
    });
    const dtypes = new Set(decoded.map((tile) => tile.dtype));
    if (dtypes.size > 1) throw new Error(`The tiles mix sample types (${[...dtypes].join(", ")}); save them all with one type.`);
    const ranks = new Set(decoded.map((tile) => tile.shape.length));
    if (ranks.size > 1) throw new Error("The tiles mix 2D images and 3D stacks; stitch one kind at a time.");
    checkPixelSizes(decoded.map((tile) => tile.pixelSize), decoded[0].shape.length);
    current.throwIfAborted();
    tiles = decoded;
    preview = null;
    scene = null;
    clearRun();
    if (layouts.length) await readLayoutFile(layouts[0]);
    else if (layoutFile && !positionsMatch()) clearLayoutFile();
    if (!layouts.length) {
      const { columns, rows } = guessGrid(tiles.length);
      $("columns").value = String(columns);
      $("rows").value = String(rows);
    }
    $("tileInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: tiffs } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = tileSummary();
    $("dropZone").classList.add("has-files");
    const pixel = tiles[0].pixelSize;
    technical(`Decoded ${tiles.length} ${tiles[0].kind} TIFF tiles, ${tiles[0].shape.join(" × ")} ${tiles[0].dtype}, ${SHARED ? "shared memory" : "copied to each worker"}; pixel size ${pixel?.x ? `${pixel.x} × ${pixel.y}${pixel.z ? ` × ${pixel.z}` : ""} µm` : "not recorded"}`);
    if (others.length) technical(`Ignored ${others.length} file${others.length > 1 ? "s" : ""} that are neither TIFF nor .txt: ${others.slice(0, 3).map((file) => file.name).join(", ")}`);
    if (tiles.every((tile) => tile.stagePosition) && !layouts.length) setLayout("stage");
    await showPreview(current, 0.6);
  });
  status(`${tiles.length} tiles loaded · check the layout, then stitch`);
  progress.end(`${tiles.length} tiles loaded`);
}

function positionsMatch() {
  const names = new Set(tiles.map((tile) => tile.name));
  return layoutFile.configuration.entries.every((entry) => names.has(entry.name));
}

function clearLayoutFile() {
  layoutFile = null;
  $("layoutInfo").hidden = true;
  $("layoutDrop").classList.remove("has-files");
}

async function readLayoutFile(file) {
  const configuration = parseTileConfiguration(await file.text());
  layoutFile = { name: file.name, configuration };
  $("layoutInfo").hidden = false;
  $("layoutInfo").textContent = `${file.name} · ${configuration.entries.length} tiles · ${configuration.dims}D`;
  $("layoutDrop").classList.add("has-files");
  $("layoutInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
  setLayout("file");
}

function setLayout(layout) {
  $("layout").value = layout;
  $("gridFields").hidden = layout !== "grid";
  $("fileFields").hidden = layout !== "file";
  $("stageFields").hidden = layout !== "stage";
}

/** Approximate tile positions (pixels) for the chosen layout. */
function approximatePositions(settings) {
  const names = tiles.map((tile) => tile.name);
  if (settings.layout === "grid") return gridPositions({ count: tiles.length, ...settings.grid, shape: tiles[0].shape });
  if (settings.layout === "file") {
    if (!layoutFile) throw new SettingsError("layoutInput", "Choose the TileConfiguration.txt that lists these tiles.");
    return positionsFromConfiguration(layoutFile.configuration, names, dims());
  }
  return positionsFromStage(tiles.map((tile) => tile.stagePosition), tiles.map((tile) => tile.pixelSize), dims());
}

function checkFusedSize(positions) {
  const shapes = tiles.map((tile) => tile.shape);
  const { shape } = fusedGeometry(shapes, positions);
  const pixels = shape.reduce((a, b) => a * b, 1);
  if (pixels > MAX_FUSED_PIXELS) throw new Error(`The fused image would be ${shape.join(" × ")} pixels, more than this app's ${MAX_FUSED_PIXELS / 1e6} million; check the layout.`);
  checkFusionMemory({ shapes, dtype: tiles[0].dtype, shape, shared: SHARED });
  return shape;
}

function fuseInWorker(positions, signal, { tiff = false, onProgress } = {}) {
  return callWorker({ type: "fuse", tiles: tiles.map(({ shape, data }) => ({ shape, data })), positions, dtype: tiles[0].dtype, pixelSize: tiles[0].pixelSize, tiff }, { signal, onProgress });
}

function samePositions(a, b) {
  return a.length === b.length && a.every((p, t) => p.every((v, d) => v === b[t][d]));
}

/**
 * The viewer's images on one frame: the layout preview, the stitched image after a run, and
 * the tile outlines at the layout and the registered positions as NiiVue vector annotations
 * (an overlay volume would exceed the GPU's 3D texture size on a large mosaic). Both images
 * share the preview's display window, so switching between them changes only the alignment.
 */
function viewerScene() {
  if (scene) return scene;
  const shapes = tiles.map((tile) => tile.shape);
  const registered = run?.result.positions;
  const frame = displayFrame(shapes, registered ? [preview.positions, registered] : [preview.positions]);
  const spacing = displaySpacing(tiles[0].pixelSize, dims());
  const window = displayWindow(preview.image.data);
  const image = (name, fused) => displayNifti(name, placeInFrame(fused, frame), { shape: frame.shape, spacing, window });
  const outlines = (kind, positions) => {
    const strokeColor = OUTLINES[kind].rgba;
    return tileOutlinePolygons(shapes, positions, frame, spacing).map(({ tile, slicePosition, outer }) => ({
      id: `${kind}-${tile}-${slicePosition}`,
      label: 1,
      group: kind,
      sliceType: SLICE_TYPE.AXIAL,
      slicePosition,
      polygons: [{ outer, holes: [] }],
      style: { fillColor: [0, 0, 0, 0], strokeColor, strokeWidth: 2 },
    }));
  };
  scene = {
    images: {
      layout: image("layout-preview.nii", preview.image),
      stitched: run ? image(`stitched-${run.id}.nii`, run.fused) : null,
    },
    legend: registered ? [OUTLINES.layout, OUTLINES.registered] : [OUTLINES.layout],
    annotations: [...outlines("layout", preview.positions), ...(registered ? outlines("registered", registered) : [])],
  };
  return scene;
}

/** Fuses the tiles at their approximate positions. */
async function fusePreview(positions, signal, onProgress) {
  const image = await fuseInWorker(positions, signal, { onProgress });
  signal.throwIfAborted();
  preview = { image, positions };
  scene = null;
}

/** Fuses the tiles at their approximate positions and shows the result. */
async function showPreview(signal, start = 0) {
  let settings;
  let positions;
  try {
    settings = readSettings(formValues());
    positions = approximatePositions(settings);
    checkFusedSize(positions);
  } catch (error) {
    technical(`No layout preview: ${error.message}`);
    status(`Layout: ${error.message}`, true);
    return false;
  }
  await fusePreview(positions, signal, (fraction) => progress.setProgress(start + (1 - start) * fraction, "Preview of the layout…"));
  await show("layout");
  return true;
}

function formValues() {
  return Object.fromEntries(SETTING_IDS.map((id) => [id, $(id).value]));
}

function showSettings(values) {
  for (const id of SETTING_IDS) if (values[id] !== undefined) $(id).value = String(values[id]);
  setLayout($("layout").value);
}

function setView(view) {
  toolbar.setActive(view);
  const pairs = view === "pairs" && Boolean(run);
  $("linkReport").hidden = !pairs;
  $("gl1").hidden = pairs;
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  const missing = !run && ["pairs", "stitched"].includes(detail.value);
  if (missing || (detail.value === "layout" && !preview)) {
    status(missing ? "Stitch the tiles to see this view" : "Load tiles to preview their layout");
    toolbar.setActive(shown?.image ?? "layout");
    return;
  }
  if (detail.value === "pairs") setView("pairs");
  else void show(detail.value).catch(report);
});

function outlineLegend(legend) {
  if (!outlinesVisible) return "";
  return `Outlines: ${legend.map(({ colour, label }) => `${colour} ${label}`).join(" · ")}`;
}

async function setOutlinesVisible(visible) {
  outlinesVisible = visible;
  outlineToggle.setAttribute("aria-pressed", String(visible));
  if (!shown) return;
  $("outlineLegend").textContent = outlineLegend(shown.scene.legend);
  viewer.isAnnotationDrawn = visible;
  viewer.drawScene();
}

function showAnnotations(annotations) {
  for (const { id } of [...viewer.annotations]) viewer.removeAnnotation(id);
  for (const annotation of annotations) viewer.addAnnotation(annotation);
  viewer.isAnnotationDrawn = outlinesVisible;
}

/**
 * Shows the layout preview or the stitched image with the tile outlines. Both share one frame,
 * and NiiVue keeps its pan, zoom and crosshair when a volume on the same grid replaces another,
 * so a seam stays in view while its ghosting appears or disappears.
 */
async function show(stage) {
  if (["links", "configuration", "provenance"].includes(stage)) {
    if (stage === "links") setView("pairs");
    return;
  }
  const image = stage === "layout" ? "layout" : "stitched";
  if (!preview || (image === "stitched" && !run)) return;
  wanted = image;
  setView(image);
  rendering ??= renderWanted().finally(() => {
    rendering = null;
  });
  await rendering;
}

// Loads one image at a time until the viewer holds the last one asked for, so quick switching
// cannot leave an earlier, slower load on screen.
async function renderWanted() {
  await viewerReady();
  while (shown?.image !== wanted || shown.scene !== viewerScene()) {
    const image = wanted;
    const current = viewerScene();
    const file = current.images[image];
    viewer.sliceType = dims() > 2 ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.AXIAL;
    await viewer.loadVolumes([{ url: file, name: file.name, colormap: "gray" }]);
    if (shown?.scene !== current) showAnnotations(current.annotations);
    viewer.drawScene();
    shown = { scene: current, image };
    outlineToggle.hidden = false;
    $("outlineLegend").textContent = outlineLegend(current.legend);
    $("emptyState").hidden = true;
  }
}

function renderReport() {
  const names = tiles.map((tile) => tile.name);
  const axes = ["x", "y", "z"].slice(0, dims());
  const summary = summarise(run.result);
  const lead = document.createElement("p");
  lead.className = "nd-report-lead";
  lead.textContent = `${summary.used} of ${summary.links} pairs used · mean residual ${summary.meanResidual.toFixed(2)} px · largest ${summary.maxResidual.toFixed(2)} px`;
  const scroll = document.createElement("div");
  scroll.className = "nd-table-scroll";
  const table = document.createElement("table");
  table.className = "nd-data-table";
  const head = table.createTHead().insertRow();
  for (const label of ["Tile A", "Tile B", ...axes.map((a) => `d${a} (px)`), "r", "Status", "Residual (px)"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  const body = table.createTBody();
  for (const link of run.result.links) {
    const row = body.insertRow();
    if (link.status !== "used") row.dataset.flag = link.status === "outlier" ? "error" : "warning";
    for (const value of [names[link.i], names[link.j], ...link.offset.map((v) => v.toFixed(2)), link.r.toFixed(3), link.status, link.residual.toFixed(2)]) {
      row.insertCell().textContent = value;
    }
  }
  scroll.append(table);
  const notes = document.createElement("p");
  notes.className = "nd-report-notes";
  notes.textContent = "Offsets are tile B's position minus tile A's. The residual is the distance between the measured offset and the one the final positions imply.";
  $("linkReport").replaceChildren(lead, scroll, notes);
}

function textFile(text, name, type) {
  return new File([text], name, { type });
}

let runCount = 0;
async function stitchTiles(signal, settings) {
  if (!tiles) throw new Error("Load the tiles before stitching them.");
  return operation(`Stitching ${tiles.length} tiles…`, signal, async (current) => {
    clearRun();
    const started = performance.now();
    const approximate = approximatePositions(settings);
    checkFusedSize(approximate);
    const pairs = planPairs(tiles.map((tile) => tile.shape), approximate);
    if (!pairs.length) throw new Error("No tiles overlap under this layout; check the grid size, order and overlap.");
    checkSolverMemory({ shapes: tiles.map((tile) => tile.shape), dtype: tiles[0].dtype, pairs });
    const wanted = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1, pairs.length));
    const threads = registrationWorkers({ shapes: tiles.map((tile) => tile.shape), dtype: tiles[0].dtype, pairs, names: tiles.map((tile) => tile.name), shared: SHARED, wanted });
    technical(`Registering ${pairs.length} overlapping pairs in ${threads} worker${threads > 1 ? "s" : ""}`);
    const shares = Array.from({ length: threads }, () => []);
    pairs.forEach((pair, k) => shares[k % threads].push(pair));
    const done = new Array(threads).fill(0);
    const parts = await Promise.all(shares.map((share, w) => {
      const needed = tiles.map((tile, k) => (share.some((pair) => pair.i === k || pair.j === k) ? { shape: tile.shape, data: tile.data } : null));
      return callWorker({ type: "register", tiles: needed, pairs: share, options: settings.pairwise }, {
        signal: current,
        onProgress: (count) => {
          done[w] = count;
          progress.setProgress(0.75 * done.reduce((a, b) => a + b, 0) / pairs.length, "Registering tile pairs…");
        },
      });
    }));
    const order = new Map(pairs.map((pair, k) => [`${pair.i},${pair.j}`, k]));
    const links = parts.flat().sort((a, b) => order.get(`${a.i},${a.j}`) - order.get(`${b.i},${b.j}`));
    const registrationSeconds = (performance.now() - started) / 1000;
    const result = optimisePositions(approximate, links, settings.global);
    const summary = summarise(result);
    log.log(`Pairs: ${summary.used} of ${summary.links} used, ${summary.lowCorrelation} below r = ${settings.global.threshold}, ${summary.outliers} outliers; mean residual ${summary.meanResidual.toFixed(3)} px, largest ${summary.maxResidual.toFixed(3)} px`, "info", "analysis");
    if (summary.unlinkedGroups) log.log(`${summary.unlinkedGroups} tile group${summary.unlinkedGroups > 1 ? "s were" : " was"} not linked to the rest and kept the layout position`, "warning", "analysis");
    checkFusedSize(result.positions);
    // The Layout view shows the tiles at the positions this run started from.
    if (!preview || !samePositions(preview.positions, approximate)) {
      progress.setProgress(0.76, "Preview of the layout…");
      await fusePreview(approximate, current);
    }
    progress.setProgress(0.78, "Fusing…");
    const fused = await fuseInWorker(result.positions, current, { tiff: true, onProgress: (fraction) => progress.setProgress(0.78 + 0.12 * fraction, "Fusing…") });
    current.throwIfAborted();
    progress.setProgress(0.92, "Writing OME-Zarr…");
    const names = tiles.map((tile) => tile.name);
    const stem = `${outputStem(names)}_stitched`;
    const pixelSize = tiles[0].pixelSize;
    const { writeFusedOmeZarr } = await import("./ome-zarr.js");
    const omeZarr = await writeFusedOmeZarr({ data: fused.data, shape: fused.shape, pixelSize, dtype: tiles[0].dtype }, `${stem}.ozx`);
    current.throwIfAborted();
    const seconds = (performance.now() - started) / 1000;
    const record = provenance({
      app: APP,
      names,
      dims: dims(),
      dtype: tiles[0].dtype,
      pixelSize,
      settings: { ...settings, layoutFile: settings.layout === "file" ? layoutFile?.name : undefined },
      approximate,
      result,
      fused,
      timings: { registrationSeconds: Number(registrationSeconds.toFixed(2)), totalSeconds: Number(seconds.toFixed(2)) },
    });
    run = {
      id: ++runCount,
      settings,
      result,
      fused: { data: fused.data, shape: fused.shape, origin: fused.origin },
      files: {
        fused: { description: `Fused image · ${fused.shape.join(" × ")} (TIFF)`, file: new File([fused.tiff], `${stem}.tif`, { type: "image/tiff" }) },
        omeZarr: { description: "Fused image (OME-Zarr .ozx)", file: omeZarr },
        configuration: { description: "TileConfiguration.registered.txt", file: textFile(registeredConfiguration(names, result.positions), "TileConfiguration.registered.txt", "text/plain"), viewable: false },
        links: { description: `Pairs (CSV) · ${summary.used}/${summary.links} used`, file: textFile(linksCsv(names, result.links), `${stem}_pairs.csv`, "text/csv") },
        provenance: { description: "Provenance (JSON)", file: textFile(`${JSON.stringify(record, null, 2)}\n`, `${stem}_provenance.json`, "application/json"), viewable: false },
      },
    };
    results.render(run.files);
    renderReport();
    $("outputSection").open = true;
    scene = null;
    await show("stitched");
    current.throwIfAborted();
    progress.end("Stitching complete");
    const moved = largestMove(approximate, result.positions);
    status(`Stitched ${tiles.length} tiles · ${fused.shape.join(" × ")} · moved up to ${moved.toFixed(1)} px · largest residual ${summary.maxResidual.toFixed(2)} px · ${seconds.toFixed(1)} s`);
    return { artifacts: Object.entries(run.files).map(([role, { file }]) => ({ role, file })), provenance: record };
  });
}

function report(error) {
  const cancelled = error?.name === "AbortError";
  status(cancelled ? "Cancelled" : error.message, !cancelled);
  if (error instanceof SettingsError) {
    if (ADVANCED.has(error.field)) $("advancedSettings").open = true;
    $(error.field)?.focus();
  }
}

function settingsOrReport() {
  try {
    return readSettings(formValues());
  } catch (error) {
    report(error);
    return null;
  }
}

function importFiles(filesPromise) {
  exampleControl.cancel();
  return filesPromise.then((files) => loadTiles(files)).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  busy?.abort();
};
$("tileInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
$("layoutInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  void readLayoutFile(file)
    .then(() => {
      status(`${file.name} loaded`);
      if (tiles && !busy) return operation("Preview of the layout…", undefined, (signal) => showPreview(signal)).then(() => progress.end("Layout preview ready"));
    })
    .catch(report);
});
bindFileDrop($("layoutDrop"), (filesPromise) => filesPromise.then((files) => readLayoutFile(files[0])).catch(report));
$("layout").addEventListener("change", () => setLayout($("layout").value));
setLayout(DEFAULT_VALUES.layout);

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadTiles(files, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("previewButton").addEventListener("click", () => {
  if (!settingsOrReport()) return;
  void operation("Preview of the layout…", undefined, (signal) => showPreview(signal))
    .then((shown) => shown && progress.end("Layout preview ready"))
    .catch(report);
});
$("runButton").addEventListener("click", () => {
  const settings = settingsOrReport();
  if (settings) void stitchTiles(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    stitch: async ({ inputs, parameters, signal }) => {
      await loadTiles([...(inputs.tiles ?? []), ...(inputs.layout ?? [])], signal);
      const values = { ...formValues(), ...(inputs.layout?.length ? { layout: "file" } : {}), ...parameters };
      const settings = readSettings(values);
      showSettings(values);
      return stitchTiles(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  busy?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, layouts: LAYOUTS, run: () => run });
