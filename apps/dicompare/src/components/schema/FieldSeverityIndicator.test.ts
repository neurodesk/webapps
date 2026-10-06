import { describe, test, expect } from 'vitest';
import { isColumnReferenceOnly } from './FieldSeverityIndicator';

describe('isColumnReferenceOnly', () => {
  test('every series reference-only marks the column reference-only', () => {
    expect(isColumnReferenceOnly(['warning', 'warning'])).toBe(true);
  });

  test('a single requiring series makes the column a requirement', () => {
    expect(isColumnReferenceOnly(['warning', 'error'])).toBe(false);
    expect(isColumnReferenceOnly(['warning', undefined])).toBe(false);
  });

  test('omitted severity is a requirement', () => {
    expect(isColumnReferenceOnly([undefined, undefined])).toBe(false);
    expect(isColumnReferenceOnly(['error'])).toBe(false);
  });

  test('a field no series defines is not reference-only', () => {
    expect(isColumnReferenceOnly([])).toBe(false);
  });
});
