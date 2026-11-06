import assert from 'node:assert/strict';
import test from 'node:test';
import { readFreeSurferCurv, readMz3, writeMz3, writeMz3Scalars, writeStl } from '../src/file-io/mesh.js';

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

test('scalar-only mz3 carries one float per vertex and no geometry', () => {
  const values = Float32Array.from([0, 1.5, -2, 3.25]);
  const bytes = new Uint8Array(writeMz3Scalars(values));
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(0, true), 23117);
  assert.equal(view.getUint16(2, true), 8, 'attribute 8 marks scalars only');
  assert.equal(view.getUint32(4, true), 0, 'no faces');
  assert.equal(view.getUint32(8, true), values.length, 'NVERT is the vertex count the layer must match');
  assert.equal(bytes.length, 16 + values.length * 4);
  assert.deepEqual([...new Float32Array(bytes.buffer.slice(16))], [...values]);
});

test('a FreeSurfer curvature file reads one big-endian float per vertex', () => {
  const values = [-0.25, 0, 0.5];
  const bytes = new Uint8Array(15 + values.length * 4);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xff, 0xff]);
  view.setInt32(3, values.length, false);
  view.setInt32(7, 2, false);
  view.setInt32(11, 1, false);
  values.forEach((value, index) => view.setFloat32(15 + index * 4, value, false));
  assert.deepEqual([...readFreeSurferCurv(bytes)], values);
  assert.throws(() => readFreeSurferCurv(bytes.subarray(0, 20)), /Truncated/);
  assert.throws(() => readFreeSurferCurv(new Uint8Array(20)), /Not a FreeSurfer/);
});

test('mz3 with colours carries one RGBA quadruple per vertex after the geometry', async () => {
  const colors = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 128]);
  const bytes = new Uint8Array(writeMz3(vertices, faces, colors));
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(2, true), 7);
  assert.equal(bytes.byteLength, 16 + faces.length * 4 + vertices.length * 4 + colors.length);
  assert.deepEqual(bytes.slice(-colors.length), colors);
  const read = await readMz3(bytes);
  assert.deepEqual(Array.from(read.vertices), Array.from(vertices));
  assert.deepEqual(Array.from(read.faces), Array.from(faces));
  assert.throws(() => writeMz3(vertices, faces, colors.slice(4)), /four bytes per vertex/);
});
