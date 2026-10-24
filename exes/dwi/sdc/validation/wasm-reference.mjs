// Verify the committed browser/Node kernel against the independent native reference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFieldFit } from '../../../../packages/sdc/src/field-fit.js';

const directory = process.env.SDC_FIELD_FIT_REFERENCE;
assert.ok(directory, 'Set SDC_FIELD_FIT_REFERENCE to the arrays staged by prepare-reference.mjs');
const metadata = JSON.parse(await readFile(join(directory, 'metadata.json')));
const modulePath = new URL('../../../../packages/sdc/src/sdc-field-fit.wasm', import.meta.url);
const kernel = await loadFieldFit(await readFile(modulePath));

async function values(name) {
  const bytes = await readFile(join(directory, `${name}.bin`));
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function errors(actual, expected, mask) {
  assert.equal(actual.length, expected.length);
  const differences = [];
  for (let i = 0; i < actual.length; i++) {
    if (!mask || mask[i] > 0) {
      differences.push(Math.abs(actual[i] - expected[i]));
    }
  }
  assert.ok(differences.every(Number.isFinite));
  differences.sort((a, b) => a - b);
  const middle = Math.floor(differences.length / 2);
  const median = differences.length % 2 === 0
    ? (differences[middle - 1] + differences[middle]) / 2
    : differences[middle];
  return {
    median,
    maximum: differences.at(-1),
  };
}

const displacement = kernel.displacementToField(await values('displacement'), metadata.image, {
  readout: metadata.readout,
  phaseEncodingDirection: metadata.pe,
});
const conversion = errors(displacement, await values('extracted'));
assert.ok(conversion.median <= 1e-4, JSON.stringify(conversion));
const fit = kernel.approximate(await values('input'), metadata.input);
assert.deepEqual(fit.grid.shape, metadata.coefficients.shape);
const coefficients = errors(fit.coefficients, await values('coefficients'));
const field = errors(fit.field, await values('field'), await values('mask'));
console.log(JSON.stringify({ conversion, coefficients, field }, null, 2));
assert.ok(coefficients.median <= 1e-4, `WASM coefficient median ${coefficients.median} Hz`);
assert.ok(field.median <= 1e-4, `WASM in-brain field median ${field.median} Hz`);
