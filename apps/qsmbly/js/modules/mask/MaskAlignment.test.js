import { repairMaskAlignment, MaskAlignmentSession } from './MaskAlignment.js';
import { readNiftiImageData, sameNiftiGrid } from '../file-io/NiftiUtils.js';

function header(dims = [3, 2, 2]) {
  const h = new ArrayBuffer(352), v = new DataView(h);
  v.setInt32(0, 348, true); v.setInt16(40, 3, true);
  dims.forEach((n, i) => v.setInt16(42 + 2 * i, n, true));
  [1, 0.2, 0.2, 0.8].forEach((n, i) => v.setFloat32(76 + 4 * i, n, true));
  v.setFloat32(108, 352, true);
  new Uint8Array(h).set([110, 43, 49, 0], 344);
  return h;
}

test.each([
  [[false, false, false], 0], [[true, false, false], 2],
  [[false, true, false], 3], [[false, false, true], 6],
  [[true, true, false], 5], [[true, true, true], 11]
])('axis flips %j move an asymmetric landmark to index %i', (flips, index) => {
  const raw = new Float32Array(12); raw[0] = 255;
  const h = header();
  const result = repairMaskAlignment(raw, h, h, flips);
  expect(result.data[index]).toBe(1);
  expect(result.count).toBe(1);
  expect(raw[0]).toBe(255);
  expect(Array.from(readNiftiImageData(new Uint8Array(result.buffer)))).toEqual(Array.from(result.data));
  expect(sameNiftiGrid(result.buffer, h)).toBe(true);
});

test('previews always start from the uploaded mask and require explicit acceptance', async () => {
  const raw = new Float32Array(12); raw[0] = 1;
  const file = {name: 'mask.nii.gz'}, reference = {};
  const session = new MaskAlignmentSession(file, reference, raw, header(), header());
  expect(() => session.accept(file, reference)).toThrow(/Preview/);
  session.preview([true, true, false]);
  expect(session.preview([false, true, false]).data[3]).toBe(1);
  const accepted = session.accept(file, reference);
  expect(accepted.name).toBe('mask_aligned_Y.nii');
  expect(readNiftiImageData(new Uint8Array(await accepted.arrayBuffer()))[3]).toBe(1);
  expect(() => session.accept({}, reference)).toThrow(/Inputs changed/);
  session.invalidate();
  expect(() => session.accept(file, reference)).toThrow(/Preview/);
});

test('rejects geometry that cannot be repaired with axis flips', () => {
  const raw = new Float32Array(12).fill(1), h = header();
  expect(() => repairMaskAlignment(raw, header([2, 3, 2]), h)).toThrow(/dimensions/);
  const other = header(); new DataView(other).setFloat32(80, 3, true);
  expect(() => repairMaskAlignment(raw, other, h)).toThrow(/voxel sizes/);
  expect(() => repairMaskAlignment(raw.slice(1), h, h)).toThrow(/3D/);
  expect(() => repairMaskAlignment(new Float32Array(12), h, h)).toThrow(/foreground/);
});

test('explicit header-only repair preserves voxel order but uses the reference geometry', () => {
  const raw = new Float32Array(12); raw[1] = 1;
  const source = header(), reference = header();
  const v = new DataView(source);
  v.setInt16(252, 1, true); v.setFloat32(264, 1, true);
  expect(sameNiftiGrid(source, reference)).toBe(false);
  const result = repairMaskAlignment(raw, source, reference);
  expect(Array.from(result.data)).toEqual(Array.from(raw));
  expect(sameNiftiGrid(result.buffer, reference)).toBe(true);
  expect(v.getFloat32(264, true)).toBe(1);
});

test('rejects a 4D mask instead of silently using its first frame', () => {
  const source = header(); new DataView(source).setInt16(48, 2, true);
  expect(() => repairMaskAlignment(new Float32Array(12).fill(1), source, header())).toThrow(/3D/);
});
