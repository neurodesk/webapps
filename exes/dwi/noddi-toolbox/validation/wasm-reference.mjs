// The committed noddi.wasm's toolbox fit against the NODDI toolbox 1.05 reference on the
// 13327 WM gate voxels (prepare_reference.py). This gate never skips.
// NODDI_TOOLBOX_PREPARED=DIR node wasm-reference.mjs [REPORT.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadNoddi } from '../../../../packages/noddi/src/wasm.js';

const root = process.env.NODDI_TOOLBOX_PREPARED;
assert.ok(root, 'NODDI_TOOLBOX_PREPARED must name the prepared reference.');
const metadata = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8'));
const doubles = async (name) => {
  const bytes = await readFile(join(root, name));
  return Float64Array.from({ length: bytes.length / 8 }, (_, i) => bytes.readDoubleLE(i * 8));
};
const signals = await doubles('signals.f64');
const expected = await doubles('expected.f64');
const frames = metadata.bvals.length;
const voxels = metadata.gateVoxels;
assert.equal(voxels, 13327);
assert.equal(signals.length, voxels * frames);
assert.equal(expected.length, voxels * 4);
const moduleBytes = await readFile(new URL('../../../../packages/noddi/src/noddi.wasm', import.meta.url));
const api = await loadNoddi(moduleBytes);
const bvecs = [0, 1, 2].map((axis) => metadata.bvecs.map((row) => row[axis]));
const model = api.noddiModel(metadata.bvals, bvecs, { method: 'toolbox' });
const columns = { ICVF: 0, ISOVF: 1, OD: 2 };
const differences = { ICVF: [], ISOVF: [], OD: [] };
const diagnostics = { fitted: 0, skipped: 0, nonconverged: 0, failed: 0 };
try {
  for (let offset = 0; offset < voxels; offset += 512) {
    const count = Math.min(512, voxels - offset);
    const data = new Float32Array(count * frames);
    for (let index = 0; index < count; index++) {
      for (let frame = 0; frame < frames; frame++) data[frame * count + index] = signals[(offset + index) * frames + frame];
    }
    const maps = model.fit(data, count);
    for (const key of Object.keys(diagnostics)) diagnostics[key] += model.diagnostics[key];
    for (let index = 0; index < count; index++) {
      for (const [key, column] of Object.entries(columns)) {
        differences[key].push(Math.abs(maps[key][index] - expected[(offset + index) * 4 + column]));
      }
    }
    console.error(`${offset + count}/${voxels} WM gate voxels`);
  }
} finally {
  model.free();
}
const maps = Object.fromEntries(Object.entries(differences).map(([key, values]) => {
  values.sort((a, b) => a - b);
  return [key === 'OD' ? 'ODI' : key, {
    medianAbsoluteDifference: (values[(values.length - 1) >> 1] + values[values.length >> 1]) / 2,
    p95AbsoluteDifference: values[Math.floor(values.length * 0.95)],
    maxAbsoluteDifference: values.at(-1),
  }];
}));
const report = { reference: metadata.source, voxels, wasmSHA256: createHash('sha256').update(moduleBytes).digest('hex'), diagnostics, maps };
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
assert.equal(diagnostics.fitted, voxels);
assert.equal(diagnostics.failed, 0);
for (const [name, row] of Object.entries(maps)) assert.ok(row.medianAbsoluteDifference < 0.02, `${name}: WM median ${row.medianAbsoluteDifference} is not below 0.02`);
