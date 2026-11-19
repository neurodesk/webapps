// Compare the actual production entry points to reviewed output bytes, including ±0 and NaN payloads.
// The native workflow supplies its checksum-verified CLI recording; no MATLAB runs are made here.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOne, treeHashes } from './run_web_matrix.mjs';

const [recording, output] = process.argv.slice(2);
if (!recording || !output || process.argv.length !== 4) throw new Error('Usage: check_arithmetic_references.mjs RECORDING OUTPUT');
const bundle = join(recording, 'bundle');
const manifest = JSON.parse(readFileSync(join(recording, 'bundle-sha256.json')));
assert.deepEqual(treeHashes(bundle), manifest, 'verified input bundle');
const plan = JSON.parse(readFileSync(join(recording, 'plan.json')));
const expected = JSON.parse(readFileSync(new URL('./arithmetic-reference-outputs.json', import.meta.url)));
assert.equal(plan.runs.length, 24);
for (const [reference, cases] of Object.entries(expected.references)) {
  assert.equal(Object.keys(cases).length, reference === 'matlab-intel' ? 12 : 24);
  for (const [id, wanted] of Object.entries(cases)) {
    const run = plan.runs.find((run) => run.id === id);
    assert.ok(run, id);
    const selected = { ...run, model: { ...run.model, Arithmetic_Reference: reference } };
    const directory = join(output, reference, id);
    mkdirSync(join(output, reference), { recursive: true });
    const actual = runOne(selected, bundle, directory);
    assert.equal(actual.status, wanted.status, `${reference} ${id}: ${actual.message}`);
    if (actual.status !== 'succeeded') {
      assert.equal(actual.message, wanted.message);
      continue;
    }
    assert.deepEqual(treeHashes(directory), wanted.files, `${reference} ${id}: output bytes changed`);
    console.log(`PASS ${reference} ${id}: ${Object.keys(wanted.files).length} files`);
  }
}
assert.deepEqual(treeHashes(bundle), manifest, 'inputs unchanged');
console.log('All explicit reference outputs equal their reviewed baselines.');
