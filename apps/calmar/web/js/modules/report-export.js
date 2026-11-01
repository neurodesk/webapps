// Report export: the Results view, or the parts of it the user ticks, as one
// self-contained HTML document that prints to PDF (the browser's print
// dialog) or downloads as a file. Nothing leaves the browser.
//
// The document is built by cloning the live report sections, so it shows
// exactly what the user saw, with every fold opened (finding rows, "Show all"
// rows, details), the interactive controls removed and citation links kept.
// Viewer images (the 3-plane crosshair on the lesion, with or without the
// mask) are captured by the app from the NiiVue canvas and passed in as
// data URLs.

/** The report's selectable parts, in reading order. `selectors` are resolved inside #resultsReport;
 *  a part with `requires` is included only when that selector matches (the stage produced a result). */
export const REPORT_PARTS = Object.freeze([
  { id: 'method', label: 'Method summary', selectors: ['#resultsMethod'], default: true },
  { id: 'image', label: 'Lesion image (3-plane crosshair)', selectors: [], default: true },
  { id: 'overlap', label: 'Direct lesion overlap', selectors: ['#outsideAtlasWarning', 'section[aria-label="Direct lesion overlap"]', '#directFunctionProfileResults'], requires: '#networkOverlapTable tbody tr', default: true },
  { id: 'network', label: 'Connectivity-map effects', selectors: ['#networkThresholdSummary', '#affectedNetworkResults'], requires: '#affectedNetworkResults:not(.hidden)', default: true },
  { id: 'measures', label: 'Lesion size: what the evidence says', selectors: ['#kbReportHeading', '#kbMeasuresResults'], default: true },
  { id: 'location', label: 'Lesion location: what the evidence says', selectors: ['#kbLocationResults'], default: true },
  { id: 'whiteMatter', label: 'White-matter disconnection', selectors: ['#kbWhiteMatterResults'], default: true },
  { id: 'therapy', label: 'Therapy evidence', selectors: ['#kbTherapyResults'], default: true },
  { id: 'provenance', label: 'Provenance and caveats', selectors: ['#kbReportProvenance'], default: true },
]);

export const IMAGE_OPTIONS = Object.freeze([
  { id: 'with-mask', label: 'With the lesion mask' },
  { id: 'without-mask', label: 'Without the mask' },
  { id: 'both', label: 'Both' },
]);

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A printable clone of a live report node: folds opened, controls removed, hidden rows shown. */
export function printableClone(node) {
  const clone = node.cloneNode(true);
  for (const element of clone.querySelectorAll('[hidden]')) element.removeAttribute('hidden');
  for (const element of clone.querySelectorAll('.hidden')) element.classList.remove('hidden');
  for (const element of clone.querySelectorAll('details')) element.setAttribute('open', '');
  for (const element of clone.querySelectorAll('.nd-info-icon, button, .kb-fold-row, .overlap-fold-row, .overlap-bar')) element.remove();
  for (const element of clone.querySelectorAll('[tabindex]')) element.removeAttribute('tabindex');
  if (clone.hasAttribute('hidden')) clone.removeAttribute('hidden');
  clone.classList.remove('hidden');
  return clone;
}

/** A rendered part: a table with rows, or text beyond its heading. */
function hasContent(node) {
  const tables = node.querySelectorAll('table');
  if (tables.length) return [...tables].some((table) => table.querySelector('tbody tr'));
  const clone = node.cloneNode(true);
  for (const heading of clone.querySelectorAll('.nd-report-heading')) heading.remove();
  return clone.textContent.trim().length > 0;
}

/**
 * The selected parts of the live report as `{ id, label, html }`, skipping
 * parts whose sections are absent or empty (a section that was never shown).
 */
