/**
 * ScanParams Tests
 */
import { requireFieldStrength, echoTimeDependentStep, fieldMapEchoTimes } from './ScanParams.js';

describe('requireFieldStrength', () => {
  test('returns a positive field strength', () => {
    expect(requireFieldStrength(7)).toBe(7);
    expect(requireFieldStrength('3.0')).toBe(3);
  });

  test.each([null, undefined, 0, -3, NaN, 'abc'])('rejects %p instead of defaulting', (b0) => {
    expect(() => requireFieldStrength(b0)).toThrow(/field strength/);
  });
});

describe('echoTimeDependentStep', () => {
  test('TGV and MEDI depend on the echo time', () => {
    expect(echoTimeDependentStep({ combined_method: 'tgv' })).toBe('TGV');
    expect(echoTimeDependentStep({ dipole_inversion: 'medi' })).toBe('MEDI');
    expect(echoTimeDependentStep({ combined_method: 'qsmart', qsmart: { inversion_algorithm: 'medi' } }))
      .toMatch(/MEDI/);
  });

  test('other algorithms do not', () => {
    expect(echoTimeDependentStep({ dipole_inversion: 'rts' })).toBeNull();
    expect(echoTimeDependentStep({ combined_method: 'qsmart' })).toBeNull();
    // TFI replaces the dipole inversion, so a leftover MEDI selection is irrelevant.
    expect(echoTimeDependentStep({ combined_method: 'tfi', dipole_inversion: 'medi' })).toBeNull();
    expect(echoTimeDependentStep(undefined)).toBeNull();
  });
});

describe('fieldMapEchoTimes', () => {
  test('uses the first echo time, in seconds', () => {
    expect(fieldMapEchoTimes([20, 30], 'TGV')).toEqual([0.02]);
  });

  test('is empty when nothing needs a TE and none was given', () => {
    expect(fieldMapEchoTimes([], null)).toEqual([]);
    expect(fieldMapEchoTimes(undefined, null)).toEqual([]);
  });

  test('reports a missing TE instead of assuming one', () => {
    expect(() => fieldMapEchoTimes([], 'MEDI')).toThrow(/MEDI needs the echo time/);
  });
});
