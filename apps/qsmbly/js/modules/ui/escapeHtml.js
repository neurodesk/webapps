const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for interpolation into an HTML string, as element content or a quoted attribute.
 *
 * File names come from dcm2niix, which derives them from the DICOM SeriesDescription, so they
 * are untrusted input. Prefer textContent where the markup is built with the DOM.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
