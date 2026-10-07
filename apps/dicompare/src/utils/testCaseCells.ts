/**
 * Helpers for the validation-function test-case grid, where each cell holds one
 * row's value for one field. A cell may be a scalar or — for list-valued fields
 * like DiffusionBValues — a list, which is stored as a real array so it
 * round-trips to a tuple in dicompare (matching real validation).
 */

/**
 * Parse a single token into a number when it looks numeric, otherwise keep it as
 * a trimmed string.
 */
export function parseCellToken(token: string): number | string {
  const t = token.trim();
  if (t === '') return '';
  const n = Number(t);
  return !isNaN(n) ? n : t;
}

/**
 * Parse a cell's raw text into its stored value. A bracketed ("[0, 1000]") or
 * bare comma-separated ("1,1") input becomes a real array (a list-valued cell);
 * anything else is a scalar.
 */
export function parseCellInput(inputValue: string): number | string | Array<number | string> {
  const trimmed = inputValue.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(parseCellToken);
  }
  if (inputValue.includes(',')) {
    return inputValue.split(',').map(parseCellToken);
  }
  return parseCellToken(inputValue);
}

/**
 * Format a stored cell value back into display text. Arrays render with brackets
 * ("[0, 6000, 30000]"); scalars render as-is.
 */
export function formatCellValue(value: any): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return value != null ? String(value) : '';
}
