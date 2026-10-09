/**
 * QSM Processing Web Worker - Pure JavaScript/WASM
 *
 * Runs QSM pipeline entirely in WASM without Pyodide.
 * All computation is done in Rust/WASM, no Python dependencies.
 */

// Import utilities - no fallbacks
import { computeWeightedEchoFit, ppmFieldToPhase } from './worker/utils/PhaseUtils.js';
import { createThresholdMask } from './worker/utils/MaskUtils.js';
import { resolveTgvParams } from './worker/utils/TgvParams.js';
import { clampTileConfig, MAX_WASM_PATCH_EDGE } from './worker/utils/DlTiling.js';
import { requireFieldStrength, echoTimeDependentStep, fieldMapEchoTimes } from './worker/utils/ScanParams.js';
import { buildConfigJson, buildQsmartInnerConfigJson } from './modules/ConfigBridge.js';
import { scaleVoxelSize } from './modules/mask/RodentMask.js';
import * as QSMConfig from './app/config.js';
import { createWorkerEmitter, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { parseRegistry, fetchModelWeights, loadDlWasm } from './modules/ModelWeights.js';

// Deep-learning model registry (id -> spec), populated from the base wasm after init, and
// the base URL for lazy-loading the DL wasm bundle. See ModelWeights.js.
let dlRegistry = {};
let wasmBaseUrl = '';
const DL_TOTAL_FIELD_MODELS = new Set(QSMConfig.DL_TOTAL_FIELD_MODELS); // take the total field (own BFR)
// Whole-volume nets that would OOM the 32-bit WASM heap on clinical data but have an
// overlap-tiled variant in qsm-core → run tiled (bounded memory, ~approximate). qsmgan/autoqsm
// already tile natively (no flag needed).
const DL_TILEABLE = new Set(QSMConfig.DL_TILING_DEFAULTS.tileable);
const isDlModel = (id) => Object.prototype.hasOwnProperty.call(dlRegistry, id);

/** Resolve the configured weight-host base to an absolute URL (or '' to use registry URLs). */
function weightBaseUrl() {
  const base = QSMConfig.MODEL_WEIGHT_BASE_URL || '';
  if (!base) return '';
  return /^https?:\/\//i.test(base) ? base : `${wasmBaseUrl}/${base.replace(/^\//, '')}`;
}

/** Fetch a DL model's weight files (IndexedDB-cached) with progress reported to the UI. */
async function downloadWeights(model) {
  const totalBytes = model.files.reduce((a, f) => a + (Number(f.bytes) || 0), 0);
  postLog(`Preparing ${model.name} weights (~${(totalBytes / 1e6).toFixed(0)} MB, cached after first download)...`);
  return fetchModelWeights(model, (idx, name, done, total, cached) => {
    if (cached) {
      postLog(`  ${name}: using cached weights`);
    } else {
      const frac = total ? done / total : 0;
      postProgress(0.63 + frac * 0.03,
        `Downloading ${model.name}: ${(done / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`);
    }
  }, weightBaseUrl());
}

// Track which wasm modules already have a rayon pool (each bundle is a separate module/memory
// with its own threadpool, so each is initialized independently and at most once).
const _rayonReady = new WeakSet();

/** Boot a wasm-bindgen-rayon threadpool for `mod`, if this is a threaded build on a
 *  cross-origin-isolated page. No-op (stays single-threaded) otherwise. `threads` bounds the
 *  pool — for the DL module this also bounds how many tiles run at once (each holds a full
 *  patch's activations in the single shared heap). */
async function initRayon(mod, label, threads) {
  try {
    if (!mod || typeof mod.initThreadPool !== 'function') return; // single-threaded build
    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
      postLog(`  (single-threaded — page is not cross-origin isolated; serve with COOP/COEP for threads)`);
      return;
    }
    if (_rayonReady.has(mod)) return;
    const hw = Math.max(1, self.navigator?.hardwareConcurrency || 4);
    const n = Math.max(1, Math.min(threads || hw, hw));
    await mod.initThreadPool(n);
    _rayonReady.add(mod);
    // Let qsm-core use the pool for deep-learning inference too (tract dispatches on rayon's
    // global pool on wasm). Per module instance: the DL bundle reports separately from the base.
    mod.set_threads_ready_wasm?.(true);
    postLog(`Threadpool ready: ${n} threads [${label}]`);
  } catch (e) {
    console.warn(`initThreadPool [${label}] failed; continuing single-threaded:`, e);
  }
}

/** Run a field-input DL inversion (local or total field → χ) in the lazy-loaded onnx bundle.
 *  `onProgress(done, total)` reports per-tile progress for tiled nets. `tiling` = the modal's
 *  dl_tiling settings ({enabled, tile_size, tile_halo}); defaults keep tiling on for supported
 *  models with a browser-safe 64³ patch. */
async function runDlFieldInversion(model, field, mask, nx, ny, nz, vsx, vsy, vsz, onProgress, tiling) {
  const weights = await downloadWeights(model);
  const dl = await loadDlWasm(wasmBaseUrl, QSMConfig.VERSION);
  // Bound the DL pool so concurrent tiles don't exhaust the shared 32-bit heap (each tile holds
  // its own patch activations). 4 is a safe default for ~64³ patches; tunable later.
  await initRayon(dl, 'dl', 4);
  postLog(`Running ${model.name} (deep-learning dipole inversion)...`);
  postProgress(0.7, `${model.name} inference...`);
  const w2 = weights[1] || new Uint8Array(0);
  const t = tiling || {};
  // Tiling on/off comes from the settings modal; default on for models with a tiled variant.
  const tiled = t.enabled !== undefined ? t.enabled !== false : DL_TILEABLE.has(model.id);
  // Browser-safe default 64³ patch (core 56 + halo 4): the size the natively-patch-based nets use,
  // proven not to OOM the 32-bit wasm heap; large core + thin halo minimizes overlap recompute.
  const { tile_core: defaultCore, tile_halo: defaultHalo } = QSMConfig.DL_TILING_DEFAULTS;
  const requestedCore = Number(t.tile_size) || defaultCore;
  const requestedHalo = Number.isFinite(Number(t.tile_halo)) ? Number(t.tile_halo) : defaultHalo;
  // One patch has to fit the wasm heap on its own; past that the run stalls rather than failing.
  const { core: tileCore, halo: tileHalo, clamped } = clampTileConfig(requestedCore, requestedHalo);
  if (tiled && clamped) {
    postLog(`  tile core ${requestedCore} + halo ${requestedHalo} is too big for the browser's memory; using core ${tileCore} + halo ${tileHalo} (${MAX_WASM_PATCH_EDGE}³ patches are the largest that fit)`);
  }
  if (tiled) postLog(`  tiled inference (${tileCore + 2 * tileHalo}³ patches, bounded memory; approximate vs whole-volume)`);
  const cb = onProgress || (() => {});
  return new Float64Array(dl.run_dl_field_inversion_wasm(
    model.id, field, mask, nx, ny, nz, vsx, vsy, vsz, 0, 0, 1, weights[0], w2, tiled, tileCore, tileHalo, cb,
  ));
}

let wasmModule = null;
const workerMessages = createWorkerEmitter(self);
const {
  complete: postComplete,
  error: postError,
  log: postLog,
  progress: postProgress,
} = workerMessages;

function emitMessage(message) {
  const { type, ...data } = message;
  workerMessages.emit(type, data);
}

// Send intermediate stage data for live display
// Set displayNow=false to cache without displaying (e.g., for auxiliary outputs)
function sendStageData(stage, data, dims, voxelSize, affine, description, displayNow = true, displayRange = null) {
  // Save as NIfTI and send to main thread
  const niftiBytes = wasmModule.save_nifti_wasm(
    data,
    dims[0], dims[1], dims[2],
    voxelSize[0], voxelSize[1], voxelSize[2],
    affine
  );
  emitMessage({ type: 'stageData', stage, data: niftiBytes, description, displayNow, displayRange });
}

/** Canonical TOML for the config-driven qsm-core stages (the mask is supplied separately). */
function stageConfigToml(configJson) {
  return wasmModule.config_json_to_toml_wasm(configJson, '');
}

/** Scale raw phase to [-π, π] with qsm-core's rule, the same one the standard pipeline uses. */
function scalePhaseToPi(phase) {
  return new Float64Array(wasmModule.scale_phase_to_pi_wasm(new Float64Array(phase)));
}

/** QSM referencing ('mean' unless the user turned it off), via qsm-core. */
function applyReference(chi, mask, pipelineSettings) {
  const method = pipelineSettings?.reference_mean === false ? 'none' : 'mean';
  const result = new Float64Array(wasmModule.apply_reference_wasm(chi, mask, method));
  if (method === 'mean') postLog('Applied mean referencing');
  return result;
}

/** Convert a field map in the user's units to ppm, via qsm-core's conversions. */
function fieldMapToPpm(field, units, b0) {
  switch (units) {
    case 'ppm': return field;
    case 'hz': return new Float64Array(wasmModule.hz_to_ppm_wasm(field, requireFieldStrength(b0)));
    case 'rad_s': return new Float64Array(wasmModule.rads_to_ppm_wasm(field, requireFieldStrength(b0)));
    default: throw new Error(`Unknown field map units '${units}' (expected hz, rad_s or ppm)`);
  }
}

function logRange(label, data, mask) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (mask[i]) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
  }
  postLog(`${label}: [${lo.toFixed(4)}, ${hi.toFixed(4)}] ppm`);
}

