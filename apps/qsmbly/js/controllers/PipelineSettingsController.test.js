/**
 * PipelineSettingsController against a DOM stub built from the real index.html: every control
 * save() reads must exist, and settings must survive open() -> save() unchanged.
 */

import { installIndexHtmlDom } from '../test/indexHtmlDom.js';
import { PipelineSettingsController } from './PipelineSettingsController.js';
import { PIPELINE_DEFAULTS, QSMART_DEFAULTS, TFI_DEFAULTS, getVoxelBasedDefaults } from '../app/config.js';

// What the app hands open()/reset() for a 1 mm isotropic scan.
const VOXEL_DEFAULTS = getVoxelBasedDefaults([1, 1, 1]);

const modal = () => ({
  querySelector: () => null,
  querySelectorAll: () => [],
  classList: { add() {}, remove() {} },
  // open()/close() go through the dialog focus helper.
  contains: () => false,
  hasAttribute: () => true,
  setAttribute() {},
  focus() {},
});

let dom;
let controller;
beforeEach(() => {
  dom = installIndexHtmlDom();
  controller = new PipelineSettingsController(modal());
});
afterEach(() => dom.restore());

/** Integers step by one, other numbers double, booleans flip; strings and nulls stay. */
function perturb(value) {
  if (Array.isArray(value)) return value.map(perturb);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, perturb(v)]));
  }
  if (typeof value === 'number') return Number.isInteger(value) ? value + 1 : value * 2;
  if (typeof value === 'boolean') return !value;
  return value;
}

/** Settings as save() produces them, with every value moved off its default. */
function userSettings() {
  controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
  const s = perturb(controller.save(4));
  // A non-default choice for every <select>; each must be an <option> index.html offers.
  Object.assign(s, {
    combined_method: 'qsmart', bf_algorithm: 'pdf', dipole_inversion: 'medi',
    unwrapping_algorithm: 'romeo', phase_offset_method: 'mcpc3ds', bipolar_correction: true,
    b0_estimation: 'linear_fit', b0_weight_type: 'mag',
  });
  s.qsmart.inversion_algorithm = 'nltv';
  s.qsmart.tikhonov.reg = 'gradient';
  s.tikhonov.reg = 'laplacian';
  s.swi.scaling = 'negative_tanh';
  s.romeo.individual = false;
  s.romeo.template = 2;
  // Fixed by save(), not user-settable: put them back.
  s.tfi = { ...TFI_DEFAULTS, lambda: s.tfi.lambda, precond: s.tfi.precond };
  s.harperella.tol = 1e-6;
  s.iharperella.tol = 1e-6;
  Object.assign(s.medi, { cg_tol: 0.01, tol: 0.1, data_weighting: 1 });
  s.tgv.regularization = 3; // a <select> with options 1-4
  return s;
}