export function collectReportParts(doc, selected, { root = '#resultsReport' } = {}) {
  const report = doc.querySelector(root);
  if (!report) return [];
  const parts = [];
  for (const part of REPORT_PARTS) {
    if (!selected.includes(part.id) || !part.selectors.length) continue;
    if (part.requires && !report.querySelector(part.requires)) continue;
    const nodes = part.selectors.map((selector) => report.querySelector(selector)).filter(Boolean)
      .filter((node) => !node.classList.contains('hidden') && hasContent(node));
    if (!nodes.length) continue;
    parts.push({ id: part.id, label: part.label, html: nodes.map((node) => printableClone(node).outerHTML).join('\n') });
  }
  return parts;
}

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 28px; font: 11pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1c1c24; background: #fff; }
  header.report-header { border-bottom: 2px solid #1f3a5f; padding-bottom: 8px; margin-bottom: 16px; }
  header.report-header h1 { margin: 0 0 4px; font-size: 18pt; color: #1f3a5f; }
  header.report-header p { margin: 0; color: #555; font-size: 9.5pt; }
  section.report-part { margin: 0 0 20px; break-inside: avoid-page; }
  section.report-part > h2 { font-size: 13pt; color: #1f3a5f; border-bottom: 1px solid #c9d2df; padding-bottom: 3px; margin: 18px 0 8px; }
  .nd-report-heading { display: none; }
  h3 { font-size: 11.5pt; margin: 12px 0 4px; }
  h4 { font-size: 10.5pt; margin: 10px 0 4px; }
  p { margin: 0 0 6px; }
  .nd-report-notes, .secondary { color: #555; font-size: 9pt; }
  .nd-message.warning { padding: 6px 10px; border-left: 3px solid #c77700; background: #fff6e5; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 4px 0 10px; page-break-inside: auto; }
  th, td { text-align: left; vertical-align: top; padding: 3px 6px; border-bottom: 1px solid #dde3ea; }
  th { background: #eef2f7; font-weight: 600; }
  tr { break-inside: avoid; }
  .nd-numeric { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .kb-findings-row > td { padding: 0 6px 8px 18px; border-bottom: 1px solid #c9d2df; }
  .kb-findings > summary, details > summary { font-weight: 600; cursor: default; list-style: none; }
  article.kb-finding { margin: 6px 0 8px; padding-left: 8px; border-left: 2px solid #c9d2df; }
  article.kb-finding.kb-draft { border-left-color: #b7791f; }
  .kb-draft-badge { font-size: 8pt; font-weight: 600; color: #7a4d00; border: 1px solid #b7791f; border-radius: 8px; padding: 0 4px; }
  blockquote.kb-passage { margin: 4px 0 6px 10px; padding-left: 8px; border-left: 2px solid #aab; color: #333; font-size: 9pt; }
  code { font: 9pt "SF Mono", Consolas, monospace; }
  a { color: #1f3a5f; }
  .report-images { display: grid; grid-template-columns: 1fr; gap: 10px; }
  .report-images figure { margin: 0; break-inside: avoid; }
  .report-images img { width: 100%; max-height: 420px; object-fit: contain; background: #000; border: 1px solid #c9d2df; }
  .report-images figcaption { font-size: 9pt; color: #555; margin-top: 3px; }
  .overlap-pct { font-variant-numeric: tabular-nums; }
  @page { margin: 14mm 12mm; }
  @media print { body { padding: 0; } section.report-part > h2 { break-after: avoid; } }
`;

/**
 * One self-contained HTML document from the selected parts.
 * `images`: [{ label, dataUrl }] placed where the 'image' part sits.
 */
export function buildReportDocument({ title = 'CALMaR report', subtitle = '', parts = [], images = [], generated = new Date() } = {}) {
  const when = generated instanceof Date ? generated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : String(generated);
  const body = [];
  for (const part of REPORT_PARTS) {
    if (part.id === 'image') {
      if (!images.length) continue;
      body.push(`<section class="report-part" data-part="image"><h2>${escapeHtml(part.label)}</h2><div class="report-images">`
        + images.map((image) => `<figure><img src="${image.dataUrl}" alt="${escapeHtml(image.label)}"><figcaption>${escapeHtml(image.label)}</figcaption></figure>`).join('')
        + '</div></section>');
      continue;
    }
    const found = parts.find((p) => p.id === part.id);
    if (!found) continue;
    body.push(`<section class="report-part" data-part="${part.id}"><h2>${escapeHtml(found.label)}</h2>${found.html}</section>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="report-header">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(subtitle)}${subtitle ? ' · ' : ''}generated ${escapeHtml(when)} · research use only, not a diagnosis · processed in the browser; no data left this computer</p>
</header>
${body.join('\n')}
</body>
</html>
`;
}

/**
 * Print an HTML document through a hidden same-origin iframe (the browser's
 * dialog offers "Save as PDF"). Resolves when the dialog has closed; the
 * iframe is removed afterwards. Rejects when printing is unavailable.
 */
export function printHtmlDocument(doc, html, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const frame = doc.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;';
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      frame.remove();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    frame.addEventListener('load', () => {
      if (done) return;
      try {
        const win = frame.contentWindow;
        if (!win || typeof win.print !== 'function') throw new Error('printing is not available in this browser');
        win.addEventListener('afterprint', () => setTimeout(() => finish(), 50));
        win.focus();
        win.print();
      } catch (error) {
        finish(error);
      }
    }, { once: true });
    frame.srcdoc = html;
    doc.body.appendChild(frame);
  });
}
