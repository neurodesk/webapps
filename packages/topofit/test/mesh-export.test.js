import assert from 'node:assert/strict';
import test from 'node:test';
import { readMz3, writeMz3, writeStl } from '../src/results.js';

const vertices = Float32Array.from([0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4]);
const faces = Int32Array.from([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);

test('mz3 written for niimath survives a round trip', async () => {
  const bytes = new Uint8Array(writeMz3(vertices, faces));
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(0, true), 23117);
  assert.equal(view.getUint16(2, true), 3);
  assert.equal(view.getUint32(4, true), 4);
  assert.equal(view.getUint32(8, true), 4);
  assert.equal(bytes.length, 16 + 4 * 12 + 4 * 12);
  const mesh = await readMz3(bytes);
  assert.deepEqual([...mesh.vertices], [...vertices]);
  assert.deepEqual([...mesh.faces], [...faces]);
});

test('mz3 read accepts the gzip niimath writes, and rejects other bytes', async () => {
  const gzipped = new Uint8Array(await new Response(
    new Blob([writeMz3(vertices, faces)]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  assert.equal(gzipped[0], 0x1f);
  const mesh = await readMz3(gzipped);
  assert.deepEqual([...mesh.faces], [...faces]);
  await assert.rejects(() => readMz3(new Uint8Array(32)), /Not an mz3 mesh/);
  await assert.rejects(() => readMz3(new Uint8Array(writeMz3(vertices, faces)).slice(0, 40)), /Truncated/);
});

test('binary STL carries every triangle with an outward unit normal', () => {
  const stl = new Uint8Array(writeStl(vertices, faces));
  const view = new DataView(stl.buffer);
  assert.equal(stl.length, 84 + 4 * 50);
  assert.deepEqual([...stl.slice(0, 80)], Array(80).fill(0), 'a binary STL header must not read as ASCII');
  assert.equal(view.getUint32(80, true), 4);
  // First facet: (0,0,0) (2,0,0) (0,3,0) is counter-clockwise seen from +z.
  assert.deepEqual([0, 1, 2].map((i) => view.getFloat32(84 + i * 4, true)), [0, 0, 1]);
  assert.deepEqual([3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => view.getFloat32(84 + i * 4, true)), [0, 0, 0, 2, 0, 0, 0, 3, 0]);
  for (let i = 0; i < 4; i += 1) {
    const normal = [0, 1, 2].map((axis) => view.getFloat32(84 + i * 50 + axis * 4, true));
    assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-6, `facet ${i} normal is not a unit vector`);
  }
});