function computeRobustRange(data, mask, lowPct = 2, highPct = 98) {
  const values = [];
  for (let i = 0; i < data.length; i++) {
    if ((!mask || mask[i]) && data[i] !== 0 && isFinite(data[i])) {
      values.push(data[i]);
    }
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const lo = values[Math.floor(values.length * lowPct / 100)];
  const hi = values[Math.floor(values.length * highPct / 100)];
  return [lo, hi];
}

async function initializeWasm() {
  try {
    // Construct URLs relative to worker location. Cache-bust by app version so a
    // deployed update fetches fresh WASM rather than a stale cached module (which
    // would throw "<fn> is not a function" when new JS meets old WASM).
    const baseUrl = self.location.href.replace(/\/js\/.*$/, '');
    const v = `?v=${QSMConfig.VERSION}`;
    const jsUrl = `${baseUrl}/wasm/qsm_wasm.js${v}`;
    const wasmBinaryUrl = `${baseUrl}/wasm/qsm_wasm_bg.wasm${v}`;

    const module = await import(jsUrl);
    await module.default(wasmBinaryUrl);
    wasmModule = module;
    wasmBaseUrl = baseUrl;

    // Spin up the rayon threadpool (threaded builds only, and only on a cross-origin-isolated
    // page). Parallelizes all classical qsm-core algorithms. Non-threaded builds omit
    // initThreadPool; a non-isolated page has no SharedArrayBuffer → skip and stay single-thread.
    await initRayon(wasmModule, 'base');

    // Deep-learning model registry (urls/sizes/hashes) — the base wasm always exposes it;
    // the heavier onnx wasm bundle is lazy-loaded only when a DL algorithm actually runs.
    try {
      if (wasmModule.get_model_registry_wasm) {
        dlRegistry = parseRegistry(wasmModule.get_model_registry_wasm());
      }
    } catch (e) {
      console.warn('DL model registry unavailable:', e);
    }

    if (wasmModule.health_check_wasm()) {
      postLog(`QSMbly v${wasmModule.get_version_wasm()} ready`);
    }
  } catch (e) {
    // Reported once, by whichever handler called us (onmessage, or a request's own error reply).
    throw new Error(`WASM load failed: ${e.message}`, { cause: e });
  }
}

// Shared SWI computation - called from any pipeline after phase unwrapping
function computeSWI(pipelineSettings, unwrappedPhase, magnitude, mask, dims, voxelSize, affine) {
  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;

  postLog('Computing Susceptibility Weighted Image...');

  const swiSettings = pipelineSettings?.swi || QSMConfig.PIPELINE_DEFAULTS.swi;
  const scalingMap = { 'tanh': 0, 'negative_tanh': 1, 'positive': 2, 'negative': 3, 'triangular': 4 };
  const scalingType = scalingMap[swiSettings.scaling];
  if (scalingType === undefined) {
    throw new Error(`Unknown SWI scaling '${swiSettings.scaling}' (expected one of ${Object.keys(scalingMap).join(', ')})`);
  }

  const swiResult = new Float64Array(wasmModule.calculate_swi_wasm(
    unwrappedPhase, magnitude, mask,
    nx, ny, nz, vsx, vsy, vsz,
    swiSettings.hp_sigma[0], swiSettings.hp_sigma[1], swiSettings.hp_sigma[2],
    scalingType, swiSettings.strength
  ));

  sendStageData('swi', swiResult, dims, voxelSize, affine, 'SWI');
  postLog('SWI complete');

  // Minimum intensity projection
  const mip_window = swiSettings.mip_window || 0;
  if (mip_window > 0 && mip_window <= nz) {
    // Each mIP slice stands for a slab, so the projection carries its own grid and affine
    // (origin shifted (window - 1) / 2 slices) rather than reusing the source ones.
    const mip = wasmModule.create_mip_wasm(
      swiResult, nx, ny, nz, affine, mip_window
    );
    const mipResult = new Float64Array(mip.data);
    const mipDims = Array.from(mip.dims);
    sendStageData('mip', mipResult, mipDims, voxelSize, Array.from(mip.affine), 'SWI mIP');
    postLog(`mIP complete (window=${mip_window}, output nz=${mipDims[2]})`);
  }
}

async function runPipeline(data) {
  // Dispatch to the appropriate pipeline based on input mode
  const inputMode = data.inputMode || 'raw';

  if (inputMode === 'totalField' || inputMode === 'localField') {
    const combined_method = data.pipelineSettings?.combined_method || 'none';
    if (combined_method === 'tgv') {
      return await runTgvFieldMapPipeline(data);
    } else if (combined_method === 'qsmart') {
      return await runQsmartFieldMapPipeline(data);
    }
    return await runFieldMapPipeline(data);
  }

  // Standard raw pipeline continues below
  const {
    magnitudeBuffers, phaseBuffers, echoTimes, magField,
    maskThreshold, customMaskBuffer, preparedMagnitude, pipelineSettings
  } = data;

  const thresholdFraction = (maskThreshold || 15) / 100;
  const hasCustomMask = customMaskBuffer !== null && customMaskBuffer !== undefined;
  const hasPreparedMagnitude = preparedMagnitude !== null && preparedMagnitude !== undefined;

  // Check for combined method (TGV)
  const combined_method = pipelineSettings?.combined_method || 'none';

  if (combined_method === 'tgv') {
    // Use TGV single-step reconstruction
    return await runTgvPipeline(data);
  } else if (combined_method === 'qsmart') {
    // Use QSMART two-stage reconstruction
    return await runQsmartPipeline(data);
  }

  const b0 = requireFieldStrength(magField);

  // =========================================================================
  // Step 1: Load NIfTI data (0% - 10%)
  // =========================================================================
  postProgress(0.02, 'Loading NIfTI data...');

  const nEchoes = echoTimes.length;
  let magnitude4d = [];
  let phase4d = [];
  let dims, voxelSize, affine;

  for (let e = 0; e < nEchoes; e++) {
    postProgress(0.02 + (e / nEchoes) * 0.08, `Loading echo ${e + 1}/${nEchoes}...`);

    // Load magnitude
    const magResult = wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffers[e]));
    const magData = Array.from(magResult.data);
    dims = Array.from(magResult.dims);
    voxelSize = Array.from(magResult.voxelSize);
    affine = Array.from(magResult.affine);
    magnitude4d.push(magData);

    // Load phase
    const phaseResult = wasmModule.load_nifti_wasm(new Uint8Array(phaseBuffers[e]));
    let phaseData = Array.from(phaseResult.data);

    // Scale phase to [-π, +π] using shared pipeline function
    phaseData = Array.from(wasmModule.scale_phase_to_pi_wasm(new Float64Array(phaseData)));
    phase4d.push(phaseData);

    postLog(`  Echo ${e + 1}: shape ${dims[0]}x${dims[1]}x${dims[2]}`);
  }

  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const voxelCount = nx * ny * nz;

  postLog(`Data shape: ${nx}x${ny}x${nz}, voxel: ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm`);

  // =========================================================================
  // Step 2: Create or load mask (10% - 15%)
  // =========================================================================
  postProgress(0.10, 'Creating mask...');
  let mask;

  if (hasCustomMask) {
    postLog("Loading custom mask...");
    const maskResult = wasmModule.load_nifti_wasm(new Uint8Array(customMaskBuffer));
    const maskData = Array.from(maskResult.data);
    mask = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      mask[i] = maskData[i] > 0.5 ? 1 : 0;
    }
  } else {
    const maskMagnitude = hasPreparedMagnitude
      ? new Float64Array(preparedMagnitude)
      : new Float64Array(magnitude4d[0]);
    const magSource = hasPreparedMagnitude ? 'prepared' : 'first echo';
    postLog(`Creating threshold mask (${thresholdFraction * 100}%) from ${magSource} magnitude...`);
    mask = createThresholdMask(maskMagnitude, thresholdFraction);
  }

  const maskCount = mask.reduce((a, b) => a + b, 0);
  postLog(`Mask coverage: ${maskCount}/${voxelCount} voxels (${(100 * maskCount / voxelCount).toFixed(1)}%)`);

  // =========================================================================
  // Step 3: Field mapping (15% - 45%) — shared with qsmxt.rs
  // =========================================================================
  postProgress(0.15, 'Field mapping...');
  // Canonical TOML from qsmxt-config (serde). Mask is supplied separately to the
  // pipeline, so the config's mask section is irrelevant here ('').
  const configToml = stageConfigToml(buildConfigJson(pipelineSettings));
  const echoTimesSec = echoTimes.map(t => t / 1000); // ms → seconds

  // Flatten per-echo arrays for WASM
  const phasesFlat = new Float64Array(nEchoes * voxelCount);
  const magsFlat = new Float64Array(nEchoes * voxelCount);
  for (let e = 0; e < nEchoes; e++) {
    phasesFlat.set(phase4d[e], e * voxelCount);
    magsFlat.set(magnitude4d[e], e * voxelCount);
  }

  const fieldResult = wasmModule.run_field_mapping_wasm(
    phasesFlat, magsFlat, mask,
    new Float64Array(echoTimesSec),
    nx, ny, nz, vsx, vsy, vsz,
    b0, configToml,
  );

  // phaseOffset is null when the field-mapping method estimates none
  const b0Fieldmap = fieldResult.b0FieldPpm;
  const phaseOffset = fieldResult.phaseOffset;

  if (phaseOffset) {
    sendStageData('phaseOffset', phaseOffset, dims, voxelSize, affine, 'Phase Offset (rad)', false);
  }

  sendStageData('B0', b0Fieldmap, dims, voxelSize, affine, 'B0 Field Map (ppm)');

  // Prepared (combined/bias-corrected) magnitude if available, for MEDI edge weighting
  const magnitudeForInversion = hasPreparedMagnitude
    ? new Float64Array(preparedMagnitude)
    : new Float64Array(magnitude4d[0]);

  await runBgRemovalAndInversion({
    fieldPpm: b0Fieldmap, isTotalField: true, mask, dims, voxelSize, affine,
    b0, echoTimesSec, magnitude: magnitudeForInversion, pipelineSettings, configToml,
  });

  postProgress(1.0, 'Pipeline complete!');
  postLog("Pipeline completed successfully!");
  postComplete({ success: true });
}

