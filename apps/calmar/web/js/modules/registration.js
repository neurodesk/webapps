// Registration helpers — the JS-side replacements for the three SynthMorph
// layers we cut from the ONNX export (VecInt, RescaleTransform,
// SpatialTransformer). Pure functions, no DOM, no ONNX. The orchestrator
// calls these after the worker returns the raw stationary velocity field.
//
// Shape conventions
// -----------------
// Volume:
//   Float32Array length X*Y*Z, F-order. idx(x,y,z) = x + y*X + z*X*Y.
//   Matches NIfTI / volume-utils.js / brain-extraction.js.
//
// Displacement / SVF field:
//   Float32Array length X*Y*Z*3. Row-major NDHWC, C innermost.
//     idx(x,y,z,c) = ((x * Y + y) * Z + z) * 3 + c
//   This matches what the SynthMorph ONNX emits (TF channel-last). Channel
//   c is the displacement along axis c of the same tensor — channel 0 is
//   x-direction, channel 1 is y-direction, channel 2 is z-direction.
//   (Same convention as voxelmorph's `transform(vec, vec)`.)
//
// Boundary handling
// -----------------
// SVF integration samples the SVF at warped grid coordinates. Out-of-bounds
// queries clamp to the volume edge — empirically more numerically stable
// than zero-padding for diffeomorphic flows (the volume isn't 'wrapping',
// it's a smooth tissue field).
//
// Volume warping (warpVolume) zero-pads out-of-bounds samples — the input
// volume's tissue intensities aren't defined past the FOV; clamping there
// would hallucinate edge stripes.

// ---------------- internal helpers ----------------

function dispLinearIndex(dims, x, y, z, c) {
  const Y = dims[1], Z = dims[2];
  return ((x * Y + y) * Z + z) * 3 + c;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Sample one channel of the displacement field at fractional coordinates,
// trilinear, clamp-to-edge. Field layout: row-major NDHWC.
function sampleDispChannelClampTri(field, dims, x, y, z, c) {
  const X = dims[0], Y = dims[1], Z = dims[2];
  const xc = clamp(x, 0, X - 1);
  const yc = clamp(y, 0, Y - 1);
  const zc = clamp(z, 0, Z - 1);
  const x0 = Math.floor(xc); const x1 = Math.min(x0 + 1, X - 1);
  const y0 = Math.floor(yc); const y1 = Math.min(y0 + 1, Y - 1);
  const z0 = Math.floor(zc); const z1 = Math.min(z0 + 1, Z - 1);
  const wx = xc - x0, wy = yc - y0, wz = zc - z0;
  const at = (xx, yy, zz) => field[((xx * Y + yy) * Z + zz) * 3 + c];
  const c000 = at(x0, y0, z0), c100 = at(x1, y0, z0);
  const c010 = at(x0, y1, z0), c110 = at(x1, y1, z0);
  const c001 = at(x0, y0, z1), c101 = at(x1, y0, z1);
  const c011 = at(x0, y1, z1), c111 = at(x1, y1, z1);
  const c00 = c000 * (1 - wx) + c100 * wx;
  const c10 = c010 * (1 - wx) + c110 * wx;
  const c01 = c001 * (1 - wx) + c101 * wx;
  const c11 = c011 * (1 - wx) + c111 * wx;
  const c0 = c00 * (1 - wy) + c10 * wy;
  const c1 = c01 * (1 - wy) + c11 * wy;
  return c0 * (1 - wz) + c1 * wz;
}

// Sample a scalar volume (F-order Float32Array) at fractional coords.
// Returns 0 outside the volume; trilinear inside.
function sampleVolumeZeroTri(vol, dims, x, y, z) {
  const X = dims[0], Y = dims[1], Z = dims[2];
  if (x < 0 || x > X - 1 || y < 0 || y > Y - 1 || z < 0 || z > Z - 1) return 0;
  const x0 = Math.floor(x), x1 = Math.min(x0 + 1, X - 1);
  const y0 = Math.floor(y), y1 = Math.min(y0 + 1, Y - 1);
  const z0 = Math.floor(z), z1 = Math.min(z0 + 1, Z - 1);
  const wx = x - x0, wy = y - y0, wz = z - z0;
  const at = (xx, yy, zz) => vol[xx + yy * X + zz * X * Y];
  const c000 = at(x0, y0, z0), c100 = at(x1, y0, z0);
  const c010 = at(x0, y1, z0), c110 = at(x1, y1, z0);
  const c001 = at(x0, y0, z1), c101 = at(x1, y0, z1);
  const c011 = at(x0, y1, z1), c111 = at(x1, y1, z1);
  const c00 = c000 * (1 - wx) + c100 * wx;
  const c10 = c010 * (1 - wx) + c110 * wx;
  const c01 = c001 * (1 - wx) + c101 * wx;
  const c11 = c011 * (1 - wx) + c111 * wx;
  const c0 = c00 * (1 - wy) + c10 * wy;
  const c1 = c01 * (1 - wy) + c11 * wy;
  return c0 * (1 - wz) + c1 * wz;
}

function sampleVolumeZeroNearest(vol, dims, x, y, z) {
  const [X, Y, Z] = dims;
  const ix = Math.round(x);
  const iy = Math.round(y);
  const iz = Math.round(z);
  if (ix < 0 || ix >= X || iy < 0 || iy >= Y || iz < 0 || iz >= Z) return 0;
  return vol[ix + iy * X + iz * X * Y];
}

// ---------------- public API ----------------

// Scaling-and-squaring integration of a stationary velocity field.
// Reproduces voxelmorph.tf.utils.utils.integrate_vec(vec, method='ss',
// nb_steps=N):
//
//   vec /= 2^N
//   for _ in range(N):  vec += transform(vec, vec)
//
// where transform(field, ref_disp)(x) = field(x + ref_disp(x)) using
// trilinear interpolation. Returns the integrated displacement field as
// a *new* Float32Array; the input is not mutated.
//
// SynthMorph's default int_steps is 7, which is what we use unless the
// caller overrides.
export function integrateSvf(svf, dims, nbSteps = 7) {
  if (nbSteps < 0 || !Number.isInteger(nbSteps)) {
    throw new Error(`integrateSvf: nbSteps must be a non-negative integer, got ${nbSteps}`);
  }
  const [X, Y, Z] = dims;
  const expected = X * Y * Z * 3;
  if (svf.length !== expected) {
    throw new Error(`integrateSvf: svf length ${svf.length} != ${expected} (dims ${dims})`);
  }

  const scale = Math.pow(0.5, nbSteps);
  const disp = new Float32Array(expected);
  for (let i = 0; i < expected; i++) disp[i] = svf[i] * scale;

  if (nbSteps === 0) return disp;

  // Working buffer for transform(disp, disp) at each step.
  const warped = new Float32Array(expected);
  for (let step = 0; step < nbSteps; step++) {
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          const i = ((x * Y + y) * Z + z) * 3;
          const qx = x + disp[i];
          const qy = y + disp[i + 1];
          const qz = z + disp[i + 2];
          warped[i]     = sampleDispChannelClampTri(disp, dims, qx, qy, qz, 0);
          warped[i + 1] = sampleDispChannelClampTri(disp, dims, qx, qy, qz, 1);
          warped[i + 2] = sampleDispChannelClampTri(disp, dims, qx, qy, qz, 2);
        }
      }
    }
    for (let i = 0; i < expected; i++) disp[i] += warped[i];
  }
  return disp;
}

