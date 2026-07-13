#!/usr/bin/env node

import assert from 'node:assert/strict';

// FileIOController imports DicomController which dynamically imports the dcm2niix
// WASM module on demand. We never trigger that path in these tests (no DICOM
// inputs go through), so we can import FileIOController directly and stub the
// document/File globals that its constructor and helpers touch.

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  toggle(c, force) {
    const shouldAdd = force === undefined ? !this.classes.has(c) : !!force;
    if (shouldAdd) this.add(c);
    else this.remove(c);
    return shouldAdd;
  }
  contains(c) { return this.classes.has(c); }
}

function makeStubElement() {
  const element = {
    classList: new FakeClassList(),
    className: '',
    _innerHTML: '',
    textContent: '',
    value: '',
    type: '',
    title: '',
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(event, handler) { this.listeners[event] = handler; },
    click() { this.listeners.click?.(); },
    setAttribute(name, value) { this[name] = value; },
    querySelector() { return { textContent: '' }; }
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    }
  });
  return element;
}

function installFakeDom() {
  const elements = new Map();
  const ensure = (id) => {
    if (!elements.has(id)) elements.set(id, makeStubElement());
    return elements.get(id);
  };
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: () => makeStubElement(),
    _ensure: ensure,
    _elements: elements
  };
  // Pre-create the elements FileIOController touches.
  ensure('inputDropZone');
  ensure('fileList');
  ensure('fileInput');
  return elements;
}

function makeFile(name) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/octet-stream' });
}

const elements = installFakeDom();

const { FileIOController } = await import('../web/js/controllers/FileIOController.js');

// Test 1: NIfTI single-file path
{
  const log = [];
  const loaded = [];
  const ctl = new FileIOController({
    updateOutput: (m) => log.push(m),
    onFileLoaded: (f) => loaded.push(f.name)
  });

  ctl.handleFiles([makeFile('scan.nii.gz')]);
  assert.equal(ctl.hasValidData(), true);
  assert.equal(ctl.getActiveFile().name, 'scan.nii.gz');
  assert.deepEqual(loaded, ['scan.nii.gz']);
  assert.ok(log.some(m => m.includes('scan.nii.gz')), 'logs the loaded filename');
  assert.equal(elements.get('inputDropZone').classList.contains('has-files'), true);
}

// Test 2: empty/null inputs are no-ops
{
  const ctl = new FileIOController({});
  ctl.handleFiles([]);
  ctl.handleFiles(null);
  ctl.handleDropItems([]);
  ctl.handleDropItems(null);
  assert.equal(ctl.hasValidData(), false);
  assert.equal(ctl.getActiveFile(), null);
}

// Test 3: NIfTI detection keeps all NIfTI files as comparable sessions and
// activates the first new session for processing.
{
  const loaded = [];
  const ctl = new FileIOController({
    onFileLoaded: (file, context) => loaded.push([file.name, context.session.id])
  });
  ctl.handleFiles([
    makeFile('readme.txt'),
    makeFile('scan_a.nii.gz'),
    makeFile('scan_b.nii'),
    makeFile('extra.dcm')
  ]);
  assert.equal(ctl.getSessions().length, 2);
  assert.equal(ctl.getActiveFile().name, 'scan_a.nii.gz');
  assert.deepEqual(loaded.map(item => item[0]), ['scan_a.nii.gz']);

  const secondSession = ctl.getSessions()[1];
  ctl.activateSession(secondSession.id);
  assert.equal(ctl.getActiveFile().name, 'scan_b.nii');
  assert.deepEqual(loaded.map(item => item[0]), ['scan_a.nii.gz', 'scan_b.nii']);
}

// Test 4: clearFiles resets state and DOM
{
  const ctl = new FileIOController({});
  ctl.handleFiles([makeFile('scan.nii')]);
  assert.equal(ctl.hasValidData(), true);
  ctl.clearFiles();
  assert.equal(ctl.hasValidData(), false);
  assert.equal(ctl.getActiveFile(), null);
  assert.deepEqual(ctl.getSessions(), []);
  assert.equal(elements.get('inputDropZone').classList.contains('has-files'), false);
  assert.equal(elements.get('fileInput').value, '');
}

// Test 5: non-NIfTI list dispatches to DICOM controller (we observe via the
// updateOutput message and confirm state was *not* set on FileIOController).
{
  const log = [];
  const ctl = new FileIOController({ updateOutput: (m) => log.push(m) });
  // Stub out the dicom dispatch so we don't load WASM.
  let dicomCalled = false;
  ctl.dicomController.convertFiles = async () => { dicomCalled = true; };

  ctl.handleFiles([makeFile('image1.dcm'), makeFile('image2.dcm')]);
  assert.equal(dicomCalled, true, 'DICOM converter was invoked');
  assert.equal(ctl.hasValidData(), false, 'no NIfTI file loaded yet');
  assert.ok(log.some(m => m.includes('DICOM input')), 'logs DICOM detection');
}

// Test 6: handleDropItems with a NIfTI item routes through handleFiles
{
  const ctl = new FileIOController({});
  const file = makeFile('drop.nii.gz');
  const dataTransfer = [{ getAsFile: () => file }];
  ctl.handleDropItems(dataTransfer);
  assert.equal(ctl.getActiveFile().name, 'drop.nii.gz');
}

// Test 7: handleDropItems without NIfTI files goes to DICOM
{
  const ctl = new FileIOController({});
  let dropDicomCalled = false;
  ctl.dicomController.convertDropItems = async () => { dropDicomCalled = true; };
  ctl.handleDropItems([{ getAsFile: () => makeFile('img.dcm') }]);
  assert.equal(dropDicomCalled, true);
  assert.equal(ctl.hasValidData(), false);
}

// Test 8: removing the active session promotes a remaining session and removing
// the last session clears state.
{
  const cleared = [];
  const loaded = [];
  const ctl = new FileIOController({
    onFileLoaded: (file) => loaded.push(file.name),
    onFilesCleared: () => cleared.push(true)
  });
  ctl.handleFiles([makeFile('first.nii.gz'), makeFile('second.nii.gz')]);
  assert.equal(ctl.getActiveFile().name, 'first.nii.gz');

  ctl.removeSession(ctl.getActiveSession().id);
  assert.equal(ctl.getActiveFile().name, 'second.nii.gz');
  assert.deepEqual(loaded, ['first.nii.gz', 'second.nii.gz']);

  ctl.removeSession(ctl.getActiveSession().id);
  assert.equal(ctl.getActiveFile(), null);
  assert.equal(ctl.getSessions().length, 0);
  assert.deepEqual(cleared, [true]);
}

console.log('FileIOController tests passed');
