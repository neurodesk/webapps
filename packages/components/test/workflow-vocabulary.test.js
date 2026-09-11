import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderConsole } from '../src/ui/renderConsole.js';
import { createInfoDialog, renderCommand } from '../src/ui/renderInfoDialog.js';
import { renderFileField, bindFileDrop } from '../src/ui/renderFileField.js';
import { bindInfoTooltips, renderInfoIcon } from '../src/ui/bindInfoTooltips.js';
import { renderViewerToolbar } from '../src/ui/renderViewerToolbar.js';
import { readFile } from 'node:fs/promises';

function dom(html = '<!doctype html><body></body>') {
  const instance = new JSDOM(html, { pretendToBeVisual: true });
  return instance.window.document;
}

test('renderFileField produces the shared scan picker contract', () => {
  const document = dom();
  const field = renderFileField({ id: 'imageInput', text: 'Drop NIfTI or DICOM files' }, document);
  document.body.append(field.root);
  assert.equal(field.root.className, 'nd-file');
  assert.equal(field.input.type, 'file');
  assert.equal(field.input.multiple, true);
  assert.equal(field.input.getAttribute('accept'), null, 'scan pickers must not filter filenames');
  assert.equal(field.input.dataset.neurodeskInput, 'image');
  assert.equal(field.root.querySelector('svg').namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(field.text.textContent, 'Drop NIfTI or DICOM files');
  const model = renderFileField({ id: 'modelInput', kind: 'model', accept: '.onnx', multiple: false }, document);
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

test('renderConsole builds a collapsed, keyboard-accessible technical log with Copy and Clear', () => {
  const document = dom();
  const log = renderConsole({ id: 'technicalLog' }, document);
  document.body.append(log.root);
  assert.equal(log.root.className, 'nd-console-container collapsed');
  assert.ok(log.root.hasAttribute('data-disclosure'));
  const toggle = log.root.querySelector('.nd-console-title');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(log.output.hidden, true);
  assert.deepEqual([...log.root.querySelectorAll('.nd-console-clear')].map((button) => button.textContent), ['Copy', 'Clear']);
  toggle.click();
  assert.equal(log.root.classList.contains('collapsed'), false);
  log.log('hello');
  assert.match(log.output.textContent, /hello/);
  log.root.querySelector('#technicalLogClear').click();
  assert.equal(log.output.textContent, '');
  log.close();
  log.log('failure', 'error');
  assert.equal(log.root.classList.contains('collapsed'), false, 'errors reveal the log');
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

test('renderViewerToolbar renders only the requested controls', () => {
  const document = dom();
  const toolbar = renderViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false }, document);
  assert.deepEqual([...toolbar.viewTabs.querySelectorAll('.nd-view-tab')].map((tab) => tab.textContent), ['3-Plane', 'Axial', 'Coronal', 'Sagittal', '3D']);
  assert.equal(toolbar.actions.children.length, 0);
  toolbar.setActive('axial');
  assert.deepEqual([...toolbar.viewTabs.querySelectorAll('.active')].map((tab) => tab.dataset.view), ['axial']);
  const full = renderViewerToolbar({}, document);
  for (const id of ['windowMin', 'rangeMin', 'overlayOpacity', 'colormapSelect', 'downloadCurrentVolume', 'screenshotViewer']) {
    assert.ok(full.root.querySelector(`#${id}`), `${id} rendered by default`);
  }
});

test('imaging workspace provides a reusable three-panel viewer layout', async () => {
  const css = await readFile(new URL('../src/styles/imaging-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.nd-viewer-panel-grid\s*\{/);
  assert.match(css, /\.nd-viewer-panel-title\s*\{/);
});