// =========================================================================
// Background removal → dipole inversion → referencing, shared by every
// standard (non-TGV/QSMART) input mode. All stages are qsm-core's
// config-driven ones (shared with qsmxt.rs), so the same settings give the
// same numbers whether the field came from raw phase or a field-map file.
// =========================================================================
async function runBgRemovalAndInversion({
  fieldPpm,        // total field (isTotalField) or local field, in ppm
  isTotalField,
  mask, dims, voxelSize, affine,
  b0,              // tesla
  echoTimesSec,    // [] when nothing in the run depends on TE
  magnitude,       // Float64Array, or null for uniform weighting
  pipelineSettings, configToml,
}) {
  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const voxelCount = nx * ny * nz;

  const combinedMethod = pipelineSettings?.combined_method || 'none';
  const backgroundMethod = pipelineSettings?.bf_algorithm || 'vsharp';
  const dipoleMethod = pipelineSettings?.dipole_inversion || 'rts';
  // TFI is selected through combined_method; the config carries it as the inversion algorithm.
  const inversionLabel = combinedMethod === 'tfi' ? 'TFI' : dipoleMethod.toUpperCase();
  const useDl = combinedMethod === 'none' && isDlModel(dipoleMethod);

  // =========================================================================
  // Background field removal (40% - 65%)
  // =========================================================================
  const skipForMediSmv = dipoleMethod === 'medi' && pipelineSettings?.medi?.smv;
  let localField, erodedMask;

  if (!isTotalField) {
    localField = fieldPpm;
    erodedMask = mask;
  } else if (skipForMediSmv) {
    postLog('Background removal: Skipped (MEDI SMV handles it internally)');
    localField = fieldPpm;
    erodedMask = mask;
  } else {
    postProgress(0.42, `Background removal (${backgroundMethod})...`);
    postLog(`Removing background field using ${backgroundMethod.toUpperCase()}...`);
    const bgProgress = (current, total) => {
      postProgress(0.42 + (current / total) * 0.20, `${backgroundMethod.toUpperCase()}: ${current}/${total}`);
    };
    const bgResult = wasmModule.run_bg_removal_wasm(
      fieldPpm, mask, nx, ny, nz, vsx, vsy, vsz,
      b0, configToml, bgProgress,
    );
    localField = new Float64Array(bgResult.slice(0, voxelCount));
    erodedMask = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      erodedMask[i] = bgResult[voxelCount + i] > 0.5 ? 1 : 0;
    }
  }

  const erodedCount = erodedMask.reduce((a, b) => a + b, 0);
  postLog(`Eroded mask: ${erodedCount} voxels (${(100 * erodedCount / voxelCount).toFixed(1)}%)`);
  sendStageData('bgRemoved', localField, dims, voxelSize, affine,
    isTotalField && skipForMediSmv ? 'B0 Field (MEDI SMV)' : 'Local Field Map (ppm)');

  // =========================================================================
  // Dipole inversion (65% - 95%)
  // =========================================================================
  postProgress(0.67, `Dipole inversion (${inversionLabel})...`);
  postLog(`Running ${inversionLabel} dipole inversion...`);

  let qsmResult;
  if (useDl) {
    // Deep-learning inversion: fetch weights in JS (WASM can't download) + run in the
    // lazy-loaded onnx bundle. AutoQSM/NeXtQSM consume the TOTAL field (own BFR); the rest
    // take the local field from background removal.
    const model = dlRegistry[dipoleMethod];
    const needsTotalField = DL_TOTAL_FIELD_MODELS.has(dipoleMethod);
    if (needsTotalField && !isTotalField) {
      throw new Error(`${model.name} reconstructs from the total field, so it cannot run on a local field map`);
    }
    const dlProgress = (done, total) => {
      const frac = total ? done / total : 0;
      postProgress(0.7 + frac * 0.22, `${dipoleMethod.toUpperCase()}: tile ${done}/${total}`);
    };
    qsmResult = await runDlFieldInversion(
      model, needsTotalField ? fieldPpm : localField, needsTotalField ? mask : erodedMask,
      nx, ny, nz, vsx, vsy, vsz, dlProgress, pipelineSettings?.dl_tiling,
    );
  } else {
    const invProgress = (current, total) => {
      postProgress(0.67 + (current / total) * 0.25, `${inversionLabel}: ${current}/${total}`);
    };
    qsmResult = new Float64Array(wasmModule.run_dipole_inversion_wasm(
      localField, erodedMask, nx, ny, nz, vsx, vsy, vsz,
      b0, new Float64Array(echoTimesSec),
      0, 0, 1, magnitude || new Float64Array(0),
      configToml, invProgress,
    ));
  }

  // Already in ppm (the stage handles all unit conversions)
  logRange('QSM range', qsmResult, erodedMask);
  qsmResult = applyReference(qsmResult, erodedMask, pipelineSettings);

  postProgress(0.95, 'Sending QSM result...');
  sendStageData('final', qsmResult, dims, voxelSize, affine, 'QSM Result (ppm)');
}

// =========================================================================
// TGV Core — shared reconstruction step for all TGV pipelines
// =========================================================================
async function runTgvCore({
  tgvInputPhase, mask, dims, voxelSize, affine,
  te, fieldstrength, tgvSettings,
  progressStart = 0.40, progressEnd = 0.95, label = 'QSM Result (ppm) - TGV',
  pipelineSettings,
}) {
  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  // The user's values win; the regularization level's preset alphas and qsm-core's
  // voxel-size-adaptive iteration count apply only where they are unset. The presets are the
  // generated table ConfigBridge also exports from, so the run and the exported config agree.
  // step_size matches the 3.0 tgv_qsm_wasm_with_progress uses.
  const step_size = 3.0;
  const { alpha0, alpha1, iterations } = resolveTgvParams(
    tgvSettings,
    QSMConfig.tgvAlphaPreset,
    () => wasmModule.tgv_get_default_iterations_wasm(vsx, vsy, vsz, step_size),
  );

  postProgress(progressStart, 'Starting TGV reconstruction...');
  postLog(`TGV parameters: alpha0=${alpha0.toFixed(4)}, alpha1=${alpha1.toFixed(4)}, iterations=${iterations}, erosions=${tgvSettings.erosions}`);
  postLog(`Using TE=${(te * 1000).toFixed(2)}ms, B0=${fieldstrength}T`);

  const progressRange = progressEnd - progressStart;
  const tgvProgress = (current, total) => {
    const progress = progressStart + (current / total) * progressRange;
    postProgress(progress, `TGV: Iteration ${current}/${total}`);
  };

  let qsmResult = new Float64Array(wasmModule.tgv_qsm_wasm_with_progress(
    tgvInputPhase, mask, nx, ny, nz, vsx, vsy, vsz,
    0, 0, 1,  // B0 direction
    alpha0, alpha1,
    iterations, tgvSettings.erosions,
    te, fieldstrength,
    tgvProgress
  ));

  logRange('QSM range', qsmResult, mask);
  qsmResult = applyReference(qsmResult, mask, pipelineSettings);

  postProgress(progressEnd, 'Sending QSM result...');
  sendStageData('final', qsmResult, dims, voxelSize, affine, label);

  return qsmResult;
}

// TGV single-step pipeline (raw multi-echo input)
async function runTgvPipeline(data) {
  const {
    magnitudeBuffers, phaseBuffers, echoTimes, magField,
    maskThreshold, customMaskBuffer, preparedMagnitude, pipelineSettings
  } = data;

  const thresholdFraction = (maskThreshold || 15) / 100;
  const hasCustomMask = customMaskBuffer !== null && customMaskBuffer !== undefined;
  const hasPreparedMagnitude = preparedMagnitude !== null && preparedMagnitude !== undefined;

  const tgvSettings = pipelineSettings?.tgv || QSMConfig.PIPELINE_DEFAULTS.tgv;

  // =========================================================================
  // Step 1: Load NIfTI data (0% - 10%)
  // =========================================================================
  postProgress(0.02, 'Loading NIfTI data...');
  postLog("TGV: Loading data via WASM...");

  const nEchoes = echoTimes.length;
  let magnitude4d = [];
  let phase4d = [];
  let dims, voxelSize, affine;

  for (let e = 0; e < nEchoes; e++) {
    postProgress(0.02 + (e / nEchoes) * 0.08, `Loading echo ${e + 1}/${nEchoes}...`);

    // Load magnitude
    const magResult = wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffers[e]));
    const magData = Array.from(magResult.data);
    dims = Array.from(magResult.dims);
    voxelSize = Array.from(magResult.voxelSize);
    affine = Array.from(magResult.affine);
    magnitude4d.push(magData);

    // Load phase
    const phaseResult = wasmModule.load_nifti_wasm(new Uint8Array(phaseBuffers[e]));
    let phaseData = Array.from(phaseResult.data);

    // Scale phase to [-π, +π] using the same qsm-core rule as the standard pipeline
    phaseData = scalePhaseToPi(phaseData);
    phase4d.push(Array.from(phaseData));

    postLog(`  Echo ${e + 1}: shape ${dims[0]}x${dims[1]}x${dims[2]}`);
  }

  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const voxelCount = nx * ny * nz;

  postLog(`Data shape: ${nx}x${ny}x${nz}, voxel: ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm`);

  // =========================================================================
  // Step 2: Create or load mask (10% - 15%)
  // =========================================================================
  postProgress(0.10, 'Creating mask...');
  let mask;

  if (hasCustomMask) {
    postLog("Loading custom mask...");
    const maskResult = wasmModule.load_nifti_wasm(new Uint8Array(customMaskBuffer));
    const maskData = Array.from(maskResult.data);
    mask = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      mask[i] = maskData[i] > 0.5 ? 1 : 0;
    }
  } else {
    // Use prepared magnitude if available (combined/bias-corrected), otherwise first echo
    const maskMagnitude = hasPreparedMagnitude
      ? new Float64Array(preparedMagnitude)
      : new Float64Array(magnitude4d[0]);
    const magSource = hasPreparedMagnitude ? 'prepared' : 'first echo';
    postLog(`Creating threshold mask (${thresholdFraction * 100}%) from ${magSource} magnitude...`);
    mask = createThresholdMask(maskMagnitude, thresholdFraction);
  }

  const maskCount = mask.reduce((a, b) => a + b, 0);
  postLog(`Mask coverage: ${maskCount}/${voxelCount} voxels (${(100 * maskCount / voxelCount).toFixed(1)}%)`);

  // =========================================================================
  // Step 3: Multi-echo combination (15% - 40%) or single-echo passthrough
  // =========================================================================
  let tgvInputPhase;
  let te;  // Echo time to use for TGV (seconds)
  const fieldstrength = requireFieldStrength(magField);

  if (nEchoes > 1) {
    // Multi-echo: field mapping → B0 → convert to phase for TGV.
    // Same shared qsm-core stage the standard pipeline uses, so TGV honours the
    // ROMEO coherence flags, the b0_estimation choice and the Laplacian handling
    // that the config carries.
    postLog(`Multi-echo data detected (${nEchoes} echoes), computing B0 field map...`);
    postProgress(0.15, 'Field mapping...');

    const configToml = stageConfigToml(buildConfigJson(pipelineSettings));
    const echoTimesSec = echoTimes.map(t => t / 1000); // ms → seconds

    const phasesFlat = new Float64Array(nEchoes * voxelCount);
    const magsFlat = new Float64Array(nEchoes * voxelCount);
    for (let e = 0; e < nEchoes; e++) {
      phasesFlat.set(phase4d[e], e * voxelCount);
      magsFlat.set(magnitude4d[e], e * voxelCount);
    }

    const fieldResult = wasmModule.run_field_mapping_wasm(
      phasesFlat, magsFlat, mask,
      new Float64Array(echoTimesSec),
      nx, ny, nz, vsx, vsy, vsz,
      fieldstrength, configToml,
    );

    // phaseOffset is null when the field-mapping method estimates none
    const b0FieldmapPpm = fieldResult.b0FieldPpm;
    const phaseOffset = fieldResult.phaseOffset;

    if (phaseOffset) {
      sendStageData('phaseOffset', phaseOffset, dims, voxelSize, affine, 'Phase Offset (rad)', false);
    }
    sendStageData('B0', b0FieldmapPpm, dims, voxelSize, affine, 'B0 Field Map (ppm)');
    postProgress(0.40, 'Field mapping complete');

    // TGV takes phase, so undo the stage's Hz→ppm with the same gamma qsm-core used,
    // then convert with the first echo time. TGV divides this straight back out.
    te = echoTimesSec[0];
    tgvInputPhase = ppmFieldToPhase(
      b0FieldmapPpm, fieldstrength, te, QSMConfig.PHYSICS.GYROMAGNETIC_RATIO,
    );
    postLog(`Converted B0 to equivalent phase using TE=${(te * 1000).toFixed(2)}ms`);

  } else {
    // Single echo: use wrapped phase directly (TGV handles wraps via Laplacian)
    postLog("Single-echo data, using wrapped phase directly for TGV...");
    tgvInputPhase = new Float64Array(phase4d[0]);
    te = echoTimes[0] / 1000;
  }

  // =========================================================================
  // Step 4: TGV reconstruction (40% - 95%)
  // =========================================================================
  await runTgvCore({
    tgvInputPhase, mask, dims, voxelSize, affine,
    te, fieldstrength, tgvSettings,
    progressStart: 0.40, progressEnd: 0.95,
    pipelineSettings,
  });

  postProgress(1.0, 'TGV pipeline complete!');
  postLog("TGV pipeline completed successfully!");
  postComplete({ success: true });
}

