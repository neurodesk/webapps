/**
 * Config Bridge — maps qsmbly pipeline settings to a qsmxt-engine PipelineConfig
 * shape (the UI→schema adapter). Serialization to TOML, command, and methods is
 * delegated to qsmxt-engine via WASM (see rust-wasm config_json_to_toml_wasm /
 * generate_command_wasm / generate_methods_wasm) — qsmbly no longer hand-rolls TOML.
 */

import { DL_TILING_DEFAULTS, QSMART_ILSQR_PAD_MM, tgvAlphaPreset } from '../app/config.js';
import { resolveTgvAlphas } from '../worker/utils/TgvParams.js';

/**
 * A [f64; 3] the config can carry, or null if any element is missing/non-finite.
 * JSON.stringify writes NaN — and anything the null-dropping replacer removes — as
 * `null` when it sits inside an array, and serde rejects null for a fixed-size f64
 * array ("invalid type: null, expected f64"). A scalar can simply be omitted so
 * qsmxt-engine's default applies; an array element cannot, so drop the whole key.
 */
function finiteTriple(arr) {
  return Array.isArray(arr) && arr.length === 3 && arr.every(Number.isFinite) ? arr : null;
}

/** The UI calls NLTV's Newton iteration limit newton_max_iter; qsmxt-engine calls it max_iter_newton. */
function nltvConfig(nltv) {
  const { newton_max_iter, ...rest } = nltv;
  return newton_max_iter === undefined ? rest : { ...rest, max_iter_newton: newton_max_iter };
}

/**
 * Build a qsmxt-engine PipelineConfig object from qsmbly pipeline settings.
 * The returned object is JSON.stringify'd and handed to the WASM serializers; the
 * mask is passed separately as a CLI-style string (see maskSectionString).
 * @param {Object} settings - Pipeline settings from PipelineSettingsController.save()
 * @param {Object} options - { doQsm (default true), doSwi, doT2star, doR2star }
 * @returns {Object} config object matching the qsmxt-engine schema
 */
