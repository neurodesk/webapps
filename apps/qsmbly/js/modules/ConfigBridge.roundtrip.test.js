/**
 * Round-trip buildConfigJson through the real qsmxt-config schema (#89).
 *
 * buildConfigJson is the seam between the UI's settings and qsmxt-config's PipelineConfig. Every
 * qsmxt-config struct is `#[serde(default)]` without `deny_unknown_fields`, so a key the schema
 * does not declare is dropped in silence and the default is used instead of the user's value.
 * Only the real schema can catch that, so this test loads the built WASM and checks that every
 * value buildConfigJson sends comes back out of config_json_to_toml_wasm.
 *
 * Needs the base WASM bundle in rust-wasm/pkg (`./build.sh --no-threads`, or
 * `wasm-pack build --target web --release --out-dir pkg` in rust-wasm/). Without it the suite
 * is skipped so plain `npm test` stays fast; set QSMBLY_REQUIRE_WASM=1 (as CI does after its
 * WASM build) to make a missing bundle a failure instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { buildConfigJson, maskSectionString } from './ConfigBridge.js';
import { PIPELINE_DEFAULTS } from '../app/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_JS = join(ROOT, 'rust-wasm', 'pkg', 'qsm_wasm.js');
const PKG_WASM = join(ROOT, 'rust-wasm', 'pkg', 'qsm_wasm_bg.wasm');
const HAVE_WASM = existsSync(PKG_JS) && existsSync(PKG_WASM);

if (!HAVE_WASM && process.env.QSMBLY_REQUIRE_WASM) {
  throw new Error(`QSMBLY_REQUIRE_WASM is set but ${PKG_JS} is missing; build the WASM first`);
}
if (!HAVE_WASM) {
  console.warn('Skipping the ConfigBridge WASM round trip: rust-wasm/pkg is not built '
    + '(run ./build.sh --no-threads, or wasm-pack build in rust-wasm/).');
}
const describeWasm = HAVE_WASM ? describe : describe.skip;
const SKIP_NOTE = HAVE_WASM ? '' : ' [SKIPPED: rust-wasm/pkg not built; run ./build.sh --no-threads]';

/** <option value> list of a <select id> in index.html — what the UI actually offers. */
const INDEX_HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
function selectOptions(id) {
  const m = INDEX_HTML.match(new RegExp(`<select[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (!m) throw new Error(`index.html has no <select id="${id}">`);
  return [...m[1].matchAll(/<option[^>]*\bvalue="([^"]*)"/g)].map(o => o[1]);
}

/**
 * Every setting moved off its default, so a value that falls back to the default cannot pass
 * by coincidence. Integers step by one (they may be usize/i32 in the schema), other numbers
 * scale, booleans flip. null stays null: PIPELINE_DEFAULTS uses it for "derive later".
 */
function perturb(value) {
  if (Array.isArray(value)) return value.map(perturb);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, perturb(v)]));
  }
  if (typeof value === 'number') return Number.isInteger(value) ? value + 1 : value * 1.5;
  if (typeof value === 'boolean') return !value;
  return value;
}

/** A settings object shaped like PipelineSettingsController.save() output. */
function userSettings(overrides = {}) {
  return {
    ...perturb(structuredClone(PIPELINE_DEFAULTS)),
    // Keep the toggles that switch whole sections off at their defaults; they get own tests.
    reference_mean: true,
    dl_tiling: { enabled: true, tile_size: 48, tile_halo: 6 },
    // save() always emits these, though PIPELINE_DEFAULTS leaves them null or absent.
    vsharp: { ...perturb(PIPELINE_DEFAULTS.vsharp), max_radius: 11, min_radius: 2 },
    ismv: { ...perturb(PIPELINE_DEFAULTS.ismv), radius: 3 },
    pdf: { ...perturb(PIPELINE_DEFAULTS.pdf), maxit: 120 },
    lbv: { ...perturb(PIPELINE_DEFAULTS.lbv), maxit: 600 },
    romeo: { ...perturb(PIPELINE_DEFAULTS.romeo), template: 2 },
    ...overrides,
  };
}

/** Leaf paths (a.b.c) and values of a JSON-able object; arrays are leaves. */
function leaves(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, path) : [[path, v]];
  });
}
const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * Equal, allowing a float to move by an ulp or so: serde_json's default float parser is not
 * correctly rounded, so 0.00045000000000000004 can come back as 0.00045. That is noise, not a
 * dropped setting.
 */
function same(a, b) {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-12 * Math.abs(a);
  return a === b;
}
const closeTo = (obj) => Object.fromEntries(Object.entries(obj).map(
  ([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? expect.closeTo(v, 15) : v]));

/**
 * Settings the UI offers that the pinned qsmxt-config schema has no field for. qsmbly uses them
 * when it runs the pipeline in the browser (the worker reads the settings directly), but the
 * exported command/TOML cannot carry them. Listed here so the gap is explicit, and so this test
 * starts failing — and the entry can go — once the schema grows the field.
 */
const NOT_IN_SCHEMA = ['bg_removal.pdf.maxit', 'bg_removal.lbv.maxit'];

describeWasm(`buildConfigJson round trip through qsmxt-config${SKIP_NOTE}`, () => {
  let wasm;

  beforeAll(async () => {
    // The threaded build's worker glue touches browser worker globals at import; stub them as
    // scripts/generate-defaults.mjs does. Nothing here starts a thread pool.
    if (typeof globalThis.self === 'undefined') {
      globalThis.self = globalThis;
      globalThis.addEventListener = () => {};
      globalThis.removeEventListener = () => {};
    }
    wasm = await import(PKG_JS);
    await wasm.default({ module_or_path: readFileSync(PKG_WASM) });
  });

  /** buildConfigJson -> config_json_to_toml_wasm -> parsed TOML, checking the TOML validates. */
  function roundTrip(settings, options = {}, maskSection = '') {
    const json = buildConfigJson(settings, options);
    const toml = wasm.config_json_to_toml_wasm(json, maskSection);
    expect(wasm.validate_config_wasm(toml)).toBe('');
    return { sent: JSON.parse(json), back: parseToml(toml) };
  }

  /** Paths whose sent value did not come back, as [path, sent, received]. */
  function lost(sent, back) {
    return leaves(sent)
      .filter(([path, v]) => !same(v, at(back, path)))
      .map(([path, v]) => [path, v, at(back, path)]);
  }

  test('the default UI settings are a valid config', () => {
    const { sent, back } = roundTrip(PIPELINE_DEFAULTS);
    expect(lost(sent, back)).toEqual([]);
  });

  test('every user-set value survives, for every algorithm section at once', () => {
    // to_toml writes every algorithm's parameter table, not only the selected one.
    const { sent, back } = roundTrip(userSettings(), { doSwi: true, doT2star: true, doR2star: true });
    expect(lost(sent, back).map(([path]) => path).sort()).toEqual([...NOT_IN_SCHEMA].sort());
  });

  test('values reach the schema field the UI meant, not just some field', () => {
    const s = userSettings();
    const { back } = roundTrip(s);
    // Fields whose UI name differs from the schema name, or that ConfigBridge reshapes.
    expect(back.inversion.nltv.newton_iter).toBe(s.nltv.newton_max_iter);
    expect(back.inversion.fansi).toMatchObject(closeTo(s.fansi));
    expect(back.field_mapping.phase_offset_sigma).toEqual(s.mcpc3ds.sigma);
    expect(back.field_mapping.linear_fit.reliability_threshold_percentile)
      .toBe(s.linearFit.reliability_threshold_percentile);
    expect(back.field_mapping.romeo.template).toBe(s.romeo.template);
    expect(back.inversion.qsmart.vasc_sphere_radius).toBe(s.qsmart.vasc_sphere_radius);
    expect(back.inversion.qsmart.inversion).toBe(s.qsmart.inversion_algorithm);
    expect(same(s.tfi.lambda, back.inversion.tfi.lambda)).toBe(true);
    expect(back.swi.hp_sigma).toEqual(s.swi.hp_sigma);
    expect(back.swi.mip_window).toBe(s.swi.mip_window);
  });

  test('FANSI-TGV parameters go to the fansi table when that method is chosen', () => {
    const s = userSettings({ dipole_inversion: 'fansitgv', fansitgv: { ...perturb(perturb(PIPELINE_DEFAULTS.fansi)) } });
    const { back } = roundTrip(s);
    expect(back.inversion.algorithm).toBe('fansi-tgv');
    expect(back.inversion.fansi).toMatchObject(closeTo(s.fansitgv));
  });

  describe('every algorithm the UI offers is accepted and selected', () => {
    test.each(selectOptions('bf_algorithm'))('background removal %s', (algorithm) => {
      const { back } = roundTrip(userSettings({ bf_algorithm: algorithm }));
      expect(back.bg_removal.algorithm).toBe(algorithm);
    });

    test.each(selectOptions('dipole_method'))('dipole inversion %s', (method) => {
      const { back } = roundTrip(userSettings({ dipole_inversion: method }));
      expect(back.inversion.algorithm).toBe(method === 'fansitgv' ? 'fansi-tgv' : method);
    });

    test.each(selectOptions('combined_method').filter(m => m !== 'none'))('combined method %s', (method) => {
      const { back } = roundTrip(userSettings({ combined_method: method }));
      expect(back.inversion.algorithm).toBe(method);
    });

    test('TGV carries the iterations and erosions the user set', () => {
      const s = userSettings({ combined_method: 'tgv', tgv: { regularization: 3, iterations: 777, erosions: 4 } });
      const { back } = roundTrip(s);
      expect(back.inversion.tgv).toMatchObject({ iterations: 777, erosions: 4 });
    });

    test.each(selectOptions('qsmartInversionMethod'))('QSMART inner inversion %s', (inner) => {
      const s = userSettings({ combined_method: 'qsmart' });
      s.qsmart.inversion_algorithm = inner;
      const { back } = roundTrip(s);
      expect(back.inversion.qsmart.inversion).toBe(inner);
    });

    test.each(selectOptions('unwrapping_algorithm'))('unwrapping %s', (algorithm) => {
      const { back } = roundTrip(userSettings({ unwrapping_algorithm: algorithm }));
      expect(back.field_mapping.unwrapping_algorithm).toBe(algorithm);
    });

    test.each(selectOptions('b0_estimation'))('B0 estimation %s', (method) => {
      const { back } = roundTrip(userSettings({ b0_estimation: method }));
      expect(back.field_mapping.b0_estimation).toBe(method.replace(/_/g, '-'));
    });

    test.each(selectOptions('b0_weight_type'))('B0 weighting %s', (type) => {
      const { back } = roundTrip(userSettings({ b0_weight_type: type }));
      expect(back.field_mapping.b0_weight_type).toBe(type.replace(/_/g, '-'));
    });

    test.each(selectOptions('tikhReg'))('Tikhonov regularization %s', (reg) => {
      const s = userSettings({ dipole_inversion: 'tikhonov' });
      s.tikhonov.reg = reg;
      expect(roundTrip(s).back.inversion.tikhonov.reg).toBe(reg);
    });

    test.each(selectOptions('sidebarSwiScaling'))('SWI scaling %s', (scaling) => {
      const s = userSettings();
      s.swi.scaling = scaling;
      expect(roundTrip(s, { doSwi: true }).back.swi.scaling).toBe(scaling.replace(/_/g, '-'));
    });
  });

  describe('masking sections', () => {
    const SOURCES = selectOptions('maskInputSource').filter(s => s !== 'custom');
    const INPUT = {
      first_echo: 'magnitude-first', last_echo: 'magnitude-last',
      combined: 'magnitude', phase_quality: 'phase-quality',
    };

    test.each(SOURCES)('mask source %s', (source) => {
      const { back } = roundTrip(userSettings(), {}, maskSectionString(['threshold:otsu'], source));
      expect(back.masking.sections).toHaveLength(1);
      expect(back.masking.sections[0].input).toBe(INPUT[source]);
    });

    // The op strings qsm-app-romeo.js records into maskOpsHistory.
    test.each([
      [['threshold:otsu', 'fill-holes:0', 'signal-erode'],
        { op: 'threshold', method: 'otsu' }, [{ op: 'fill-holes', max_size: 0 }, { op: 'signal-erode' }]],
      [['bet:0.35', 'erode:3'],
        { op: 'bet', fractional_intensity: 0.35 }, [{ op: 'erode', iterations: 3 }]],
      [['hd-bet:128x128x64:tta', 'dilate:2'],
        { op: 'hd-bet', patch: [128, 128, 64], tta: true }, [{ op: 'dilate', iterations: 2 }]],
      [['hd-bet:96x96x96'], { op: 'hd-bet', patch: [96, 96, 96], tta: false }, []],
    ])('ops %j', (ops, generator, refinements) => {
      const { back } = roundTrip(userSettings(), {}, maskSectionString(ops, 'combined'));
      const [section] = back.masking.sections;
      expect(section.generator).toMatchObject(generator);
      expect(section.refinements ?? []).toHaveLength(refinements.length);
      refinements.forEach((r, i) => expect(section.refinements[i]).toMatchObject(r));
    });
  });

  describe('null and NaN dropping', () => {
    // serde rejects null for a typed field — the whole config, and so the whole run, fails.
    test('a null scalar is fatal to the schema, which is why buildConfigJson drops it', () => {
      expect(() => wasm.config_json_to_toml_wasm('{"bg_removal":{"ismv":{"radius":null}}}', ''))
        .toThrow(/invalid type: null/);
    });

    test('blank numeric inputs fall back to the qsmxt-config defaults', () => {
      const defaults = JSON.parse(wasm.get_default_config_json_wasm());
      const s = userSettings({
        ismv: { radius: NaN, tol: null, max_iter: 77 },
        rts: { ...PIPELINE_DEFAULTS.rts, delta: NaN, mu: Infinity },
        mcpc3ds: { sigma: [NaN, 3, 3] },
        swi: { hp_sigma: [4, null, 0], scaling: 'tanh', strength: NaN, mip_window: 9 },
        linearFit: { reliability_threshold_percentile: NaN },
      });
      const { back } = roundTrip(s, { doSwi: true });

      expect(back.bg_removal.ismv).toEqual({ ...defaults.bg_removal.ismv, max_iter: 77 });
      expect(back.inversion.rts.delta).toBe(defaults.inversion.rts.delta);
      expect(back.inversion.rts.mu).toBe(defaults.inversion.rts.mu);
      expect(back.field_mapping.phase_offset_sigma).toEqual([4, 4, 4]);
      expect(back.swi.hp_sigma).toEqual(defaults.swi.hp_sigma);
      expect(back.swi.strength).toBe(defaults.swi.strength);
      expect(back.swi.mip_window).toBe(9);
      expect(back.field_mapping.linear_fit.reliability_threshold_percentile)
        .toBe(defaults.field_mapping.linear_fit.reliability_threshold_percentile);
    });

    test('PIPELINE_DEFAULTS placeholders (null radii) take the schema defaults', () => {
      const defaults = JSON.parse(wasm.get_default_config_json_wasm());
      const { back } = roundTrip(PIPELINE_DEFAULTS);
      expect(back.bg_removal.vsharp.max_radius).toBe(defaults.bg_removal.vsharp.max_radius);
      expect(back.bg_removal.ismv.radius).toBe(defaults.bg_removal.ismv.radius);
    });
  });

  test('section toggles survive', () => {
    const off = roundTrip(userSettings({ reference_mean: false, dl_tiling: { enabled: false } }), {}).back;
    expect(off.qsm.reference).toBe('none');
    expect(off.pipeline).toMatchObject({ do_qsm: true, do_swi: false, do_t2starmap: false, do_r2starmap: false });

    const dl = roundTrip(userSettings({ dipole_inversion: 'xqsm' })).back;
    expect(dl.inversion).toMatchObject({ algorithm: 'xqsm', tile_size: 48, tile_halo: 6 });
  });
});
