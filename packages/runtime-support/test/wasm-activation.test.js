import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmActivation, activationUses, releaseConsumedActivations } from '../src/streamed-onnx/activation.js';

test('activation storage preserves NCDHW slab reads and writes across arbitrary chunks', () => {
  const channels = 3;
  const depth = 7;
  const plane = 15;
  const length = channels * depth * plane;
  const values = Float32Array.from({ length }, (_, i) => Math.fround((i - 151) / 13));
  for (const chunkElements of [1, 7, 15, 16, 31, 105, 106, length + 1]) {
    const source = new WasmActivation(length, chunkElements);
    const target = new WasmActivation(length, chunkElements);
    source.set(values);
    assert.ok(source.chunks.every(chunk => chunk.length <= chunkElements));
    assert.equal(source.chunks.reduce((sum, chunk) => sum + chunk.length, 0), length);
    for (let start = 0; start < depth; start += 2) {
      const end = Math.min(depth, start + 2);
      const count = (end - start) * plane;
      const slab = new Float32Array(channels * count);
      for (let channel = 0; channel < channels; channel++) {
        const offset = (channel * depth + start) * plane;
        source.copyTo(slab, offset, offset + count, channel * count);
        assert.deepEqual(slab.subarray(channel * count, (channel + 1) * count), values.subarray(offset, offset + count));
        target.set(slab.subarray(channel * count, (channel + 1) * count), offset);
      }
    }
    const actual = new Float32Array(length);
    target.copyTo(actual);
    assert.deepEqual(actual, values);
    const repeated = new Float32Array(length + 4);
    target.copyTo(repeated, 0, length, 2);
    assert.deepEqual(repeated.subarray(2, -2), values);
    assert.deepEqual(repeated.subarray(0, 2), new Float32Array(2));
  }
});

test('default activation chunks cap each backing store at 32 MiB', () => {
  const cap = 8 * 1024 * 1024;
  const activation = new WasmActivation(cap + 3);
  assert.deepEqual(activation.chunks.map(chunk => chunk.length), [cap, 3]);
  const values = new Float32Array([1, -2, 3, -4, 5]);
  activation.set(values, cap - 2);
  const actual = new Float32Array(5);
  activation.copyTo(actual, cap - 2, cap + 3);
  assert.deepEqual(actual, values);
});
test('activation lifetimes follow tensor names through repeated inputs, skips and reused GPU slots', () => {
  const nodes = [
    { inputs: ['input', 'weights'], output: 'skip', slot: 1 },
    { inputs: ['skip'], output: 'deep', slot: 0 },
    { inputs: ['deep', 'deep'], output: 'decoded', slot: 2 },
    { inputs: ['decoded', 'skip'], output: 'output', slot: 0 },
  ];
  const remaining = activationUses(nodes, { weights: {} });
  assert.equal(remaining.has('weights'), false);
  assert.equal(remaining.get('deep'), 2);
  assert.equal(remaining.get('skip'), 2);
  const activation = new Map([['input', new WasmActivation(1)]]);
  const expected = [['skip'], ['skip', 'deep'], ['skip', 'decoded'], ['output']];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    activation.set(node.output, new WasmActivation(1));
    for (const name of node.inputs.filter(name => name !== 'weights')) {
      assert.ok(activation.has(name), `input ${name} survives all slabs`);
    }
    releaseConsumedActivations(activation, remaining, node.inputs);
    assert.deepEqual([...activation.keys()], expected[index]);
  }
  assert.equal(remaining.get('output'), 1);
});
