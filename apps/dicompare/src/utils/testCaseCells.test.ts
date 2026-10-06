import { parseCellInput, formatCellValue } from './testCaseCells';

describe('test-case cell parsing/formatting', () => {
  test('parses scalars', () => {
    expect(parseCellInput('66')).toBe(66);
    expect(parseCellInput('SIEMENS')).toBe('SIEMENS');
    expect(parseCellInput('')).toBe('');
  });

  test('parses bracketed and bare list cells into arrays', () => {
    expect(parseCellInput('[0, 6000, 30000]')).toEqual([0, 6000, 30000]);
    expect(parseCellInput('1,1')).toEqual([1, 1]);
    expect(parseCellInput('[]')).toEqual([]);
  });

  test('formats arrays with brackets and scalars as-is', () => {
    expect(formatCellValue([0, 6000, 30000])).toBe('[0, 6000, 30000]');
    expect(formatCellValue(66)).toBe('66');
    expect(formatCellValue(undefined)).toBe('');
  });

  test('format -> parse round-trips a completed list cell and is stable', () => {
    // The real invariant: a fully-typed value survives display <-> store both
    // ways. (Partial mid-edit text is handled by the draft display in the
    // component, which never re-formats until blur — that is why backspacing no
    // longer accumulates "[" brackets.)
    const stored = [0, 6000, 30000];
    const displayed = formatCellValue(stored);
    expect(parseCellInput(displayed)).toEqual(stored);
    expect(formatCellValue(parseCellInput(displayed))).toBe(displayed);
  });
});
