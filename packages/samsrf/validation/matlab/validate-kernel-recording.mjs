// Completeness of a single-kernel recording (record_single_kernels.m) and,
// given a second one, same-host determinism: every array byte for byte.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const read = (root) => JSON.parse(fs.readFileSync(path.join(root, 'kernels.json'), 'utf8'));
const descriptors = (item) => Object.values(item).filter((value) => value && typeof value === 'object' && value.file);

export function validateKernelRecording(root, { smoke = false } = {}) {
  const recording = read(root);
  assert.equal(Boolean(recording.smoke), smoke, 'Smoke and full recordings are not interchangeable');
  const ids = recording.cases.map((item) => item.id);
  const expected = ['exp_single'];
  for (const dataset of smoke ? ['x001_lh'] : ['x001_lh', 'x001_rh']) {
    expected.push(`kernels_${dataset}_corr`, `kernels_${dataset}_gaussian_smooth0`, `kernels_${dataset}_gaussian_smooth1`);
  }
  assert.deepEqual(ids, expected, 'Incomplete single-kernel recording');
  for (const item of recording.cases) {
    for (const descriptor of descriptors(item)) {
      const bytes = fs.statSync(path.join(root, descriptor.file)).size;
      assert.equal(bytes, descriptor.shape.reduce((a, b) => a * b, 1) * 8, descriptor.file);
    }
    if (item.kind === 'gaussian') {
      assert.ok(item.evaluations.shape[0] > 0, `${item.id}: no logged evaluations`);
      assert.equal(item.models.shape[0], item.evaluations.shape[0], `${item.id}: models per evaluation`);
    }
  }
  if (!smoke) {
    for (const key of ['matlab', 'computer', 'requested', 'observed']) assert.ok(recording.environment?.[key], `Missing ${key} provenance`);
  }
  return recording;
}

export function compareKernelRecordings(first, second) {
  const a = read(first);
  const b = read(second);
  let arrays = 0;
  for (const [index, item] of a.cases.entries()) {
    for (const [key, descriptor] of Object.entries(item)) {
      if (!descriptor?.file) continue;
      const hash = (root) => createHash('sha256').update(fs.readFileSync(path.join(root, descriptor.file))).digest('hex');
      assert.equal(hash(first), hash(second), `${item.id}/${key} differs between repeats`);
      assert.equal(b.cases[index][key].file, descriptor.file);
      arrays += 1;
    }
  }
  return arrays;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, repeat] = process.argv.slice(2).filter((arg) => arg !== '--smoke');
  assert.ok(root, 'Usage: validate-kernel-recording.mjs RECORDING [REPEAT] [--smoke]');
  validateKernelRecording(root, { smoke: process.argv.includes('--smoke') });
  if (repeat) console.log(`Exact repeat: ${compareKernelRecordings(root, repeat)} arrays.`);
  console.log(`Single-kernel recording ${root} is complete.`);
}
