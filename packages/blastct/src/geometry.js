// Pure-JS SimpleITK-compatible 3D NIfTI geometry: RAS<->LPS conversion,
// BLAST-CT radiology reorientation, 1 mm isotropic trilinear resampling,
// and nearest-neighbour native-grid label restoration.

/** Maximum 1 mm isotropic working volume (32M voxels, ~320 x 320 x 312 mm). */
export const MAX_WORKING_VOXELS = 32_000_000;
/** Maximum native / intermediate reoriented voxel count (150M voxels, e.g. thin-slice 512 x 512 x 500 head CT). */
export const MAX_NATIVE_VOXELS = 150_000_000;

/** Python-compatible round-half-to-even (matches `int(round(...))` in blast_ct/nifti/rescale.py). */
export function roundHalfToEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function inv3(m) {
  const d = det3(m);
  if (Math.abs(d) < 1e-12) throw new Error('Singular 3x3 affine matrix in NIfTI header.');
  const invD = 1 / d;
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invD,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invD,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invD,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invD,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invD,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invD,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invD,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invD,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invD,
    ],
  ];
}

function matVec3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function matMul3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return out;
}

/**
 * Convert NIfTI RAS 4x4 affine and [nx, ny, nz] dims into SimpleITK LPS geometry:
 * `{ size: [nx, ny, nz], spacing: [sx, sy, sz], origin: [ox, oy, oz], direction: 3x3 }`.
 */
export function niftiRasToSitkLps(dimsXYZ, rasAffine) {
  const size = [dimsXYZ[0], dimsXYZ[1], dimsXYZ[2]];
  // SimpleITK reads NIfTI RAS by negating rows 0 (R->L) and 1 (A->P).
  const signs = [-1, -1, 1];
  const origin = [
    signs[0] * rasAffine[0][3] + 0,
    signs[1] * rasAffine[1][3] + 0,
    signs[2] * rasAffine[2][3] + 0,
  ];
  const spacing = [0, 0, 0];
  const direction = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let c = 0; c < 3; c++) {
    const vx = signs[0] * rasAffine[0][c] + 0;
    const vy = signs[1] * rasAffine[1][c] + 0;
    const vz = signs[2] * rasAffine[2][c] + 0;
    const len = Math.hypot(vx, vy, vz);
    if (!Number.isFinite(len) || len <= 0) {
      throw new Error(`Invalid NIfTI voxel spacing along axis ${c}.`);
    }
    spacing[c] = len;
    direction[0][c] = vx / len + 0;
    direction[1][c] = vy / len + 0;
    direction[2][c] = vz / len + 0;
  }
  return { size, spacing, origin, direction };
}

/** Build the 3x3 linear index->LPS matrix `dir * diag(spacing)` and origin. */
function indexToPhysical(geom) {
  const { direction: d, spacing: s, origin } = geom;
  const mat = [
    [d[0][0] * s[0], d[0][1] * s[1], d[0][2] * s[2]],
    [d[1][0] * s[0], d[1][1] * s[1], d[1][2] * s[2]],
    [d[2][0] * s[0], d[2][1] * s[1], d[2][2] * s[2]],
  ];
  return { mat, origin };
}

/**
 * Exact port of `blast_ct.nifti.rescale.create_reference_reoriented_image`.
 * Permutes axes so the dominant component of each column lies on the diagonal,
 * flips negative diagonal axes, and falls back to the input geometry if singular.
 */
