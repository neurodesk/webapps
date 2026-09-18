import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createConsole } from '../src/elements/console.js';
import { createInfoDialog, renderCommand } from '../src/ui/renderInfoDialog.js';
import { createFileField } from '../src/elements/file-field.js';
import { bindFileDrop } from '../src/ui/renderFileField.js';
import { bindInfoTooltips, renderInfoIcon } from '../src/ui/bindInfoTooltips.js';
import { createViewerToolbar } from '../src/elements/viewer-toolbar.js';
import { createResultList } from '../src/elements/result-list.js';
import { readFile } from 'node:fs/promises';

function dom(html = '<!doctype html><body></body>') {
  const instance = new JSDOM(html, { pretendToBeVisual: true });
  return instance.window.document;
}

test('sidebar grids let long result labels shrink within their available width', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.nd-imaging-controls \.nd-section-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('createFileField produces the shared scan picker contract', () => {
  const document = dom();
  const field = createFileField({ id: 'imageInput', text: 'Drop NIfTI or DICOM files' }, document);
  document.body.append(field);
  assert.equal(field.querySelector('label').className, 'nd-file');
  assert.equal(field.input.type, 'file');
  assert.equal(field.input.multiple, true);
  assert.equal(field.input.getAttribute('accept'), null, 'scan pickers must not filter filenames');
  assert.equal(field.input.dataset.neurodeskInput, 'image');
  assert.equal(field.querySelector('svg').namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(field.text.textContent, 'Drop NIfTI or DICOM files');
  const model = createFileField({ id: 'modelInput', kind: 'model', accept: '.onnx', multiple: false }, document);
  assert.equal(model.input.dataset.neurodeskInput, 'model');
  assert.equal(model.input.getAttribute('accept'), '.onnx');
  assert.equal(model.input.multiple, false);
});

test('bindFileDrop toggles the dragover state and forwards dropped files', async () => {
  const document = dom();
  const target = document.createElement('label');
  const received = [];
  bindFileDrop(target, (files) => received.push(files), document);
  const Event = document.defaultView.Event;
  const dragover = new Event('dragover', { cancelable: true });
  target.dispatchEvent(dragover);
  assert.equal(target.classList.contains('dragover'), true);
  assert.equal(dragover.defaultPrevented, true);
  target.dispatchEvent(new Event('dragleave'));
  assert.equal(target.classList.contains('dragover'), false);
  const file = new document.defaultView.File(['x'], 'scan.nii');
  const drop = new Event('drop', { cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { items: [], files: [file] } });
  target.dispatchEvent(drop);
  assert.equal(received.length, 1);
  assert.deepEqual(await received[0], [file]);
});

test('createConsole builds a collapsed, keyboard-accessible technical log with Copy and Clear', () => {
  const document = dom();
  const log = createConsole({ id: 'technicalLog' }, document);
  document.body.append(log);
  assert.equal(log.className, 'nd-console-container collapsed');
  assert.ok(log.hasAttribute('data-disclosure'));
  const toggle = log.querySelector('.nd-console-title');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(log.output.hidden, true);
  assert.deepEqual([...log.querySelectorAll('.nd-console-clear')].map((button) => button.textContent), ['Copy', 'Clear']);
  toggle.click();
  assert.equal(log.classList.contains('collapsed'), false);
  log.log('hello');
  assert.match(log.output.textContent, /hello/);
  log.querySelector('#technicalLogClear').click();
  assert.equal(log.output.textContent, '');
  log.close();
  log.log('failure', 'error');
  assert.equal(log.classList.contains('collapsed'), false, 'errors reveal the log');
});

test('createInfoDialog renders one centered dialog frame and swaps content', () => {
  const document = dom('<!doctype html><body><template id="about"><p>About text</p></template></body>');
  document.defaultView.HTMLDialogElement.prototype.showModal ??= function showModal() { this.setAttribute('open', ''); };
  document.defaultView.HTMLDialogElement.prototype.close ??= function close() { this.removeAttribute('open'); };
  const info = createInfoDialog({ id: 'info' }, document);
  assert.equal(info.root.parentElement, document.body);
  assert.equal(info.root.className, 'nd-dialog');
  assert.equal(info.root.getAttribute('aria-labelledby'), 'infoTitle');
  info.open('About', document.getElementById('about'));
  assert.equal(info.title.textContent, 'About');
  assert.equal(info.body.innerHTML.trim(), '<p>About text</p>');
  assert.equal(info.root.hasAttribute('open'), true);
  info.open('Standalone', '<pre>cmd</pre>', { wide: true });
  assert.equal(info.root.classList.contains('nd-dialog-wide'), true);
  assert.equal(info.body.querySelector('pre').textContent, 'cmd');
  info.root.querySelector('.nd-dialog-close').click();
  assert.equal(info.root.hasAttribute('open'), false);
  assert.equal(document.getElementById('about').content.querySelector('p').textContent, 'About text', 'templates are cloned, not consumed');
});

test('renderCommand exposes a copy button bound to its command', () => {
  const document = dom();
  const command = renderCommand({ id: 'run', command: 'synthsr in.nii out.nii' }, document);
  assert.equal(command.root.className, 'nd-command');
  assert.equal(command.code.textContent, 'synthsr in.nii out.nii');
  assert.equal(command.button.dataset.copyTarget, 'run');
});

test('bindInfoTooltips shows tooltips on focus and hides them on blur', () => {
  const document = dom();
  const icon = renderInfoIcon('Why this matters', { label: 'About the setting' }, document);
  document.body.append(icon);
  bindInfoTooltips(document);
  const tooltip = icon.querySelector('.nd-info-tooltip');
  assert.equal(tooltip.getAttribute('role'), 'tooltip');
  assert.equal(tooltip.hidden, true);
  assert.equal(icon.getAttribute('aria-describedby'), tooltip.id);
  icon.dispatchEvent(new document.defaultView.FocusEvent('focus'));
  assert.equal(tooltip.hidden, false);
  icon.dispatchEvent(new document.defaultView.FocusEvent('blur'));
  assert.equal(tooltip.hidden, true);
});

test('createViewerToolbar renders only the requested controls', () => {
  const document = dom();
  const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false }, document);
  assert.deepEqual([...toolbar.viewTabs.querySelectorAll('.nd-view-tab')].map((tab) => tab.textContent), ['3-Plane', 'Axial', 'Coronal', 'Sagittal', '3D']);
  assert.equal(toolbar.actions.children.length, 0);
  toolbar.setActive('axial');
  assert.deepEqual([...toolbar.viewTabs.querySelectorAll('.active')].map((tab) => tab.dataset.view), ['axial']);
  const full = createViewerToolbar({}, document);
  for (const id of ['windowMin', 'rangeMin', 'overlayOpacity', 'colormapSelect', 'downloadCurrentVolume', 'screenshotViewer']) {
    assert.ok(full.control(id), `${id} rendered by default`);
  }
});

