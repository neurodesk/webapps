// Exercise the validator against the recorder's real Octave smoke output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { validateRecording } from './validate-revcor-recording.mjs';

const source = process.env.SAMSRF_REVCOR_SMOKE;
assert.ok(source, 'Set SAMSRF_REVCOR_SMOKE to a completed Octave recorder smoke');
let directory;
let reference;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'samsrf-validator-'));
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(source, entry.name), path.join(directory, entry.name));
  }
  reference = JSON.parse(fs.readFileSync(path.join(directory, 'reference.json'), 'utf8'));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function validate() {
  fs.writeFileSync(path.join(directory, 'reference.json'), JSON.stringify(reference));
  return validateRecording(directory, { smoke: true });
}
function pipeline() {
  return reference.cases.find(item => item.analysis === 'cf');
}
function writeValues(descriptor, mutate) {
  const file = path.join(directory, descriptor.file);
  const bytes = fs.readFileSync(file);
  mutate(bytes);
  fs.writeFileSync(file, bytes);
}

test('the complete recorder smoke validates without claiming MATLAB or port parity', () => {
  const report = validate();
  assert.equal(report.cases, 17);
  assert.equal(report.execution, 'Octave plumbing smoke');
  assert.equal(report.portParityVerified, false);
  assert.equal(report.compiledRuntimeVerified, false);
  assert.ok(Object.values(report.informativeVertices).every(count => count > 0));
  assert.throws(() => validateRecording(directory), /Smoke and full recordings/);
});

test('missing and duplicate cases are rejected', () => {
  const last = reference.cases.pop();
  assert.throws(validate, /Incomplete RC\/CF matrix/);
  reference.cases.push(last, last);
  assert.throws(validate, /Duplicate case IDs/);
});

test('labels and replay options retain the source meaning', () => {
  const item = pipeline();
  const label = item.values[0];
  item.values[0] = 'wrong R^2';
  assert.throws(validate, /Wrong map labels/);
  item.values[0] = label;
  item.mapReplayModel.Smoothing = 123;
  assert.throws(validate, /Map replay may change storage and precision selection only/);
});

test('a wholly failed fit cannot pass by preserving map shapes and compression', () => {
  const item = pipeline();
  for (const invalid of [0, NaN]) {
    for (const descriptor of [item.savedMaps, item.maps]) {
      writeValues(descriptor, bytes => {
        for (let column = 0; column < descriptor.shape[1]; column++) {
          bytes.writeDoubleLE(invalid, 8 * column * descriptor.shape[0]);
        }
      });
    }
    assert.throws(validate, /No finite nonzero R\^2/);
  }
});

test('inside-ROI CF profiles must be finite', () => {
  const item = pipeline();
  const vertex = fs.readFileSync(path.join(directory, item.savedVertices.file)).readDoubleLE();
  writeValues(item.profiles, bytes => bytes.writeDoubleLE(NaN, 8 * (vertex - 1) * item.profiles.shape[0]));
  assert.throws(validate, /Nonfinite inside-ROI profile/);
});

test('seed selection must partly overlap the ROI', () => {
  const item = reference.cases.find(item => item.kind === 'preprocess');
  writeValues(item.seedVertices, bytes => {
    for (let i = 0; i < bytes.length / 8; i++) bytes.writeDoubleLE(30 + i, i * 8);
  });
  assert.throws(validate, /Seed\/ROI must overlap only partly/);
});

test('truncated arrays fail before any numerical checks', () => {
  const file = path.join(directory, pipeline().profiles.file);
  fs.truncateSync(file, fs.statSync(file).size - 8);
  assert.throws(validate, /Wrong size/);
});