describe('PipelineSettingsController.save', () => {
  test('reads only controls that index.html renders', () => {
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    dom.missing.clear();
    controller.save(4);
    controller.save(1);
    expect([...dom.missing]).toEqual([]);
  });

  test('open() then save() returns the settings it was given', () => {
    const settings = userSettings();
    controller.open(structuredClone(settings), VOXEL_DEFAULTS, 4, true);
    expect(controller.save(4)).toEqual(settings);
  });

  test('a plain open and save keeps the qsm-core QSMART defaults', () => {
    // index.html's static QSMART values differ from QSMART_DEFAULTS (e.g. SDF sigma 2 is 0
    // there, 10 in qsm-core); the form used to keep them, so saving changed the parameters.
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    const { qsmart } = controller.save(4);
    const { inversion_algorithm, ...fields } = QSMART_DEFAULTS;
    expect(qsmart).toMatchObject(fields);
    expect(qsmart.inversion_algorithm).toBe(inversion_algorithm);
  });

  test('reset() and opening the defaults agree', () => {
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    const opened = controller.save(4);
    controller.open(userSettings(), VOXEL_DEFAULTS, 4, true);
    controller.reset(VOXEL_DEFAULTS);
    const reset = controller.save(4);
    // Known difference, left as is: reset() derives the SHARP radius from voxel size, while
    // PIPELINE_DEFAULTS carries qsm-core's fixed radius.
    expect(reset.sharp.radius).toBe(VOXEL_DEFAULTS.sharpRadius);
    expect(opened.sharp.radius).toBe(PIPELINE_DEFAULTS.sharp.radius);
    expect({ ...reset, sharp: opened.sharp }).toEqual(opened);
  });

  test('fills voxel-derived radii when the settings leave them unset', () => {
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    const s = controller.save(4);
    expect(s.vsharp).toMatchObject({
      max_radius: VOXEL_DEFAULTS.vsharpMaxRadius, min_radius: VOXEL_DEFAULTS.vsharpMinRadius });
    expect(s.ismv.radius).toBe(VOXEL_DEFAULTS.ismv_radius);
    expect(s.pdf.maxit).toBe(VOXEL_DEFAULTS.pdfMaxit);
  });

  test('single-echo data has no phase-offset removal or bipolar correction', () => {
    controller.open(userSettings(), VOXEL_DEFAULTS, 1, true);
    const s = controller.save(1);
    expect(s.phase_offset_method).toBe('none');
    expect(s.bipolar_correction).toBe(false);
    expect(s.romeo.phase_gradient_coherence).toBe(true);
  });

  test('Laplacian unwrapping turns off phase-offset removal and bipolar correction', () => {
    controller.open({ ...userSettings(), unwrapping_algorithm: 'laplacian' }, VOXEL_DEFAULTS, 4, true);
    const s = controller.save(4);
    expect(s.unwrapping_algorithm).toBe('laplacian');
    expect(s.phase_offset_method).toBe('none');
    expect(s.bipolar_correction).toBe(false);
  });

  test('bipolar correction needs at least three echoes', () => {
    controller.open(userSettings(), VOXEL_DEFAULTS, 2, true);
    expect(controller.save(2).bipolar_correction).toBe(false);
  });

  test('a blank DL tile halo falls back to 4, but 0 is kept', () => {
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    dom.elements.get('dlTileHalo').value = '';
    expect(controller.save(4).dl_tiling.tile_halo).toBe(4);
    dom.elements.get('dlTileHalo').value = '0';
    expect(controller.save(4).dl_tiling.tile_halo).toBe(0);
  });

  test('a blank SWI input falls back to the SWI default', () => {
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    dom.elements.get('sidebarSwiStrength').value = '';
    dom.elements.get('sidebarSwiHpSigmaY').value = '';
    const swi = controller.save(4).swi;
    expect(swi.strength).toBe(PIPELINE_DEFAULTS.swi.strength);
    expect(swi.hp_sigma[1]).toBe(PIPELINE_DEFAULTS.swi.hp_sigma[1]);
  });
});

describe('PipelineSettingsController.updateVisibility', () => {
  const shown = (id) => {
    const el = dom.elements.get(id);
    return !el.hidden && el.style.display !== 'none';
  };

  test('hides dipole inversion for the combined methods, which invert internally', () => {
    controller.open(structuredClone(PIPELINE_DEFAULTS), VOXEL_DEFAULTS, 4, true);
    expect(shown('dipoleInversionSection')).toBe(true);
    for (const method of ['tgv', 'qsmart', 'tfi']) {
      dom.elements.get('combined_method').value = method;
      controller.updateVisibility(4);
      expect(shown('dipoleInversionSection')).toBe(false);
    }
  });

  test('shows only the selected background-removal and inversion parameters', () => {
    controller.open({ ...structuredClone(PIPELINE_DEFAULTS), bf_algorithm: 'ismv', dipole_inversion: 'tkd' },
      VOXEL_DEFAULTS, 4, true);
    expect(shown('ismv_settings')).toBe(true);
    expect(shown('vsharp_settings')).toBe(false);
    expect(shown('tkd_settings')).toBe(true);
    expect(shown('rts_settings')).toBe(false);
  });
});