export function buildConfig(settings, options = {}) {
  if (!settings) return {};

  const isTgv = settings.combined_method === 'tgv';
  const isQsmart = settings.combined_method === 'qsmart';
  const isTfi = settings.combined_method === 'tfi';

  const config = {
    pipeline: {
      do_qsm: options.doQsm ?? true,
      do_swi: !!options.doSwi,
      do_t2starmap: !!options.doT2star,
      do_r2starmap: !!options.doR2star,
    },
    field_mapping: {
      phase_offset_removal: settings.phase_offset_method !== 'none',
      ...(finiteTriple(settings.mcpc3ds?.sigma) ? { phase_offset_sigma_mm: settings.mcpc3ds.sigma } : {}),
      bipolar_correction: !!settings.bipolar_correction,
      unwrapping_algorithm: settings.unwrapping_algorithm || 'romeo',
      b0_estimation: (settings.b0_estimation || 'weighted_avg').replace(/_/g, '-'),
      b0_weight_type: (settings.b0_weight_type || 'phase_snr').replace(/_/g, '-'),
      // qsmxt-engine's LinearFitConfig carries only the reliability percentile; its bridge
      // pins qsm-core's estimate_offset to the default, so the UI does not offer it.
      linear_fit: {
        reliability_threshold_percentile: settings.linearFit?.reliability_threshold_percentile,
      },
      romeo: {
        individual: settings.romeo?.individual ?? true,
        correct_global: settings.romeo?.correct_global ?? true,
        template: settings.romeo?.template ?? 0,
        phase_gradient_coherence: settings.romeo?.phase_gradient_coherence ?? true,
        mag_coherence: settings.romeo?.mag_coherence ?? true,
        mag_weight: settings.romeo?.mag_weight ?? false,
      },
    },
    masking: { inhomogeneity_correction: true },
    bg_removal: {
      algorithm: settings.bf_algorithm || 'vsharp',
    },
    inversion: {},
    qsm: { reference: settings.reference_mean === false ? 'none' : 'mean' },
  };

  if (isTgv) config.inversion.algorithm = 'tgv';
  else if (isQsmart) config.inversion.algorithm = 'qsmart';
  else if (isTfi) config.inversion.algorithm = 'tfi';
  else {
    // Translate qsmbly dropdown value -> qsmxt-engine serde string.
    // 'fansitgv' maps to 'fansi-tgv'; all others pass through unchanged.
    const dipole = settings.dipole_inversion || 'rts';
    config.inversion.algorithm = dipole === 'fansitgv' ? 'fansi-tgv' : dipole;
  }

  // Deep-learning overlap-tiling: qsmbly runs the tileable DL nets tiled (bounded wasm memory),
  // so reflect that in the generated `qsmxt run` command + methods. Only set for those algorithms
  // (qsmxt-engine emits --tile-size/--tile-halo for them, and the methods note is DL-only).
  const tiling = settings.dl_tiling || {};
  if (tiling.enabled !== false && DL_TILING_DEFAULTS.tileable.includes(config.inversion.algorithm)) {
    config.inversion.tile_size = Number(tiling.tile_size) || DL_TILING_DEFAULTS.tile_core;
    const halo = Number(tiling.tile_halo);
    config.inversion.tile_halo = Number.isFinite(halo) ? halo : DL_TILING_DEFAULTS.tile_halo;
  }

  // Algorithm params
  if (settings.rts) config.inversion.rts = settings.rts;
  if (settings.tv) config.inversion.tv = settings.tv;
  if (settings.tkd) config.inversion.tkd = settings.tkd;
  if (settings.tsvd) config.inversion.tsvd = settings.tsvd;
  if (settings.tikhonov) config.inversion.tikhonov = settings.tikhonov;
  if (settings.nltv) config.inversion.nltv = nltvConfig(settings.nltv);
  if (settings.ndi) config.inversion.ndi = settings.ndi;
  if (settings.fansi) config.inversion.fansi = settings.fansi;
  if (settings.fansitgv) config.inversion.fansi = settings.fansitgv;
  if (settings.l1qsm) config.inversion.l1qsm = settings.l1qsm;
  if (settings.whqsm) config.inversion.whqsm = settings.whqsm;
  if (settings.hdqsm) config.inversion.hdqsm = settings.hdqsm;
  if (settings.amp_pe) config.inversion.amp_pe = settings.amp_pe;
  if (settings.medi) config.inversion.medi = settings.medi;
  if (settings.tfi) config.inversion.tfi = {
    lambda: settings.tfi.lambda, precond: settings.tfi.precond,
    data_weighting: settings.tfi.data_weighting, percentage: settings.tfi.percentage,
    cg_tol: settings.tfi.cg_tol, cg_max_iter: settings.tfi.cg_max_iter,
    max_iter: settings.tfi.max_iter, tol: settings.tfi.tol,
  };
  if (settings.ilsqr) config.inversion.ilsqr = settings.ilsqr;
  if (settings.tgv) config.inversion.tgv = {
    iterations: settings.tgv.iterations, erosions: settings.tgv.erosions,
    // The UI picks alphas by regularization level, which TgvConfig has no field for, so
    // export the pair the run resolves to; left unset, qsmxt-engine would fill in its own.
    ...resolveTgvAlphas(settings.tgv, tgvAlphaPreset),
    step_size: settings.tgv.step_size,
  };
  if (settings.qsmart) config.inversion.qsmart = {
    ilsqr_max_iter: settings.qsmart.ilsqr_max_iter,
    vasc_sphere_radius: settings.qsmart.vasc_sphere_radius,
    inversion: settings.qsmart.inversion_algorithm || 'ilsqr',
    sdf_sigma1_stage1: settings.qsmart.sdf_sigma1_stage1, sdf_sigma2_stage1: settings.qsmart.sdf_sigma2_stage1,
    sdf_sigma1_stage2: settings.qsmart.sdf_sigma1_stage2, sdf_sigma2_stage2: settings.qsmart.sdf_sigma2_stage2,
    sdf_lower_lim: settings.qsmart.sdf_lower_lim, sdf_curv_constant: settings.qsmart.sdf_curv_constant,
    frangi_scale_min: settings.qsmart.frangi_scale_min, frangi_scale_max: settings.qsmart.frangi_scale_max,
    frangi_scale_ratio: settings.qsmart.frangi_scale_ratio, frangi_c: settings.qsmart.frangi_c,
    // This interface gives the bottom-hat radius and the Frangi scales in mm.
    vessel_size_units: 'mm',
  };
  // QSMART's inner inversion reads the top-level per-algorithm section (qsm-core run_qsmart),
  // so the QSMART panel's own values for that algorithm go there.
  if (isQsmart) {
    const inner = settings.qsmart?.inversion_algorithm || 'ilsqr';
    const panel = settings.qsmart?.[inner];
    if (inner !== 'ilsqr' && panel) config.inversion[inner] = inner === 'nltv' ? nltvConfig(panel) : panel;
    // QSMART's iLSQR tolerance is iLSQR's own (`inversion.ilsqr.tol`); it has no QSMART field.
    if (settings.qsmart) config.inversion.ilsqr = { ...config.inversion.ilsqr, tol: settings.qsmart.ilsqr_tol };
  }

  // BG removal params
  if (settings.vsharp) config.bg_removal.vsharp = settings.vsharp;
  if (settings.pdf) config.bg_removal.pdf = settings.pdf;
  if (settings.lbv) config.bg_removal.lbv = settings.lbv;
  if (settings.ismv) config.bg_removal.ismv = settings.ismv;
  if (settings.sharp) config.bg_removal.sharp = settings.sharp;
  if (settings.resharp) config.bg_removal.resharp = settings.resharp;
  if (settings.harperella) config.bg_removal.harperella = settings.harperella;
  if (settings.iharperella) config.bg_removal.iharperella = settings.iharperella;

  if (settings.swi) config.swi = {
    // scaling uses snake_case in the UI (e.g. negative_tanh) but qsmxt-engine expects
    // kebab-case (negative-tanh), same as b0_estimation/b0_weight_type above.
    // hp_sigma is omitted entirely unless it is a usable triple (see finiteTriple).
    ...(finiteTriple(settings.swi.hp_sigma) ? { hp_sigma: settings.swi.hp_sigma } : {}),
    scaling: (settings.swi.scaling || 'tanh').replace(/_/g, '-'),
    strength: settings.swi.strength, mip_window: settings.swi.mip_window,
  };

  return config;
}