// =========================================================================
// QSMART Core — shared stages for all QSMART pipelines
// Handles: vasculature detection, two-stage SDF+iLSQR (or iLSQR-only),
// offset adjustment, and ppm scaling.
// =========================================================================
async function runQsmartCore({
  fieldPpm,         // Float64Array - total field, or local field when skipSdf, in ppm
  mask,             // Uint8Array - brain mask
  R_0,              // Uint8Array - reliability map (all-ones if unavailable)
  magnitudeData,    // Float64Array or null - for vasculature detection and MEDI weighting
  dims, voxelSize, affine,
  pipelineSettings,
  b0,               // B0 in tesla
  echoTimesSec,     // for the inner inversion (MEDI); [] when it does not need one
  skipSdf = false,  // true for local field inputs (skip background removal)
}) {
  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const voxelCount = nx * ny * nz;

  // QSMART settings; unset ones fall back to the generated qsm-core defaults
  const qsmartSettings = { ...QSMConfig.QSMART_DEFAULTS, ...pipelineSettings?.qsmart };
  const sdf_sigma1_stage1 = qsmartSettings.sdf_sigma1_stage1;
  const sdf_sigma2_stage1 = qsmartSettings.sdf_sigma2_stage1;
  const sdf_sigma1_stage2 = qsmartSettings.sdf_sigma1_stage2;
  const sdf_sigma2_stage2 = qsmartSettings.sdf_sigma2_stage2;
  const sdf_spatial_radius = qsmartSettings.sdf_spatial_radius;
  const sdf_lower_lim = qsmartSettings.sdf_lower_lim;
  const sdf_curv_constant = qsmartSettings.sdf_curv_constant;
  const useCurvature = qsmartSettings.useCurvature !== false;
  const vasculatureSphereRadiusMm = qsmartSettings.vasc_sphere_radius;
  const vasculatureSphereRadiusOverride = qsmartSettings.vascSphereRadius ?? qsmartSettings.vasculatureSphereRadius;
  const frangi_scale_min = qsmartSettings.frangi_scale_min;
  const frangi_scale_max = qsmartSettings.frangi_scale_max;
  const frangi_scale_ratio = qsmartSettings.frangi_scale_ratio;
  const frangiScaleMinVoxelOverride = qsmartSettings.frangiScaleRange?.[0] ?? qsmartSettings.frangiScaleMin;
  const frangiScaleMaxVoxelOverride = qsmartSettings.frangiScaleRange?.[1] ?? qsmartSettings.frangiScaleMax;
  const frangiScaleRatioOverride = qsmartSettings.frangiScaleRatio;
  const frangi_c = qsmartSettings.frangi_c;
  const enableVasculature = qsmartSettings.enableVasculature !== false && magnitudeData !== null;

  const maskCount = mask.reduce((a, b) => a + b, 0);

  // =========================================================================
  // Vasculature detection
  // =========================================================================
  let vascOnly;
  if (enableVasculature) {
    postProgress(0.20, 'Detecting vasculature (Frangi filter)...');

    const avgVoxelSize = (vsx + vsy + vsz) / 3.0;
    const sphereRadiusVoxels = vasculatureSphereRadiusOverride ?? Math.round(vasculatureSphereRadiusMm / avgVoxelSize);
    const effectiveSphereRadius = Math.max(sphereRadiusVoxels, 2);
    const frangiScaleMin = frangiScaleMinVoxelOverride ?? (frangi_scale_min / avgVoxelSize);
    const frangiScaleMax = frangiScaleMaxVoxelOverride ?? (frangi_scale_max / avgVoxelSize);
    const frangiScaleRatio = frangiScaleRatioOverride ?? (frangi_scale_ratio / avgVoxelSize);
    const effectiveScaleRatio = Math.max(frangiScaleRatio, 0.1);

    postLog(`Generating vasculature mask:`);
    postLog(`  Voxel size: ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm (avg=${avgVoxelSize.toFixed(2)}mm)`);
    postLog(`  Sphere radius: ${effectiveSphereRadius} voxels (${vasculatureSphereRadiusMm.toFixed(1)}mm)`);
    postLog(`  Frangi scales: [${frangiScaleMin.toFixed(2)}, ${frangiScaleMax.toFixed(2)}] voxels (step=${effectiveScaleRatio.toFixed(2)})`);
    postLog(`  (Physical: [${frangi_scale_min.toFixed(1)}, ${frangi_scale_max.toFixed(1)}]mm, Frangi C: ${frangi_c})`);

    const vascProgress = (current, total) => {
      postProgress(0.20 + (current / total) * 0.10, `Vasculature: Step ${current}/${total}`);
    };

    vascOnly = new Float64Array(wasmModule.vasculature_mask_wasm_with_progress(
      magnitudeData, mask, nx, ny, nz,
      effectiveSphereRadius,
      frangiScaleMin, frangiScaleMax, effectiveScaleRatio,
      frangi_c,
      vascProgress
    ));

    const vascCount = vascOnly.filter(v => v === 0).length;
    postLog(`Vessel voxels: ${vascCount} (${(100 * vascCount / maskCount).toFixed(1)}% of brain)`);

    const vascDisplay = new Float64Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      vascDisplay[i] = mask[i] ? (1 - vascOnly[i]) : 0;
    }
    sendStageData('vascDetect', vascDisplay, dims, voxelSize, affine, 'Vessel Detection (Frangi)');
  } else {
    if (!magnitudeData) {
      postLog("No magnitude available - vasculature detection disabled, using full mask for both stages");
    } else {
      postLog("Vasculature detection disabled - using full mask for both stages");
    }
    vascOnly = new Float64Array(voxelCount).fill(1.0);
  }

  // =========================================================================
  // Create weighted mask (mask * R_0)
  // =========================================================================
  const weightedMask = new Float64Array(voxelCount);
  let weightedCount = 0;
  for (let i = 0; i < voxelCount; i++) {
    weightedMask[i] = (mask[i] && R_0[i]) ? 1.0 : 0.0;
    if (weightedMask[i] > 0) weightedCount++;
  }
  postLog(`Weighted mask (mask * R_0): ${weightedCount}/${maskCount} voxels (${(100 * weightedCount / maskCount).toFixed(1)}% of brain)`);

  // Inner dipole inversion for both QSMART stages (default iLSQR), run through the same
  // config-driven stage as the standard pipeline, configured as qsm-core's run_qsmart does.
  const innerAlgo = (qsmartSettings.inversion_algorithm || 'ilsqr').toLowerCase();
  const innerConfigToml = stageConfigToml(buildQsmartInnerConfigJson(pipelineSettings));
  const runInnerInversion = (field, innerMask, progress) => new Float64Array(wasmModule.run_dipole_inversion_wasm(
    field, innerMask, nx, ny, nz, vsx, vsy, vsz,
    b0, new Float64Array(echoTimesSec),
    0, 0, 1, magnitudeData || new Float64Array(0),
    innerConfigToml, progress,
  ));

  // =========================================================================
  // Stage 1: SDF (optional) + inversion on whole ROI (30% - 50%)
  // =========================================================================
  let lfsStage1;
  if (skipSdf) {
    // Local field input: field map IS the local field, skip SDF
    postLog("Skipping SDF background removal (local field input)");
    lfsStage1 = fieldPpm;
  } else {
    postProgress(0.30, 'Stage 1: SDF background removal...');
    postLog(`Stage 1 SDF: sigma1=${sdf_sigma1_stage1}, sigma2=${sdf_sigma2_stage1}, curvature=${useCurvature}`);

    const onesArray = new Float64Array(voxelCount).fill(1.0);
    const sdfProgress1 = (current, total) => {
      postProgress(0.30 + (current / total) * 0.10, `Stage 1 SDF: ${current}/${total} alphas`);
    };

    lfsStage1 = new Float64Array(wasmModule.sdf_wasm_with_progress(
      fieldPpm, weightedMask, onesArray,
      nx, ny, nz,
      sdf_sigma1_stage1, sdf_sigma2_stage1,
      sdf_spatial_radius,
      sdf_lower_lim, sdf_curv_constant,
      useCurvature,
      sdfProgress1
    ));

    logRange('Stage 1 LFS range', lfsStage1, weightedMask);
    sendStageData('lfsStage1', lfsStage1, dims, voxelSize, affine, 'Stage 1 Local Field (ppm)');
  }

  postProgress(0.42, `Stage 1: ${innerAlgo.toUpperCase()} inversion...`);
  postLog(`Stage 1 ${innerAlgo.toUpperCase()} inversion`);

  const maskStage1 = new Uint8Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    maskStage1[i] = weightedMask[i] > 0.1 ? 1 : 0;
  }

  const chiStage1 = runInnerInversion(lfsStage1, maskStage1, (current, total) => {
    postProgress(0.42 + (current / total) * 0.08, `Stage 1 ${innerAlgo.toUpperCase()}: ${current}/${total}`);
  });

  logRange('Stage 1 chi range', chiStage1, maskStage1);
  sendStageData('chiStage1', chiStage1, dims, voxelSize, affine, 'Stage 1 QSM (ppm)');

  // =========================================================================
  // Stage 2: SDF (optional) + inversion on tissue only (50% - 75%)
  // =========================================================================
  let lfsStage2;
  if (skipSdf) {
    // Local field input: same local field, different mask
    lfsStage2 = fieldPpm;
  } else {
    postProgress(0.50, 'Stage 2: SDF on tissue region...');
    postLog(`Stage 2 SDF: sigma1=${sdf_sigma1_stage2}, sigma2=${sdf_sigma2_stage2}`);

    const tfsWeighted = new Float64Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      tfsWeighted[i] = fieldPpm[i] * weightedMask[i];
    }

    const sdfProgress2 = (current, total) => {
      postProgress(0.50 + (current / total) * 0.12, `Stage 2 SDF: ${current}/${total} alphas`);
    };

    lfsStage2 = new Float64Array(wasmModule.sdf_wasm_with_progress(
      tfsWeighted, weightedMask, vascOnly,
      nx, ny, nz,
      sdf_sigma1_stage2, sdf_sigma2_stage2,
      sdf_spatial_radius,
      sdf_lower_lim, sdf_curv_constant,
      useCurvature,
      sdfProgress2
    ));

    sendStageData('lfsStage2', lfsStage2, dims, voxelSize, affine, 'Stage 2 Local Field (ppm)');
  }

  postProgress(0.64, `Stage 2: ${innerAlgo.toUpperCase()} inversion...`);

  const maskStage2 = new Uint8Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    maskStage2[i] = (weightedMask[i] > 0.1 && vascOnly[i] > 0.5) ? 1 : 0;
  }

  const chiStage2 = runInnerInversion(lfsStage2, maskStage2, (current, total) => {
    postProgress(0.64 + (current / total) * 0.10, `Stage 2 ${innerAlgo.toUpperCase()}: ${current}/${total}`);
  });

  sendStageData('chiStage2', chiStage2, dims, voxelSize, affine, 'Stage 2 QSM (ppm)');

  // =========================================================================
  // Combine stages with offset adjustment (75% - 95%)
  // =========================================================================
  postProgress(0.75, 'Combining stages with offset adjustment...');
  postLog("Computing offset adjustment in Fourier space...");

  const removedVoxels = new Float64Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    removedVoxels[i] = weightedMask[i] - vascOnly[i];
  }

  // Everything is already in ppm, so the field rescale factor is the identity (as in run_qsmart).
  let qsmResult = new Float64Array(wasmModule.qsmart_adjust_offset_wasm(
    removedVoxels, lfsStage1, chiStage1, chiStage2,
    nx, ny, nz, vsx, vsy, vsz,
    0, 0, 1,
    1.0
  ));
  // QSMART susceptibility is only defined inside the brain mask.
  for (let i = 0; i < voxelCount; i++) {
    if (!mask[i]) qsmResult[i] = 0;
  }

  logRange('QSMART QSM range', qsmResult, mask);
  qsmResult = applyReference(qsmResult, mask, pipelineSettings);

  postProgress(0.95, 'Sending QSMART result...');
  sendStageData('final', qsmResult, dims, voxelSize, affine, 'QSMART QSM (ppm)');

  return qsmResult;
}

