// The synthetic two-hemisphere sheet of the region tests, shared with the compatibility
// check that compares a search's outputs with recorded hashes.
export function source(dims) {
  const header = new ArrayBuffer(348);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  for (let i = 1; i < 4; i += 1) {
    view.setInt16(40 + i * 2, dims[i - 1], true);
    view.setFloat32(76 + i * 4, 1, true);
  }
  view.setInt16(254, 1, true);
  for (const offset of [280, 300, 320]) view.setFloat32(offset, 1, true);
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  return { dims, affine, data: new Float32Array(dims[0] * dims[1] * dims[2]), source: header, header: { littleEndian: true } };
}

function plane(size) {
  const white = [];
  const faces = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      white.push(x, y, 0);
      const a = x + y * size;
      if (x + 1 < size && y + 1 < size) faces.push(a, a + 1, a + size, a + 1, a + size + 1, a + size);
    }
  }
  const pial = Float64Array.from(white, (v, i) => i % 3 === 2 ? v + 2 : v);
  return { white: Float64Array.from(white), pial, faces: Int32Array.from(faces) };
}

// A flat 31 x 31 mm sheet in both hemispheres. Vertices with x < 15 register to the
// first atlas vertex, the rest to the second; both atlas vertices are cortex.
export function fixture(labels = {}) {
  const { white, pial, faces } = plane(31);
  const registration = Float64Array.from(white, (_, i) => {
    const x = white[i - i % 3];
    return (i % 3) === (x < 15 ? 0 : 1) ? 100 : 0;
  });
  const vertices = {};
  const triangles = {};
  for (const hemisphere of ['lh', 'rh']) {
    vertices[`${hemisphere}.white`] = white;
    vertices[`${hemisphere}.pial`] = pial;
    vertices[`${hemisphere}.registration`] = registration;
    triangles[hemisphere] = faces;
  }
  const atlas = new ArrayBuffer(4 + 2 * 14);
  const view = new DataView(atlas);
  view.setUint32(0, 2, true);
  view.setFloat32(4, 1, true);
  view.setFloat32(20, 1, true);
  new Uint8Array(atlas).set([1, 1, 1, 1], 28);
  const regions = new Uint8Array(4 + 2 * 4);
  new DataView(regions.buffer).setUint32(0, 2, true);
  const layout = { wang2015: { lh: [1, 0], rh: [0, 0] }, aparc: { lh: [0, 0], rh: [0, 0] }, ...labels };
  regions.set([...layout.wang2015.lh, ...layout.wang2015.rh, ...layout.aparc.lh, ...layout.aparc.rh], 4);
  return {
    source: source([32, 32, 4]),
    vertices,
    faces: triangles,
    estimateNormals: false,
    patches: { radius: 5, count: 3, hemisphere: 'lh' },
    loadAtlas: async () => atlas.slice(0),
    loadRegions: async () => regions.buffer.slice(0),
  };
}

// A NIfTI-2 float32 scan. `srow` is written whatever the codes; the qform comes from the
// quaternion (b, c, d), `offset`, `pixdim` and `qfac` (pixdim[0]).
export function nifti2Buffer(dims, srow, { sformCode = 1, qformCode = 0, quaternion = [0, 0, 0], offset = [0, 0, 0], pixdim = srow.map((row, axis) => row[axis]), qfac = 1 } = {}) {
  const count = dims[0] * dims[1] * dims[2];
  const buffer = new ArrayBuffer(544 + count * 4);
  const view = new DataView(buffer);
  view.setInt32(0, 540, true);
  new Uint8Array(buffer).set([110, 43, 50, 0, 13, 10, 26, 10], 4);
  view.setInt16(12, 16, true);
  view.setInt16(14, 32, true);
  view.setBigInt64(16, 3n, true);
  for (let i = 1; i < 8; i += 1) view.setBigInt64(16 + i * 8, BigInt(dims[i - 1] ?? 1), true);
  view.setFloat64(104, qfac, true);
  pixdim.forEach((size, axis) => view.setFloat64(112 + axis * 8, size, true));
  view.setBigInt64(168, 544n, true);
  view.setFloat64(176, 1, true);
  view.setInt32(344, qformCode, true);
  view.setInt32(348, sformCode, true);
  [...quaternion, ...offset].forEach((value, index) => view.setFloat64(352 + index * 8, value, true));
  srow.forEach((row, axis) => row.forEach((value, column) => view.setFloat64(400 + (axis * 4 + column) * 8, value, true)));
  view.setInt32(500, 2, true);
  for (let i = 0; i < count; i += 1) view.setFloat32(544 + i * 4, i % 17, true);
  return buffer;
}
