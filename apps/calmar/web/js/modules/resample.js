// Phase 6.1: affine-aware 3D volume resampler. Bridges between MNI160 1mm
// (the SynthMorph displacement-field grid) and the Yeo7 MNI2mm 99x117x95
// grid the parcel-overlap reducer expects.
//
// Usage: given a source volume + its NIfTI affine and a destination grid +
// its NIfTI affine, resampleAffine walks every destination voxel, projects
// it to world coordinates via dstAffine, then back to source-voxel
// coordinates via inv(srcAffine), and samples the source.
//
// Modes:
//   - 'nearest'   round to the closest src voxel (correct for label/binary masks)
//   - 'trilinear' bilinear-style 8-corner blend (correct for continuous data)
//
// Out-of-bounds dst voxels read 0. Output is a Float32Array unless the
// input is a Uint8Array (binary mask), in which case nearest mode returns
// a Uint8Array so the binary contract round-trips losslessly.

const MODES = new Set(['nearest', 'trilinear']);

// Pull the world-space affine off a nifti-reader-js header. nifti-reader-js
// already does the qform/sform precedence + matrix construction work and
// surfaces the chosen 4x4 as `header.affine` (NaN-padded if neither code is
// set). We mirror the on-disk priority: sform wins when sform_code > 0.
export function affineFromHeader(header) {
  if (!header || !Array.isArray(header.affine)) {
    throw new Error('affineFromHeader: header.affine missing');
  }
  return header.affine;
}

// 4x4 affine inversion. Affine = [[R | t]; [0 0 0 1]] so we only invert the
// 3x3 R then compute -inv(R)*t. Avoids a full 4x4 cofactor expansion.
export function invertAffine(M) {
  const R = [
    [M[0][0], M[0][1], M[0][2]],
    [M[1][0], M[1][1], M[1][2]],
    [M[2][0], M[2][1], M[2][2]]
  ];
  const t = [M[0][3], M[1][3], M[2][3]];

  const det =
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
  if (Math.abs(det) < 1e-12) {
    throw new Error('invertAffine: singular 3x3 block');
  }
  const inv = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  inv[0][0] = (R[1][1] * R[2][2] - R[1][2] * R[2][1]) / det;
  inv[0][1] = (R[0][2] * R[2][1] - R[0][1] * R[2][2]) / det;
  inv[0][2] = (R[0][1] * R[1][2] - R[0][2] * R[1][1]) / det;
  inv[1][0] = (R[1][2] * R[2][0] - R[1][0] * R[2][2]) / det;
  inv[1][1] = (R[0][0] * R[2][2] - R[0][2] * R[2][0]) / det;
  inv[1][2] = (R[0][2] * R[1][0] - R[0][0] * R[1][2]) / det;
  inv[2][0] = (R[1][0] * R[2][1] - R[1][1] * R[2][0]) / det;
  inv[2][1] = (R[0][1] * R[2][0] - R[0][0] * R[2][1]) / det;
  inv[2][2] = (R[0][0] * R[1][1] - R[0][1] * R[1][0]) / det;

  // -inv(R) * t.
  const minv0 = -(inv[0][0] * t[0] + inv[0][1] * t[1] + inv[0][2] * t[2]);
  const minv1 = -(inv[1][0] * t[0] + inv[1][1] * t[1] + inv[1][2] * t[2]);
  const minv2 = -(inv[2][0] * t[0] + inv[2][1] * t[1] + inv[2][2] * t[2]);

  return [
    [inv[0][0], inv[0][1], inv[0][2], minv0],
    [inv[1][0], inv[1][1], inv[1][2], minv1],
    [inv[2][0], inv[2][1], inv[2][2], minv2],
    [0,         0,         0,         1]
  ];
}