// QSMART two-stage pipeline (raw multi-echo input)
async function runQsmartPipeline(data) {
  const {
    magnitudeBuffers, phaseBuffers, echoTimes, magField,
    maskThreshold, customMaskBuffer, preparedMagnitude, pipelineSettings
  } = data;

  const thresholdFraction = (maskThreshold || 15) / 100;
  const hasCustomMask = customMaskBuffer !== null && customMaskBuffer !== undefined;
  const hasPreparedMagnitude = preparedMagnitude !== null && preparedMagnitude !== undefined;

  // Settings used in steps 1-3 (remaining QSMART settings parsed in runQsmartCore)
  const qsmartSettings = pipelineSettings?.qsmart || {};
  const fitThreshold = qsmartSettings.fitThreshold ?? 40;
  const fitThreshPercentile = qsmartSettings.fitThreshPercentile ?? null;
  const b0 = requireFieldStrength(magField);

  // =========================================================================
  // Step 1: Load NIfTI data (0% - 10%)
  // =========================================================================
  postProgress(0.02, 'Loading NIfTI data...');
  postLog("QSMART: Loading multi-echo data...");

  const nEchoes = echoTimes.length;
  let magnitude4d = [];
  let phase4d = [];
  let dims, voxelSize, affine;

  for (let e = 0; e < nEchoes; e++) {
    postProgress(0.02 + (e / nEchoes) * 0.06, `Loading echo ${e + 1}/${nEchoes}...`);

    const magResult = wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffers[e]));
    magnitude4d.push(Array.from(magResult.data));
    dims = Array.from(magResult.dims);
    voxelSize = Array.from(magResult.voxelSize);
    affine = Array.from(magResult.affine);

    const phaseResult = wasmModule.load_nifti_wasm(new Uint8Array(phaseBuffers[e]));
    phase4d.push(Array.from(scalePhaseToPi(phaseResult.data)));

    postLog(`  Echo ${e + 1}: shape ${dims[0]}x${dims[1]}x${dims[2]}`);
  }

  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const voxelCount = nx * ny * nz;

  postLog(`Data: ${nx}x${ny}x${nz}, voxel: ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm, B0=${b0}T`);

  // =========================================================================
  // Step 2: Create or load mask (10% - 12%)
  // =========================================================================
  postProgress(0.10, 'Creating mask...');
  let mask;

  if (hasCustomMask) {
    postLog("Loading custom mask...");
    const maskResult = wasmModule.load_nifti_wasm(new Uint8Array(customMaskBuffer));
    mask = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      mask[i] = maskResult.data[i] > 0.5 ? 1 : 0;
    }
  } else {
    const maskMagnitude = hasPreparedMagnitude
      ? new Float64Array(preparedMagnitude)
      : new Float64Array(magnitude4d[0]);
    mask = createThresholdMask(maskMagnitude, thresholdFraction);
  }

  const maskCount = mask.reduce((a, b) => a + b, 0);
  postLog(`Mask: ${maskCount}/${voxelCount} voxels (${(100 * maskCount / voxelCount).toFixed(1)}%)`);

  // =========================================================================
  // Step 3: Phase unwrapping and B0 estimation (12% - 20%)
  // =========================================================================
  postProgress(0.12, 'Phase unwrapping (Laplacian)...');
  postLog("Running Laplacian phase unwrapping...");

  // Unwrap first echo
  const phase1 = new Float64Array(phase4d[0]);
  let unwrappedPhase = new Float64Array(wasmModule.laplacian_unwrap_wasm(
    phase1, mask, nx, ny, nz, vsx, vsy, vsz
  ));

  // Multi-echo B0 estimation with magnitude-weighted fitting and R_0
  postProgress(0.16, 'Computing total field shift...');
  let tfs;
  let R_0;
  if (nEchoes > 1) {
    // Unwrap all echoes
    const allUnwrapped = new Float64Array(voxelCount * nEchoes);
    allUnwrapped.set(unwrappedPhase, 0);

    for (let e = 1; e < nEchoes; e++) {
      const phaseE = new Float64Array(phase4d[e]);
      const unwrappedE = new Float64Array(wasmModule.laplacian_unwrap_wasm(
        phaseE, mask, nx, ny, nz, vsx, vsy, vsz
      ));
      allUnwrapped.set(unwrappedE, e * voxelCount);
    }

    // Magnitude-weighted fit + R_0 reliability map (matching echofit.m)
    const fitResult = computeWeightedEchoFit(
      allUnwrapped, magnitude4d, echoTimes, nx, ny, nz, voxelSize, mask, fitThreshold, fitThreshPercentile
    );
    tfs = fitResult.tfs;
    R_0 = fitResult.R_0;

    const r0Count = R_0.reduce((a, b) => a + b, 0);
    const maskCount2 = mask.reduce((a, b) => a + b, 0);
    const excludedCount = maskCount2 - r0Count;
    const threshMode = fitThreshPercentile !== null ? `adaptive percentile=${fitThreshPercentile}` : `fixed=${fitThreshold}`;
    postLog(`R_0 reliability: ${r0Count} reliable voxels, ${excludedCount} excluded (${(100 * excludedCount / maskCount2).toFixed(1)}% of brain, ${threshMode})`);
  } else {
    // Single echo: no residuals to compute R_0 from
    const te = echoTimes[0] / 1000;
    tfs = new Float64Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      tfs[i] = unwrappedPhase[i] / (2 * Math.PI * te);
    }
    R_0 = new Uint8Array(voxelCount).fill(1);
    postLog("Single echo: R_0 set to all ones (no multi-echo residual available)");
  }

  // Apply mask
  for (let i = 0; i < voxelCount; i++) {
    if (!mask[i]) tfs[i] = 0;
  }

  // Compute TFS range without spread operator (avoid stack overflow for large arrays)
  let tfsMin = Infinity, tfsMax = -Infinity;
  for (let i = 0; i < voxelCount; i++) {
    if (mask[i]) {
      if (tfs[i] < tfsMin) tfsMin = tfs[i];
      if (tfs[i] > tfsMax) tfsMax = tfs[i];
    }
  }
  postLog(`TFS range: [${tfsMin.toFixed(1)}, ${tfsMax.toFixed(1)}] Hz`);

  // Send TFS as intermediate stage
  sendStageData('tfs', tfs, dims, voxelSize, affine, 'Total Field Shift (Hz)');

  // Send R_0 reliability map for visualization
  if (nEchoes > 1) {
    const r0Float = new Float64Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      r0Float[i] = R_0[i];
    }
    sendStageData('R0', r0Float, dims, voxelSize, affine, 'Reliability Map R_0', false);
  }

  // =========================================================================
  // Steps 4-9: QSMART core (vasculature, two-stage SDF+iLSQR, combine, ppm)
  // =========================================================================
  const magnitudeForVasc = hasPreparedMagnitude
    ? new Float64Array(preparedMagnitude)
    : new Float64Array(magnitude4d[0]);

  await runQsmartCore({
    fieldPpm: new Float64Array(wasmModule.hz_to_ppm_wasm(tfs, b0)),
    mask, R_0,
    magnitudeData: magnitudeForVasc,
    dims, voxelSize, affine,
    pipelineSettings,
    b0,
    echoTimesSec: echoTimes.map(t => t / 1000),
  });

  postProgress(1.0, 'QSMART pipeline complete!');
  postLog("QSMART two-stage pipeline completed successfully!");
  postComplete({ success: true });
}

