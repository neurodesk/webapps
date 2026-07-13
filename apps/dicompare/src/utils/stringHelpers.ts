/**
 * String helper utilities for the workspace.
 */

/**
 * Normalize a DICOM tag for comparison.
 * Removes parentheses, spaces, and commas, then converts to uppercase.
 *
 * @example
 * normalizeTag('(0008, 0018)') // => '00080018'
 * normalizeTag('0008,0018') // => '00080018'
 */
export function normalizeTag(tag: string | null | undefined): string {
  if (!tag) return '';
  return tag.replace(/[(), ]/g, '').toUpperCase();
}

/**
 * Escape HTML special characters to prevent XSS in generated HTML.
 *
 * @param str - Any value to escape (will be converted to string)
 * @returns HTML-safe string
 */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
