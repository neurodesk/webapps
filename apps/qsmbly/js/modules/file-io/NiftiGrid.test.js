import { sameNiftiGrid } from './NiftiUtils.js';

function header() {
  const buffer = new ArrayBuffer(352);
  const h = new DataView(buffer);
  [96, 82, 18].forEach((d, i) => h.setInt16(42 + i * 2, d, true));
  [1, 0.167, 0.195, 0.8].forEach((d, i) => h.setFloat32(76 + i * 4, d, true));
  h.setInt16(254, 1, true);
  h.setUint8(123, 2);
  [0.167, 0, 0, -8, 0, 0.195, 0, -1, 0, 0, 0.8, -8].forEach((d, i) => h.setFloat32(280 + i * 4, d, true));
  return buffer;
}

test('allows converter float32 rounding but rejects translated and flipped grids', () => {
  const a = header(), b = header(), h = new DataView(b);
  h.setFloat32(292, -8.000002, true);
  expect(sameNiftiGrid(a, b)).toBe(true);
  h.setFloat32(292, -7, true);
  expect(sameNiftiGrid(a, b)).toBe(false);
  h.setFloat32(292, -8, true);
  h.setFloat32(280, -0.167, true);
  expect(sameNiftiGrid(a, b)).toBe(false);
});

test('qform-only and sform representations of the same grid match', () => {
  const a = header(), b = header(), h = new DataView(b);
  h.setInt16(254, 0, true);
  h.setInt16(252, 1, true);
  [-8, -1, -8].forEach((d, i) => h.setFloat32(268 + i * 4, d, true));
  expect(sameNiftiGrid(a, b)).toBe(true);
  h.setFloat32(76, -1, true);
  expect(sameNiftiGrid(a, b)).toBe(false);
});

test('honors spatial units and rejects nonfinite transforms', () => {
  const a = header(), b = header(), h = new DataView(b);
  h.setUint8(123, 1);
  for (let offset = 280; offset < 328; offset += 4) h.setFloat32(offset, h.getFloat32(offset, true) / 1000, true);
  expect(sameNiftiGrid(a, b)).toBe(true);
  h.setFloat32(280, NaN, true);
  expect(sameNiftiGrid(a, b)).toBe(false);
});
