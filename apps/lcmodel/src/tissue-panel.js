// The "Tissue correction" sidebar section and the Voxel view: load a T1 from
// the same session, segment it (MindMap partial-volume maps), place the
// spectroscopy voxel on it, and turn the fractions inside the voxel into
// tissue-corrected concentrations. The page (main.js) calls in through the
// object returned by createTissuePanel; the science lives in voxel.js and
// tissue.js.
import { version as mindgrabVersion } from "@brainchop/mindgrab/package.json";
import { readImageFiles } from "@neurodesk/runtime-support/dcm2niix-client";
import { decodeNiftiBuffer, parseNiftiHeader, readNiftiImageData, extractNiftiHeader, createFloat32Nifti } from "@neurodesk/webapp-components/file-io";
import { bindFileDrop } from "@neurodesk/webapp-components/ui";
import { voxelWeights, tissueFractions } from "./voxel.js";
import { correctConcentrations, correctedCsv, fieldKey } from "./tissue.js";

const $ = (id) => document.getElementById(id);
const FIELDS = { gm: "fGm", wm: "fWm", csf: "fCsf" };
const fixed = (x, digits = 2) => Number(x).toFixed(digits);

/**
 * @param {{
 *   status: (message: string, error?: boolean) => void,
 *   log: {log: (message: string, level?: string) => void},
 *   progress: {begin: Function, setProgress: Function, setIndeterminate: Function, end: Function, reset: Function},
 *   setBusy: (busy: boolean) => void,
 *   onChange: () => void,
 *   onViewAvailable: (available: boolean) => void,
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
    hooks.onViewAvailable(canMeasure());
    if (t1 && dataset && !dataset.voxel) summary("This format does not record where the voxel is; enter fractions.", "warning");
  }

  /** The loaded spectroscopy dataset's header (null when there is none). */
  function setDataset(header) {
    const next = header?.voxel
      ? { voxel: header.voxel, fieldT: header.fieldT, teMs: header.teMs, trMs: header.trMs, waterTeMs: header.waterTeMs, waterTrMs: header.waterTrMs }
      : header
        ? { voxel: null, fieldT: header.fieldT, teMs: header.teMs, trMs: header.trMs, waterTeMs: header.waterTeMs, waterTrMs: header.waterTrMs }
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
    if (viewer && !$("t1Canvas").hidden) void showOverlay();
  }

  async function loadT1(files, signal) {
    hooks.progress.setIndeterminate?.("Reading the T1 image…");
    const images = await readImageFiles(files, { signal });
    signal?.throwIfAborted();
    if (images.length !== 1) throw new Error(images.length ? `These files hold ${images.length} images; choose the one T1 series.` : "No image found among the T1 files.");
    const buffer = await decodeNiftiBuffer(await images[0].arrayBuffer());
    const header = parseNiftiHeader(buffer);
    if (header.dims[0] > 3 && header.dims[4] > 1) throw new Error("The T1 image must be a single 3D volume.");
    t1 = { name: images[0].name, buffer, header, dims: [header.nx, header.ny, header.nz], affine: header.affine.map((row) => Array.from(row)) };
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
    hooks.log.log(`T1 loaded: ${$("t1Info").textContent}`);
    refresh();
    if (viewer && !$("t1Canvas").hidden) await showOverlay();
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
        if (data.error) reject(new Error(`Segmentation failed: ${data.error}`));
        else resolve(data.result);
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
   * mindgrab's `auto` takes WebGL2 whenever WebGPU is missing, even on a
   * software renderer (SwiftShader, llvmpipe), where MindMap takes many
   * minutes; its threaded CPU module is far faster there. Prefer WebGPU,
   * then hardware WebGL2, then the CPU (the page is cross-origin isolated).
   */
  async function chooseBackend() {
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    if (adapter && !adapter.info?.isFallbackAdapter && adapter.features.has("shader-f16")) return "webgpu";
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    const software = !gl || /swiftshader|llvmpipe|software|softpipe/i.test(renderer);
    if (software && globalThis.crossOriginIsolated) return "cpu";
    return gl ? "webgl2" : "cpu";
  }

  /** Segment the T1 (once per T1) and measure the voxel. */
  async function measure(signal) {
    if (!canMeasure()) throw new Error(t1 ? "These spectroscopy data do not record the voxel position." : "Load a T1 image first.");
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
        result = await segment(controller.signal, backend);
      } finally {
        if (active === controller) active = null;
      }
      const read = (b) => readNiftiImageData(b).data;
      // Own copies: the CPU module may hand back views of its shared memory.
      const files = Object.fromEntries(["gm", "wm", "csf"].map((k) => [k, new Uint8Array(result.tissues[k]).slice().buffer]));
      const gm = read(files.gm);
      if (gm.length !== t1.dims[0] * t1.dims[1] * t1.dims[2]) throw new Error("The tissue maps do not match the T1 grid.");
      maps = { gm, wm: read(files.wm), csf: read(files.csf), backend: result.backend, elapsedMs: result.elapsedMs, files };
      hooks.log.log(`MindMap tissue maps on ${result.backend} in ${(result.elapsedMs / 1000).toFixed(1)} s`);
    }
    const f = measureFromMaps();
    hooks.onChange();
    return f;
  }

  /**
   * Tissue-corrected rows, or { reason } when the correction does not apply.
   * @param rows LCModel's rows; `waterScaled` whether they are in mM.
   */
  function correct(rows, { waterScaled, edited }) {
    const fractions = fractionsFromFields();
    if (!fractions) return null;
    if (!waterScaled) return { reason: "Tissue correction needs water-scaled concentrations (a water reference)." };
    if (!dataset) return { reason: "Tissue correction needs the acquisition header (not a .RAW file)." };
    if (!fieldKey(dataset.fieldT)) return { reason: `Relaxation constants are tabulated for 3 T and 7 T, not ${fixed(dataset.fieldT)} T.` };
    try {
      return correctConcentrations(rows, {
        fractions,
        fieldT: dataset.fieldT,
        metabolite: { teMs: dataset.teMs, trMs: dataset.trMs },
        water: { teMs: dataset.waterTeMs ?? dataset.teMs, trMs: dataset.waterTrMs ?? dataset.trMs },
        metaboliteRelaxation: $("metabRelax").checked,
        alpha: edited,
      });
    } catch (error) {
      return { reason: error.message };
    }
  }

  /** Downloads for the result list, keyed by stage. */
  function resultFiles(result, stem, ratioTo) {
    if (!result?.rows) return {};
    const report = {
      fractions: result.fractions,
      molalFractions: result.molalFractions,
      fractionSource: measured ? { method: "MindMap partial-volume maps (@brainchop/mindgrab segmentTissues)", version: mindgrabVersion, backend: maps?.backend, t1: t1?.name, coverage: measured.coverage } : "entered",
      voxel: dataset?.voxel ?? null,
      voxelInT1Mm3: weights?.volumeMm3 ?? null,
      waterAttenuation: result.waterAttenuation,
      ...result.constants,
      concentrations: result.rows.map((r) => ({ name: r.name, lcmodel: r.concentration, corrected: r.corrected, alphaCorrected: r.alphaCorrected ?? null, t1Ms: r.t1 * 1000, t2Ms: r.t2 * 1000 })),
    };
    const entries = {
      tissueConcentrations: { description: "Tissue-corrected concentrations (.csv)", file: new File([correctedCsv(result, ratioTo)], `${stem}_tissue_corrected.csv`, { type: "text/csv" }), viewable: false },
      tissueReport: { description: "Tissue correction inputs (.json)", file: new File([JSON.stringify(report, null, 2)], `${stem}_tissue_correction.json`, { type: "application/json" }), viewable: false },
    };
    if (t1 && dataset?.voxel) entries.voxelMask = { description: "Voxel mask in T1 space (.nii)", file: new File([maskNifti()], `${stem}_voxel_mask.nii`), viewable: true };
    if (measured && maps?.files) {
      // The partial-volume maps behind the fractions, for checking the segmentation.
      const t1Stem = t1.name.replace(/\.nii(\.gz)?$/i, "");
      for (const [key, label] of [["gm", "Grey matter"], ["wm", "White matter"], ["csf", "CSF"]]) {
        entries[`${key}Map`] = { description: `${label} map (.nii)`, file: new File([maps.files[key]], `${t1Stem}_${key}.nii`), viewable: false };
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
      // NiiVue loads with the first Voxel view, not with the page.
      const { default: NiiVue, SLICE_TYPE } = await import("@niivue/niivue");
      viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
      await viewer.attachTo("t1Canvas");
      viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
      viewer.isColorbarVisible = false;
    })();
    return viewerReady;
  }

  async function showOverlay() {
    if (!t1) return;
    await ensureViewer();
    const volumes = [{ url: new File([t1.buffer], t1.name.replace(/\.gz$/i, "")), name: t1.name.replace(/\.gz$/i, "") }];
    if (dataset?.voxel) volumes.push({ url: new File([maskNifti()], "voxel.nii"), name: "voxel.nii", colormap: "red", opacity: 0.45, calMin: 0, calMax: 1, isColorbarVisible: false });
    await viewer.loadVolumes(volumes);
    // The crosshair (world mm) through the voxel centre, so all three planes cut it.
    if (dataset?.voxel) viewer.setCrosshairPos(dataset.voxel.centerMm);
    const v = dataset?.voxel;
    $("plotLabel").textContent = v
      ? `Voxel ${v.sizeMm.map((s) => fixed(s, 0)).join(" × ")} mm at ${v.centerMm.map((c) => fixed(c, 1)).join(", ")} mm (RAS) on ${t1.name}`
      : `${t1.name}: no voxel position in these spectroscopy data`;
  }

  async function show() {
    $("t1Canvas").hidden = false;
    try {
      await showOverlay();
    } catch (error) {
      $("viewerNotice").hidden = false;
      $("viewerNotice").textContent = `The image viewer is unavailable: ${error.message}`;
    }
  }

  function hide() {
    $("t1Canvas").hidden = true;
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
      hooks.onChange();
    } catch (error) {
      hooks.progress.end(error.message, { success: false });
      hooks.status(error.message, true);
    } finally {
      hooks.setBusy(false);
    }
  }

  $("t1Input").addEventListener("change", (event) => {
    const files = Array.from(event.target.files);
    event.target.value = "";
    if (files.length) void importT1(files);
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
  function reset() {
    cancel();
    t1 = null;
    maps = null;
    weights = null;
    measured = null;
    fillFields(null);
    summary("");
    $("t1Info").hidden = true;
    $("t1Drop").classList.remove("has-files");
    refresh();
  }

  return {
    setDataset,
    reset,
    loadT1,
    measure,
    correct,
    resultFiles,
    show,
    hide,
    cancel,
    get hasT1() {
      return Boolean(t1);
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
