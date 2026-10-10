import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { loadMindgrabCpu } from '../src/mindgrab.js';
import { MINDGRAB_CASES, MINDGRAB_INPUT, REFERENCE_URL, mindgrabOutputs, pinnedFile, sha256 } from '../validation/cases.mjs';

const reference = JSON.parse(await readFile(REFERENCE_URL, 'utf8')).mindgrab;
const mindgrab = await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));
const input = new Uint8Array(1024);

test('runs the mindgrab version the browser reference ran', () => {
  assert.equal(mindgrab.version, reference.version);
});

test('refuses GPU backends and options the model does not support before loading a module', async () => {
  for (const [options, message] of [
    [{ model: 'mindgrab', backend: 'webgpu' }, /only the cpu backend/],
    [{ model: 'mindgrab', device: {} }, /only the cpu backend/],
    [{ model: 'nope' }, /unknown model 'nope'/],
    [{ model: 'mindmap', mask: true }, /mindmap does not support `mask`/],
    [{ model: 'mindgrab', saveConform: true }, /mindgrab does not support `saveConform`/],
    [{ model: 'mindgrab', borderMm: -1 }, /borderMm must be a non-negative number/],
    [{ model: 'mindgrab', legacyCleanup: true }, /only for MindMap/],
  ]) {
    await assert.rejects(mindgrab.segment(input, options), error => error.code === 'unsupported-option' && message.test(error.message));
  }
  await assert.rejects(mindgrab.segmentTissues(input, { model: 'mindsnap' }), /tissue fractions/);
  await assert.rejects(mindgrab.segment(new Uint8Array(0), { model: 'mindgrab' }), /the input is empty/);
});

test('a run past its time limit is stopped and reported', async () => {
  await assert.rejects(
    mindgrab.segment(input, { model: 'mindgrab', timeoutMs: 1 }),
    error => error.code === 'inference-failed' && /did not finish within 1 ms/.test(error.message),
  );
});

// Each case needs 2.6-3.9 GB and about a minute on eight cores, so the parity run is opt-in.
const parity = process.env.MINDGRAB_PARITY === '1';
for (const item of MINDGRAB_CASES) {
  test(`${item.id} equals the browser CPU backend voxel for voxel`, { skip: !parity && 'set MINDGRAB_PARITY=1 to run MindGrab inference' }, async () => {
    const bytes = await pinnedFile(MINDGRAB_INPUT);
    process.exitCode = undefined;
    // A gzipped input returns gzipped outputs, as in the wrapper; the pins are of the NIfTI inside.
    const result = await mindgrab[item.call](bytes, item.options);
    assert.equal(result.backend, 'cpu');
    assert.equal(process.exitCode, undefined, 'the module exit leaves the host exit code alone');
    assert.equal(globalThis.Worker, undefined, 'the glue installs no global Worker in the host');
    const expected = reference.cases[item.id];
    const outputs = mindgrabOutputs(result);
    const digests = Object.fromEntries(Object.entries(outputs).map(([name, data]) => [name, sha256(gunzipSync(new Uint8Array(data)))]));
    assert.deepEqual(digests, expected.outputs);
  });
}
