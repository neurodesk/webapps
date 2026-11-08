import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeMrc } from '../../../test-utils/relion-simulator.mjs';
import { displayRange, imagePixels, mrcImage, readMrc } from '../src/mrc.js';

const bytes = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

test('reads a float32 volume with its pixel size', () => {
  const data = Float32Array.from({ length: 4 * 3 * 2 }, (_, index) => index - 5);
  const mrc = readMrc(bytes(writeMrc({ nx: 4, ny: 3, nz: 2, data, angpix: 1.77 })));
  assert.deepEqual([mrc.nx, mrc.ny, mrc.nz, mrc.mode, mrc.stack], [4, 3, 2, 2, false]);
  assert.ok(Math.abs(mrc.angpix - 1.77) < 1e-6);
  assert.deepEqual([...mrc.data], [...data]);
});

test('an .mrcs stack is a stack and its images are addressed by index', () => {
  const data = Float32Array.from({ length: 2 * 2 * 3 }, (_, index) => index);
  const mrc = readMrc(bytes(writeMrc({ nx: 2, ny: 2, nz: 3, data, stack: true })));
  assert.equal(mrc.stack, true);
  assert.deepEqual([...mrcImage(mrc, 2)], [8, 9, 10, 11]);
});

test('reads float16, int16 and big-endian files', () => {
  const header = (mode, little = true) => {
    const buffer = new ArrayBuffer(1024 + 4);
    const view = new DataView(buffer);
    for (const [offset, value] of [[0, 2], [4, 1], [8, 1], [12, mode]]) view.setInt32(offset, value, little);
    view.setUint8(212, little ? 0x44 : 0x11);
    return { buffer, view };
  };
  const half = header(12);
  half.view.setUint16(1024, 0x3c00, true);
  half.view.setUint16(1026, 0xc000, true);
  assert.deepEqual([...readMrc(half.buffer).data], [1, -2]);
  const big = header(1, false);
  big.view.setInt16(1024, -300, false);
  big.view.setInt16(1026, 7, false);
  assert.deepEqual([...readMrc(big.buffer).data], [-300, 7]);
});

test('refuses truncated files and unsupported modes', () => {
  assert.throws(() => readMrc(new ArrayBuffer(100)), /1024-byte header/);
  const short = bytes(writeMrc({ nx: 4, ny: 4, data: new Float32Array(16) })).slice(0, 1030);
  assert.throws(() => readMrc(short), /shorter than its dimensions/);
  const odd = bytes(writeMrc({ nx: 1, ny: 1, data: new Float32Array(1) }));
  new DataView(odd).setInt32(12, 4, true);
  assert.throws(() => readMrc(odd), /mode 4/);
});

test('display pixels put the first file row at the bottom', () => {
  const image = Float32Array.from([0, 0, 10, 10]);
  const pixels = imagePixels(image, 2, 2, [0, 10]);
  assert.deepEqual([pixels[0], pixels[8]], [255, 0]);
  assert.deepEqual(displayRange(Float32Array.from({ length: 101 }, (_, index) => index)), [1, 99]);
});