// BET-specific handlers
function postBETProgress(value, text) {
  emitMessage({ type: 'betProgress', value, text });
}

function postBETLog(message) {
  emitMessage({ type: 'betLog', message });
}

function postBETComplete(maskData, coverage) {
  emitMessage({ type: 'betComplete', maskData, coverage });
}

function postBETError(message) {
  emitMessage({ type: 'betError', message });
}

/**
 * Apply mask operations (`erode:2`, `fill-holes:0`, `signal-erode`, …) through qsm-core's masking
 * pipeline — the same code the qsmxt pipeline runs, so an interactively refined mask matches the
 * `--mask ...` section we print. Pure Rust, so it lives in the base wasm bundle.
 */
/** HD-BET deep-learning brain extraction (magnitude -> brain mask).
 *
 *  A mask *generator*: the result replaces the mask, and any refinements the user adds
 *  afterwards go through `applyMaskOps` as usual — the same generator-then-refinements split
 *  qsm-core's `build_mask_section` makes natively.
 *
 *  Lives in the lazily-loaded DL bundle (it needs onnx), so this downloads the 123 MB weights
 *  (IndexedDB-cached after the first run) and boots that bundle's own rayon pool. */
async function runHdBet(data) {
  const { magnitude, dims, voxelSize, patch, tileStep, tta } = data;
  try {
    const [nx, ny, nz] = dims;
    const [vsx, vsy, vsz] = voxelSize;

    const model = dlRegistry['hd-bet'];
    if (!model) throw new Error('hd-bet is not in the model registry');

    emitMessage({ type: 'hdBetProgress', value: 0.05, text: 'Fetching HD-BET weights...' });
    const weights = await downloadWeights(model);

    emitMessage({ type: 'hdBetProgress', value: 0.15, text: 'Loading inference bundle...' });
    const dl = await loadDlWasm(wasmBaseUrl, QSMConfig.VERSION);
    // Same bound as the tiled inversions (4), and for their sake rather than HD-BET's: the DL
    // bundle has ONE pool, whoever boots it first sets the size, and `xqsm_tiled` & co. batch
    // tiles by `rayon::current_num_threads()` — so a 14-thread pool booted here would later run
    // 14 concurrent tiles, each holding its own activations, and exhaust the 32-bit heap.
    // HD-BET parallelises *inside* a patch (tract's matmuls), so a small pool costs it time, not
    // correctness.
    await initRayon(dl, 'dl', 4);

    const [px, py, pz] = patch;
    emitMessage({
      type: 'hdBetLog',
      message: `Running HD-BET on ${nx}x${ny}x${nz} @ ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm `
             + `(${px}x${py}x${pz} patches, step ${tileStep ?? 0.5}`
             + `${tta ? ', mirroring TTA' : ''}). This runs a 30 M-parameter `
             + `network over every overlapping patch and takes several minutes — progress below.`,
    });

    // Once patches start landing we can report a real ETA from measured throughput, rather than
    // the modal's up-front guess.
    const startedAt = performance.now();
    const onProgress = (done, total) => {
      const frac = total ? done / total : 0;
      let eta = '';
      if (done > 0 && done < total) {
        const secsLeft = ((performance.now() - startedAt) / done) * (total - done) / 1000;
        eta = secsLeft < 60
          ? ` — ${Math.ceil(secsLeft)}s left`
          : ` — ~${Math.round(secsLeft / 60)} min left`;
      }
      emitMessage({
        type: 'hdBetProgress',
        value: 0.2 + frac * 0.75,
        text: `HD-BET patch ${done}/${total}${eta}`,
      });
    };

    const maskData = dl.hd_bet_wasm(
      new Float64Array(magnitude), nx, ny, nz, vsx, vsy, vsz,
      weights[0], px, py, pz, tileStep ?? 0.5, !!tta, onProgress,
    );

    let count = 0;
    for (let i = 0; i < maskData.length; i++) if (maskData[i]) count++;
    emitMessage({
      type: 'hdBetLog',
      message: `HD-BET mask: ${count}/${maskData.length} voxels (${(100 * count / maskData.length).toFixed(1)}%)`,
    });
    emitMessage({ type: 'hdBetProgress', value: 1.0, text: 'Complete' });
    emitMessage({ type: 'hdBetComplete', maskData }, [maskData.buffer]);
  } catch (error) {
    emitMessage({ type: 'hdBetError', message: error.message || String(error) });
  }
}

/** RS2-Net deep-learning rodent brain extraction (magnitude -> brain mask).
 *
 *  A mask *generator*, like HD-BET: the result replaces the mask and refinements follow through
 *  `applyMaskOps`. Lives in the DL bundle, so this downloads the 63 MB weights (IndexedDB-cached
 *  after the first run) and boots that bundle's rayon pool. */
async function runRs2Net(data) {
  const { magnitude, dims, voxelSize, tileStep, tta } = data;
  try {
    const [nx, ny, nz] = dims;
    const [vsx, vsy, vsz] = voxelSize;

    const model = dlRegistry['rs2-net'];
    if (!model) throw new Error('rs2-net is not in the model registry');

    emitMessage({ type: 'rs2NetProgress', value: 0.05, text: 'Fetching RS2-Net weights...' });
    let weights;
    try {
      weights = await downloadWeights(model);
    } catch (e) {
      // qsm-core lists RS2-Net as Pending until rs2-net.onnx is on the weight mirror; say so
      // rather than surfacing a bare 404.
      if (!model.available) {
        throw new Error(`${e.message || e} — the RS2-Net weights are not hosted on the model mirror yet`);
      }
      throw e;
    }

    emitMessage({ type: 'rs2NetProgress', value: 0.15, text: 'Loading inference bundle...' });
    const dl = await loadDlWasm(wasmBaseUrl, QSMConfig.VERSION);
    // Same pool bound as HD-BET (see runHdBet): the DL bundle has one pool for every model.
    await initRayon(dl, 'dl', 4);

    emitMessage({
      type: 'rs2NetLog',
      message: `Running RS2-Net on ${nx}x${ny}x${nz} @ ${vsx.toFixed(3)}x${vsy.toFixed(3)}x${vsz.toFixed(3)}mm `
             + `(step ${tileStep ?? 0.5}${tta ? ', mirroring TTA' : ''}). A mouse head usually fits in `
             + `one 128x96x128 patch; each patch takes a minute or two — progress below.`,
    });

    const startedAt = performance.now();
    const onProgress = (done, total) => {
      const frac = total ? done / total : 0;
      let eta = '';
      if (done > 0 && done < total) {
        const secsLeft = ((performance.now() - startedAt) / done) * (total - done) / 1000;
        eta = secsLeft < 60
          ? ` — ${Math.ceil(secsLeft)}s left`
          : ` — ~${Math.round(secsLeft / 60)} min left`;
      }
      emitMessage({
        type: 'rs2NetProgress',
        value: 0.2 + frac * 0.75,
        text: `RS2-Net patch ${done}/${total}${eta}`,
      });
    };

    const maskData = dl.rs2_net_wasm(
      new Float64Array(magnitude), nx, ny, nz, vsx, vsy, vsz,
      weights[0], tileStep ?? 0.5, !!tta, onProgress,
    );

    let count = 0;
    for (let i = 0; i < maskData.length; i++) if (maskData[i]) count++;
    const mm3 = count * vsx * vsy * vsz;
    emitMessage({
      type: 'rs2NetLog',
      message: `RS2-Net mask: ${count}/${maskData.length} voxels (${(100 * count / maskData.length).toFixed(1)}%, `
             + `${mm3.toFixed(0)} mm³ — an adult mouse brain is ~450-500 mm³)`,
    });
    emitMessage({ type: 'rs2NetProgress', value: 1.0, text: 'Complete' });
    emitMessage({ type: 'rs2NetComplete', maskData }, [maskData.buffer]);
  } catch (error) {
    emitMessage({ type: 'rs2NetError', message: error.message || String(error) });
  }
}

async function runApplyMaskOps(data) {
  const { mask, ops, inputData, magnitude, dims, voxelSize } = data;
  try {
    const [nx, ny, nz] = dims;
    const [vsx, vsy, vsz] = voxelSize;
    const maskData = wasmModule.apply_mask_ops_wasm(
      new Uint8Array(mask), ops,
      new Float64Array(inputData || []),
      new Float64Array(magnitude || []),
      nx, ny, nz, vsx, vsy, vsz,
    );
    emitMessage({ type: 'applyMaskOpsComplete', maskData }, [maskData.buffer]);
  } catch (error) {
    emitMessage({ type: 'applyMaskOpsError', message: error.message || String(error) });
  }
}

async function runBET(data) {
  const { magnitudeBuffer, fractionalIntensity, smoothnessFactor, gradientThreshold, iterations, subdivisions, voxelScale } = data;
  const betIterations = iterations || 1000;
  const betSubdivisions = subdivisions || 4;
  const betSmoothness = smoothnessFactor ?? 1.0;  // FSL default
  const betGradient = gradientThreshold ?? 0.0;   // FSL default

  try {
    // Load magnitude data
    postBETProgress(0.1, 'Loading data...');
    postBETLog("Loading magnitude image...");

    const magResult = wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffer));
    const magData = new Float64Array(magResult.data);
    const dims = Array.from(magResult.dims);
    const voxelSize = Array.from(magResult.voxelSize);

    const [nx, ny, nz] = dims;
    postBETLog(`Image: ${nx}x${ny}x${nz}, voxel: ${voxelSize.map(v => v.toFixed(2)).join('x')}mm`);

    // Mouse BET: BET's search distances and curvature limits are fixed in mm for a human brain,
    // so run it on voxel sizes scaled up to human dimensions. The mask grid is unchanged.
    const [vsx, vsy, vsz] = scaleVoxelSize(voxelSize, voxelScale);
    if (voxelScale && voxelScale !== 1) {
      postBETLog(`Mouse BET: voxel sizes scaled x${voxelScale} to ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm`);
    }

    // Run BET with progress callback
    postBETProgress(0.15, 'Running BET...');
    postBETLog(`Running BET (fi=${fractionalIntensity || 0.5}, smooth=${betSmoothness}, grad=${betGradient}, iter=${betIterations}, subdiv=${betSubdivisions})...`);

    // Progress callback that updates the progress bar during iteration
    const progressCallback = (current, total) => {
      // Map iterations to 0.15 - 0.9 range (leave room for mask conversion)
      const progress = 0.15 + (current / total) * 0.75;
      const pct = Math.round((current / total) * 100);
      postBETProgress(progress, `BET iteration ${current}/${total} (${pct}%)`);
    };

    const mask = wasmModule.bet_wasm_with_progress(
      magData, nx, ny, nz, vsx, vsy, vsz,
      fractionalIntensity || 0.5, betSmoothness, betGradient,
      betIterations, betSubdivisions,
      progressCallback
    );

    postBETProgress(0.95, 'Converting mask...');

    const maskCount = mask.reduce((a, b) => a + b, 0);
    const totalVoxels = mask.length;
    const coveragePct = (maskCount / totalVoxels) * 100;

    postBETLog(`Mask coverage: ${maskCount}/${totalVoxels} voxels (${coveragePct.toFixed(1)}%)`);

    // Convert mask to Float32 for transfer
    const maskFloat = new Float32Array(totalVoxels);
    for (let i = 0; i < totalVoxels; i++) {
      maskFloat[i] = mask[i];
    }

    postBETProgress(1.0, 'Complete');
    postBETComplete(maskFloat, `${coveragePct.toFixed(1)}%`);

  } catch (error) {
    postBETError(error.message);
    console.error('BET error:', error);
  }
}

