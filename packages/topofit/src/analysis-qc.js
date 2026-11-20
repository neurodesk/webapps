import { inverseAffine } from './volume.js';
import { roundEven, writeInt16Nifti, writeUint8Nifti } from './qc.js';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const transform = (matrix, point) => matrix.slice(0, 3).map((row) => dot(row.slice(0, 3), point) + row[3]);

export function triangleVoxelMask(volume, vertices, faces) {
  const mask = new Uint8Array(volume.data.length);
  const inverse = inverseAffine(volume.affine);
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const points = new Float64Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) points.set(transform(inverse, Array.from(vertices.subarray(i, i + 3))), i);
  for (let i = 0; i < faces.length; i += 3) {
    const triangle = Array.from(faces.subarray(i, i + 3), (v) => Array.from(points.subarray(v * 3, v * 3 + 3)));
    const edges = triangle.map((p, j) => sub(triangle[(j + 1) % 3], p));
    const testAxes = [...axes, cross(edges[0], edges[1]), ...edges.flatMap((edge) => axes.map((axis) => cross(edge, axis)))];
    const projections = testAxes.filter((axis) => dot(axis, axis) > 1e-16).map((axis) => ({
      axis,
      radius: 0.5 * axis.reduce((sum, v) => sum + Math.abs(v), 0),
      min: Math.min(...triangle.map((p) => dot(p, axis))),
      max: Math.max(...triangle.map((p) => dot(p, axis))),
    }));
    const low = axes.map((_, a) => Math.max(0, Math.ceil(Math.min(...triangle.map((p) => p[a])) - 0.5)));
    const high = axes.map((_, a) => Math.min(volume.dims[a] - 1, Math.floor(Math.max(...triangle.map((p) => p[a])) + 0.5)));
    for (let z = low[2]; z <= high[2]; z += 1) {
      for (let y = low[1]; y <= high[1]; y += 1) {
        for (let x = low[0]; x <= high[0]; x += 1) {
          if (projections.every(({ axis, radius, min, max }) => {
            const center = dot([x, y, z], axis);
            return min - center <= radius && max - center >= -radius;
          })) mask[x + volume.dims[0] * (y + volume.dims[1] * z)] = 1;
        }
      }
    }
  }
  return mask;
}

function normalGlyph(volume, mask, patch, output) {
  const inverse = inverseAffine(volume.affine);
  const centerVoxel = transform(inverse, patch.center_ras_mm);
  const occupied = new Set();
  const planeSize = volume.dims[0] * volume.dims[1];
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) occupied.add(Math.floor(i / planeSize));
  if (!occupied.size) return;
  const slice = [...occupied].sort((a, b) => Math.abs(a - centerVoxel[2]) - Math.abs(b - centerVoxel[2]))[0];
  const center = centerVoxel.slice(0, 2).map((v, i) => Math.max(0, Math.min(volume.dims[i] - 1, roundEven(v))));
  const zooms = [0, 1].map((axis) => Math.hypot(...volume.affine.slice(0, 3).map((row) => row[axis])));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < volume.dims[0] && y < volume.dims[1]) output[x + volume.dims[0] * y + slice * planeSize] = 4095;
  };
  const radius = 4;
  for (let y = center[1] - Math.ceil(radius / zooms[1]) - 1; y <= center[1] + Math.ceil(radius / zooms[1]) + 1; y += 1) {
    for (let x = center[0] - Math.ceil(radius / zooms[0]) - 1; x <= center[0] + Math.ceil(radius / zooms[0]) + 1; x += 1) {
      if (Math.abs(Math.hypot((x - center[0]) * zooms[0], (y - center[1]) * zooms[1]) - radius) <= Math.max(...zooms) * 0.6) mark(x, y);
    }
  }
  const vector = inverse.slice(0, 3).map((row) => 20 * dot(row.slice(0, 3), patch.normal_ras));
  const endpoint = center.map((v, i) => v + vector[i]);
  const line = (from, to) => {
    const count = Math.max(2, Math.ceil(Math.hypot(...sub(to, from)) * 2) + 1);
    for (let i = 0; i < count; i += 1) mark(...from.map((v, axis) => roundEven(v + (to[axis] - v) * i / (count - 1))));
  };
  line(center, endpoint);
  const length = Math.hypot(vector[0], vector[1]);
  if (length >= 3) {
    const direction = vector.slice(0, 2).map((v) => v / length);
    const arm = Math.min(3, length * 0.4);
    for (const side of [-1, 1]) line(endpoint, [endpoint[0] - direction[0] * arm - direction[1] * side * arm * 0.6, endpoint[1] - direction[1] * arm + direction[0] * side * arm * 0.6]);
  }
  if (vector[2] >= 0) mark(...center);
  else for (let offset = -2; offset <= 2; offset += 1) for (const sign of [-1, 1]) mark(center[0] + offset, center[1] + sign * offset);
}

