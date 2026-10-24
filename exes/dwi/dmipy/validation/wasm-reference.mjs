// Actual committed noddi.wasm against the independent dmipy reference on pinned WM voxels.
// NODDI_DMIPY_PREPARED=DIR node wasm-reference.mjs [REPORT.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadNoddi } from '../../../../packages/noddi/src/wasm.js';

const root = process.env.NODDI_DMIPY_PREPARED;
assert.ok(root, 'NODDI_DMIPY_PREPARED must name the verified prepared reference; this gate never skips.');
const metadata = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8'));
const inputs = {};
for (const name of ['signals.f64', 'expected.f64']) {
  const bytes = await readFile(join(root, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.files[name], name);
  inputs[name] = Float64Array.from({ length: bytes.length / 8 }, (_, i) => bytes.readDoubleLE(i * 8));
}
const selected = metadata.wmIndices;
assert.equal(selected.length, 13324);
const frames = metadata.frames;
assert.equal(inputs['signals.f64'].length, metadata.eligibleVoxels * frames);
assert.equal(inputs['expected.f64'].length, metadata.eligibleVoxels * 6);
const moduleBytes = await readFile(new URL('../../../../packages/noddi/src/noddi.wasm', import.meta.url));
const api = await loadNoddi(moduleBytes);
const model = api.noddiModel(metadata.bvals, [0, 1, 2].map(axis => metadata.gradients.map(row => row[axis])), { method: 'dmipy' });
const differences = { ICVF: [], ISOVF: [], OD: [] };
const columns = { ICVF: 3, ISOVF: 4, OD: 2 };
const diagnostics = { fitted: 0, skipped: 0, nonconverged: 0, failed: 0 };
try {
  for (let offset = 0; offset < selected.length; offset += 512) {
    const indices = selected.slice(offset, offset + 512);
    const data = new Float32Array(indices.length * frames);
    indices.forEach((voxel, index) => {
      for (let frame = 0; frame < frames; frame++) data[frame * indices.length + index] = inputs['signals.f64'][voxel * frames + frame];
    });
    const maps = model.fit(data, indices.length);
    for (const key of Object.keys(diagnostics)) diagnostics[key] += model.diagnostics[key];
    indices.forEach((voxel, index) => {
      for (const [key, values] of Object.entries(maps)) assert.ok(Number.isFinite(values[index]), `${key} voxel${voxel}`);
      for (const key of Object.keys(differences)) differences[key].push(Math.abs(maps[key][index] - inputs['expected.f64'][voxel * 6 + columns[key]]));
    });
    console.error(`${offset + indices.length}/${selected.length} WM voxels`);
  }
} finally { model.free(); }
const maps = Object.fromEntries(Object.entries(differences).map(([key, values]) => {
  values.sort((a, b) => a - b);
  return [key === 'OD' ? 'ODI' : key, {
    medianAbsoluteDifference: (values[(values.length - 1) >> 1] + values[values.length >> 1]) / 2,
    maxAbsoluteDifference: values.at(-1), voxelsAtOrAbove002: values.filter(value => value >= 0.02).length,
  }];
}));
const report = { reference: metadata.source, wmSelection: metadata.wmSelection, voxels: selected.length,
  wasmSHA256: createHash('sha256').update(moduleBytes).digest('hex'), diagnostics, maps };
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
assert.equal(diagnostics.fitted, 13324);
assert.equal(diagnostics.failed, 0);
for (const [name, row] of Object.entries(maps)) assert.ok(row.medianAbsoluteDifference < 0.02, `${name} WM median exceeds the accepted gate`);