/**
 * Run bias field correction on magnitude data
 * @param {Object} data - Contains magnitude, dimensions, voxel sizes, and parameters
 */
async function runBiasCorrection(data) {
  const { magnitude, nx, ny, nz, vx, vy, vz, sigma_mm, nbox } = data;

  try {
    // Ensure WASM is initialized
    if (!wasmModule) {
      await initializeWasm();
    }

    console.log(`[Worker] Bias correction: ${nx}x${ny}x${nz}, voxel size=${vx.toFixed(2)}x${vy.toFixed(2)}x${vz.toFixed(2)}mm, sigma=${sigma_mm}mm, nbox=${nbox}`);

    const inputArray = new Float64Array(magnitude);
    const inputSum = inputArray.reduce((a, b) => a + b, 0);
    console.log(`[Worker] Input data length: ${inputArray.length}, sum: ${inputSum.toExponential(3)}`);

    // Call WASM bias correction
    const result = wasmModule.makehomogeneous_wasm(
      inputArray,
      nx, ny, nz,
      vx, vy, vz,
      sigma_mm,
      nbox
    );

    const resultSum = result.reduce((a, b) => a + b, 0);
    console.log(`[Worker] Bias correction complete, result sum: ${resultSum.toExponential(3)}`);

    // Send result back
    emitMessage({
      type: 'biasCorrection',
      result
    }, [result.buffer]);

  } catch (error) {
    console.error('[Worker] Bias correction error:', error);
    emitMessage({
      type: 'biasCorrection',
      error: error.message
    });
  }
}

/**
 * Compute ROMEO voxel quality map for phase-based masking
 * @param {Object} data - Contains phase, mag, phase2, te1, te2, mask, nx, ny, nz
 */
async function runVoxelQuality(data) {
  const { phase, mag, phase2, te1, te2, mask, nx, ny, nz } = data;

  try {
    if (!wasmModule) {
      await initializeWasm();
    }

    console.log(`[Worker] Voxel quality: ${nx}x${ny}x${nz}`);

    // Scale phase to [-π, +π] before quality map computation
    const phaseArray = scalePhaseToPi(phase);
    const magArray = new Float64Array(mag || []);
    const phase2Array = phase2 && phase2.length > 0
      ? scalePhaseToPi(phase2)
      : new Float64Array([]);
    const maskArray = new Uint8Array(mask);

    const result = wasmModule.voxel_quality_romeo_wasm(
      phaseArray, magArray, phase2Array,
      te1 || 1.0, te2 || 1.0,
      maskArray, nx, ny, nz
    );

    console.log(`[Worker] Voxel quality map complete, length: ${result.length}`);

    emitMessage({
      type: 'voxelQuality',
      result
    }, [result.buffer]);

  } catch (error) {
    console.error('[Worker] Voxel quality error:', error);
    emitMessage({
      type: 'voxelQuality',
      error: error.message
    });
  }
}

// =========================================================================
// Field-map inputs (total or local field)
// The field is converted to ppm on load, so every field-map pipeline runs the
// same stages, in the same units, as a raw-phase run.
// =========================================================================
function loadBinaryMask(buffer, voxelCount) {
  const maskResult = wasmModule.load_nifti_wasm(new Uint8Array(buffer));
  const mask = new Uint8Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    mask[i] = maskResult.data[i] > 0.5 ? 1 : 0;
  }
  return mask;
}

/**
 * Load a field-map run's field (in ppm), grid, optional magnitude and mask.
 * `requireMaskFile`: only an uploaded or edited mask will do (no threshold mask).
 */
function loadFieldMapInputs(data, { requireMaskFile = false } = {}) {
  const {
    inputMode, totalFieldBuffer, localFieldBuffer, fieldMapUnits,
    magnitudeBuffer, maskBuffer, customMaskBuffer, magField, maskThreshold, preparedMagnitude,
  } = data;
  const isLocalField = inputMode === 'localField';
  const fieldLabel = isLocalField ? 'local' : 'total';

  postProgress(0.05, `Loading ${fieldLabel} field map...`);
  postLog(`Loading ${fieldLabel} field map...`);
  const fieldResult = wasmModule.load_nifti_wasm(new Uint8Array(isLocalField ? localFieldBuffer : totalFieldBuffer));
  const dims = Array.from(fieldResult.dims);
  const voxelSize = Array.from(fieldResult.voxelSize);
  const affine = Array.from(fieldResult.affine);
  const voxelCount = dims[0] * dims[1] * dims[2];
  postLog(`Field map shape: ${dims.join('x')}, voxel: ${voxelSize.map(v => v.toFixed(2)).join('x')}mm`);

  // Prefer prepared magnitude (RSS-combined, bias-corrected) over the raw file
  let magnitudeData = null;
  if (preparedMagnitude !== null && preparedMagnitude !== undefined) {
    magnitudeData = new Float64Array(preparedMagnitude);
    postLog("Using prepared magnitude");
  } else if (magnitudeBuffer !== null && magnitudeBuffer !== undefined) {
    postProgress(0.08, 'Loading magnitude...');
    magnitudeData = new Float64Array(wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffer)).data);
    postLog("Loaded magnitude image");
  }

  postProgress(0.10, 'Converting field map units...');
  const fieldPpm = fieldMapToPpm(new Float64Array(fieldResult.data), fieldMapUnits, magField);
  if (fieldMapUnits !== 'ppm') postLog(`Converted field map from ${fieldMapUnits} to ppm`);

  postProgress(0.12, 'Loading mask...');
  let mask;
  if (customMaskBuffer !== null && customMaskBuffer !== undefined) {
    postLog("Using edited mask");
    mask = loadBinaryMask(customMaskBuffer, voxelCount);
  } else if (maskBuffer !== null && maskBuffer !== undefined) {
    postLog("Loading mask from file...");
    mask = loadBinaryMask(maskBuffer, voxelCount);
  } else if (requireMaskFile) {
    throw new Error("Mask is required for local field map pipeline");
  } else if (magnitudeData) {
    const thresholdFraction = (maskThreshold || 15) / 100;
    postLog(`Creating threshold mask from magnitude (${thresholdFraction * 100}%)...`);
    mask = createThresholdMask(magnitudeData, thresholdFraction);
  } else {
    throw new Error("No mask source available. Provide a mask file or magnitude image.");
  }

  const maskCount = mask.reduce((a, b) => a + b, 0);
  postLog(`Mask coverage: ${maskCount}/${voxelCount} voxels (${(100 * maskCount / voxelCount).toFixed(1)}%)`);
  for (let i = 0; i < voxelCount; i++) {
    if (!mask[i]) fieldPpm[i] = 0;
  }

  return { isLocalField, fieldLabel, fieldPpm, dims, voxelSize, affine, magnitudeData, mask };
}

// Standard pipeline from a total field (background removal + inversion) or a local field
// (inversion only): the same stages runPipeline uses after field mapping.
async function runFieldMapPipeline(data) {
  const { magField, echoTimes, pipelineSettings } = data;
  const b0 = requireFieldStrength(magField);
  const echoTimesSec = fieldMapEchoTimes(echoTimes, echoTimeDependentStep(pipelineSettings));

  const { isLocalField, fieldPpm, dims, voxelSize, affine, magnitudeData, mask } =
    loadFieldMapInputs(data, { requireMaskFile: data.inputMode === 'localField' });
  if (!isLocalField) {
    sendStageData('B0', fieldPpm, dims, voxelSize, affine, 'Total Field Map (ppm)');
  }

  await runBgRemovalAndInversion({
    fieldPpm, isTotalField: !isLocalField, mask, dims, voxelSize, affine,
    b0, echoTimesSec, magnitude: magnitudeData, pipelineSettings,
    configToml: stageConfigToml(buildConfigJson(pipelineSettings)),
  });

  postProgress(1.0, 'Pipeline complete!');
  postLog(`${isLocalField ? 'Local' : 'Total'} field map pipeline completed successfully!`);
  postComplete({ success: true });
}

// TGV from a total or local field map
async function runTgvFieldMapPipeline(data) {
  const { magField, echoTimes, pipelineSettings } = data;
  const b0 = requireFieldStrength(magField);
  // TGV regularizes the phase at this TE, so it is the field map's own echo time, not a nominal one.
  const [te] = fieldMapEchoTimes(echoTimes, 'TGV');
  const tgvSettings = pipelineSettings?.tgv || QSMConfig.PIPELINE_DEFAULTS.tgv;

  const { isLocalField, fieldLabel, fieldPpm, dims, voxelSize, affine, mask } = loadFieldMapInputs(data);
  sendStageData('B0', fieldPpm, dims, voxelSize, affine,
    `${isLocalField ? 'Local' : 'Total'} Field Map (ppm)`);

  const tgvInputPhase = ppmFieldToPhase(fieldPpm, b0, te, QSMConfig.PHYSICS.GYROMAGNETIC_RATIO);
  postLog(`Converted field map to phase at TE=${(te * 1000).toFixed(2)}ms`);

  await runTgvCore({
    tgvInputPhase, mask, dims, voxelSize, affine,
    te, fieldstrength: b0, tgvSettings,
    progressStart: 0.15, progressEnd: 0.95,
    label: `QSM Result (ppm) - TGV (from ${fieldLabel} field)`,
    pipelineSettings,
  });

  postProgress(1.0, 'TGV pipeline complete!');
  postLog(`TGV ${fieldLabel} field pipeline completed successfully!`);
  postComplete({ success: true });
}