// Trilinear upsample of a displacement field from `srcDims` to `dstDims`,
// with displacement-magnitude scaling. SynthMorph emits the SVF at half
// resolution; the integrated displacement gets fed into a full-resolution
// warp. The displacement values are in voxel units of their grid, so when
// the grid spacing changes by factor s = dst / src, each value must be
// multiplied by s to retain the same physical displacement.
//
// In practice s ≈ 2 (half-res -> full-res), but this implementation handles
// arbitrary scale factors per axis (and uses a per-axis scale because in
// principle the model could produce a non-symmetric ratio).
export function upsampleDisplacementField(svf, srcDims, dstDims) {
  const [sX, sY, sZ] = srcDims;
  const [dX, dY, dZ] = dstDims;
  if (svf.length !== sX * sY * sZ * 3) {
    throw new Error('upsampleDisplacementField: svf length does not match srcDims');
  }
  const out = new Float32Array(dX * dY * dZ * 3);

  // Scale factor per axis: dst voxel of motion per src voxel of motion.
  const scaleX = dX / sX, scaleY = dY / sY, scaleZ = dZ / sZ;

  // Map a destination voxel coord (x, y, z) to source voxel coord. Use the
  // 'pixel-centers aligned' convention: src = dst * (sN-1) / (dN-1) so the
  // first and last destination voxels land exactly on src endpoints.
  const mapX = sX > 1 ? (sX - 1) / Math.max(dX - 1, 1) : 0;
  const mapY = sY > 1 ? (sY - 1) / Math.max(dY - 1, 1) : 0;
  const mapZ = sZ > 1 ? (sZ - 1) / Math.max(dZ - 1, 1) : 0;

  for (let z = 0; z < dZ; z++) {
    const sz = z * mapZ;
    for (let y = 0; y < dY; y++) {
      const sy = y * mapY;
      for (let x = 0; x < dX; x++) {
        const sx = x * mapX;
        const oi = ((x * dY + y) * dZ + z) * 3;
        out[oi]     = scaleX * sampleDispChannelClampTri(svf, srcDims, sx, sy, sz, 0);
        out[oi + 1] = scaleY * sampleDispChannelClampTri(svf, srcDims, sx, sy, sz, 1);
        out[oi + 2] = scaleZ * sampleDispChannelClampTri(svf, srcDims, sx, sy, sz, 2);
      }
    }
  }
  return out;
}

