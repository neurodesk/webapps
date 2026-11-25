// The "Tissue correction" sidebar section and the Voxel view: load a T1 from
// the same session, segment it (MindMap partial-volume maps), place the
// spectroscopy voxel on it, and turn the fractions inside the voxel into
// tissue-corrected concentrations. The page (main.js) calls in through the
// object returned by createTissuePanel; the science lives in voxel.js and
// tissue.js.
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { version as mindgrabVersion } from "@brainchop/core/package.json";
import { readImageFiles } from "@neurodesk/runtime-support/dcm2niix-client";
import { chooseBackend as chooseMindgrabBackend, isSoftwareAdapter } from "@neurodesk/runtime-support/mindgrab/backend";
import { decodeNiftiBuffer, parseNiftiHeader, readNiftiImageData, extractNiftiHeader, createFloat32Nifti } from "@neurodesk/webapp-components/file-io";
import { bindFileDrop } from "@neurodesk/webapp-components/ui";
import { voxelWeights, tissueFractions } from "@neurodesk/lcmodel/voxel";
import { correctionFor, tissueTexts } from "@neurodesk/lcmodel/tissue";

const $ = (id) => document.getElementById(id);
const FIELDS = { gm: "fGm", wm: "fWm", csf: "fCsf" };
const MAPS = { gm: { label: "Grey matter", colormap: "green" }, wm: { label: "White matter", colormap: "blue" }, csf: { label: "CSF", colormap: "violet" } };
const fixed = (x, digits = 2) => Number(x).toFixed(digits);
// MindMap's WebGL2 WASM module has a fixed 768 MiB heap: a T1 larger than its
// own 256^3 grid (0.8 mm isotropic, GE's 512 x 512 matrices) runs out of memory
// on WebGL2, so when WebGPU V4 is unavailable those go to the growable CPU module.
const WEBGL2_MAX_VOXELS = 256 ** 3;
const WEBGPU_MIN_BUFFER_BYTES = 128 * 1024 * 1024;

function t1HeaderFacts(header) {
  const types = { 2: "uint8", 4: "int16", 8: "int32", 16: "float32", 64: "float64", 256: "int8", 512: "uint16", 768: "uint32" };
  const type = types[header.datatype] ?? `datatype ${header.datatype}`;
  return `${type}, scaling ${header.sclSlope} x + ${header.sclInter}, qform code ${header.qformCode}, sform code ${header.sformCode}`;
}

/**
 * @param {{
 *   status: (message: string, error?: boolean) => void,
 *   log: {log: (message: string, level?: string) => void},
 *   progress: {begin: Function, setProgress: Function, setIndeterminate: Function, end: Function, reset: Function},
 *   setBusy: (busy: boolean) => void,
 *   onChange: () => void,
 *   onViewAvailable: (available: boolean) => void,
 *   onViewRequested: () => void,
 * }} hooks
 */
