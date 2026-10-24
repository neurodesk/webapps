import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadFieldFit } from '../src/field-fit.js';

const kernel = await loadFieldFit(await readFile(new URL('../src/sdc-field-fit.wasm', import.meta.url)));
const grid = {
  shape: [2, 1, 1],
  affine: [[-2, 0, 0, 12], [0, 3, 0, -8], [0, 0, 4, 5], [0, 0, 0, 1]],
};
const acquisition = { readout: 0.1, phaseEncodingDirection: 'j' };

test('the committed module converts Hz and LPS displacements in all six PE directions', () => {
  const directions = [
    ['i', 0, 2], ['i-', 0, -2],
    ['j', 1, -3], ['j-', 1, 3],
    ['k', 2, 4], ['k-', 2, -4],
  ];
  for (const [phaseEncodingDirection, axis, scale] of directions) {
    const acquisition = { phaseEncodingDirection, readout: 0.1 };
    const field = new Float32Array([10, -20]);
    const vectors = kernel.fieldToDisplacement(field, grid, acquisition);
    const expected = new Float32Array(6);
    expected[axis] = scale;
    expected[axis + 3] = -2 * scale;
    assert.deepEqual(vectors.map(value => value || 0), expected);
    assert.deepEqual(kernel.displacementToField(vectors, grid, acquisition), field);
  }
});

test('conversions require explicit acquisition metadata', () => {
  for (const method of ['fieldToDisplacement', 'displacementToField']) {
    const input = new Float32Array(method === 'fieldToDisplacement' ? 2 : 6);
    for (const missing of [undefined, {}, { phaseEncodingDirection: 'j' }]) {
      assert.throws(() => kernel[method](input, grid, missing), /Readout time/);
    }
    assert.throws(() => kernel[method](input, grid, { readout: 0.1 }), /Phase encoding/);
    assert.throws(() => kernel[method](input, grid, { ...acquisition, readout: NaN }), /Readout time/);
    assert.throws(() => kernel[method](input, grid, { ...acquisition, readout: Infinity }), /Readout time/);
  }
});

test('the module evaluates independent native sdcflows coefficients', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../../exes/dwi/sdc/tests/fixtures/synthetic.json', import.meta.url)));
  for (const value of fixture.cases) {
    const control = { shape: value.controlShape, affine: value.controlAffine };
    const image = { shape: value.shape, affine: value.affine };
    const result = kernel.evaluate(new Float32Array(value.coefficients), control, image);
    assert.deepEqual(result, new Float32Array(value.field));
  }
});

test('zero fields fit to literal zero coefficients and independent result arrays', () => {
  const image = {
    shape: [6, 7, 8],
    affine: [[-2, 0, 0, 14], [0, 2.5, 0, -9], [0, 0, 3, 8], [0, 0, 0, 1]],
  };
  const result = kernel.approximate(new Float32Array(336), image);
  assert.deepEqual(result.grid.shape, [3, 3, 5]);
  assert.deepEqual(result.coefficients, new Float32Array(45));
  assert.deepEqual(result.field, new Float32Array(336));
  result.field[0] = 100;
  assert.deepEqual(kernel.approximate(new Float32Array(336), image).field, new Float32Array(336));
});

test('invalid inputs fail without exposing stale results and allow retry', () => {
  assert.throws(() => kernel.approximate(new Float64Array(2), grid), /Float32Array/);
  assert.throws(() => kernel.approximate(new Float32Array(2), { ...grid, shape: [2, 0, 1] }), /dimensions/);
  assert.throws(() => kernel.fieldToDisplacement(new Float32Array(2), grid, { ...acquisition, readout: 0 }), /Readout time/);
  assert.throws(() => kernel.fieldToDisplacement(new Float32Array([NaN, 1]), grid, acquisition), /finite/);
  assert.throws(() => kernel.fieldToDisplacement(new Float32Array(1), grid, acquisition), /length/);
  const retried = kernel.displacementToField(new Float32Array(6), grid, acquisition);
  assert.deepEqual(Array.from(retried, value => value || 0), [0, 0]);
});

test('rotated bases and unrepresentable conversions are refused', () => {
  const control = {
    shape: [6, 6, 6],
    affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  };
  const rotated = {
    shape: [2, 2, 2],
    affine: [[0, -1, 0, 2], [1, 0, 0, 1], [0, 0, 1, 2], [0, 0, 0, 1]],
  };
  const coefficients = Float32Array.from({ length: 216 }, (_, index) => index % 6);
  assert.throws(() => kernel.evaluate(coefficients, control, rotated), /parallel/);
  for (const readout of [1e-60, 1e60]) {
    assert.throws(() => kernel.fieldToDisplacement(new Float32Array([1, 1]), grid, { ...acquisition, readout }), /Float32/);
    assert.throws(() => kernel.displacementToField(new Float32Array([1, 0, 0, 1, 0, 0]), grid, { ...acquisition, readout }), /Float32/);
  }
});

test('oversized CSR grids fail clearly before large internal allocations', () => {
  const large = {
    shape: [256, 256, 128],
    affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  };
  assert.throws(() => kernel.approximate(new Float32Array(1), large), /CSR and buffers.*budget/);
  const control = { ...large, shape: [6,6,6] };
  assert.throws(() => kernel.evaluate(new Float32Array(1), control, large), /CSR and buffers.*budget/);
});
