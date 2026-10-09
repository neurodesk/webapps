/**
 * Config Module Tests
 */
import { readFileSync } from 'node:fs';
import * as Config from './config.js';
import * as Generated from './qsm-defaults.js';

const {
  PHYSICS,
  VIEWER_CONFIG,
  MASK_CONFIG,
  PIPELINE_DEFAULTS,
  PIPELINE_METHODS,
  STAGE_DISPLAY_NAMES,
  getVoxelBasedDefaults
} = Config;

// How each algorithm default in config.js derives from the generated qsm-defaults.js.
// `keys` is the exact key set config.js exports: a plain name reads the generated field of
// the same name, and 'jsName:generatedName' reads a renamed one. `extras` are qsmbly-only
// keys (not qsm-core parameters) with their expected types.
const DERIVED = {
  RTS_DEFAULTS: { from: 'RTS_DEFAULTS', keys: ['delta', 'mu', 'rho', 'tol', 'max_iter', 'lsmr_iter'] },
  TV_DEFAULTS: { from: 'TV_DEFAULTS', keys: ['lambda', 'rho', 'tol', 'max_iter'] },
  TKD_DEFAULTS: { from: 'TKD_DEFAULTS', keys: ['threshold'] },
  TSVD_DEFAULTS: { from: 'TKD_DEFAULTS', keys: ['threshold'] },
  ILSQR_DEFAULTS: { from: 'ILSQR_DEFAULTS', keys: ['tol', 'max_iter'] },
  VSHARP_DEFAULTS: { from: 'VSHARP_DEFAULTS', keys: ['threshold', 'max_radius', 'min_radius'] },
  PDF_DEFAULTS: { from: 'PDF_DEFAULTS', keys: ['tol'] },
  LBV_DEFAULTS: { from: 'LBV_DEFAULTS', keys: ['tol'] },
  ISMV_DEFAULTS: { from: 'ISMV_DEFAULTS', keys: ['tol', 'max_iter', 'radius'] },
  SHARP_DEFAULTS: { from: 'SHARP_DEFAULTS', keys: ['threshold', 'radius'] },
  RESHARP_DEFAULTS: { from: 'RESHARP_DEFAULTS', keys: ['radius', 'tik_reg', 'tol', 'max_iter'] },
  HARPERELLA_DEFAULTS: { from: 'HARPERELLA_DEFAULTS', keys: ['radius', 'max_iter', 'tol'] },
  BET_DEFAULTS: {
    from: 'BET_DEFAULTS',
    keys: ['fractionalIntensity:fractional_intensity', 'smoothness',
      'gradientThreshold:gradient_threshold', 'iterations', 'subdivisions'],
    extras: { erosions: 'number' },
  },
  TGV_DEFAULTS: {
    from: 'TGV_DEFAULTS',
    keys: ['alpha0', 'alpha1', 'iterations', 'erosions', 'step_size', 'tol'],
    extras: { regularization: 'number' },
  },
  SWI_DEFAULTS: { from: 'SWI_DEFAULTS', keys: ['hp_sigma', 'scaling', 'strength', 'mip_window'] },
  QSMART_DEFAULTS: {
    from: 'QSMART_DEFAULTS',
    keys: ['sdf_sigma1_stage1', 'sdf_sigma2_stage1', 'sdf_sigma1_stage2', 'sdf_sigma2_stage2',
      'sdf_spatial_radius', 'sdf_lower_lim', 'sdf_curv_constant', 'vasc_sphere_radius',
      'frangi_scale_min', 'frangi_scale_max', 'frangi_scale_ratio', 'frangi_c',
      'ilsqr_tol', 'ilsqr_max_iter', 'inversion_algorithm:inversion'],
  },
  ROMEO_DEFAULTS: {
    from: 'ROMEO_DEFAULTS',
    keys: ['phase_gradient_coherence', 'mag_coherence', 'mag_weight'],
    extras: { weighting: 'string' },
  },
  MCPC3DS_DEFAULTS: { from: 'MCPC3DS_DEFAULTS', keys: ['sigma'] },
  LINEAR_FIT_DEFAULTS: { from: 'LINEAR_FIT_DEFAULTS', keys: ['estimate_offset', 'reliability_threshold_percentile'] },
  HOMOGENEITY_DEFAULTS: { from: 'HOMOGENEITY_DEFAULTS', keys: ['sigmaMm:sigma_mm', 'nbox'] },
  SIGNAL_ERODE_DEFAULTS: {
    from: 'SIGNAL_ERODE_DEFAULTS',
    keys: ['bias_sigma', 'depth_cap', 'global_erosions', 'min_component', 'threshold'],
  },
  TIKHONOV_DEFAULTS: { from: 'TIKHONOV_DEFAULTS', keys: ['lambda', 'reg'] },
  DL_TILING_DEFAULTS: {
    from: 'DL_TILING_DEFAULTS',
    keys: ['tile_core', 'tile_halo', 'tileable', 'off_design', 'native'],
  },
  NLTV_DEFAULTS: { from: 'NLTV_DEFAULTS', keys: ['lambda', 'mu', 'max_iter', 'tol', 'newton_max_iter:newton_iter'] },
  NDI_DEFAULTS: { from: 'NDI_DEFAULTS', keys: ['tau', 'alpha', 'max_iter'] },
  FANSI_DEFAULTS: { from: 'FANSI_DEFAULTS', keys: ['alpha1', 'mu1', 'mu2', 'alpha0', 'mu0', 'max_iter', 'tol_update'] },
  L1QSM_DEFAULTS: { from: 'L1QSM_DEFAULTS', keys: ['alpha1', 'mu1', 'mu2', 'mu3', 'lambda', 'max_iter', 'tol_update'] },
  WHQSM_DEFAULTS: { from: 'WHQSM_DEFAULTS', keys: ['alpha1', 'mu1', 'mu2', 'beta', 'muh', 'max_iter', 'tol_update'] },
  HDQSM_DEFAULTS: { from: 'HDQSM_DEFAULTS', keys: ['alpha_l2', 'mu1_l2', 'mu2', 'max_iter_l1', 'max_iter_l2', 'tol_update'] },
  MEDI_DEFAULTS: {
    from: 'MEDI_DEFAULTS',
    keys: ['lambda', 'percentage', 'max_iter', 'cg_max_iter', 'cg_tol', 'tol', 'smv', 'smv_radius',
      'merit', 'data_weighting'],
  },
  TFI_DEFAULTS: {
    from: 'TFI_DEFAULTS',
    keys: ['lambda', 'precond', 'merit', 'data_weighting', 'percentage', 'cg_tol', 'cg_max_iter',
      'max_iter', 'tol'],
  },
};

