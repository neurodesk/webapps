#!/usr/bin/env node --no-warnings
// Phase 35: behavior tests for web/js/controllers/FileIOController.js.
//
// Covers: NIfTI vs DICOM detection, file dispatch via onFileLoaded,
// state tracking (getActiveFile/hasValidData/clearFiles), drop-item
// handling with mixed payloads.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// FileIOController._updateUI / clearFiles touch the DOM. Stub document
// minimally so they no-op cleanly in Node.
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    appendChild: () => {},
    setAttribute: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    querySelector: () => null,
    innerHTML: '',
    set className(v) {},
    set textContent(v) {},
    set value(v) {}
  })
};

const { FileIOController } = await import(path.join(ROOT, 'web/js/controllers/FileIOController.js'));

function fakeFile(name) {
  return { name, size: 1024 };
}

// ---- Test 1: handleFiles with a NIfTI -> onFileLoaded fires + state set ----
{
  const events = [];
  const fic = new FileIOController({
    updateOutput: (m) => events.push({ kind: 'output', m }),
    onFileLoaded: (f) => events.push({ kind: 'loaded', name: f.name })
  });
  assert.equal(fic.hasValidData(), false, 'initial state: no file');
  assert.equal(fic.getActiveFile(), null);

  fic.handleFiles([fakeFile('subject01.nii.gz')]);
  assert.equal(fic.hasValidData(), true);
  assert.equal(fic.getActiveFile().name, 'subject01.nii.gz');
  // Both an output message and an onFileLoaded callback must fire.
  assert.ok(events.some(e => e.kind === 'output' && e.m.includes('Loaded')));
  assert.deepEqual(events.filter(e => e.kind === 'loaded'),
    [{ kind: 'loaded', name: 'subject01.nii.gz' }]);
}

// ---- Test 2: handleFiles with .nii (uncompressed) also detected ----
{
  let loadedName = null;
  const fic = new FileIOController({
    onFileLoaded: (f) => { loadedName = f.name; }
  });
  fic.handleFiles([fakeFile('uncompressed.nii')]);
  assert.equal(loadedName, 'uncompressed.nii',
    '.nii (no .gz) must be recognised');
}

// ---- Test 3: empty file list -> no callback, no state change ----
{
  let loaded = false;
  const fic = new FileIOController({
    onFileLoaded: () => { loaded = true; }
  });
  fic.handleFiles([]);
  fic.handleFiles(null);
  fic.handleFiles(undefined);
  assert.equal(loaded, false);
  assert.equal(fic.getActiveFile(), null);
}

// ---- Test 4: NIfTI mixed with non-NIfTI files - the NIfTI is picked ----
{
  let loaded = null;
  const fic = new FileIOController({
    onFileLoaded: (f) => { loaded = f; }
  });
  fic.handleFiles([
    fakeFile('readme.txt'),
    fakeFile('volume.nii.gz'),
    fakeFile('header.json')
  ]);
  assert.equal(loaded.name, 'volume.nii.gz',
    'mixed list must extract the NIfTI');
}

// ---- Test 5: case-insensitive extension match ----
{
  let loaded = null;
  const fic = new FileIOController({
    onFileLoaded: (f) => { loaded = f; }
  });
  fic.handleFiles([fakeFile('SUBJECT.NII.GZ')]);
  assert.equal(loaded.name, 'SUBJECT.NII.GZ',
    'uppercase extensions must be detected (case-insensitive)');
}

// ---- Test 6: DICOM-only payload routes through DicomController ----
// We can't fully test DICOM conversion here (it pulls in dcm2niix), so
// just verify the dispatch path: no NIfTI in the payload triggers a
// DicomController call without loading any file directly.
{
  let loaded = false;
  const outputs = [];
  const fic = new FileIOController({
    updateOutput: (m) => outputs.push(m),
    onFileLoaded: () => { loaded = true; }
  });
  // Stub the dicomController to record + not crash.
  let dicomCalled = false;
  fic.dicomController = {
    convertFiles: () => { dicomCalled = true; },
    convertDropItems: () => { dicomCalled = true; }
  };
  fic.handleFiles([fakeFile('IMG001.dcm'), fakeFile('IMG002.dcm')]);
  assert.equal(loaded, false, 'DICOM input must NOT call onFileLoaded directly');
  assert.equal(dicomCalled, true, 'DICOM input must dispatch to DicomController');
  assert.ok(outputs.some(m => /Detected DICOM/.test(m)),
    'must announce DICOM detection');
}

// ---- Test 7: clearFiles resets state ----
{
  const fic = new FileIOController({});
  fic.handleFiles([fakeFile('sub.nii')]);
  assert.equal(fic.hasValidData(), true);
  fic.clearFiles();
  assert.equal(fic.hasValidData(), false);
  assert.equal(fic.getActiveFile(), null);
}

// ---- Test 8: handleDropItems with a NIfTI getAsFile() returns the file ----
{
  let loaded = null;
  const fic = new FileIOController({
    onFileLoaded: (f) => { loaded = f; }
  });
  const dropItems = [
    { getAsFile: () => fakeFile('drop.nii.gz') }
  ];
  fic.handleDropItems(dropItems);
  assert.equal(loaded.name, 'drop.nii.gz');
}

// ---- Test 9: handleDropItems with no NIfTI routes to DicomController ----
{
  const fic = new FileIOController({});
  let dicomDropCalled = false;
  fic.dicomController = {
    convertFiles: () => {},
    convertDropItems: () => { dicomDropCalled = true; }
  };
  const dropItems = [
    { getAsFile: () => fakeFile('IMG001.dcm') },
    { getAsFile: () => fakeFile('IMG002.dcm') }
  ];
  fic.handleDropItems(dropItems);
  assert.equal(dicomDropCalled, true,
    'non-NIfTI drop must route to DicomController.convertDropItems');
}

console.log('FileIOController OK: 9 cases (NIfTI detection, dispatch, DICOM routing, drop handling).');
