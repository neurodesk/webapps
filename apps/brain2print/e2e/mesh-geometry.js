// Independent checks for the pipeline specs. Nothing here imports app code: the STL and MZ3
// are parsed from their file formats and the brain volume is counted from the downloaded image.
import { readVolume } from '../../../packages/synthsr/src/volume.js';

const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

/** Edge census and signed volume of an indexed triangle mesh. A printable surface is closed
 *  (every edge shared by exactly two triangles), consistently wound (the two triangles traverse
 *  the edge in opposite directions) and encloses a positive volume in right-handed world space. */
function census(positions, indices) {
  const vertices = positions.length / 3;
  const uses = new Map();
  const balance = new Map();
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    const [ax, ay, az] = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
    const [bx, by, bz] = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
    const [cx, cy, cz] = [positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]];
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(from, to) * vertices + Math.max(from, to);
      uses.set(key, (uses.get(key) ?? 0) + 1);
      balance.set(key, (balance.get(key) ?? 0) + (from < to ? 1 : -1));
    }
  }
  let openEdges = 0;
  let misorientedEdges = 0;
  for (const count of uses.values()) if (count !== 2) openEdges += 1;
  for (const sum of balance.values()) if (sum !== 0) misorientedEdges += 1;
  return {
    vertices,
    triangles: indices.length / 3,
    edges: uses.size,
    openEdges,
    misorientedEdges,
    volume: volume / 6,
  };
}

/** Binary STL: vertices are welded by their exact coordinates, which is how a slicer rebuilds
 *  the surface. `contradicting` counts stored facet normals that oppose the winding; zero
 *  normals are allowed by the format and mean "derive from winding". */
export function inspectStl(bytes) {
  const triangles = bytes.readUInt32LE(80);
  if (bytes.length !== 84 + triangles * 50) throw new Error(`STL holds ${bytes.length} bytes, not the ${84 + triangles * 50} its ${triangles} triangles need`);
  const ids = new Map();
  const positions = [];
  const indices = [];
  let contradicting = 0;
  for (let f = 0; f < triangles; f++) {
    const values = Array.from({ length: 12 }, (_, i) => bytes.readFloatLE(84 + f * 50 + i * 4));
    const [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz] = values;
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    if (nx * (uy * vz - uz * vy) + ny * (uz * vx - ux * vz) + nz * (ux * vy - uy * vx) < 0) contradicting += 1;
    for (let corner = 0; corner < 3; corner++) {
      const key = bytes.toString('latin1', 96 + f * 50 + corner * 12, 108 + f * 50 + corner * 12);
      if (!ids.has(key)) {
        ids.set(key, positions.length / 3);
        positions.push(values[3 + corner * 3], values[4 + corner * 3], values[5 + corner * 3]);
      }
      indices.push(ids.get(key));
    }
  }
  return { ...census(positions, indices), contradicting };
}

/** Uncompressed MZ3 with faces and vertices only: 16-byte header, int32 faces, float32 vertices. */
export function inspectMz3(bytes) {
  if (bytes.readUInt16LE(0) !== 23117) throw new Error('Not an uncompressed MZ3 file');
  if (bytes.readUInt16LE(2) !== 3) throw new Error('MZ3 must hold faces and vertices only');
  const faces = bytes.readUInt32LE(4);
  const vertices = bytes.readUInt32LE(8);
  const start = 16 + bytes.readUInt32LE(12);
  if (bytes.length !== start + faces * 12 + vertices * 12) throw new Error('MZ3 length does not match its header');
  const indices = Array.from({ length: faces * 3 }, (_, i) => bytes.readInt32LE(start + i * 4));
  const positions = Array.from({ length: vertices * 3 }, (_, i) => bytes.readFloatLE(start + faces * 12 + i * 4));
  return census(positions, indices);
}

const determinant = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
  - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
  + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

/** Grid of a NIfTI file and the volume of the voxels at or above `threshold`, in mm^3. */
export function voxelVolume(bytes, threshold) {
  const { data, dims, affine } = readVolume(arrayBuffer(bytes));
  let inside = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of data) {
    if (value >= threshold) inside += 1;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { dims, affine, minimum, maximum, handedness: Math.sign(determinant(affine)), volume: inside * Math.abs(determinant(affine)) };
}

/** Distinct values of a label image. */
export function labels(bytes) {
  const { data, dims } = readVolume(arrayBuffer(bytes));
  return { dims, values: [...new Set(data)].sort((a, b) => a - b) };
}

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Volume in mm^3 enclosed by a closed surface around the non-zero voxels once interior cavities
 *  are filled: every voxel the background cannot reach from the grid border. `dilate` first
 *  grows the labels by one voxel, the upper bound for a surface within one voxel of them. */
export function enclosedVolume(bytes, { dilate = false } = {}) {
  const { data, dims: [nx, ny, nz], affine } = readVolume(arrayBuffer(bytes));
  const at = (i, j, k) => i + nx * (j + ny * k);
  const inGrid = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz;
  let inside = Uint8Array.from(data, (value) => (value >= 0.5 ? 1 : 0));
  if (dilate) {
    const grown = Uint8Array.from(inside);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!inside[at(i, j, k)]) continue;
      for (const [a, b, c] of NEIGHBOURS) if (inGrid(i + a, j + b, k + c)) grown[at(i + a, j + b, k + c)] = 1;
    }
    inside = grown;
  }
  const outside = new Uint8Array(inside.length);
  const queue = [];
  const visit = (i, j, k) => {
    if (!inGrid(i, j, k) || inside[at(i, j, k)] || outside[at(i, j, k)]) return;
    outside[at(i, j, k)] = 1;
    queue.push([i, j, k]);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) visit(i, j, k);
  }
  while (queue.length) {
    const [i, j, k] = queue.pop();
    for (const [a, b, c] of NEIGHBOURS) visit(i + a, j + b, k + c);
  }
  let enclosed = 0;
  for (const value of outside) enclosed += 1 - value;
  return enclosed * Math.abs(determinant(affine));
}
