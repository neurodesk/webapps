// Synthetic images with known orientation, shared by the unit tests, the browser tests and
// validation/scipy-reference.py (which rebuilds them from the same formulas).

/** A 2D grating whose stripes run at `degrees` counterclockwise from x, with y downwards. */
export function grating2d({ size = 64, degrees, period = 8 }) {
  const theta = (degrees * Math.PI) / 180;
  const data = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[x + size * y] = 100 + 50 * Math.cos((2 * Math.PI * (x * Math.sin(theta) + y * Math.cos(theta))) / period);
    }
  }
  return { data, dims: [size, size, 1], spacing: [1, 1, 1] };
}

/** The unit fibre direction for azimuth and elevation in degrees, in (x, y down, z). */
export function direction(azimuth, elevation) {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), -Math.cos(e) * Math.sin(a), Math.sin(e)];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v) {
  const n = Math.hypot(...v);
  return v.map((value) => value / n);
}

/**
 * A 3D lattice of parallel cylinders along `direction(azimuth, elevation)`: intensity varies
 * along two directions perpendicular to the fibres and not along them. Coordinates are
 * physical (spacing applied), so an anisotropic grid samples the same object.
 */
export function cylinders3d({ size = [32, 32, 32], spacing = [1, 1, 1], azimuth, elevation, period = 8 }) {
  const u = direction(azimuth, elevation);
  const helper = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const n1 = unit(cross(u, helper));
  const n2 = unit(cross(u, n1));
  const [nx, ny, nz] = size;
  const data = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const p = [x * spacing[0], y * spacing[1], z * spacing[2]];
        const a = p[0] * n1[0] + p[1] * n1[1] + p[2] * n1[2];
        const b = p[0] * n2[0] + p[1] * n2[1] + p[2] * n2[2];
        data[x + nx * (y + ny * z)] = 100 + 25 * Math.cos((2 * Math.PI * a) / period) + 25 * Math.cos((2 * Math.PI * b) / period);
      }
    }
  }
  return { data, dims: size, spacing, direction: u };
}

/** The angle in degrees between two undirected axes. */
export function axisAngle(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}