export function createReferenceReoriented(geom) {
  const { size, spacing, origin, direction: dir } = geom;
  const ind = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let bestR = 0;
    let bestVal = Math.abs(dir[0][c]);
    for (let r = 1; r < 3; r++) {
      const v = Math.abs(dir[r][c]);
      if (v > bestVal) {
        bestVal = v;
        bestR = r;
      }
    }
    ind[c] = bestR;
  }

  const newSize = [size[ind[0]], size[ind[1]], size[ind[2]]];
  const newSpacing = [spacing[ind[0]], spacing[ind[1]], spacing[ind[2]]];
  const newExtent = [newSize[0] * newSpacing[0], newSize[1] * newSpacing[1], newSize[2] * newSpacing[2]];
  const permDir = [
    [dir[0][ind[0]], dir[0][ind[1]], dir[0][ind[2]]],
    [dir[1][ind[0]], dir[1][ind[1]], dir[1][ind[2]]],
    [dir[2][ind[0]], dir[2][ind[1]], dir[2][ind[2]]],
  ];

  const flip = [permDir[0][0] < 0 ? 1 : 0, permDir[1][1] < 0 ? 1 : 0, permDir[2][2] < 0 ? 1 : 0];
  const shift = matVec3(permDir, [newExtent[0] * flip[0], newExtent[1] * flip[1], newExtent[2] * flip[2]]);
  const newOrigin = [origin[0] + shift[0], origin[1] + shift[1], origin[2] + shift[2]];
  const finalDir = [
    [permDir[0][0] * (flip[0] ? -1 : 1) + 0, permDir[0][1] * (flip[1] ? -1 : 1) + 0, permDir[0][2] * (flip[2] ? -1 : 1) + 0],
    [permDir[1][0] * (flip[0] ? -1 : 1) + 0, permDir[1][1] * (flip[1] ? -1 : 1) + 0, permDir[1][2] * (flip[2] ? -1 : 1) + 0],
    [permDir[2][0] * (flip[0] ? -1 : 1) + 0, permDir[2][1] * (flip[1] ? -1 : 1) + 0, permDir[2][2] * (flip[2] ? -1 : 1) + 0],
  ];

  if (Math.abs(det3(finalDir)) < 1e-6) {
    return geom;
  }
  return { size: newSize, spacing: newSpacing, origin: newOrigin, direction: finalDir };
}

/** Exact port of `blast_ct.nifti.rescale.get_reference_image(image, new_spacing)`. */
export function createRescaledGeometry(geom, targetSpacing = [1.0, 1.0, 1.0]) {
  const size = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const phys = (geom.size[a] - 1) * geom.spacing[a];
    size[a] = Math.max(1, roundHalfToEven(phys / targetSpacing[a] + 1));
  }
  return {
    size,
    spacing: [...targetSpacing],
    origin: [...geom.origin],
    direction: geom.direction.map((row) => [...row]),
  };
}

function sameGeometry(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.size[i] !== b.size[i]) return false;
    if (Math.abs(a.spacing[i] - b.spacing[i]) > 1e-6) return false;
    if (Math.abs(a.origin[i] - b.origin[i]) > 1e-5) return false;
    for (let j = 0; j < 3; j++) {
      if (Math.abs(a.direction[i][j] - b.direction[i][j]) > 1e-6) return false;
    }
  }
  return true;
}

/**
 * Exact ITK/SimpleITK `sitkLinear` resample from `srcData` (flat x + nx*(y + ny*z))
 * in `srcGeom` onto `dstGeom`, using `defaultValue` outside `[-0.5, size - 0.5)`.
 */
