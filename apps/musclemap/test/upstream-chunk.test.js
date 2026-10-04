import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { roundtripTemporaryChunk } from '../web/js/upstream-chunk.js';

const fixtures = JSON.parse(await readFile(
  new URL('./fixtures/upstream-chunk-roundtrip.json', import.meta.url),
  'utf8'
));

for (const fixture of fixtures) {
  test(`temporary NIfTI chunk matches MONAI float64 decode then float32 bits: ${fixture.name}`, () => {
    const input = Float32Array.from(fixture.input);
    const original = input.slice();
    const output = roundtripTemporaryChunk(input, fixture.datatype);
    const bits = new Uint32Array(output.buffer, output.byteOffset, output.length);
    assert.deepEqual(Array.from(bits), fixture.expectedBits);
    assert.deepEqual(input, original, 'the source volume must remain unchanged');
  });
}

for (const datatype of [16, 64]) {
  test(`float NIfTI datatype ${datatype} bypasses integer storage`, () => {
    const input = Float32Array.of(-0, -1.125, 0, 47.25, NaN, Infinity);
    assert.equal(roundtripTemporaryChunk(input, datatype), input);
  });
}

test('subnormal scaling fails when the stored float32 slope rounds to zero', () => {
  assert.throws(
    () => roundtripTemporaryChunk(Float32Array.of(0, 1e-45), 4),
    /scaling slope cannot be zero/
  );
});
