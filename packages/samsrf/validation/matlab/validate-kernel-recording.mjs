// Completeness of a single-kernel recording (record_single_kernels.m) and,
// given a second one, same-host determinism: every array byte for byte.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const read = (root) => JSON.parse(fs.readFileSync(path.join(root, 'kernels.json'), 'utf8'));

export function validateKernelRecording(root, { smoke = false } = {}) {
  const recording = read(root);
  assert.equal(Boolean(recording.smoke), smoke, 'Smoke and full recordings are not interchangeable');
  const ids = recording.cases.map((item) => item.id);
  const expected = ['exp_single'];
  for (const dataset of smoke ? ['x001_lh'] : ['x001_lh', 'x001_rh']) {
    expected.push(`kernels_${dataset}_corr`, `kernels_${dataset}_gaussian_smooth0`, `kernels_${dataset}_gaussian_smooth1`);
  }
  assert.deepEqual(ids, expected, 'Incomplete single-kernel recording');
  const files = new Set();
  for (const item of recording.cases) {
    const kind = item.id === 'exp_single' ? 'exp' : item.id.endsWith('_corr') ? 'corr' : 'gaussian';
    assert.equal(item.kind, kind, `${item.id}: kind`);
    const schema = {};
    const fields = (names, shape, type = 'single') => {
      for (const name of names.split(' ')) schema[name] = { shape, class: type };
    };
    if (kind === 'exp') {
      const n = smoke ? 8875 : 711307;
      fields('input whole chunk9 chunk81 chunk400', [n, 1]);
      fields('chunk1', [Math.min(n, 20000), 1]);
    } else {
      const dataset = item.id.includes('_lh_') ? 'x001_lh' : 'x001_rh';
      assert.equal(item.dataset, dataset, `${item.id}: dataset`);
      if (kind === 'corr') {
        fields('roi', [1, 21], 'double');
        fields('seed', [1, 9], 'double');
        fields('courses', [250, 21]);
        fields('seedCourses', [250, 9]);
        fields('meanSeed sumSeed normSeed', [1, 9]);
        fields('meanCourse normCourse', [21, 1]);
        fields('corr product columnProducts', [21, 9]);
        assert.equal(item.candidateEqual?.length, 3, `${item.id}: candidate comparisons`);
        assert.ok(item.candidateEqual.every(value => typeof value === 'boolean'));
      } else {
        assert.equal(item.smoothing, Number(item.id.at(-1)), `${item.id}: smoothing`);
        const labels = ['R^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline', 'Fwhm', 'Vx'];
        if (dataset === 'x001_lh') labels.push('Noise Ceiling');
        assert.deepEqual(item.values, labels, `${item.id}: map labels`);
        const n = item.evaluations?.shape?.[0];
        assert.ok(Number.isSafeInteger(n) && n > 0, `${item.id}: no logged evaluations`);
        fields('savedMaps', [labels.length, 21]);
        fields('profiles', [9, 21]);
        fields('coordinates', [9, 2]);
        fields('replicaParameters', [5, 21], 'double');
        fields('replicaR2', [1, 21], 'double');
        fields('evaluations', [n, 5], 'double');
        fields('evaluationVertex evaluationStart', [n, 1], 'double');
        fields('models exponents', [n, 9]);
        fields('objectives', [n, 1]);
      }
    }
    assert.deepEqual(Object.keys(item).filter(key => item[key]?.file).sort(), Object.keys(schema).sort(), `${item.id}: descriptor inventory`);
    for (const [key, expectedDescriptor] of Object.entries(schema)) {
      const descriptor = item[key];
      assert.deepEqual(descriptor.shape, expectedDescriptor.shape, `${item.id}/${key}: shape`);
      assert.equal(descriptor.class, expectedDescriptor.class, `${item.id}/${key}: class`);
      assert.equal(descriptor.imaginary, '', `${item.id}/${key}: unexpected imaginary data`);
      assert.equal(path.basename(descriptor.file), descriptor.file, `${item.id}/${key}: array filename`);
      assert.ok(!files.has(descriptor.file), `${item.id}/${key}: reused array`);
      files.add(descriptor.file);
      const bytes = fs.statSync(path.join(root, descriptor.file)).size;
      assert.equal(bytes, descriptor.shape.reduce((a, b) => a * b, 1) * 8, descriptor.file);
    }
  }
  if (!smoke) {
    for (const key of ['matlab', 'computer', 'requested', 'observed']) assert.ok(recording.environment?.[key], `Missing ${key} provenance`);
  }
  return recording;
}

export function compareKernelRecordings(first, second) {
  const smoke = read(first).smoke;
  const a = validateKernelRecording(first, { smoke });
  const b = validateKernelRecording(second, { smoke });
  assert.deepEqual(a.cases, b.cases, 'Repeat schema or metadata differs');
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