// Marks with `value` every voxel reached by the ribbon between the white and pial
// triangles of `faces`. Each prism is sampled on barycentric and depth grids no coarser
// than half a voxel; a sample marks the voxel whose centre is nearest.
export function ribbonVoxelMask(volume, white, pial, faces, mask, value) {
  const inverse = inverseAffine(volume.affine);
  const toVoxels = (points) => {
    const output = new Float64Array(points.length);
    for (let i = 0; i < points.length; i += 3) output.set(transform(inverse, [points[i], points[i + 1], points[i + 2]]), i);
    return output;
  };
  const inner = toVoxels(white);
  const outer = toVoxels(pial);
  const [nx, ny, nz] = volume.dims;
  const corner = new Float64Array(18);
  const triangle = new Float64Array(9);
  const span = (points, a, b) => Math.hypot(points[a] - points[b], points[a + 1] - points[b + 1], points[a + 2] - points[b + 2]);
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = faces[f + k] * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        corner[k * 3 + axis] = inner[v + axis];
        corner[9 + k * 3 + axis] = outer[v + axis];
      }
    }
    let edge = 0;
    let depth = 0;
    for (let k = 0; k < 3; k += 1) {
      const next = (k + 1) % 3;
      edge = Math.max(edge, span(corner, k * 3, next * 3), span(corner, 9 + k * 3, 9 + next * 3));
      depth = Math.max(depth, span(corner, k * 3, 9 + k * 3));
    }
    const across = Math.max(1, Math.ceil(edge * 2));
    const layers = Math.max(1, Math.ceil(depth * 2));
    for (let layer = 0; layer <= layers; layer += 1) {
      const t = layer / layers;
      for (let c = 0; c < 9; c += 1) triangle[c] = (1 - t) * corner[c] + t * corner[9 + c];
      for (let i = 0; i <= across; i += 1) {
        for (let j = 0; j <= across - i; j += 1) {
          const a = i / across;
          const b = j / across;
          const c = (across - i - j) / across;
          const x = roundEven(a * triangle[0] + b * triangle[3] + c * triangle[6]);
          const y = roundEven(a * triangle[1] + b * triangle[4] + c * triangle[7]);
          const z = roundEven(a * triangle[2] + b * triangle[5] + c * triangle[8]);
          if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) mask[x + nx * (y + ny * z)] = value;
        }
      }
    }
  }
  return mask;
}

export function patchQc(volume, geometries, patches) {
  const output = new Int16Array(volume.data.length);
  const midMasks = [];
  for (const [id, geometry] of Object.entries(geometries)) {
    const faces = Int32Array.from(geometry.faces.flat());
    for (const [key, value] of [['white_ras_mm', 2400], ['pial_ras_mm', 2700]]) {
      const mask = triangleVoxelMask(volume, Float64Array.from(geometry[key].flat()), faces);
      for (let i = 0; i < mask.length; i += 1) if (mask[i]) output[i] = value;
    }
    midMasks.push([id, triangleVoxelMask(volume, Float64Array.from(geometry.mid_ras_mm.flat()), faces)]);
  }
  for (const [, mask] of midMasks) for (let i = 0; i < mask.length; i += 1) if (mask[i]) output[i] = 3000;
  for (const [id, mask] of midMasks) normalGlyph(volume, mask, patches[id], output);
  return writeInt16Nifti(volume, output, 'TopoFit patches and normals: white 2400, pial 2700, mid 3000, normal 4095');
}

// The search region in the cortical ribbon on the source grid: 0 outside, then each
// hemisphere's `value` (left 1, right 2), the later hemisphere where two meet.
export function regionMask(volume, hemispheres, description) {
  const mask = new Uint8Array(volume.data.length);
  for (const { white, pial, faces, value } of hemispheres) ribbonVoxelMask(volume, white, pial, faces, mask, value);
  return writeUint8Nifti(volume, mask, description);
}
