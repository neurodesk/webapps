/**
 * TgvParams Tests
 */
import { resolveTgvParams, resolveTgvAlphas } from './TgvParams.js';

describe('resolveTgvParams', () => {
  const defaultAlpha = (level) => [level * 0.001, level * 0.002];
  const defaultIterations = () => 1655;

  test('uses the user iteration count rather than the adaptive default', () => {
    const p = resolveTgvParams({ regularization: 2, iterations: 800 }, defaultAlpha, defaultIterations);
    expect(p.iterations).toBe(800);
  });

  test('falls back to the adaptive iteration count when unset or invalid', () => {
    expect(resolveTgvParams({}, defaultAlpha, defaultIterations).iterations).toBe(1655);
    expect(resolveTgvParams({ iterations: NaN }, defaultAlpha, defaultIterations).iterations).toBe(1655);
    expect(resolveTgvParams(null, defaultAlpha, defaultIterations).iterations).toBe(1655);
  });

  test('uses explicit alphas when both are set', () => {
    const p = resolveTgvParams(
      { regularization: 4, alpha0: 0.0015, alpha1: 0.0005 }, defaultAlpha, defaultIterations,
    );
    expect(p.alpha0).toBe(0.0015);
    expect(p.alpha1).toBe(0.0005);
  });

  test('derives alphas from the regularization level when they are unset', () => {
    const p = resolveTgvParams({ regularization: 3 }, defaultAlpha, defaultIterations);
    expect(p.alpha0).toBeCloseTo(0.003);
    expect(p.alpha1).toBeCloseTo(0.006);
  });

  test('defaults to regularization level 2', () => {
    const p = resolveTgvParams({}, defaultAlpha, defaultIterations);
    expect(p.alpha0).toBeCloseTo(0.002);
  });
});

describe('resolveTgvAlphas', () => {
  const defaultAlpha = (level) => [level * 0.001, level * 0.002];

  test('treats null alphas (the PIPELINE_DEFAULTS shape) as unset', () => {
    expect(resolveTgvAlphas({ regularization: 1, alpha0: null, alpha1: null }, defaultAlpha))
      .toEqual({ alpha0: 0.001, alpha1: 0.002 });
  });

  test('needs both alphas to override the level', () => {
    expect(resolveTgvAlphas({ regularization: 2, alpha0: 0.5 }, defaultAlpha))
      .toEqual({ alpha0: 0.002, alpha1: 0.004 });
  });
});
