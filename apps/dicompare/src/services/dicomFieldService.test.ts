import { describe, test, expect, beforeEach, vi } from 'vitest';
import { searchDicomFields } from './dicomFieldService';

// Force the offline/fallback path so the test never depends on the Innolitics
// network fetch. The registry merge is applied to the fallback list too, so
// derived fields must still appear.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

describe('derived fields in the field suggestion service', () => {
  test('suggests a derived field (no DICOM tag) by keyword', async () => {
    const results = await searchDicomFields('CoilCombinationMethod', 5);
    const coil = results.find(f => f.keyword === 'CoilCombinationMethod');

    expect(coil).toBeDefined();
    expect(coil!.fieldType).toBe('derived');
    expect(coil!.tag).toBe('');                       // no official DICOM tag
    expect(coil!.valueType).toBe('string');
    // Enum vocabulary carried through from the single source of truth.
    expect(coil!.vocabulary).toContain('Sum of Squares');
    expect(coil!.vocabulary).toContain('Adaptive Combine');
  });

  test('suggests a numeric derived field with its registry type', async () => {
    const results = await searchDicomFields('NumberOfDiffusionShells', 5);
    const shells = results.find(f => f.keyword === 'NumberOfDiffusionShells');

    expect(shells).toBeDefined();
    expect(shells!.fieldType).toBe('derived');
    expect(shells!.valueType).toBe('number');
  });

  test('still returns official DICOM fields', async () => {
    const results = await searchDicomFields('EchoTime', 5);
    expect(results.some(f => f.keyword === 'EchoTime')).toBe(true);
  });
});