// QSMART from a total or local field map
async function runQsmartFieldMapPipeline(data) {
  const { magField, echoTimes, pipelineSettings } = data;
  const b0 = requireFieldStrength(magField);
  const echoTimesSec = fieldMapEchoTimes(echoTimes, echoTimeDependentStep(pipelineSettings));

  const { isLocalField, fieldLabel, fieldPpm, dims, voxelSize, affine, magnitudeData, mask } =
    loadFieldMapInputs(data);
  sendStageData(isLocalField ? 'bgRemoved' : 'tfs', fieldPpm, dims, voxelSize, affine,
    `${isLocalField ? 'Local' : 'Total'} Field Map (ppm)`);

  // No multi-echo data for a reliability estimate, so R_0 is the mask
  const R_0 = Uint8Array.from(mask);
  postLog("R_0 set to mask (no multi-echo data for reliability estimation)");

  await runQsmartCore({
    fieldPpm, mask, R_0, magnitudeData,
    dims, voxelSize, affine,
    pipelineSettings, b0, echoTimesSec,
    skipSdf: isLocalField,
  });

  postProgress(1.0, 'QSMART pipeline complete!');
  postLog(`QSMART ${fieldLabel} field pipeline completed successfully!`);
  postComplete({ success: true });
}

// =========================================================================
// SWI-only pipeline
// =========================================================================
async function runT2starR2starPipeline(data) {
  const {
    magnitudeBuffers, maskThreshold, customMaskBuffer, preparedMagnitude, echoTimes
  } = data;

  const nEchoes = magnitudeBuffers.length;
  if (nEchoes < 3) {
    throw new Error(`T2*/R2* mapping requires 3+ echoes, got ${nEchoes}`);
  }

  // Step 1: Load magnitude data
  postProgress(0.05, 'Loading magnitude data...');
  postLog(`T2*/R2*: Loading ${nEchoes} echo magnitudes...`);

  const magnitude4d = [];
  let dims, voxelSize, affine;
  for (let i = 0; i < nEchoes; i++) {
    const result = wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffers[i]));
    magnitude4d.push(new Float64Array(result.data));
    if (i === 0) {
      dims = Array.from(result.dims);
      voxelSize = Array.from(result.voxelSize);
      affine = Array.from(result.affine);
    }
  }

  const [nx, ny, nz] = dims;
  const voxelCount = nx * ny * nz;
  postLog(`Data: ${nx}x${ny}x${nz}, ${nEchoes} echoes`);

  // Step 2: Create mask
  postProgress(0.15, 'Creating mask...');
  const thresholdFraction = (maskThreshold || 15) / 100;
  const hasCustomMask = customMaskBuffer !== null && customMaskBuffer !== undefined;
  const hasPreparedMagnitude = preparedMagnitude !== null && preparedMagnitude !== undefined;

  let mask;
  if (hasCustomMask) {
    const maskResult = wasmModule.load_nifti_wasm(new Uint8Array(customMaskBuffer));
    mask = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      mask[i] = maskResult.data[i] > 0.5 ? 1 : 0;
    }
  } else {
    const maskMagnitude = hasPreparedMagnitude
      ? new Float64Array(preparedMagnitude)
      : magnitude4d[0];
    mask = createThresholdMask(maskMagnitude, thresholdFraction);
  }

  // Step 3: Compute R2* via ARLO
  postProgress(0.30, 'Computing R2* map...');
  postLog(`Computing R2* map (ARLO, ${nEchoes} echoes)...`);

  const interleaved = new Float64Array(voxelCount * nEchoes);
  for (let e = 0; e < nEchoes; e++) {
    for (let v = 0; v < voxelCount; v++) {
      interleaved[v * nEchoes + e] = magnitude4d[e][v];
    }
  }

  const echoTimesSec = new Float64Array(echoTimes.map(t => t / 1000));

  const r2starMap = new Float64Array(wasmModule.r2star_arlo_wasm(
    interleaved, mask, echoTimesSec, nx, ny, nz
  ));

  const r2range = computeRobustRange(r2starMap, mask, 2, 98);
  sendStageData('r2star', r2starMap, dims, voxelSize, affine, 'R2* Map (1/s)', true, r2range ? [0, r2range[1]] : null);
  postLog('R2* map computed');

  // Step 4: Compute T2* = 1/R2*
  postProgress(0.80, 'Computing T2* map...');
  const t2starMap = new Float64Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    t2starMap[i] = (mask[i] && r2starMap[i] > 0) ? (1.0 / r2starMap[i]) : 0;
  }
  const t2range = computeRobustRange(t2starMap, mask, 2, 90);
  sendStageData('t2star', t2starMap, dims, voxelSize, affine, 'T2* Map (s)', true, t2range ? [0, t2range[1]] : null);
  postLog('T2* map computed');

  postProgress(1.0, 'T2*/R2* complete!');
  postLog('T2*/R2* mapping completed successfully!');
  postComplete({ success: true });
}

async function runSWIPipeline(data) {
  const {
    magnitudeBuffers, phaseBuffers,
    maskThreshold, customMaskBuffer, preparedMagnitude, pipelineSettings
  } = data;

  const thresholdFraction = (maskThreshold || 15) / 100;
  const hasCustomMask = customMaskBuffer !== null && customMaskBuffer !== undefined;
  const hasPreparedMagnitude = preparedMagnitude !== null && preparedMagnitude !== undefined;

  // Step 1: Load first echo NIfTI data
  postProgress(0.05, 'Loading NIfTI data...');
  postLog("SWI: Loading data...");

  const magResult = wasmModule.load_nifti_wasm(new Uint8Array(magnitudeBuffers[0]));
  const magnitude = new Float64Array(magResult.data);
  const dims = Array.from(magResult.dims);
  const voxelSize = Array.from(magResult.voxelSize);
  const affine = Array.from(magResult.affine);

  const phaseResult = wasmModule.load_nifti_wasm(new Uint8Array(phaseBuffers[0]));
  const phase = scalePhaseToPi(phaseResult.data);

  const [nx, ny, nz] = dims;
  const [vsx, vsy, vsz] = voxelSize;
  const voxelCount = nx * ny * nz;

  postLog(`Data: ${nx}x${ny}x${nz}, voxel: ${vsx.toFixed(2)}x${vsy.toFixed(2)}x${vsz.toFixed(2)}mm`);

  // Step 2: Create or load mask
  postProgress(0.15, 'Creating mask...');
  let mask;

  if (hasCustomMask) {
    const maskResult = wasmModule.load_nifti_wasm(new Uint8Array(customMaskBuffer));
    mask = new Uint8Array(voxelCount);
    for (let i = 0; i < voxelCount; i++) {
      mask[i] = maskResult.data[i] > 0.5 ? 1 : 0;
    }
  } else {
    const maskMagnitude = hasPreparedMagnitude
      ? new Float64Array(preparedMagnitude)
      : magnitude;
    mask = createThresholdMask(maskMagnitude, thresholdFraction);
  }

  const maskCount = mask.reduce((a, b) => a + b, 0);
  postLog(`Mask: ${maskCount}/${voxelCount} voxels (${(100 * maskCount / voxelCount).toFixed(1)}%)`);

  // Step 3: Laplacian phase unwrapping
  postProgress(0.25, 'Unwrapping phase...');
  postLog("Laplacian phase unwrapping...");
  const unwrappedPhase = new Float64Array(wasmModule.laplacian_unwrap_wasm(
    phase, mask, nx, ny, nz, vsx, vsy, vsz
  ));

  // Step 4: SWI computation
  postProgress(0.50, 'Computing SWI...');
  computeSWI(pipelineSettings, unwrappedPhase, magnitude, mask, dims, voxelSize, affine);

  postProgress(1.0, 'SWI complete!');
  postLog("SWI pipeline completed successfully!");
  postComplete({ success: true });
}

// Handle messages from main thread
/**
 * Run an export serializer and reply under `type` either way.
 *
 * These three replies are awaited by a one-shot listener in the export modal, and
 * `configTomlResult` is what detaches it. Letting the throw escape to the generic
 * postError would leave the modal on "Generating..." with the listener still attached,
 * so a failure is reported as `{ type, error }` on the same channel instead.
 */
function exportReply(type, serialize) {
  try {
    return { type, result: serialize() };
  } catch (err) {
    return { type, error: err?.message || String(err) };
  }
}

installWorkerRouter({
  scope: self,
  getServices: async () => ({}),
  handle: async ({ type, data }) => {
  try {
    switch (type) {
      case 'init':
        await initializeWasm();
        workerMessages.initialized();
        break;

      case 'run':
        await runPipeline(data);
        break;

      case 'runBET':
        await runBET(data);
        break;

      case 'hdBet':
        await runHdBet(data);
        break;
      case 'rs2Net':
        await runRs2Net(data);
        break;
      case 'applyMaskOps':
        await runApplyMaskOps(data);
        break;

      case 'runSWI':
        await runSWIPipeline(data);
        break;

      case 'runT2starR2star':
        await runT2starR2starPipeline(data);
        break;

      case 'biasCorrection':
        await runBiasCorrection(data);
        break;

      case 'voxelQuality':
        await runVoxelQuality(data);
        break;

      case 'getDefaultConfig':
        emitMessage({ type: 'defaultConfig', result: wasmModule.get_default_config_json_wasm() });
        break;

      case 'generateCommand':
        emitMessage(exportReply('commandResult', () =>
          wasmModule.generate_command_wasm(data.configJson, data.maskSection || '')));
        break;

      case 'generateMethods':
        emitMessage(exportReply('methodsResult', () =>
          wasmModule.generate_methods_wasm(data.configJson, 'QSMbly', data.maskSection || '')));
        break;

      case 'generateConfigToml':
        // Download path: pruned to the selected algorithm (still loads in qsmxt.rs).
        emitMessage(exportReply('configTomlResult', () =>
          wasmModule.config_json_to_toml_selected_wasm(data.configJson, data.maskSection || '')));
        break;

      default:
        postError(`Unknown message type: ${type}`);
    }
  } catch (error) {
    postError(error.message);
    console.error(error);
  }
  },
});