export function resampleLinear(srcData, srcGeom, dstGeom, defaultValue, maxVoxels = MAX_WORKING_VOXELS) {
  if (sameGeometry(srcGeom, dstGeom)) {
    return srcData instanceof Float32Array ? srcData : Float32Array.from(srcData);
  }
  const [dx, dy, dz] = dstGeom.size;
  const dstLen = dx * dy * dz;
  if (dstLen > maxVoxels) {
    throw new Error(
      `Resampled volume is ${dx} × ${dy} × ${dz} (${(dstLen / 1e6).toFixed(1)}M voxels), exceeding the ${(maxVoxels / 1e6).toFixed(0)}M-voxel browser limit. Crop to the head or use the Standalone container.`,
    );
  }

  const [sx, sy, sz] = srcGeom.size;
  const sPlane = sx * sy;
  const srcMap = indexToPhysical(srcGeom);
  const dstMap = indexToPhysical(dstGeom);
  const srcInv = inv3(srcMap.mat);
  // dstIdx -> srcIdx: A * dstIdx + t
  const A = matMul3(srcInv, dstMap.mat);
  const t = matVec3(srcInv, [
    dstMap.origin[0] - srcMap.origin[0],
    dstMap.origin[1] - srcMap.origin[1],
    dstMap.origin[2] - srcMap.origin[2],
  ]);

  const a00 = A[0][0]; const a01 = A[0][1]; const a02 = A[0][2];
  const a10 = A[1][0]; const a11 = A[1][1]; const a12 = A[1][2];
  const a20 = A[2][0]; const a21 = A[2][1]; const a22 = A[2][2];
  const t0 = t[0]; const t1 = t[1]; const t2 = t[2];

  const maxX = sx - 1;
  const maxY = sy - 1;
  const maxZ = sz - 1;
  const hiX = sx - 0.5;
  const hiY = sy - 0.5;
  const hiZ = sz - 0.5;

  const out = new Float32Array(dstLen);
  let outIdx = 0;
  for (let k = 0; k < dz; k++) {
    const kz0 = a02 * k + t0;
    const kz1 = a12 * k + t1;
    const kz2 = a22 * k + t2;
    for (let j = 0; j < dy; j++) {
      let cx = a01 * j + kz0;
      let cy = a11 * j + kz1;
      let cz = a21 * j + kz2;
      for (let i = 0; i < dx; i++, outIdx++, cx += a00, cy += a10, cz += a20) {
        // ITK ImageBase::IsInsideBuffer(ContinuousIndex): [-0.5, size - 0.5)
        if (cx < -0.5 || cx >= hiX || cy < -0.5 || cy >= hiY || cz < -0.5 || cz >= hiZ) {
          out[outIdx] = defaultValue;
          continue;
        }
        // ITK LinearInterpolateImageFunction clamps base/upper indices to [0, size-1]
        const x0 = Math.floor(cx);
        const y0 = Math.floor(cy);
        const z0 = Math.floor(cz);
        const wx = cx - x0;
        const wy = cy - y0;
        const wz = cz - z0;

        const ix0 = x0 < 0 ? 0 : x0 > maxX ? maxX : x0;
        const iy0 = y0 < 0 ? 0 : y0 > maxY ? maxY : y0;
        const iz0 = z0 < 0 ? 0 : z0 > maxZ ? maxZ : z0;
        const ix1 = x0 + 1 < 0 ? 0 : x0 + 1 > maxX ? maxX : x0 + 1;
        const iy1 = y0 + 1 < 0 ? 0 : y0 + 1 > maxY ? maxY : y0 + 1;
        const iz1 = z0 + 1 < 0 ? 0 : z0 + 1 > maxZ ? maxZ : z0 + 1;

        const zOff0 = iz0 * sPlane;
        const zOff1 = iz1 * sPlane;
        const yOff0 = iy0 * sx;
        const yOff1 = iy1 * sx;

        const c000 = srcData[zOff0 + yOff0 + ix0];
        const c100 = srcData[zOff0 + yOff0 + ix1];
        const c010 = srcData[zOff0 + yOff1 + ix0];
        const c110 = srcData[zOff0 + yOff1 + ix1];
        const c001 = srcData[zOff1 + yOff0 + ix0];
        const c101 = srcData[zOff1 + yOff0 + ix1];
        const c011 = srcData[zOff1 + yOff1 + ix0];
        const c111 = srcData[zOff1 + yOff1 + ix1];

        const c00 = c000 + (c100 - c000) * wx;
        const c10 = c010 + (c110 - c010) * wx;
        const c01 = c001 + (c101 - c001) * wx;
        const c11 = c011 + (c111 - c011) * wx;
        const c0 = c00 + (c10 - c00) * wy;
        const c1 = c01 + (c11 - c01) * wy;
        out[outIdx] = c0 + (c1 - c0) * wz;
      }
    }
  }
  return out;
}

/**
 * Exact ITK/SimpleITK `sitkNearestNeighbor` resample of integer labels from `srcGeom`
 * (reoriented 1 mm grid) back onto `dstGeom` (native input CT grid).
 */