export function createTissuePanel(hooks) {
  let t1 = null; // { name, buffer, header, dims, affine }
  let maps = null; // { gm, wm, csf, backend, elapsedMs }
  let dataset = null; // { voxel, fieldT, teMs, trMs, waterTeMs, waterTrMs }
  let weights = null; // per T1 voxel, for the current voxel
  let measured = null; // fractions from the segmentation for the current voxel
  let viewer = null;
  let viewerReady = null;
  let renderQueue = Promise.resolve();
  let renderVersion = 0;
  let renderedT1 = null;
  let renderedVoxel = null;
  const mapSelect = document.createElement("select");
  mapSelect.id = "tissueMap";
  mapSelect.setAttribute("aria-label", "Tissue map");
  mapSelect.append(new Option("Anatomy", "anatomy"));
  for (const [id, { label }] of Object.entries(MAPS)) mapSelect.append(new Option(label, id));
  const mapField = document.createElement("div");
  mapField.className = "nd-field";
  mapField.hidden = true;
  const mapLabel = document.createElement("label");
  mapLabel.htmlFor = mapSelect.id;
  mapLabel.textContent = "Image";
  mapField.append(mapLabel, mapSelect);
  const outputControls = [mapField];
  const voxelToggle = document.createElement("button");
  voxelToggle.type = "button";
  voxelToggle.className = "nd-btn nd-btn-secondary nd-btn-sm";
  voxelToggle.textContent = "Voxel";
  voxelToggle.setAttribute("aria-label", "Show spectroscopy voxel");
  voxelToggle.setAttribute("aria-pressed", "true");
  const viewControls = [voxelToggle];
  for (const control of viewControls) control.hidden = true;
  mapSelect.addEventListener("change", () => {
    hooks.onViewRequested();
    void show();
  });
  voxelToggle.addEventListener("click", () => {
    voxelToggle.setAttribute("aria-pressed", String(voxelToggle.getAttribute("aria-pressed") !== "true"));
    void show();
  });
  let worker = null;
  let active = null; // AbortController of the running segmentation

  function fractionsFromFields() {
    const values = Object.fromEntries(Object.entries(FIELDS).map(([k, id]) => [k, $(id).value.trim()]));
    if (Object.values(values).some((v) => v === "")) return null;
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]));
  }

  function fillFields(f) {
    for (const [k, id] of Object.entries(FIELDS)) $(id).value = f ? fixed(f[k], 3) : "";
  }

  function summary(text, level = "hint") {
    const el = $("tissueSummary");
    el.hidden = !text;
    el.textContent = text ?? "";
    el.className = level === "hint" ? "nd-hint" : `nd-message ${level}`;
  }

  function canMeasure() {
    return Boolean(t1 && dataset?.voxel);
  }

  function refresh() {
    $("measureButton").disabled = !canMeasure();
    mapField.hidden = !t1;
    hooks.onViewAvailable(Boolean(t1));
    for (const option of mapSelect.options) option.disabled = option.value !== "anatomy" && !maps;
    voxelToggle.disabled = !dataset?.voxel;
    if (t1 && dataset && !dataset.voxel) {
      summary(dataset.voxelNote ? "The voxel position could not be read (see the log); enter fractions." : "The voxel position is unavailable; enter fractions.", "warning");
    }
  }

  /** The loaded spectroscopy dataset's header (null when there is none). */
  function setDataset(header) {
    const next = header?.voxel
      ? { voxel: header.voxel, fieldT: header.fieldT, teMs: header.teMs, trMs: header.trMs, waterTeMs: header.waterTeMs, waterTrMs: header.waterTrMs }
      : header
        ? { voxel: null, voxelNote: header.voxelNote ?? null, fieldT: header.fieldT, teMs: header.teMs, trMs: header.trMs, waterTeMs: header.waterTeMs, waterTrMs: header.waterTrMs }
        : null;
    const sameVoxel = JSON.stringify(next?.voxel?.affine) === JSON.stringify(dataset?.voxel?.affine);
    dataset = next;
    if (!sameVoxel) {
      weights = null;
      if (measured) {
        // Fractions measured for another voxel no longer apply.
        measured = null;
        fillFields(null);
        summary("");
      }
      if (maps && canMeasure()) measureFromMaps();
    }
    refresh();
    if (viewer && !$("t1Canvas").hidden) void show();
  }

  async function prepareT1(files, signal) {
    hooks.progress.setIndeterminate?.("Reading the T1 image…");
    const images = await readImageFiles(files, { signal });
    signal?.throwIfAborted();
    if (images.length !== 1) throw new Error(images.length ? `These files hold ${images.length} images; choose the one T1 series.` : "No image found among the T1 files.");
    const buffer = await decodeNiftiBuffer(await images[0].arrayBuffer());
    const header = parseNiftiHeader(buffer);
    if (header.dims.slice(4, header.dims[0] + 1).some((dimension) => dimension > 1)) throw new Error("The T1 image must be a single 3D volume.");
    const count = header.nx * header.ny * header.nz;
    if ([header.nx, header.ny, header.nz].some((dimension) => dimension < 1)
      || !Number.isFinite(header.voxOffset) || header.voxOffset < 348
      || header.bitpix < 8 || header.voxOffset + count * header.bitpix / 8 > buffer.byteLength) {
      throw new Error("The T1 image has incomplete voxel data.");
    }
    signal?.throwIfAborted();
    return { name: images[0].name, buffer, header, dims: [header.nx, header.ny, header.nz], affine: header.affine.map((row) => Array.from(row)), sourceFiles: [...files] };
  }

  async function loadT1(files, signal) {
    const prepared = await prepareT1(files, signal);
    signal?.throwIfAborted();
    await commitT1(prepared);
  }

  async function commitT1(prepared) {
    cancel();
    renderVersion++;
    mapSelect.value = "anatomy";
    voxelToggle.setAttribute("aria-pressed", "true");
    t1 = prepared;
    const { header } = t1;
    maps = null;
    weights = null;
    if (measured) {
      measured = null;
      fillFields(null);
    }
    summary("");
    $("t1Info").hidden = false;
    $("t1Info").textContent = `${t1.name}: ${t1.dims.join(" × ")} voxels, ${header.voxelSize.map((v) => fixed(v, 1)).join(" × ")} mm`;
    $("t1Drop").classList.add("has-files");
    $("t1Input").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [...(t1.sourceFiles ?? [])], restoreWithUndo: true } }));
    hooks.log.log(`T1 loaded: ${$("t1Info").textContent}; ${t1HeaderFacts(header)}`);
    refresh();
    hooks.onChange();
    hooks.onViewRequested();
    await show();
  }

  function currentWeights() {
    if (!weights) weights = voxelWeights(dataset.voxel.affine, { affine: t1.affine, dims: t1.dims });
    return weights;
  }

  function measureFromMaps() {
    const w = currentWeights();
    const f = tissueFractions(w.weights, maps);
    measured = f;
    fillFields(f);
    const volume = (w.volumeMm3 / 1000).toFixed(1);
    const nominal = (w.nominalMm3 / 1000).toFixed(1);
    summary(`MindMap: GM ${fixed(f.gm)}, WM ${fixed(f.wm)}, CSF ${fixed(f.csf)} (${Math.round((1 - f.coverage) * 100)}% unlabelled, as CSF)`);
    hooks.log.log(`Tissue fractions (MindMap on ${maps.backend}): GM ${f.gm.toFixed(4)}, WM ${f.wm.toFixed(4)}, CSF ${f.csf.toFixed(4)}; the maps label ${(f.coverage * 100).toFixed(1)}% of the voxel and the rest counts as CSF; ${volume} of ${nominal} ml inside the T1`);
    if (w.volumeMm3 < 0.9 * w.nominalMm3) hooks.log.log("Part of the spectroscopy voxel lies outside the T1 image.", "warning");
    return f;
  }

  function segment(signal, backend) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      worker = new Worker(new URL("./tissue-worker.js", import.meta.url), { type: "module" });
      const stop = () => {
        worker?.terminate();
        worker = null;
        reject(new DOMException("Segmentation cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", stop, { once: true });
      worker.onmessage = ({ data }) => {
        signal?.removeEventListener("abort", stop);
        worker?.terminate();
        worker = null;
        if (data.error) {
          for (const line of data.log?.slice(-40) ?? []) hooks.log.log(`MindMap: ${line}`);
          reject(new Error(`Segmentation failed: ${data.error}`));
        } else resolve(data.result);
      };
      worker.onerror = (event) => {
        signal?.removeEventListener("abort", stop);
        worker?.terminate();
        worker = null;
        reject(new Error(`Segmentation failed: ${event.message || "the worker stopped"}`));
      };
      worker.postMessage({
        input: t1.buffer.slice(0),
        options: { model: "mindmap", backend, gzipOutput: false, assetPath: `${import.meta.env.BASE_URL}brainchop/${mindgrabVersion}/` },
      });
    });
  }

  /**
   * Prefer hardware WebGPU (pure-JS V4 supports f16 and f32 fallback down to
   * 128 MiB storage buffers), then hardware WebGL2 (within its 256^3 WASM heap),
   * then the threaded CPU module (cross-origin isolated).
   */
  async function chooseBackend() {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
    const info = adapter?.info;
    const gpu = info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ") || "unnamed adapter" : "no WebGPU adapter";
    const softwareGpu = isSoftwareAdapter(info) || Boolean(adapter?.isFallbackAdapter);
    const limits = adapter?.limits;
    const bufferOk = !limits || ((limits.maxBufferSize ?? Infinity) >= WEBGPU_MIN_BUFFER_BYTES && (limits.maxStorageBufferBindingSize ?? Infinity) >= WEBGPU_MIN_BUFFER_BYTES);
    hooks.log.log(`Browser: ${navigator.userAgent}; WebGPU: ${gpu}${softwareGpu ? " (software fallback)" : ""}${adapter && !adapter.features?.has("shader-f16") ? ", f32 fallback" : ""}`);
    const choice = chooseMindgrabBackend({
      webgpu: { supported: Boolean(adapter && bufferOk), software: softwareGpu },
      webgl2: () => {
        const voxels = t1.dims[0] * t1.dims[1] * t1.dims[2];
        if (voxels > WEBGL2_MAX_VOXELS && globalThis.crossOriginIsolated) {
          hooks.log.log(`The T1 has ${voxels.toLocaleString("en")} voxels, more than the WebGL2 module's 768 MiB heap holds (256³): segmenting on the CPU`);
          return { supported: false };
        }
        const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
        if (!gl) return { supported: false };
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        const caveatGl = new OffscreenCanvas(1, 1).getContext("webgl2", { failIfMajorPerformanceCaveat: true });
        const caveat = !caveatGl;
        caveatGl?.getExtension("WEBGL_lose_context")?.loseContext();
        return { supported: true, renderer, caveat };
      },
      cpu: Boolean(globalThis.crossOriginIsolated),
    });
    if (choice === null) {
      throw new Error("No hardware GPU is available for MindMap and the CPU backend requires cross-origin isolation.");
    }
    return choice === "auto" ? "cpu" : choice;
  }

  /** Segment the T1 (once per T1) and measure the voxel. */
  async function measure(signal) {
    signal?.throwIfAborted();
    if (!canMeasure()) throw new Error(t1 ? "These spectroscopy data do not record the voxel position." : "Load a T1 image first.");
    const measuredT1 = t1;
    if (!maps) {
      hooks.progress.setIndeterminate?.("Segmenting the T1 image (MindMap)…");
      hooks.status("Segmenting the T1 image (MindMap)…");
      const controller = new AbortController();
      active = controller;
      signal?.addEventListener("abort", () => controller.abort(), { once: true });
      let result;
      try {
        const backend = await chooseBackend();
        hooks.log.log(`Segmenting with MindMap on ${backend}`);
        try {
          result = await segment(controller.signal, backend);
        } catch (error) {
          // A GPU module can still run out of memory or lose its device.
          if (backend === "cpu" || error.name === "AbortError" || !globalThis.crossOriginIsolated) throw error;
          hooks.log.log(`${error.message}; segmenting on the CPU instead`, "warning");
          result = await segment(controller.signal, "cpu");
        }
      } finally {
        if (active === controller) active = null;
      }
      controller.signal.throwIfAborted();
      if (t1 !== measuredT1) throw new DOMException("T1 replaced", "AbortError");
      const read = (b) => readNiftiImageData(b).data;
      // Own copies: the CPU module may hand back views of its shared memory.
      const files = Object.fromEntries(["gm", "wm", "csf"].map((k) => [k, new Uint8Array(result.tissues[k]).slice().buffer]));
      const gm = read(files.gm);
      if (gm.length !== t1.dims[0] * t1.dims[1] * t1.dims[2]) throw new Error("The tissue maps do not match the T1 grid.");
      maps = { gm, wm: read(files.wm), csf: read(files.csf), backend: result.backend, elapsedMs: result.elapsedMs, files };
      hooks.log.log(`MindMap tissue maps on ${result.backend} in ${(result.elapsedMs / 1000).toFixed(1)} s`);
    }
    const f = measureFromMaps();
    mapSelect.value = "gm";
    refresh();
    hooks.onChange();
    hooks.onViewRequested();
    await show();
    return f;
  }

  /**
   * Tissue-corrected rows, or { reason } when the correction does not apply.
   * @param rows LCModel's rows; `waterScaled` whether they are in mM.
   */
  function correct(rows, { waterScaled, edited }) {
    return correctionFor(rows, { fractions: fractionsFromFields(), header: dataset, waterScaled, edited, metaboliteRelaxation: $("metabRelax").checked });
  }

  /** Downloads for the result list, keyed by stage. */
  function resultFiles(result, stem, ratioTo) {
    if (!result?.rows) return {};
    const texts = tissueTexts(result, stem, ratioTo, {
      fractionSource: measured ? { method: "MindMap partial-volume maps (@brainchop/core segmentTissues)", version: mindgrabVersion, backend: maps?.backend, t1: t1?.name, coverage: measured.coverage } : "entered",
      voxel: dataset?.voxel ?? null,
      voxelInT1Mm3: weights?.volumeMm3 ?? null,
    });
    const entries = Object.fromEntries(Object.entries(texts).map(([role, { description, name, type, body, viewable }]) => [role, { description, file: new File([body], name, { type }), viewable }]));
    if (t1 && dataset?.voxel) entries.voxelMask = { description: "Voxel mask in T1 space (.nii)", file: new File([maskNifti()], `${stem}_voxel_mask.nii`), viewable: true };
    if (measured && maps?.files) {
      // The partial-volume maps behind the fractions, for checking the segmentation.
      const t1Stem = t1.name.replace(/\.nii(\.gz)?$/i, "");
      for (const [key, label] of [["gm", "Grey matter"], ["wm", "White matter"], ["csf", "CSF"]]) {
        entries[`${key}Map`] = { description: `${label} map (.nii)`, file: new File([maps.files[key]], `${t1Stem}_${key}.nii`), viewable: true };
      }
    }
    return entries;
  }

  function maskNifti() {
    return createFloat32Nifti(currentWeights().weights, extractNiftiHeader(t1.buffer));
  }

  // -------------------------------------------------------------- viewer

  async function ensureViewer() {
    viewerReady ??= (async () => {
      const next = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
      await next.attachTo("t1Canvas");
      next.sliceType = SLICE_TYPE.MULTIPLANAR;
      next.isColorbarVisible = false;
      viewer = next;
    })().catch((error) => {
      viewerReady = null;
      throw error;
    });
    return viewerReady;
  }

  async function renderAnatomy(version) {
    if (!t1 || version !== renderVersion) return;
    await ensureViewer();
    if (!t1 || version !== renderVersion) return;
    const image = t1;
    const voxel = dataset?.voxel;
    const samePosition = renderedT1 === image && renderedVoxel === voxel;
    const crosshair = samePosition ? viewer.getCrosshairPos() : voxel?.centerMm;
    const name = image.name.replace(/\.gz$/i, "");
    const volumes = [{ url: new File([image.buffer], name), name }];
    const map = mapSelect.value;
    if (maps && MAPS[map]) {
      volumes.push({ url: new File([maps.files[map]], `${map}.nii`), name: `${map}.nii`, colormap: MAPS[map].colormap, opacity: 0.5, calMin: 0, calMax: 1, isColorbarVisible: false });
    }
    if (voxel && voxelToggle.getAttribute("aria-pressed") === "true") {
      volumes.push({ url: new File([maskNifti()], "voxel.nii"), name: "voxel.nii", colormap: "red", opacity: 0.45, calMin: 0, calMax: 1, isColorbarVisible: false });
    }
    await viewer.loadVolumes(volumes);
    if (version !== renderVersion) return;
    if (crosshair) viewer.setCrosshairPos(crosshair);
    renderedT1 = image;
    renderedVoxel = voxel;
    $("plotLabel").textContent = voxel
      ? `Voxel ${voxel.sizeMm.map((s) => fixed(s, 0)).join(" × ")} mm at ${voxel.centerMm.map((c) => fixed(c, 1)).join(", ")} mm (RAS) on ${image.name}`
      : image.name;
    $("viewerNotice").hidden = true;
    $("viewerNotice").textContent = "";
  }

  async function show(map) {
    if (map && (map === "anatomy" || (maps && MAPS[map]))) mapSelect.value = map;
    $("t1Canvas").hidden = false;
    for (const control of viewControls) control.hidden = false;
    const version = ++renderVersion;
    renderQueue = renderQueue.then(() => renderAnatomy(version)).catch((error) => {
      if (version !== renderVersion) return;
      $("viewerNotice").hidden = false;
      $("viewerNotice").textContent = `The image viewer is unavailable: ${error.message}`;
    });
    await renderQueue;
  }

  function hide() {
    renderVersion++;
    $("t1Canvas").hidden = true;
    for (const control of viewControls) control.hidden = true;
  }

  function cancel() {
    active?.abort();
  }

  async function runMeasure() {
    hooks.setBusy(true);
    hooks.progress.begin("Segmenting the T1 image…");
    try {
      const f = await measure();
      hooks.progress.end("Voxel measured");
      hooks.status(`Tissue fractions: GM ${fixed(f.gm)}, WM ${fixed(f.wm)}, CSF ${fixed(f.csf)}`);
    } catch (error) {
      if (error.name === "AbortError") {
        hooks.progress.reset("Cancelled");
        hooks.status("Segmentation cancelled");
      } else {
        hooks.progress.end(error.message, { success: false });
        hooks.status(error.message, true);
      }
    } finally {
      hooks.setBusy(false);
    }
  }

  // -------------------------------------------------------------- wiring

  async function importT1(files) {
    hooks.setBusy(true);
    hooks.progress.begin("Reading the T1 image…");
    try {
      await loadT1(files);
      hooks.progress.end("T1 loaded");
      hooks.status(dataset?.voxel ? "T1 loaded; segment it to measure the voxel." : "T1 loaded.");
    } catch (error) {
      $("t1Input").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [...(t1?.sourceFiles ?? [])], cancelPending: true } }));
      hooks.progress.end(error.message, { success: false });
      hooks.status(error.message, true);
    } finally {
      hooks.setBusy(false);
    }
  }

  $("t1Input").addEventListener("nd-replace", () => {
    hooks.onT1Replace?.();
  });
  $("t1Input").addEventListener("change", (event) => {
    const files = Array.from(event.target.files);
    event.target.value = "";
    if (!files.length) return;
    if (hooks.onT1Input?.(files)) return;
    void importT1(files);
  });
  bindFileDrop($("t1Drop"), async (files) => importT1(await files));
  // Update as the user types: waiting for "change" would re-render the results
  // while the pointer is on its way to a Download button, and the table growing
  // above it would move the button out from under the click.
  for (const id of Object.values(FIELDS)) {
    $(id).addEventListener("input", () => {
      const f = fractionsFromFields();
      if (measured && f && Object.keys(FIELDS).some((k) => Math.abs(f[k] - measured[k]) > 5e-4)) {
        measured = null;
        summary("Entered fractions");
      }
      hooks.onChange();
    });
  }
  $("metabRelax").addEventListener("change", () => hooks.onChange());
  $("measureButton").addEventListener("click", () => void runMeasure());

  /** Forget the T1 and the fractions (another subject's data). */
  function reset({ notify = true } = {}) {
    cancel();
    hide();
    mapSelect.value = "anatomy";
    voxelToggle.setAttribute("aria-pressed", "true");
    renderedT1 = null;
    renderedVoxel = null;
    t1 = null;
    maps = null;
    weights = null;
    measured = null;
    fillFields(null);
    summary("");
    $("t1Info").hidden = true;
    $("t1Drop").classList.remove("has-files");
    if (notify) {
      $("t1Input").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [], restoreWithUndo: true } }));
    }
    refresh();
  }

  return {
    outputControls,
    viewControls,
    setDataset,
    reset,
    loadT1,
    prepareT1,
    commitT1,
    measure,
    correct,
    resultFiles,
    show,
    hide,
    cancel,
    get hasT1() {
      return Boolean(t1);
    },
    get files() {
      return [...(t1?.sourceFiles ?? [])];
    },
    get needsSegmentation() {
      return canMeasure() && !measured && !fractionsFromFields();
    },
    get fractions() {
      return fractionsFromFields();
    },
    get source() {
      return measured ? { kind: "segmentation", backend: maps?.backend, coverage: measured.coverage } : fractionsFromFields() ? { kind: "entered" } : null;
    },
    setFractions(f) {
      measured = null;
      fillFields(f);
      summary(f ? "Entered fractions" : "");
    },
    setDisabled(disabled) {
      $("t1Input").disabled = disabled;
      $("measureButton").disabled = disabled || !canMeasure();
    },
  };
}
