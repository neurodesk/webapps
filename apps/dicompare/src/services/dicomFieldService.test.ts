import { describe, test, expect, afterEach, vi } from 'vitest';
import { searchDicomFields } from './dicomFieldService';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('../data/fieldRegistry.json');
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


describe('field list request lifecycle', () => {
  test('coalesces concurrent requests and caches the bundled registry without fetching', async () => {
    vi.resetModules();
    const fetch = vi.fn().mockRejectedValue(new Error('No network allowed'));
    vi.stubGlobal('fetch', fetch);
    const { fetchDicomFieldList } = await import('./dicomFieldService');
    const [first, second] = await Promise.all([fetchDicomFieldList(), fetchDicomFieldList()]);
    expect(first).toBe(second);
    expect(first.some(field => field.keyword === 'EchoTime')).toBe(true);
    expect(await fetchDicomFieldList()).toBe(first);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects registry enrichment failures and permits retry', async () => {
    vi.resetModules();
    const primary = new Error('registry enrichment failed');
    let broken = true;
    vi.doMock('../data/fieldRegistry.json', () => ({ default: {
      DerivedField: { valueType: 'string', get tag() { if (broken) throw primary; return undefined; } },
    } }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchDicomFieldList } = await import('./dicomFieldService');
    await expect(fetchDicomFieldList()).rejects.toBe(primary);
    broken = false;
    const fields = await fetchDicomFieldList();
    expect(fields.some(field => field.keyword === 'EchoTime')).toBe(true);
  });
});
