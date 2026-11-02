#!/usr/bin/env node
// The report export (web/js/modules/report-export.js) and the Method
// paragraph (lnm-app describeMethod / renderMethodSummary):
//   * printableClone opens every fold and strips the interactive controls;
//   * collectReportParts picks the ticked parts of the live report in reading
//     order and skips empty or hidden sections;
//   * buildReportDocument writes one self-contained HTML document with the
//     parts, the images and the research-use framing, citation links kept;
//   * printHtmlDocument prints through a hidden iframe and removes it;
//   * the app's Method paragraph names the models and atlases the run used,
//     changes with the mask's origin, and the Download report button follows
//     the Results view's availability; exportReport builds the document from
//     the ticked boxes and captures images only when asked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(join(root, 'web/index.html'), 'utf8');
const kb = JSON.parse(readFileSync(join(root, 'web/models/annotations/aphasia-kb.json'), 'utf8'));
const parity = JSON.parse(readFileSync(join(root, 'tests/fixtures/kb-parity/kb-parity.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'web/models/manifest.json'), 'utf8'));

const { REPORT_PARTS, printableClone, collectReportParts, buildReportDocument, printHtmlDocument } = await import('../web/js/modules/report-export.js');
const { evaluateDamage, renderKbReport } = await import('../web/js/modules/kb-report.js');
const { bindPatientBehavior } = await import('../web/js/modules/patient-behavior.js');

{
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const context = bindPatientBehavior(doc);
  const notes = doc.getElementById('patientBehaviorNotes');
  notes.value = 'Difficulty naming objects. <img src=x onerror=alert(1)>';
  notes.dispatchEvent(new dom.window.Event('input'));
  const fields = doc.querySelectorAll('#patientBehaviorAssessments input');
  fields[0].value = 'Naming assessment';
  fields[1].value = '12/60';
  fields[2].value = '2026-11-02';
  fields[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const report = doc.getElementById('patientBehaviorReport');
  assert.equal(report.hidden, false);
  assert.equal(report.querySelector('img'), null, 'clinical text is never parsed as HTML');
  const parts = collectReportParts(doc, ['behavior']);
  assert.equal(parts.length, 1);
  assert.ok(parts[0].html.includes('12/60'));
  doc.getElementById('includePatientBehavior').checked = false;
  context.render();
  assert.deepEqual(collectReportParts(doc, ['behavior']), []);
  assert.ok(notes.value.includes('Difficulty naming'), 'opting out preserves context');
  context.reset();
  assert.equal(notes.value, '');
  assert.equal(report.hidden, true);
  const table = doc.createElement('table');
  table.innerHTML = '<thead><tr><th><button data-column-label="Lesion %">Lesion % ↓</button></th></tr></thead>';
  assert.equal(printableClone(table).querySelector('th').textContent, 'Lesion %');
}

// --- Parts, clones and the document ------------------------------------------
{
  const dom = new JSDOM(html);
  const { document } = dom.window;
  assert.deepEqual(REPORT_PARTS.map((p) => p.id), ['behavior', 'method', 'image', 'overlap', 'network', 'measures', 'location', 'whiteMatter', 'therapy', 'provenance']);
  for (const part of REPORT_PARTS) {
    for (const selector of part.selectors) assert.ok(document.querySelector(selector), `${part.id}: ${selector} exists in index.html`);
  }
  // Nothing rendered yet: every part is hidden or empty, so nothing is collected.
  assert.deepEqual(collectReportParts(document, REPORT_PARTS.map((p) => p.id)), []);

  const fractions = Object.fromEntries(Object.entries(parity.disconnectome.arcuate_cut.fractions).map(([k, v]) => [k, v === null ? NaN : v]));
  const result = evaluateDamage(kb, parity.cases.left_perisylvian.input, { fractions, lesionVolumeMl: 27.3 });
  renderKbReport(document, result, { kb, context: { measured: ['HarvardOxford', 'AAL'], unmeasured: [], missingAtlases: ['JHU', 'XTRACT'], disconnectomeNote: 'Disconnectome: ENIGMA.' } });
  document.getElementById('resultsMethod').classList.remove('hidden');
  document.getElementById('resultsMethodText').textContent = 'This run performed, in this browser: 1) a step.';

  const location = document.getElementById('kbLocationResults');
  const foldedBefore = location.querySelectorAll('tr[hidden], details:not([open])').length;
  assert.ok(foldedBefore > 0, 'the live section has folded rows and closed details');
  const clone = printableClone(location);
  assert.equal(clone.querySelectorAll('[hidden], details:not([open]), button, .nd-info-icon, .kb-fold-row').length, 0, 'the clone is fully opened and has no controls');
  assert.ok(clone.querySelector('a[href^="https://doi.org/"]'), 'citation DOI links survive');
  assert.equal(location.querySelectorAll('tr[hidden], details:not([open])').length, foldedBefore, 'the live report is untouched');

  const parts = collectReportParts(document, ['method', 'location', 'therapy', 'overlap']);
  assert.deepEqual(parts.map((p) => p.id), ['method', 'location', 'therapy'], 'empty sections (no overlap table yet) are skipped; order is the report order');
  assert.ok(parts[1].html.includes('kb-region-table'));

  const built = buildReportDocument({
    title: 'CALMaR report', subtitle: 'CALMaR test', parts,
    images: [{ label: 'With mask', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
    generated: new Date('2026-10-26T10:00:00Z'),
  });
  assert.match(built, /^<!doctype html>/);
  assert.ok(built.includes('<title>CALMaR report</title>'));
  assert.ok(built.includes('generated 2026-10-26 10:00 UTC'));
  assert.ok(built.includes('research use only, not a diagnosis'));
  assert.ok(built.includes('no data left this computer'));
  const order = ['data-part="method"', 'data-part="image"', 'data-part="location"', 'data-part="therapy"'].map((m) => built.indexOf(m));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'parts appear in reading order with the image after the method');
  assert.ok(built.includes('src="data:image/png;base64,iVBORw0KGgo="'));
  assert.ok(built.includes('href="https://doi.org/'), 'DOI links are kept in the document');
  assert.ok(!built.includes('nd-info-icon'), 'no tooltips in the document');
  assert.ok(!/<script/i.test(built), 'the document carries no script');
  const noImage = buildReportDocument({ parts, images: [] });
  assert.ok(!noImage.includes('data-part="image"'), 'no image section without images');

  // Printing: a hidden iframe whose window prints, then is removed.
  const printed = [];
  const win = dom.window;
  const originalCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = originalCreate(tag);
    if (tag === 'iframe') {
      Object.defineProperty(node, 'contentWindow', { value: { print: () => printed.push('print'), focus() {}, addEventListener(type, fn) { if (type === 'afterprint') setTimeout(fn, 0); } } });
      setTimeout(() => node.dispatchEvent(new win.Event('load')), 0);
    }
    return node;
  };
  await printHtmlDocument(document, built);
  assert.deepEqual(printed, ['print']);
  assert.equal(document.querySelector('iframe'), null, 'the print frame is removed afterwards');
  document.createElement = originalCreate;
}

// --- The app: Method paragraph, button state, export --------------------------
{
  const dom = new JSDOM(html, { url: 'http://localhost:8080/' });
  for (const name of ['window', 'document', 'HTMLElement', 'customElements', 'Event', 'Node', 'MutationObserver', 'File']) {
    globalThis[name] = dom.window[name];
  }
  globalThis.niivue = { SHOW_RENDER: { NEVER: 0, AUTO: 2 }, Niivue: class {} };
  globalThis.Worker = class { postMessage() {} terminate() {} };
  const { LesionNetworkMappingApp } = await import('../web/js/lnm-app.js');
  const app = Object.create(LesionNetworkMappingApp.prototype);
  Object.assign(app, {
    manifest, overlapResult: null, networkMapFile: null, mniLesionFile: null, brainmaskFile: null, nativeBrainmaskFile: null,
    structuralFromDiffusion: null, maskOrigin: null, kbReport: null, knowledgeBase: null, viewerView: 'multiplanar', maskReviewActive: false,
    nv: null, viewerController: null, viewerLayerVisibility: {}, _resultsGeneration: 0,
    getAtlasOption: () => manifest.atlasOptions[0],
    resultsViewAvailable() { return Boolean(this.overlapResult) && !this.maskReviewActive; },
    setViewerView() {}, updateOutput() {},
  });
  const method = document.getElementById('resultsMethod');
  const button = document.getElementById('downloadReportButton');
  app.refreshResultsView();
  assert.equal(button.disabled, true, 'no report to download before a result');
  assert.ok(method.classList.contains('hidden'), 'no Method paragraph before a result');

  app.overlapResult = { atlasOption: manifest.atlasOptions[0], summary: { networks: [] } };
  app.brainmaskFile = { name: 'mask' };
  app.maskOrigin = 'synthstroke';
  app.mniLesionFile = { name: 'mni' };
  app.networkMapFile = { name: 'map' };
  app.refreshResultsView();
  assert.equal(button.disabled, false, 'a result enables Download report');
  const text = document.getElementById('resultsMethodText').textContent;
  assert.ok(!method.classList.contains('hidden'));
  assert.equal(method.querySelector('details').open, false);
  assert.equal(method.querySelectorAll('ol > li').length, 5);
  assert.match(text, /^This run performed, in this browser and without uploading any data: brain extraction .*SynthStrip \(SynthStrip-Hoopes2022-Apache-2\.0\)/);
  assert.match(text, /an automatic lesion seed from SynthStroke \(SynthStroke-baseline-MELBA2025-MIT, 8-axis test-time augmentation\) on the T1, reviewed and confirmed by the user/);
  assert.match(text, /registration to MNI space .*SynthMorph/);
  assert.match(text, /direct overlap of the warped mask with the Schaefer 400 parcels atlas/);
  assert.match(text, /a lesion-network map .*development_fmri-N155.*thresholded to the strongest 5% of voxels by \|t\| with clusters below 30 voxels removed/);
  assert.match(text, /not a diagnosis or a prediction for this person/);
  assert.ok(!text.includes('knowledge-base report'), 'no KB step before the KB stage ran');

  app.maskOrigin = 'uploaded';
  app.knowledgeBase = { kb };
  app.kbReport = { context: { measured: ['HarvardOxford', 'AAL'], missingAtlases: ['JHU', 'XTRACT'] }, fractions: { a: 1 } };
  app.renderMethodSummary();
  const text2 = document.getElementById('resultsMethodText').textContent;
  assert.match(text2, /an uploaded lesion mask, reviewed and confirmed by the user/);
  assert.match(text2, /the knowledge-base report: the warped mask measured on HarvardOxford and AAL .*\(JHU, XTRACT not hosted in this build\), and scored against the ENIGMA tractography atlas with nii2tvx/);
  assert.match(text2, new RegExp(`${kb.version.findings} findings from ${kb.version.papers} papers, approved entries`));

  app.maskOrigin = 'atlas-grid';
  app.mniLesionFile = null;
  app.brainmaskFile = null;
  app.renderMethodSummary();
  assert.match(document.getElementById('resultsMethodText').textContent, /^This run performed, [^:]+: a lesion mask supplied already on the atlas grid/);

  // exportReport: ticked boxes decide the parts; the image is captured only when ticked; HTML download goes through the app's download path.
  const downloads = [];
  app.triggerBrowserDownload = async (file, filename) => { downloads.push({ filename, size: file.size }); };
  let captured = 0;
  app.captureLesionImages = (mode) => { captured += 1; return [{ label: `image ${mode}`, dataUrl: 'data:image/png;base64,AAAA' }]; };
  const tbody = document.querySelector('#networkOverlapTable tbody');
  tbody.innerHTML = '<tr><td>LH_Label_1</td><td class="nd-numeric">10</td><td class="nd-numeric">100.0%</td></tr>';
  for (const box of document.querySelectorAll('#reportParts [data-report-part]')) box.checked = ['method', 'image', 'overlap'].includes(box.dataset.reportPart);
  document.querySelector('#reportImageOptions input[value="both"]').checked = true;
  const exported = await app.exportReport('html');
  assert.equal(captured, 1);
  assert.deepEqual(downloads.map((d) => d.filename.startsWith('calmar-report-') && d.filename.endsWith('.html')), [true]);
  assert.ok(exported.includes('data-part="method"') && exported.includes('data-part="image"') && exported.includes('data-part="overlap"'));
  assert.ok(!exported.includes('data-part="location"'), 'unticked parts stay out');
  assert.ok(exported.includes('image both'));
  document.querySelector('#reportParts [data-report-part="image"]').checked = false;
  await app.exportReport('html');
  assert.equal(captured, 1, 'no capture when the image is unticked');
  app.overlapResult = null;
  assert.equal(await app.exportReport('html'), null, 'no report without a result');
  assert.equal(document.getElementById('reportModalStatus').textContent, 'Run an analysis first.');
}

console.log('report-export OK: parts, printable clones, the standalone document, printing, the Method paragraph and the export flow checked.');
