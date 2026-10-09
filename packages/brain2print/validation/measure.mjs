// What the release check compares, measured straight from the written files with parsers of its
// own, so neither the browser run nor the command line grades itself with the code that wrote it.
import { createHash } from 'node:crypto';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const VOXEL_READERS = {
  2: (view, offset) => view.getUint8(offset),
  4: (view, offset) => view.getInt16(offset, true),
  8: (view, offset) => view.getInt32(offset, true),
  16: (view, offset) => view.getFloat32(offset, true),
  512: (view, offset) => view.getUint16(offset, true),
};

function measureVolume(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== 348) throw new Error('The segmentation is not an uncompressed NIfTI-1 file.');
  const dims = [1, 2, 3].map((axis) => view.getInt16(40 + axis * 2, true));
  const datatype = view.getInt16(70, true);
  const read = VOXEL_READERS[datatype];
  if (!read) throw new Error(`Unexpected NIfTI datatype ${datatype}.`);
  const step = view.getInt16(72, true) / 8;
  const start = Math.round(view.getFloat32(108, true));
  const count = dims[0] * dims[1] * dims[2];
  let inside = 0;
  let sum = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let i = 0; i < count; i++) {
    const value = read(view, start + i * step);
    if (value >= 0.5) inside++;
    sum += value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return { dims, datatype, headerSha256: sha256(bytes.subarray(0, 352)), inside, sum: Number(sum.toFixed(3)), minimum, maximum };
}

// Binary STL facets and the volume they enclose; a positive volume means outward winding in world space.
function measureStl(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  if (bytes.byteLength !== 84 + triangles * 50) throw new Error('The STL is not a complete binary STL.');
  let volume = 0;
  let contradicting = 0;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let f = 0; f < triangles; f++) {
    const at = (i) => view.getFloat32(84 + f * 50 + i * 4, true);
    const [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from({ length: 12 }, (_, i) => at(i));
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    if (nx * (uy * vz - uz * vy) + ny * (uz * vx - ux * vz) + nz * (ux * vy - uy * vx) < 0) contradicting++;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      [x, y, z].forEach((value, axis) => {
        low[axis] = Math.min(low[axis], value);
        high[axis] = Math.max(high[axis], value);
      });
    }
  }
  const round = (values) => values.map((value) => Number(value.toFixed(3)));
  return { triangles, volumeMl: Number((volume / 6000).toFixed(3)), contradicting, bounds: [round(low), round(high)] };
}

// Uncompressed MZ3 as Brain2Print writes it: every edge shared by exactly two faces in
// opposite directions makes a closed, consistently wound manifold.
function measureMz3(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 23117 || view.getUint16(2, true) !== 3) throw new Error('The MZ3 is not an uncompressed faces-and-vertices mesh.');
  const faces = view.getUint32(4, true);
  const vertices = view.getUint32(8, true);
  const start = 16 + view.getUint32(12, true);
  if (bytes.byteLength !== start + faces * 12 + vertices * 12) throw new Error('The MZ3 has the wrong length.');
  const edges = new Map();
  for (let f = 0; f < faces; f++) {
    const corners = [0, 1, 2].map((corner) => view.getInt32(start + (f * 3 + corner) * 4, true));
    for (let k = 0; k < 3; k++) {
      const from = corners[k];
      const to = corners[(k + 1) % 3];
      const key = Math.min(from, to) * vertices + Math.max(from, to);
      const edge = edges.get(key) ?? { uses: 0, balance: 0 };
      edge.uses++;
      edge.balance += from < to ? 1 : -1;
      edges.set(key, edge);
    }
  }
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const { uses, balance } of edges.values()) {
    if (uses !== 2) nonManifoldEdges++;
    if (balance !== 0) inconsistentEdges++;
  }
  // Euler characteristic: 2 for each closed genus-0 component.
  return { vertices, faces, edges: edges.size, euler: vertices - edges.size + faces, nonManifoldEdges, inconsistentEdges };
}

/** `files` maps file names to their bytes. */
export function measureOutputs(files) {
  const segmentationName = files.has('brain-fraction.nii') ? 'brain-fraction.nii' : 'segmentation.nii';
  const measured = {
    files: [...files.keys()].sort(),
    sha256: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]).sort()),
    segmentation: files.has(segmentationName) ? measureVolume(files.get(segmentationName)) : null,
    stl: files.has('brain2print.stl') ? measureStl(files.get('brain2print.stl')) : null,
    mz3: files.has('brain2print.mz3') ? measureMz3(files.get('brain2print.mz3')) : null,
  };
  return measured;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** [passed, line] pairs holding `measured` to the browser's measurements `want`. */
export function compareOutputs(measured, want) {
  const { segmentation, stl, mz3 } = measured;
  const lines = [[same(measured.files, want.files), `files ${measured.files.join(', ')}`]];
  if (!segmentation || !stl || !mz3) return [...lines, [false, 'a segmentation, an STL and an MZ3 were written']];
  lines.push(
    [segmentation.headerSha256 === want.segmentation.headerSha256, `segmentation NIfTI header identical to the browser's (${segmentation.dims.join(' x ')}, datatype ${segmentation.datatype})`],
    [segmentation.inside === want.segmentation.inside, `${segmentation.inside} voxels at or above 0.5, browser ${want.segmentation.inside}`],
    [segmentation.sum === want.segmentation.sum && segmentation.minimum === want.segmentation.minimum && segmentation.maximum === want.segmentation.maximum, `segmentation sum ${segmentation.sum} in [${segmentation.minimum}, ${segmentation.maximum}], browser ${want.segmentation.sum} in [${want.segmentation.minimum}, ${want.segmentation.maximum}]`],
    [mz3.vertices === want.mz3.vertices && mz3.faces === want.mz3.faces, `${mz3.vertices} vertices and ${mz3.faces} faces, browser ${want.mz3.vertices} and ${want.mz3.faces}`],
    [mz3.nonManifoldEdges === 0 && mz3.inconsistentEdges === 0, `closed manifold with consistent winding (${mz3.nonManifoldEdges} non-manifold, ${mz3.inconsistentEdges} inconsistent edges; Euler characteristic ${mz3.euler})`],
    [stl.triangles === mz3.faces, `STL has the MZ3's ${mz3.faces} triangles (${stl.triangles})`],
    [stl.volumeMl > 0 && stl.contradicting === 0, `outward normals: enclosed volume ${stl.volumeMl} ml, ${stl.contradicting} facet normals against the winding`],
    [stl.volumeMl === want.stl.volumeMl, `enclosed volume ${stl.volumeMl} ml, browser ${want.stl.volumeMl} ml`],
    [same(stl.bounds, want.stl.bounds), `bounds ${JSON.stringify(stl.bounds)} mm, browser ${JSON.stringify(want.stl.bounds)}`],
  );
  for (const name of Object.keys(want.sha256)) {
    const digest = measured.sha256[name];
    lines.push([digest === want.sha256[name], `${name} identical to the browser's (${digest?.slice(0, 16)}, browser ${want.sha256[name].slice(0, 16)})`]);
  }
  return lines;
}