export function displacementMagnitudeField(disp, dims) {
  const [X, Y, Z] = dims;
  const expected = X * Y * Z * 3;
  if (disp.length !== expected) {
    throw new Error(`displacementMagnitudeField: disp length ${disp.length} != ${expected}`);
  }
  const out = new Float32Array(X * Y * Z);
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const di = ((x * Y + y) * Z + z) * 3;
        const dx = disp[di];
        const dy = disp[di + 1];
        const dz = disp[di + 2];
        out[x + y * X + z * X * Y] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
  }
  return out;
}

// Apply a full-resolution displacement field to a scalar volume. For each
// output voxel (x, y, z), sample input volume at (x + dx, y + dy, z + dz)
// using trilinear interpolation; out-of-bounds returns zero.
//
// volume:    Float32Array, F-order, length volDims[0]*volDims[1]*volDims[2]
// disp:      Float32Array, NDHWC, length dispDims[0]*dispDims[1]*dispDims[2]*3
// Both grids must match (volDims == dispDims). Returns a new Float32Array
// of the same length as `volume`.
export function warpVolume(volume, volDims, disp, dispDims) {
  const [X, Y, Z] = volDims;
  if (volume.length !== X * Y * Z) {
    throw new Error(`warpVolume: volume length ${volume.length} != ${X * Y * Z}`);
  }
  if (disp.length !== dispDims[0] * dispDims[1] * dispDims[2] * 3) {
    throw new Error('warpVolume: disp length does not match dispDims');
  }
  if (volDims[0] !== dispDims[0] || volDims[1] !== dispDims[1] || volDims[2] !== dispDims[2]) {
    throw new Error(`warpVolume: volDims ${volDims} must equal dispDims ${dispDims}`);
  }

  const out = new Float32Array(X * Y * Z);
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        const di = ((x * Y + y) * Z + z) * 3;
        const sx = x + disp[di];
        const sy = y + disp[di + 1];
        const sz = z + disp[di + 2];
        out[x + y * X + z * X * Y] = sampleVolumeZeroTri(volume, volDims, sx, sy, sz);
      }
    }
  }
  return out;
}

// Approximate inverse application of the forward sampling transform used by
// warpVolume(). warpVolume samples source at target + disp(target); this
// helper walks each source-space output voxel and solves
//   source = target + disp(target)
// by fixed-point iteration, then samples the target-space input volume there.
export function inverseWarpVolume(volume, volDims, disp, dispDims, options = {}) {
  const [X, Y, Z] = volDims;
  if (volume.length !== X * Y * Z) {
    throw new Error(`inverseWarpVolume: volume length ${volume.length} != ${X * Y * Z}`);
  }
  if (disp.length !== dispDims[0] * dispDims[1] * dispDims[2] * 3) {
    throw new Error('inverseWarpVolume: disp length does not match dispDims');
  }
  if (volDims[0] !== dispDims[0] || volDims[1] !== dispDims[1] || volDims[2] !== dispDims[2]) {
    throw new Error(`inverseWarpVolume: volDims ${volDims} must equal dispDims ${dispDims}`);
  }

  const iterations = Number.isInteger(options.iterations) ? options.iterations : 8;
  if (iterations < 0) {
    throw new Error(`inverseWarpVolume: iterations must be non-negative, got ${iterations}`);
  }
  const mode = options.mode || 'trilinear';
  if (mode !== 'nearest' && mode !== 'trilinear') {
    throw new Error(`inverseWarpVolume: unknown mode '${mode}'`);
  }
  const sampleVolume = mode === 'nearest' ? sampleVolumeZeroNearest : sampleVolumeZeroTri;

  const out = new Float32Array(X * Y * Z);
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      for (let x = 0; x < X; x++) {
        let qx = x;
        let qy = y;
        let qz = z;
        for (let i = 0; i < iterations; i++) {
          const dx = sampleDispChannelClampTri(disp, dispDims, qx, qy, qz, 0);
          const dy = sampleDispChannelClampTri(disp, dispDims, qx, qy, qz, 1);
          const dz = sampleDispChannelClampTri(disp, dispDims, qx, qy, qz, 2);
          qx = x - dx;
          qy = y - dy;
          qz = z - dz;
        }
        out[x + y * X + z * X * Y] = sampleVolume(volume, volDims, qx, qy, qz);
      }
    }
  }
  return out;
}
