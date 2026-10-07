
// mz3 is the only mesh format the niimath WebAssembly build can read and write (its STL and GIfTI
// writers are behind HAVE_FORMATS, which that build omits), so it is how simplified and smoothed
// geometry travels to and from niimath. STL is what slicers and 3D printers take.
const MZ3_SIGNATURE = 23117;

export function writeMz3(vertices, faces) {
  const buffer = new ArrayBuffer(16 + faces.length * 4 + vertices.length * 4);
  const view = new DataView(buffer);
  view.setUint16(0, MZ3_SIGNATURE, true);
  view.setUint16(2, 3, true); // faces and vertices, no colours or scalars
  view.setUint32(4, faces.length / 3, true);
  view.setUint32(8, vertices.length / 3, true);
  view.setUint32(12, 0, true);
  let offset = 16;
  for (const value of faces) {
    view.setInt32(offset, value, true);
    offset += 4;
  }
  for (const value of vertices) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  return buffer;
}

export async function readMz3(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const raw = input[0] === 0x1f && input[1] === 0x8b // niimath gzips the mz3 it writes
    ? new Uint8Array(await new Response(new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : input;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.byteLength < 16 || view.getUint16(0, true) !== MZ3_SIGNATURE) throw new Error('Not an mz3 mesh.');
  if ((view.getUint16(2, true) & 3) !== 3) throw new Error('The mz3 mesh has no faces or vertices.');
  const faceBytes = view.getUint32(4, true) * 12;
  const vertexBytes = view.getUint32(8, true) * 12;
  const start = 16 + view.getUint32(12, true);
  if (raw.byteLength < start + faceBytes + vertexBytes) throw new Error('Truncated mz3 mesh.');
  // slice() copies into fresh buffers, so the typed-array views are aligned whatever NSKIP was.
  const faces = raw.slice(start, start + faceBytes);
  const vertices = raw.slice(start + faceBytes, start + faceBytes + vertexBytes);
  return { vertices: new Float32Array(vertices.buffer), faces: new Int32Array(faces.buffer) };
}

export function writeStl(vertices, faces) {
  const triangles = faces.length / 3;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true); // the 80-byte header stays zeroed: "solid" there reads as ASCII STL
  let offset = 84;
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = [faces[i] * 3, faces[i + 1] * 3, faces[i + 2] * 3];
    const [ux, uy, uz] = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
    const [vx, vy, vz] = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]];
    const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...normal) || 1; // a degenerate triangle keeps a zero normal
    for (const value of [...normal.map((n) => n / length),
      vertices[a], vertices[a + 1], vertices[a + 2],
      vertices[b], vertices[b + 1], vertices[b + 2],
      vertices[c], vertices[c + 1], vertices[c + 2]]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    offset += 2; // attribute byte count
  }
  return buffer;
}
