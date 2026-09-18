import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createFileField, defineFileField } from '../src/elements/file-field.js';

function setup(html = '') {
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`);
  defineFileField(window);
  return window;
}

function drop(window, field, files) {
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  field.querySelector('label').dispatchEvent(event);
}

test('file field imports without browser globals', async () => {
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.HTMLElement, undefined);
  const module = await import('../src/elements/file-field.js?node-import');
  assert.equal(typeof module.defineFileField, 'function');
});

test('definition upgrades a disabled property assigned before registration', () => {
  const { window } = new JSDOM('<nd-file-field></nd-file-field>');
  const field = window.document.querySelector('nd-file-field');
  field.disabled = true;
  defineFileField(window);
  assert.equal(field.input.disabled, true);
  field.disabled = false;
  assert.equal(field.input.disabled, false);
});

test('declarative fields retain native semantics and independent identifiers', () => {
  const window = setup('<nd-file-field label="Scan" text="Choose scan"></nd-file-field><nd-file-field></nd-file-field>');
  const [first, second] = window.document.querySelectorAll('nd-file-field');
  assert.notEqual(first.input.id, second.input.id);
  assert.equal(first.querySelector('label').control, first.input);
  assert.equal(first.input.multiple, true);
  assert.equal(first.input.hasAttribute('accept'), false);
  assert.equal(first.input.dataset.neurodeskInput, 'image');
  assert.equal(first.input.getAttribute('aria-label'), 'Scan');
  first.setAttribute('label', 'Updated scan');
  assert.equal(first.input.getAttribute('aria-label'), 'Updated scan');
  first.setText('New instruction');
  assert.equal(first.text.textContent, 'New instruction');
});

test('factory preserves options, native input and content across DOM moves', () => {
  const window = setup();
  const field = createFileField({ id: 'model', rootId: 'modelField', kind: 'model', multiple: false, accept: '.json', html: '<strong>Model</strong>', directory: true }, window.document);
  window.document.body.append(field);
  const input = field.input;
  const files = [new window.File(['a'], 'model.json')];
  Object.defineProperty(input, 'files', { value: files });
  field.setHasFiles(true);
  field.remove();
  window.document.body.append(field);
  assert.equal(field.input, input);
  assert.equal(field.input.files, files);
  assert.equal(field.id, 'modelField');
  assert.equal(input.id, 'model');
  assert.equal(input.multiple, false);
  assert.equal(input.accept, '.json');
  assert.equal(input.hasAttribute('webkitdirectory'), true);
  assert.equal(field.text.innerHTML, '<strong>Model</strong>');
  assert.equal(field.querySelector('label').classList.contains('has-files'), true);
});

test('picker and drops emit once, isolate instances, disable together and clean up on removal', async () => {
  const window = setup();
  const first = createFileField({}, window.document);
  const second = createFileField({}, window.document);
  window.document.body.append(first, second);
  const received = [];
  let secondCalls = 0;
  let eventCalls = 0;
  first.onFiles(files => received.push(files));
  second.onFiles(() => secondCalls++);
  first.addEventListener('nd-files', event => {
    eventCalls++;
    assert.ok(event.detail.files instanceof Promise);
  });
  const files = [new window.File(['a'], 'scan.nii')];
  Object.defineProperty(first.input, 'files', { value: files });
  first.input.dispatchEvent(new window.Event('change'));
  first.remove();
  drop(window, first, files);
  window.document.body.append(first);
  drop(window, first, files);
  assert.equal(received.length, 2);
  assert.deepEqual(await received[1], files);
  assert.equal(eventCalls, 2);
  assert.equal(secondCalls, 0);
  first.disabled = true;
  assert.equal(first.input.disabled, true);
  first.input.dispatchEvent(new window.Event('change'));
  drop(window, first, files);
  assert.equal(received.length, 2);
  first.disabled = false;
  drop(window, first, files);
  assert.equal(received.length, 3);
});

test('folder transfer entries expand before delivery', async () => {
  const window = setup();
  const field = createFileField({}, window.document);
  window.document.body.append(field);
  let pending;
  field.onFiles(files => { pending = files; });
  const file = new window.File(['slice'], 'DICOM');
  const entry = { isFile: true, file: resolve => resolve(file) };
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { items: [{ webkitGetAsEntry: () => entry }] } });
  field.querySelector('label').dispatchEvent(event);
  assert.deepEqual(await pending, [file]);
});

test('text and label changes preserve a directly disabled native picker', () => {
  const window = setup();
  const field = createFileField({}, window.document);
  window.document.body.append(field);
  field.input.disabled = true;
  field.setText('loaded.nii');
  field.setAttribute('label', 'Replacement scan');
  assert.equal(field.input.disabled, true);
  let calls = 0;
  field.onFiles(() => calls++);
  drop(window, field, [new window.File(['a'], 'scan.nii')]);
  assert.equal(calls, 0);
  field.disabled = true;
  field.disabled = false;
  assert.equal(field.input.disabled, false);
});

test('file selection events cross a containing shadow root', () => {
  const window = setup();
  const container = window.document.createElement('div');
  const shadow = container.attachShadow({ mode: 'open' });
  const field = createFileField({}, window.document);
  shadow.append(field);
  window.document.body.append(container);
  let calls = 0;
  window.document.addEventListener('nd-files', () => calls++);
  drop(window, field, [new window.File(['a'], 'scan.nii')]);
  assert.equal(calls, 1);
});

test('HTML instructions supply the accessible name unless a label is explicit', () => {
  const window = setup();
  const inferred = createFileField({ kind: 'model', html: '<strong>Choose a model</strong>' }, window.document);
  const explicit = createFileField({ kind: 'model', html: '<strong>Choose a model</strong>', label: 'Model weights' }, window.document);
  window.document.body.append(inferred, explicit);
  assert.equal(inferred.input.getAttribute('aria-label'), 'Choose a model');
  assert.equal(explicit.input.getAttribute('aria-label'), 'Model weights');
});
