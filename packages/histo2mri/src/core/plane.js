// A section's plane in an MRI volume: a voxel axis and index, an offset along the normal and a
// small tilt, sampled on a square 2-D grid. The plane's local frame has x along u, y along v and
// z along the normal n, in millimetres, with its origin at grid pixel (0, 0); `frame` maps it to
// world (RAS) millimetres.
import { apply, applyLinear, invert } from './matrix.js';

const AXIS_NAMES = ['sagittal', 'coronal', 'axial'];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => a.map((value) => value * s);
const add = (a, b) => a.map((value, i) => value + b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => scale(a, 1 / Math.hypot(...a));

/** Rodrigues rotation of `vector` about the unit `axis` by `degrees`. */
function rotate(vector, axis, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(vector, c), scale(cross(axis, vector), s)), scale(axis, dot(axis, vector) * (1 - c)));
}

function column(affine, axis) {
  return [affine[0][axis], affine[1][axis], affine[2][axis]];
}

/** Each voxel axis's anatomical plane (the world axis it runs along most): sagittal, coronal or axial. */
export function axisPlanes(affine) {
  return [0, 1, 2].map((axis) => {
    const direction = column(affine, axis).map(Math.abs);
    return AXIS_NAMES[direction.indexOf(Math.max(...direction))];
  });
}

/**
 * The plane of slice `index` along voxel `axis`, moved `offset` mm along its normal and tilted
 * `tilt[0]` degrees about its first in-plane axis and `tilt[1]` about its second. The grid has
 * the slice's smallest in-plane voxel size and covers its field of view; pass `grid`
 * ({ nu, nv, spacing }) to keep another plane's grid.
 */
export function slicePlane(volume, { axis, index, offset = 0, tilt = [0, 0], grid = null }) {
  const { dims, affine } = volume;
  if (![0, 1, 2].includes(axis)) throw new Error('The slice axis must be 0, 1 or 2.');
  if (!(index >= 0 && index <= dims[axis] - 1)) throw new Error(`Slice ${index} is outside 0–${dims[axis] - 1}.`);
  const [p, q] = [0, 1, 2].filter((a) => a !== axis);
  const cp = column(affine, p);
  const cq = column(affine, q);
  let u = unit(cp);
  let v = unit(add(cq, scale(u, -dot(cq, u))));
  let n = cross(u, v);
  v = rotate(v, u, tilt[0]);
  n = rotate(n, u, tilt[0]);
  u = rotate(u, v, tilt[1]);
  n = rotate(n, v, tilt[1]);
  const spacing = grid?.spacing ?? Math.min(Math.hypot(...cp), Math.hypot(...cq));
  const nu = grid?.nu ?? Math.ceil((dims[p] * Math.hypot(...cp)) / spacing);
  const nv = grid?.nv ?? Math.ceil((dims[q] * Math.hypot(...cq)) / spacing);
  const voxel = [0, 0, 0];
  voxel[p] = (dims[p] - 1) / 2;
  voxel[q] = (dims[q] - 1) / 2;
  voxel[axis] = index;
  const centre = add(apply(affine, voxel), scale(n, offset));
  const origin = add(centre, add(scale(u, (-(nu - 1) / 2) * spacing), scale(v, (-(nv - 1) / 2) * spacing)));
  const frame = [
    [u[0], v[0], n[0], origin[0]],
    [u[1], v[1], n[1], origin[1]],
    [u[2], v[2], n[2], origin[2]],
    [0, 0, 0, 1],
  ];
  // Half the voxel's extent along the normal: a voxel whose centre is this close is on the plane.
  const halfThickness = 0.5 * [0, 1, 2].reduce((sum, a) => sum + Math.abs(dot(column(affine, a), n)), 0);
  return { axis, index, offset, tilt: [...tilt], nu, nv, spacing, frame, halfThickness, sliceThickness: Math.abs(dot(column(affine, axis), n)) };
}

/** Trilinear sample of a volume at continuous voxel coordinates, 0 outside. */
export function trilinear(volume, [x, y, z]) {
  const [nx, ny, nz] = volume.dims;
  if (!(x >= 0 && y >= 0 && z >= 0 && x <= nx - 1 && y <= ny - 1 && z <= nz - 1)) return 0;
  const x0 = Math.min(Math.floor(x), Math.max(0, nx - 2));
  const y0 = Math.min(Math.floor(y), Math.max(0, ny - 2));
  const z0 = Math.min(Math.floor(z), Math.max(0, nz - 2));
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const d = volume.data;
  const at = (i, j, k) => d[(k * ny + j) * nx + i];
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/**
 * The volume on the plane's grid (row-major, `nu` columns). With `mask`, only its set pixels
 * are sampled and the rest are 0.
 */
export function samplePlane(volume, plane, mask = null) {
  const toVoxel = invert(volume.affine);
  const { nu, nv, spacing, frame } = plane;
  const start = apply(toVoxel, apply(frame, [0, 0, 0]));
  const stepU = applyLinear(toVoxel, applyLinear(frame, [spacing, 0, 0]));
  const stepV = applyLinear(toVoxel, applyLinear(frame, [0, spacing, 0]));
  const out = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i;
      if (mask && !mask[k]) continue;
      out[k] = trilinear(volume, [start[0] + i * stepU[0] + j * stepV[0], start[1] + i * stepU[1] + j * stepV[1], start[2] + i * stepU[2] + j * stepV[2]]);
    }
  }
  return out;
}

/**
 * Writes a 2-D image on the plane into the volume's grid: every voxel the plane passes through
 * (centre within half the voxel's extent along the normal) takes the image's value at the
 * voxel centre's projection. `sample(x, y)` gets local millimetres and returns a value or
 * null; `write(voxelIndex, value)` stores it. Returns the number of voxels written.
 */
export function placeOnPlane(volume, plane, sample, write) {
  const { dims, affine } = volume;
  const { axis, frame, halfThickness } = plane;
  const [p, q] = [0, 1, 2].filter((a) => a !== axis);
  const toLocal = invert(frame);
  const local = (voxel) => apply(toLocal, apply(affine, voxel));
  const base = local([0, 0, 0]);
  const step = [0, 1, 2].map((a) => {
    const voxel = [0, 0, 0];
    voxel[a] = 1;
    const moved = local(voxel);
    return [moved[0] - base[0], moved[1] - base[1], moved[2] - base[2]];
  });
  if (Math.abs(step[axis][2]) < 1e-9) throw new Error('The plane is parallel to the slice axis.');
  let written = 0;
  for (let j = 0; j < dims[q]; j++) {
    for (let i = 0; i < dims[p]; i++) {
      const zAt = base[2] + i * step[p][2] + j * step[q][2];
      // Slice indices k with |zAt + k step| <= halfThickness.
      const a = (-halfThickness - zAt) / step[axis][2];
      const b = (halfThickness - zAt) / step[axis][2];
      const first = Math.max(0, Math.ceil(Math.min(a, b)));
      const last = Math.min(dims[axis] - 1, Math.floor(Math.max(a, b)));
      for (let k = first; k <= last; k++) {
        const voxel = [0, 0, 0];
        voxel[p] = i;
        voxel[q] = j;
        voxel[axis] = k;
        const x = base[0] + i * step[p][0] + j * step[q][0] + k * step[axis][0];
        const y = base[1] + i * step[p][1] + j * step[q][1] + k * step[axis][1];
        const value = sample(x, y);
        if (value === null) continue;
        write(voxel[0] + dims[0] * (voxel[1] + dims[1] * voxel[2]), value);
        written++;
      }
    }
  }
  return written;
}