const splitKey = (k) => {
  const [jsKey, genKey = jsKey] = k.split(':');
  return [jsKey, genKey];
};

// A generated value is whatever serde_json emits for a qsmxt-config field.
const isJsonScalarOrArray = (v) =>
  ['number', 'boolean', 'string'].includes(typeof v) ||
  (Array.isArray(v) && v.every(x => ['number', 'string'].includes(typeof x)));

describe('Config Module', () => {
  describe('PHYSICS', () => {
    test('should have correct gyromagnetic ratio', () => {
      expect(PHYSICS.GYROMAGNETIC_RATIO).toBe(42.576e6);
    });
  });

  describe('VIEWER_CONFIG', () => {
    test('should have expected NiiVue settings', () => {
      expect(VIEWER_CONFIG.loadingText).toBe("");
      expect(VIEWER_CONFIG.dragToMeasure).toBe(false);
      expect(VIEWER_CONFIG.crosshairColor).toHaveLength(4);
      expect(VIEWER_CONFIG.crosshairWidth).toBe(0.75);
    });
  });

  describe('MASK_CONFIG', () => {
    test('should have sensible defaults', () => {
      expect(MASK_CONFIG.defaultThreshold).toBe(15);
      expect(MASK_CONFIG.defaultBrushSize).toBe(2);
    });
  });

  describe('generated qsm-defaults.js', () => {
    test('exports exactly what scripts/generate-defaults.mjs generates', () => {
      const generator = readFileSync(new URL('../../scripts/generate-defaults.mjs', import.meta.url), 'utf8');
      const block = generator.slice(generator.indexOf('const defaults = {'));
      const generatorNames = [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map(m => m[1]);
      expect(generatorNames.length).toBeGreaterThan(0);
      expect(Object.keys(Generated).sort()).toEqual([...generatorNames].sort());
    });

    test.each(Object.keys(Generated))('%s is a non-empty object of JSON values', (name) => {
      const obj = Generated[name];
      expect(Object.keys(obj).length).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(obj)) {
        expect([key, isJsonScalarOrArray(value)]).toEqual([key, true]);
      }
    });
  });

  describe('algorithm defaults derived from qsm-defaults.js', () => {
    test.each(Object.keys(DERIVED))('%s has the expected key set', (name) => {
      const { keys, extras = {} } = DERIVED[name];
      const expected = [...keys.map(k => splitKey(k)[0]), ...Object.keys(extras)];
      expect(Object.keys(Config[name]).sort()).toEqual(expected.sort());
    });

    test.each(Object.keys(DERIVED))('%s reads fields the generated defaults provide', (name) => {
      const { from, keys } = DERIVED[name];
      const generated = Generated[from];
      for (const k of keys) {
        const [jsKey, genKey] = splitKey(k);
        expect(generated).toHaveProperty(genKey);
        expect(Config[name][jsKey]).toEqual(generated[genKey]);
      }
    });

    test.each(Object.keys(DERIVED))('%s has typed qsmbly-only extras', (name) => {
      for (const [key, type] of Object.entries(DERIVED[name].extras || {})) {
        expect(typeof Config[name][key]).toBe(type);
      }
    });

    test('every exported *_DEFAULTS built from qsm-defaults.js is covered above', () => {
      const local = ['INPUT_DEFAULTS', 'MASK_PREP_DEFAULTS', 'PIPELINE_DEFAULTS', 'BOX_FILTER_DEFAULTS'];
      const exported = Object.keys(Config).filter(n => n.endsWith('_DEFAULTS') && !local.includes(n));
      expect(exported.sort()).toEqual(Object.keys(DERIVED).sort());
    });
  });

  describe('TGV alpha presets', () => {
    test('cover regularization levels 1-4 with [alpha0, alpha1] pairs', () => {
      expect(Object.keys(Config.TGV_ALPHA_PRESETS).sort()).toEqual(['1', '2', '3', '4']);
      for (const pair of Object.values(Config.TGV_ALPHA_PRESETS)) {
        expect(pair).toHaveLength(2);
        pair.forEach(a => expect(a).toBeGreaterThan(0));
      }
    });

    test('tgvAlphaPreset reads the table and clamps like qsm-core', () => {
      expect(Config.tgvAlphaPreset(3)).toEqual(Config.TGV_ALPHA_PRESETS[3]);
      expect(Config.tgvAlphaPreset(0)).toEqual(Config.TGV_ALPHA_PRESETS[1]);
      expect(Config.tgvAlphaPreset(9)).toEqual(Config.TGV_ALPHA_PRESETS[4]);
      expect(Config.tgvAlphaPreset(undefined)).toEqual(Config.TGV_ALPHA_PRESETS[2]);
    });

    test('PIPELINE_DEFAULTS leaves the alphas to the regularization level', () => {
      expect(PIPELINE_DEFAULTS.tgv.alpha0).toBeNull();
      expect(PIPELINE_DEFAULTS.tgv.alpha1).toBeNull();
      expect(PIPELINE_DEFAULTS.tgv.regularization).toBe(2);
    });
  });

  describe('STAGE_DISPLAY_NAMES', () => {
    test('should have all main stages', () => {
      expect(STAGE_DISPLAY_NAMES.magnitude).toBe('Magnitude');
      expect(STAGE_DISPLAY_NAMES.phase).toBe('Phase');
      expect(STAGE_DISPLAY_NAMES.mask).toBe('Mask');
      expect(STAGE_DISPLAY_NAMES.B0).toBe('B0 Field');
      expect(STAGE_DISPLAY_NAMES.final).toBe('QSM');
    });

    test('should have QSMART stages', () => {
      expect(STAGE_DISPLAY_NAMES.lfsStage1).toBe('LFS 1');
      expect(STAGE_DISPLAY_NAMES.chiStage1).toBe('χ1');
      expect(STAGE_DISPLAY_NAMES.vasculature).toBe('Vessels');
    });
  });

  describe('PIPELINE_DEFAULTS', () => {
    test('should have all algorithm settings', () => {
      expect(PIPELINE_DEFAULTS.combined_method).toBe('none');
      expect(PIPELINE_DEFAULTS.unwrapping_algorithm).toBe('romeo');
      expect(PIPELINE_DEFAULTS.bf_algorithm).toBe('vsharp');
      expect(PIPELINE_DEFAULTS.dipole_inversion).toBe('rts');
    });

    test('has a settings object for every selectable algorithm', () => {
      const methods = [
        ...PIPELINE_METHODS.combined.filter(m => m !== 'none'),
        ...PIPELINE_METHODS.bf_algorithm,
        ...PIPELINE_METHODS.dipole_inversion,
        ...PIPELINE_METHODS.qsmart_inversion,
      ];
      for (const m of methods) {
        expect([m, typeof PIPELINE_DEFAULTS[m]]).toEqual([m, 'object']);
      }
    });

    test('has no undefined values in algorithm settings', () => {
      for (const [name, value] of Object.entries(PIPELINE_DEFAULTS)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [key, v] of Object.entries(value)) {
          expect([name, key, v === undefined]).toEqual([name, key, false]);
        }
      }
    });

    test('leaves voxel-size-derived radii unset until voxel size is known', () => {
      expect(PIPELINE_DEFAULTS.vsharp.max_radius).toBeNull();
      expect(PIPELINE_DEFAULTS.vsharp.min_radius).toBeNull();
      expect(PIPELINE_DEFAULTS.ismv.radius).toBeNull();
      expect(PIPELINE_DEFAULTS.pdf.maxit).toBeNull();
    });
  });

  describe('getVoxelBasedDefaults', () => {
    test('should calculate V-SHARP radii for isotropic voxels', () => {
      const defaults = getVoxelBasedDefaults([1, 1, 1]);

      // maxRadius = 18 * min(vsz) = 18
      expect(defaults.vsharpMaxRadius).toBe(18);
      // minRadius = max(1, 2 * min(vsz)) = 2
      expect(defaults.vsharpMinRadius).toBe(2);
    });

    test('should calculate SHARP radius', () => {
      const defaults = getVoxelBasedDefaults([1, 1, 1]);
      // radius = 18 * min(vsz) = 18
      expect(defaults.sharpRadius).toBe(18);
    });

    test('should calculate iSMV radius', () => {
      const defaults = getVoxelBasedDefaults([1, 1, 1]);
      // radius = max(2, 2 * max(vsz)) = 2
      expect(defaults.ismv_radius).toBe(2);
    });

    test('anisotropic voxels follow QSM.jl: largest radius from the smallest voxel, smallest from the largest', () => {
      // QSM.jl sharp.jl: vsharp r = 18*minimum(vsz):-2*maximum(vsz):2*maximum(vsz),
      // sharp r = 18*minimum(vsz); ismv.jl r = 2*maximum(vsz).
      const defaults = getVoxelBasedDefaults([0.5, 0.5, 2]);

      expect(defaults.vsharpMaxRadius).toBe(9);
      expect(defaults.vsharpMinRadius).toBe(4);
      expect(defaults.sharpRadius).toBe(9);
      expect(defaults.ismv_radius).toBe(4);
    });

    test('the smallest V-SHARP radius never exceeds the largest', () => {
      // 18 * 0.3 = 5.4 mm is below 2 * 5 mm: one kernel at the largest radius remains.
      const defaults = getVoxelBasedDefaults([0.3, 0.3, 5]);

      expect(defaults.vsharpMaxRadius).toBe(5);
      expect(defaults.vsharpMinRadius).toBe(5);
    });

    test('LBV iterations default to the longest mask dimension', () => {
      expect(getVoxelBasedDefaults([1, 1, 1], [64, 192, 128]).lbvMaxit).toBe(192);
      expect(getVoxelBasedDefaults([1, 1, 1]).lbvMaxit).toBe(256);
    });

    test('should calculate PDF maxit from mask dimensions', () => {
      const maskDims = [100, 100, 100];  // 1M voxels
      const defaults = getVoxelBasedDefaults([1, 1, 1], maskDims);

      // maxit = ceil(sqrt(1000000)) = 1000
      expect(defaults.pdfMaxit).toBe(1000);
    });

    test('should use default mask size when not provided', () => {
      const defaults = getVoxelBasedDefaults([1, 1, 1], null);

      // Default mask of 100000 voxels: sqrt is 316.2, rounded up.
      expect(defaults.pdfMaxit).toBe(317);
    });

    test('should use default voxel size when not provided', () => {
      const defaults = getVoxelBasedDefaults();

      // Default [1, 1, 1]
      expect(defaults.vsharpMaxRadius).toBe(18);
    });
  });
});