export function resampleAffine(src, srcDims, srcAffine, dstDims, dstAffine, mode = 'nearest') {
  if (!Array.isArray(srcDims) || srcDims.length !== 3) {
    throw new Error('resampleAffine: srcDims must be [X, Y, Z]');
  }
  if (!Array.isArray(dstDims) || dstDims.length !== 3) {
    throw new Error('resampleAffine: dstDims must be [X, Y, Z]');
  }
  if (!MODES.has(mode)) {
    throw new Error(`resampleAffine: unknown mode '${mode}'; expected one of ${[...MODES].join(', ')}`);
  }
  const [SX, SY, SZ] = srcDims;
  const [DX, DY, DZ] = dstDims;
  const expectedSrc = SX * SY * SZ;
  if (src.length !== expectedSrc) {
    throw new Error(`resampleAffine: src length ${src.length} != srcDims ${SX}x${SY}x${SZ}=${expectedSrc}`);
  }

  const inv = invertAffine(srcAffine);
  // Compose M = inv(srcAffine) * dstAffine — dstVoxel -> srcVoxel directly.
  // We unroll only the 3x4 we need (last row stays [0,0,0,1]).
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      M[r][c] =
        inv[r][0] * dstAffine[0][c] +
        inv[r][1] * dstAffine[1][c] +
        inv[r][2] * dstAffine[2][c] +
        inv[r][3] * dstAffine[3][c];
    }
  }

  const isBinary = (src instanceof Uint8Array) && mode === 'nearest';
  const out = isBinary
    ? new Uint8Array(DX * DY * DZ)
    : new Float32Array(DX * DY * DZ);

  for (let dz = 0; dz < DZ; dz++) {
    for (let dy = 0; dy < DY; dy++) {
      for (let dx = 0; dx < DX; dx++) {
        const sx = M[0][0] * dx + M[0][1] * dy + M[0][2] * dz + M[0][3];
        const sy = M[1][0] * dx + M[1][1] * dy + M[1][2] * dz + M[1][3];
        const sz = M[2][0] * dx + M[2][1] * dy + M[2][2] * dz + M[2][3];
        const dstIdx = dx + dy * DX + dz * DX * DY;

        if (mode === 'nearest') {
          const ix = Math.round(sx);
          const iy = Math.round(sy);
          const iz = Math.round(sz);
          if (ix < 0 || ix >= SX || iy < 0 || iy >= SY || iz < 0 || iz >= SZ) {
            out[dstIdx] = 0;
          } else {
            out[dstIdx] = src[ix + iy * SX + iz * SX * SY];
          }
        } else {
          // trilinear
          const x0 = Math.floor(sx), x1 = x0 + 1;
          const y0 = Math.floor(sy), y1 = y0 + 1;
          const z0 = Math.floor(sz), z1 = z0 + 1;
          if (x1 < 0 || x0 >= SX || y1 < 0 || y0 >= SY || z1 < 0 || z0 >= SZ) {
            out[dstIdx] = 0;
            continue;
          }
          const xd = sx - x0, yd = sy - y0, zd = sz - z0;
          const sample = (ix, iy, iz) => {
            if (ix < 0 || ix >= SX || iy < 0 || iy >= SY || iz < 0 || iz >= SZ) return 0;
            return src[ix + iy * SX + iz * SX * SY];
          };
          const c000 = sample(x0, y0, z0);
          const c100 = sample(x1, y0, z0);
          const c010 = sample(x0, y1, z0);
          const c110 = sample(x1, y1, z0);
          const c001 = sample(x0, y0, z1);
          const c101 = sample(x1, y0, z1);
          const c011 = sample(x0, y1, z1);
          const c111 = sample(x1, y1, z1);
          const c00 = c000 * (1 - xd) + c100 * xd;
          const c01 = c001 * (1 - xd) + c101 * xd;
          const c10 = c010 * (1 - xd) + c110 * xd;
          const c11 = c011 * (1 - xd) + c111 * xd;
          const c0 = c00 * (1 - yd) + c10 * yd;
          const c1 = c01 * (1 - yd) + c11 * yd;
          out[dstIdx] = c0 * (1 - zd) + c1 * zd;
        }
      }
    }
  }
  return out;
}