/**
 * Serialize the config to JSON for the WASM serializers, dropping null/undefined
 * and non-finite numbers (NaN/Infinity, e.g. from a blank numeric input). serde
 * rejects null for a typed field; omitting it makes qsmxt-engine fall back to the
 * default — mirroring how the old hand-rolled TOML serializer skipped such values.
 */
export function buildConfigJson(settings, options = {}) {
  return serializeConfig(buildConfig(settings, options));
}

function serializeConfig(config) {
  return JSON.stringify(
    config,
    (_k, v) => (v === null || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
  );
}

/**
 * The config for one of QSMART's two inner dipole inversions, run through the standard
 * inversion stage: QSMART's inner algorithm with iLSQR pinned to QSMART's own tolerance
 * and iteration limit, exactly as qsm-core's run_qsmart builds it.
 */
export function buildQsmartInnerConfigJson(settings) {
  const config = buildConfig(settings);
  config.inversion.algorithm = settings?.qsmart?.inversion_algorithm || 'ilsqr';
  config.inversion.ilsqr = {
    tol: settings?.qsmart?.ilsqr_tol, max_iter: settings?.qsmart?.ilsqr_max_iter,
    pad_mm: QSMART_ILSQR_PAD_MM,
  };
  return serializeConfig(config);
}

/**
 * Default mask ops from qsmxt-engine (robust threshold preset).
 * Set dynamically from WASM default config; falls back to hardcoded.
 */
let DEFAULT_MASK_OPS = ['threshold:otsu', 'dilate:1', 'fill-holes:0', 'erode:1'];

/**
 * Update default mask ops from a parsed qsmxt-engine default config JSON.
 */
export function setDefaultsFromConfig(config) {
  if (config?.masking?.sections?.[0]) {
    const s = config.masking.sections[0];
    const ops = [];
    if (s.generator) ops.push(maskOpToString(s.generator));
    if (s.refinements) s.refinements.forEach(r => ops.push(maskOpToString(r)));
    if (ops.length > 0) DEFAULT_MASK_OPS = ops;
  }
}

function maskOpToString(op) {
  switch (op.op) {
    case 'threshold': return `threshold:${op.method || 'otsu'}`;
    case 'bet': return `bet:${op.fractional_intensity ?? 0.5}`;
    case 'erode': return `erode:${op.iterations ?? 1}`;
    case 'dilate': return `dilate:${op.iterations ?? 1}`;
    case 'close': return `close:${op.radius ?? 1}`;
    case 'fill-holes': return `fill-holes:${op.max_size ?? 0}`;
    case 'gaussian-smooth': return `gaussian:${op.sigma_mm ?? 4.0}`;
    default: return op.op;
  }
}

/**
 * Build the CLI-style mask section string (e.g. "magnitude-first,bet:0.5,erode:1")
 * from the UI's mask source + op history. Returns '' if no ops. This is the string
 * the WASM command/methods generators parse to populate the config's mask sections,
 * so both reflect the real mask. See apply_mask_section in rust-wasm/src/lib.rs.
 */
export function maskSectionString(maskOps, maskSource) {
  if (!maskOps || maskOps.length === 0) return '';
  const inputMap = {
    'phase_quality': 'phase-quality', 'combined': 'magnitude',
    'first_echo': 'magnitude-first', 'last_echo': 'magnitude-last',
  };
  const input = inputMap[maskSource] || 'phase-quality';
  return `${input},${maskOps.join(',')}`;
}
