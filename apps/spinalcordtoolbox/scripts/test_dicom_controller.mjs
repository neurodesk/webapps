#!/usr/bin/env node

import assert from 'node:assert/strict';

// We exercise DicomController's orchestration layer: result filtering,
// success/failure messaging, and drop-tree traversal. The actual dcm2niix
// WASM module is replaced with a stub so the tests run without a browser.

const { DicomController } = await import('../web/js/controllers/DicomController.js');

function makeNiftiBlob(name) {
  return { name, content: new Uint8Array([1, 2, 3]) };
}

function makeStubDcm2niix(returnFiles, opts = {}) {
  let inputCalled = null;
  return {
    init: async () => {},
    input(files) { inputCalled = files; return this; },
    async run() {
      if (opts.throw) throw new Error(opts.throw);
      return returnFiles;
    },
    _inputCalled: () => inputCalled
  };
}

// Test 1: convertFiles with successful conversion
{
  const log = [];
  let completed = null;
  const ctl = new DicomController({
    updateOutput: (m) => log.push(m),
    onConversionComplete: (f) => { completed = f; }
  });
  const stub = makeStubDcm2niix([
    makeNiftiBlob('series_001.nii.gz'),
    makeNiftiBlob('extra.json') // should be filtered out
  ]);
  ctl._createInstance = async () => stub;

  await ctl.convertFiles([{ name: 'a.dcm' }, { name: 'b.dcm' }]);

  assert.equal(completed?.name, 'series_001.nii.gz', 'first NIfTI is forwarded');
  assert.ok(log.some(m => m.includes('Converting 2 DICOM files')), 'logs file count');
  assert.ok(log.some(m => m.includes('Converted 1 NIfTI')), 'logs success summary');
  assert.equal(ctl.converting, false, 'converting flag is reset');
}

// Test 2: convertFiles produces no NIfTI output -> error message, no callback
{
  const log = [];
  let completed = null;
  const ctl = new DicomController({
    updateOutput: (m) => log.push(m),
    onConversionComplete: (f) => { completed = f; }
  });
  ctl._createInstance = async () => makeStubDcm2niix([
    { name: 'something.json' },
    { name: 'log.txt' }
  ]);

  await ctl.convertFiles([{ name: 'bad.dcm' }]);

  assert.equal(completed, null, 'no NIfTI -> callback not invoked');
  assert.ok(log.some(m => m.includes('No NIfTI files produced')), 'logs failure');
}

// Test 3: convertFiles handles thrown errors gracefully
{
  const log = [];
  const ctl = new DicomController({ updateOutput: (m) => log.push(m) });
  ctl._createInstance = async () => makeStubDcm2niix([], { throw: 'wasm exploded' });

  await ctl.convertFiles([{ name: 'a.dcm' }]);

  assert.ok(log.some(m => m.includes('DICOM conversion failed') && m.includes('wasm exploded')));
  assert.equal(ctl.converting, false, 'converting flag is reset even on error');
}

// Test 4: empty/null input is a no-op
{
  const ctl = new DicomController({});
  await ctl.convertFiles([]);
  await ctl.convertFiles(null);
  await ctl.convertDropItems([]);
  await ctl.convertDropItems(null);
  assert.equal(ctl.converting, false);
}

// Test 5: convertDropItems traverses a directory entry tree
{
  const log = [];
  let completed = null;
  const ctl = new DicomController({
    updateOutput: (m) => log.push(m),
    onConversionComplete: (f) => { completed = f; }
  });
  const stub = makeStubDcm2niix([makeNiftiBlob('out.nii.gz')]);
  ctl._createInstance = async () => stub;

  // Build a minimal tree: root dir -> 2 files
  const fileA = { name: 'a.dcm' };
  const fileB = { name: 'b.dcm' };
  const fileEntry = (file) => ({
    isFile: true,
    isDirectory: false,
    file: (cb) => cb(file)
  });
  let readCalls = 0;
  const dirReader = {
    readEntries: (cb) => {
      readCalls += 1;
      // First call returns 2 files; subsequent calls return [] to terminate.
      if (readCalls === 1) cb([fileEntry(fileA), fileEntry(fileB)]);
      else cb([]);
    }
  };
  const dirEntry = {
    isFile: false,
    isDirectory: true,
    name: 'series',
    createReader: () => dirReader
  };

  const dataTransfer = [{ webkitGetAsEntry: () => dirEntry }];
  await ctl.convertDropItems(dataTransfer);

  assert.equal(completed?.name, 'out.nii.gz');
  // The traversed files (with _webkitRelativePath set) should have been passed in.
  const inputs = stub._inputCalled();
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(f => typeof f._webkitRelativePath === 'string' && f._webkitRelativePath.includes('series/')));
}

// Test 6: convertDropItems with no entries -> "No DICOM files found" message
{
  const log = [];
  const ctl = new DicomController({ updateOutput: (m) => log.push(m) });
  ctl._createInstance = async () => makeStubDcm2niix([]);
  // Entry that turns out to have no files.
  const emptyDir = {
    isFile: false,
    isDirectory: true,
    name: 'empty',
    createReader: () => ({ readEntries: (cb) => cb([]) })
  };
  await ctl.convertDropItems([{ webkitGetAsEntry: () => emptyDir }]);
  assert.ok(log.some(m => m.includes('No DICOM files found')));
}

console.log('DicomController tests passed');
