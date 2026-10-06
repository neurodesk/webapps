import { formatRangeConstraint, formatFieldDisplay, formatSeriesFieldValue } from './fieldFormatters';

describe('formatRangeConstraint', () => {
  test('renders a two-sided range as "min to max"', () => {
    expect(formatRangeConstraint(5, 8)).toBe('5 to 8');
  });

  test('renders one-sided bounds with inequality signs', () => {
    expect(formatRangeConstraint(5, undefined)).toBe('≥ 5');
    expect(formatRangeConstraint(undefined, 8)).toBe('≤ 8');
  });

  test('survives negative bounds without reading as arithmetic', () => {
    expect(formatRangeConstraint(-5, 8)).toBe('-5 to 8');
  });

  test('reports an unset range rather than an empty string', () => {
    expect(formatRangeConstraint(undefined, undefined)).toBe('range (not set)');
  });
});

describe('range vs list display', () => {
  // The reason ranges moved off interval notation: both formatted as "[5, 8]",
  // so a range was indistinguishable from a two-element list at a glance.
  test('a range and a two-element list no longer look the same', () => {
    const range = formatFieldDisplay(undefined, { type: 'range', min: 5, max: 8 }, {
      showValue: true,
      showConstraint: true,
    });
    const list = formatFieldDisplay([5, 8], { type: 'exact', value: [5, 8] }, {
      showValue: true,
      showConstraint: true,
    });

    expect(range).toBe('5 to 8');
    expect(list).toBe('[5, 8]');
    expect(range).not.toBe(list);
  });

  // No bundled schema carries a series-level range, so the series table's
  // formatting can't be checked by loading one — pin it here instead.
  test('series cells format ranges the same way as acquisition fields', () => {
    expect(formatSeriesFieldValue(undefined, { type: 'range', min: 5, max: 8 })).toBe('5 to 8');
    expect(formatSeriesFieldValue([5, 8])).toBe('[5, 8]');
  });
});
