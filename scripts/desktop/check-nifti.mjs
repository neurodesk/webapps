import assert from 'node:assert/strict';
import { readVolume } from '../../packages/synthsr/src/volume.js';

export function verifyNiftiOffset(inputBytes, outputBytes, offset) {
  const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const input = readVolume(buffer(inputBytes));
  const output = readVolume(buffer(outputBytes));
  assert.deepEqual(output.dims, input.dims, 'Output dimensions changed');
  assert.deepEqual(output.affine, input.affine, 'Output spatial transform changed');
  let maximumError = 0;
  for (let index = 0; index < input.data.length; index++) {
    maximumError = Math.max(maximumError, Math.abs(output.data[index] - (input.data[index] + offset)));
  }
  assert.ok(maximumError <= 1e-5, `Unexpected voxel values: maximum error ${maximumError}`);
  return { voxels: output.data.length, maximumError };
}
