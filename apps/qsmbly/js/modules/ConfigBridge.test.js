/**
 * Tests for the mask-section string handed to qsmxt (`--mask <section>`).
 */

import { maskSectionString, buildConfigJson } from './ConfigBridge.js';

describe('maskSectionString', () => {
  test('returns empty for no ops', () => {
    expect(maskSectionString([], 'combined')).toBe('');
    expect(maskSectionString(null, 'combined')).toBe('');
  });

  test('maps the mask source to the qsmxt input name', () => {
    expect(maskSectionString(['threshold:otsu'], 'combined')).toBe('magnitude,threshold:otsu');
    expect(maskSectionString(['threshold:otsu'], 'phase_quality')).toBe('phase-quality,threshold:otsu');
    expect(maskSectionString(['bet:0.50'], 'first_echo')).toBe('magnitude-first,bet:0.50');
  });

  test('passes HD-BET through with its patch size', () => {
    // The browser runs qsm-core's low-memory patch; qsmxt parses `hd-bet:128x128x64` back to
    // exactly those HdBetParams, so the printed command reproduces what the UI just did.
    expect(maskSectionString(['hd-bet:128x128x64'], 'combined'))
      .toBe('magnitude,hd-bet:128x128x64');
    expect(maskSectionString(['hd-bet:128x128x64', 'signal-erode', 'erode:2'], 'combined'))
      .toBe('magnitude,hd-bet:128x128x64,signal-erode,erode:2');
  });

  test('passes signal-gated erosion through in order', () => {
    // qsmxt parses a bare `signal-erode` as qsm-core's defaults (the QSM-CI setting).
    expect(maskSectionString(['bet:0.50', 'signal-erode'], 'combined'))
      .toBe('magnitude,bet:0.50,signal-erode');
    expect(maskSectionString(['threshold:otsu', 'fill-holes:0', 'signal-erode', 'erode:2'], 'combined'))
      .toBe('magnitude,threshold:otsu,fill-holes:0,signal-erode,erode:2');
  });
});

/**
 * Background-removal parameter fields as declared by the pinned qsmxt-config
 * schema (crates/qsmxt-config/src/config.rs, v9.18.1):
 *
 *   param_config!(VsharpConfig  { threshold, max_radius, min_radius });
 *   param_config!(PdfConfig     { tol });
 *   param_config!(LbvConfig     { tol });
 *   param_config!(IsmvConfig    { tol, max_iter, radius });
 *   param_config!(SharpConfig   { threshold, radius });
 *   param_config!(ResharpConfig { radius, tik_reg, tol, max_iter });
 *   param_config!(HarperellaConfig { radius, max_iter, tol });
 *
 * Every one of these derives `#[serde(default)]` with no `deny_unknown_fields`,
 * so a key the schema does not declare is dropped in silence and the qsm-core
 * default is used instead of the user's setting. Nothing at runtime reports it.
 */
const BG_REMOVAL_SCHEMA = {
  vsharp: ['threshold', 'max_radius', 'min_radius'],
  pdf: ['tol'],
  lbv: ['tol'],
  ismv: ['tol', 'max_iter', 'radius'],
  sharp: ['threshold', 'radius'],
  resharp: ['radius', 'tik_reg', 'tol', 'max_iter'],
  harperella: ['radius', 'max_iter', 'tol'],
  iharperella: ['radius', 'max_iter', 'tol'],
};

/** A settings object shaped like PipelineSettingsController.save() output. */
function settingsFixture(overrides = {}) {
  return {
    combined_method: 'none',
    bf_algorithm: 'ismv',
    dipole_inversion: 'rts',
    vsharp: { max_radius: 12, min_radius: 1, threshold: 0.2 },
    sharp: { radius: 9, threshold: 0.07 },
    ismv: { radius: 4, tol: 1e-5, max_iter: 123 },
    pdf: { tol: 1e-5 },
    lbv: { tol: 1e-6 },
    resharp: { radius: 6, tik_reg: 1e-4, tol: 1e-6, max_iter: 30 },
    harperella: { radius: 10, max_iter: 20, tol: 1e-6 },
    iharperella: { radius: 10, max_iter: 20, tol: 1e-6 },
    ...overrides,
  };
}

describe('buildConfigJson background-removal parameters', () => {
  test('emits only fields the qsmxt-config schema declares', () => {
    const bg = JSON.parse(buildConfigJson(settingsFixture())).bg_removal;

    for (const [algorithm, fields] of Object.entries(BG_REMOVAL_SCHEMA)) {
      const sent = bg[algorithm];
      if (!sent) continue;
      expect({ [algorithm]: Object.keys(sent).sort() })
        .toEqual({ [algorithm]: [...fields].sort() });
    }
  });

  test('carries user-set iSMV values through to the schema field names', () => {
    const bg = JSON.parse(buildConfigJson(settingsFixture())).bg_removal;

    expect(bg.ismv).toEqual({ radius: 4, tol: 1e-5, max_iter: 123 });
  });

  test('carries the user-set SHARP radius, not just the threshold', () => {
    const bg = JSON.parse(buildConfigJson(settingsFixture())).bg_removal;

    expect(bg.sharp).toEqual({ radius: 9, threshold: 0.07 });
  });

  test('omits a blank numeric input rather than sending null', () => {
    // serde rejects null for a typed field; omitting it falls back to the default.
    const bg = JSON.parse(buildConfigJson(
      settingsFixture({ ismv: { radius: null, tol: 1e-5, max_iter: NaN } }),
    )).bg_removal;

    expect(bg.ismv).toEqual({ tol: 1e-5 });
  });
});