test('createResultList uses visibility checkboxes only for toggleable results', () => {
  const document = dom('<!doctype html><body><div id="results"></div></body>');
  const changes = [];
  const results = createResultList({
    element: document.getElementById('results'),
    stageLabels: { surface: 'Left pial surface' },
    onVisibilityChange: (stage, visible) => changes.push([stage, visible]),
  });
  results.render({ surface: { visible: true }, report: {} });

  const checkbox = document.querySelector('input[type="checkbox"]');
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.getAttribute('aria-label'), 'Show Left pial surface');
  checkbox.click();
  assert.deepEqual(changes, [['surface', false]]);
  assert.equal(document.querySelectorAll('.nd-view-btn').length, 1);
});

test('imaging workspace provides a reusable three-panel viewer layout', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.nd-viewer-panel-grid\s*\{/);
  assert.match(css, /\.nd-viewer-panel-title\s*\{/);
  // Phones: the panels size the viewer (page scrolls) and switch to three columns in landscape.
  assert.match(css, /\.nd-viewer-canvas-wrapper \{ flex: none; min-height: 0; height: calc\(3 \* min\(100vw, 360px\)\); \}/);
  assert.match(css, /orientation: landscape\) \{\s*\.nd-imaging-viewer:has\([^)]*\) \.nd-viewer-canvas-wrapper \{ height: calc\(100vw \/ 3\); \}/);
});


test('download sections share visible separation and accessible disclosure targets', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.nd-dialog-section\s*\{[^}]*border: 1px solid var\(--nd-color-border\)/);
  assert.match(css, /\.nd-dialog-section \+ \.nd-dialog-section\s*\{[^}]*margin-top:/);
  assert.match(css, /\.nd-download-option summary\s*\{[^}]*min-height: 44px/);
});

test('select and input fields shrink within narrow control grids', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.nd-field > :is\(select, input\)\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
});


test('shared icon buttons reserve a 44px square on touch screens', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  const touchRules = css.slice(css.indexOf('@media (pointer: coarse), (max-width: 780px)'));
  assert.match(touchRules, /\.nd-btn-icon-sm\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
});

test('result selection and colour swatches use shared theme tokens', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /#controls \.nd-result-selected\s*\{[^}]*box-shadow: 0 0 0 2px var\(--nd-color-primary\)/);
  assert.match(css, /\.nd-result-swatch\s*\{[^}]*border: 1px solid var\(--nd-color-border\)/);
});

test('custom element hosts retain block layout in the shared stylesheet', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /nd-file-field,\s*nd-result-list,\s*nd-example-selector\s*\{\s*display: block;/);
});
