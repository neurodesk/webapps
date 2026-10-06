#!/usr/bin/env node
// Opt-in regression using local data; no scan data is stored in the repository.
// node scripts/verify-troubleshoot-import.mjs /path/to/troubleshoot
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import Module from '../dcm2niix/dcm2niix.js';
import { DicomController } from '../js/controllers/DicomController.js';
import { MaskController } from '../js/controllers/MaskController.js';
import { FileIOController } from '../js/controllers/FileIOController.js';
import { parseNiftiHeader, readNiftiImageData, sameNiftiGrid } from '../js/modules/file-io/NiftiUtils.js';

const directory = process.argv[2];
assert.ok(directory, 'Pass the local troubleshoot directory');
const files = await Promise.all((await readdir(directory)).map(async name =>
  new File([await readFile(join(directory, name))], name)));
const niftiFiles = files.filter(f => f.name.endsWith('.nii'));
const sidecars = files.filter(f => f.name.endsWith('.json'));
const io = new FileIOController({});
await io.addFiles([...niftiFiles, ...sidecars]);
assert.equal(io.buckets.magnitude.length, 6);
assert.equal(io.buckets.phase.length, 6);
assert.equal(io.buckets.extra.length, 0);
const expectedTimes = [1.7, 3.7, 5.7, 7.7, 9.7, 11.7];
globalThis.document = { getElementById: () => null };
io.populateEchoTimeInputs = times => assert.deepEqual(times.map(t => +t.toFixed(2)), expectedTimes);
await io.processJsonFiles(sidecars);

const mod = await Module({ noInitialRun: true });
mod.FS.mkdir('/input');
mod.FS.mkdir('/output');
for (const file of files.filter(f => f.name.endsWith('.dcm'))) {
  mod.FS.writeFile('/input/' + file.name, new Uint8Array(await file.arrayBuffer()));
}
assert.equal(mod.callMain(['-o', '/output', '/input']), 0);
const converted = mod.FS.readdir('/output').filter(name => !name.startsWith('.'))
  .map(name => new File([mod.FS.readFile('/output/' + name)], name));
let batch;
await new DicomController({ onConversionComplete: result => { batch = result; } })._processResults(converted);
assert.equal(batch.magnitude.length, 6);
assert.equal(batch.phase.length, 6);
assert.equal(batch.extras.length, 0);
assert.deepEqual(batch.echoTimes.map(t => +t.toFixed(2)), expectedTimes);
for (const category of ['magnitude', 'phase']) {
  for (let i = 0; i < 6; i++) {
    const actual = await batch[category][i].file.arrayBuffer();
    const expected = await io.buckets[category][i].file.arrayBuffer();
    assert.deepEqual(parseNiftiHeader(actual), parseNiftiHeader(expected));
    // Compare qform/sform, including orientation and position.
    assert.deepEqual(new Uint8Array(actual, 252, 4), new Uint8Array(expected, 252, 4));
    // Native and WASM builds differ by a few float32 ULPs in the transforms.
    for (let offset = 256; offset < 328; offset += 4) {
      assert.ok(Math.abs(new DataView(actual).getFloat32(offset, true) -
        new DataView(expected).getFloat32(offset, true)) < 1e-5);
    }
    assert.deepEqual(readNiftiImageData(new Uint8Array(actual)), readNiftiImageData(new Uint8Array(expected)));
  }
}
const mask = files.find(f => f.name.endsWith('.nii.gz'));
assert.ok(mask, 'Expected compressed mask');
const maskBytes = await new Response(mask.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
assert.deepEqual(parseNiftiHeader(maskBytes).dims.slice(1, 4), [96, 82, 18]);
assert.ok(readNiftiImageData(new Uint8Array(maskBytes)).some(value => value > 0));
assert.equal(sameNiftiGrid(maskBytes, await io.buckets.magnitude[0].file.arrayBuffer()), false,
  'The supplied mask has different orientation/origin and must not be silently relabelled');
const masks = new MaskController({ nv: { volumes: [] } });
const adoption = await masks.loadMaskFromFile(new File([maskBytes], 'mask.nii'), io.buckets.magnitude[0].file);
assert.equal(adoption.ok, false);
assert.equal(masks.currentMaskData, null);
assert.match(adoption.message, /orientation, origin/);
console.log('PASS: both import paths have six magnitude/phase echoes and correct timings; all converted voxels and spatial headers match offline conversion; gzip mask decodes and its incompatible spatial grid is detected.');
