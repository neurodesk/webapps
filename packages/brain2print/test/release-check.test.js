import assert from 'node:assert/strict';
import test from 'node:test';
import { createFloat32Nifti, extractNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import { createMesh } from '../src/pipeline.js';
import { ballNifti, niimathMesh } from '../src/node.js';
import { compareOutputs, measureOutputs } from '../validation/measure.mjs';

// A stand-in for MindGrab, so the release check's comparisons can be exercised without inference.
const mindgrab = {
  version: 'test',
  segmentTissues: async () => {
    const gm = ballNifti();
    const wm = createFloat32Nifti(new Float32Array(16 ** 3), extractNiftiHeader(gm));
    return { tissues: { gm: gm.buffer, wm, csf: wm, brain: wm }, backend: 'cpu', elapsedMs: 1 };
  },
};
const settings = { model: 'pve', simplify: 100, smooth: 0, largestOnly: true, fillBubbles: true };
const result = await createMesh({ input: new Uint8Array(1), settings, mindgrab, mesher: niimathMesh });
const written = () => new Map(result.files.map(({ name, bytes }) => [name, bytes.slice()]));
const expected = measureOutputs(written());

const failing = (files) => compareOutputs(measureOutputs(files), expected).filter(([passed]) => !passed).map(([, line]) => line);

test('identical files pass every comparison', () => {
  assert.deepEqual(failing(written()), []);
  assert.equal(expected.mz3.nonManifoldEdges, 0);
  assert.equal(expected.mz3.euler, 2);
  assert.ok(expected.stl.volumeMl > 3.5);
});

test('inward winding fails the normal and volume checks', () => {
  const files = written();
  for (const name of ['brain2print.stl', 'brain2print.mz3']) {
    const bytes = files.get(name);
    const view = new DataView(bytes.buffer);
    if (name.endsWith('.stl')) {
      // Swap each facet's second and third vertex.
      for (let f = 0; f < view.getUint32(80, true); f++) {
        const at = 84 + f * 50 + 24;
        const second = bytes.slice(at, at + 12);
        bytes.copyWithin(at, at + 12, at + 24);
        bytes.set(second, at + 12);
      }
    } else {
      for (let f = 0; f < view.getUint32(4, true); f++) {
        const at = 16 + f * 12;
        const second = view.getInt32(at + 4, true);
        view.setInt32(at + 4, view.getInt32(at + 8, true), true);
        view.setInt32(at + 8, second, true);
      }
    }
  }
  const lines = failing(files);
  assert.ok(lines.some((line) => line.startsWith('outward normals')), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('enclosed volume')));
});

test('a dropped triangle fails the counts and the manifold check', () => {
  const files = written();
  const mz3 = files.get('brain2print.mz3');
  const view = new DataView(mz3.buffer);
  const faces = view.getUint32(4, true);
  const vertices = view.getUint32(8, true);
  const shorter = new Uint8Array(mz3.length - 12);
  shorter.set(mz3.subarray(0, 16 + (faces - 1) * 12));
  shorter.set(mz3.subarray(16 + faces * 12), 16 + (faces - 1) * 12);
  new DataView(shorter.buffer).setUint32(4, faces - 1, true);
  files.set('brain2print.mz3', shorter);
  const lines = failing(files);
  assert.ok(lines.some((line) => line.startsWith(`${vertices} vertices and ${faces - 1} faces`)), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('closed manifold')));
  assert.ok(lines.some((line) => line.startsWith('STL has')));
});

test('a 1 % scale fails the volume and bounds checks', () => {
  const files = written();
  const stl = files.get('brain2print.stl');
  const view = new DataView(stl.buffer);
  for (let f = 0; f < view.getUint32(80, true); f++) {
    for (let i = 3; i < 12; i++) {
      const at = 84 + f * 50 + i * 4;
      view.setFloat32(at, view.getFloat32(at, true) * 1.01, true);
    }
  }
  const lines = failing(files);
  assert.ok(lines.some((line) => line.startsWith('enclosed volume')), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('bounds')));
});

test('a changed voxel or header fails the segmentation checks', () => {
  const voxel = written();
  const fraction = voxel.get('brain-fraction.nii');
  new DataView(fraction.buffer).setFloat32(352, 0.75, true);
  assert.ok(failing(voxel).some((line) => line.startsWith('segmentation sum')));
  const header = written();
  new DataView(header.get('brain-fraction.nii').buffer).setFloat32(80, 1.5, true);
  assert.ok(failing(header).some((line) => line.startsWith('segmentation NIfTI header')));
});

test('a missing file fails', () => {
  const files = written();
  files.delete('brain2print.stl');
  assert.ok(failing(files).length > 0);
});