export function resampleLabelsNearest(srcLabels, srcGeom, dstGeom) {
  const [dx, dy, dz] = dstGeom.size;
  const dstLen = dx * dy * dz;
  if (sameGeometry(srcGeom, dstGeom)) {
    return Uint8Array.from(srcLabels);
  }

  const [sx, sy, sz] = srcGeom.size;
  const sPlane = sx * sy;
  const srcMap = indexToPhysical(srcGeom);
  const dstMap = indexToPhysical(dstGeom);
  const srcInv = inv3(srcMap.mat);
  const A = matMul3(srcInv, dstMap.mat);
  const t = matVec3(srcInv, [
    dstMap.origin[0] - srcMap.origin[0],
    dstMap.origin[1] - srcMap.origin[1],
    dstMap.origin[2] - srcMap.origin[2],
  ]);

  const a00 = A[0][0]; const a01 = A[0][1]; const a02 = A[0][2];
  const a10 = A[1][0]; const a11 = A[1][1]; const a12 = A[1][2];
  const a20 = A[2][0]; const a21 = A[2][1]; const a22 = A[2][2];
  const t0 = t[0]; const t1 = t[1]; const t2 = t[2];

  const hiX = sx - 0.5;
  const hiY = sy - 0.5;
  const hiZ = sz - 0.5;

  const out = new Uint8Array(dstLen);
  let outIdx = 0;
  for (let k = 0; k < dz; k++) {
    const kz0 = a02 * k + t0;
    const kz1 = a12 * k + t1;
    const kz2 = a22 * k + t2;
    for (let j = 0; j < dy; j++) {
      let cx = a01 * j + kz0;
      let cy = a11 * j + kz1;
      let cz = a21 * j + kz2;
      for (let i = 0; i < dx; i++, outIdx++, cx += a00, cy += a10, cz += a20) {
        if (cx < -0.5 || cx >= hiX || cy < -0.5 || cy >= hiY || cz < -0.5 || cz >= hiZ) {
          out[outIdx] = 0;
          continue;
        }
        const ix = Math.floor(cx + 0.5);
        const iy = Math.floor(cy + 0.5);
        const iz = Math.floor(cz + 0.5);
        if (ix >= 0 && ix < sx && iy >= 0 && iy < sy && iz >= 0 && iz < sz) {
          out[outIdx] = srcLabels[iz * sPlane + iy * sx + ix];
        }
      }
    }
  }
  return out;
}

/**
 * Exact 2-step BLAST-CT preprocessing geometry:
 * 1. `reorient_image(image, is_discrete=False)`
 * 2. `rescale([1, 1, 1], reoriented, is_discrete=False)`
 */
export function prepareVolume1mm(srcData, nativeGeom) {
  const nativeLen = nativeGeom.size[0] * nativeGeom.size[1] * nativeGeom.size[2];
  const reorientedGeom = createReferenceReoriented(nativeGeom);
  const isoGeom = createRescaledGeometry(reorientedGeom, [1.0, 1.0, 1.0]);
  const [ix, iy, iz] = isoGeom.size;
  const isoLen = ix * iy * iz;
  if (isoLen > MAX_WORKING_VOXELS) {
    throw new Error(
      `1 mm working volume is ${ix} × ${iy} × ${iz} (${(isoLen / 1e6).toFixed(1)}M voxels), exceeding the 32M-voxel browser limit. Crop to the head or use the Standalone container.`,
    );
  }
  if (nativeLen > MAX_NATIVE_VOXELS) {
    throw new Error(
      `Native volume is ${nativeGeom.size.join(' × ')} (${(nativeLen / 1e6).toFixed(1)}M voxels), exceeding the 150M-voxel browser limit. Crop to the head or use the Standalone container.`,
    );
  }

  let minVal = Infinity;
  for (let i = 0; i < srcData.length; i++) {
    const v = srcData[i];
    if (v < minVal) minVal = v;
  }
  const reoriented = resampleLinear(srcData, nativeGeom, reorientedGeom, minVal, MAX_NATIVE_VOXELS);

  let reorMin = Infinity;
  for (let i = 0; i < reoriented.length; i++) {
    const v = reoriented[i];
    if (v < reorMin) reorMin = v;
  }
  const isoData = resampleLinear(reoriented, reorientedGeom, isoGeom, reorMin, MAX_WORKING_VOXELS);
  return { data: isoData, isoGeom, reorientedGeom };
}
