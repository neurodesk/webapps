/**
 * DlTiling Tests
 */
import { clampTileConfig, MAX_WASM_PATCH_EDGE } from './DlTiling.js';

describe('clampTileConfig', () => {
  test('leaves a config that fits unchanged', () => {
    expect(clampTileConfig(56, 4)).toEqual({ core: 56, halo: 4, clamped: false });
    // Exactly at the limit: 120 + 2·4 = 128.
    expect(clampTileConfig(120, 4)).toEqual({ core: 120, halo: 4, clamped: false });
  });

  test('shrinks the core, not the halo, when the patch is too big', () => {
    // The settings modal used to allow cores up to 192.
    expect(clampTileConfig(192, 4)).toEqual({ core: 120, halo: 4, clamped: true });
    // qsm-core's native default (144³ patches).
    expect(clampTileConfig(128, 8)).toEqual({ core: 112, halo: 8, clamped: true });
  });

  test('reduces the halo only when it leaves no room for a core', () => {
    const c = clampTileConfig(56, 60);
    expect(c.clamped).toBe(true);
    expect(c.core).toBeGreaterThanOrEqual(16);
    expect(c.core + 2 * c.halo).toBe(MAX_WASM_PATCH_EDGE);
  });

  test('every clamped config fits', () => {
    for (let core = 16; core <= 256; core += 8) {
      for (const halo of [0, 4, 8, 16, 32, 64]) {
        const c = clampTileConfig(core, halo);
        expect(c.core + 2 * c.halo).toBeLessThanOrEqual(MAX_WASM_PATCH_EDGE);
        expect(c.core).toBeGreaterThan(0);
      }
    }
  });
});
