import { inferDataTypeFromField } from './datatypeInference';

describe('inferDataTypeFromField', () => {
  test('infers from value when present', () => {
    expect(inferDataTypeFromField({ value: [0, 5990, 30450] })).toBe('list_number');
    expect(inferDataTypeFromField({ value: 2.5 })).toBe('number');
    expect(inferDataTypeFromField({ value: 'SIEMENS' })).toBe('string');
  });

  test('infers list type from contains_any / contains_all when value is absent', () => {
    expect(inferDataTypeFromField({ contains_any: ['ASL', 'PERFUSION'] })).toBe('list_string');
    expect(inferDataTypeFromField({ contains_all: [0, 1000] })).toBe('list_number');
  });

  test('infers string from contains and number from min/max', () => {
    expect(inferDataTypeFromField({ contains: 'DERIVED' })).toBe('string');
    expect(inferDataTypeFromField({ min: 1, max: 3 })).toBe('number');
  });
});
