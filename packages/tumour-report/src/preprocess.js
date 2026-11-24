// Raidionics v1.3 preprocessing and spatial resampling in pure JavaScript.
// Reproduces raidionics_seg_lib (BSD-2-Clause): background cropping, nibabel
// resample_to_output (1 mm canonical RAS, linear), skimage linear resize,
// [0, 99.5] percentile clipping, zeromean_nonzero (ddof=1), inverse affine
// resampling, and 26-connected brain_overlap refinement.
//
// All 3D volumes use NIfTI Fortran linear order: x + nx * (y + ny * z).

export function product(dims) {
  return dims[0] * dims[1] * dims[2];
}

export function voxelIndex(x, y, z, dims) {
  return x + dims[0] * (y + dims[1] * z);
}

export function determinant3(affine) {
  const a00 = affine[0][0];
  const a01 = affine[0][1];
  const a02 = affine[0][2];
  const a10 = affine[1][0];
  const a11 = affine[1][1];
  const a12 = affine[1][2];
  const a20 = affine[2][0];
  const a21 = affine[2][1];
  const a22 = affine[2][2];
  return (
    a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20)
  );
}

export function voxelSpacingMm(affine) {
  return [0, 1, 2].map((col) => Math.hypot(affine[0][col], affine[1][col], affine[2][col]));
}

export function voxelVolumeMl(affine) {
  return Math.abs(determinant3(affine)) / 1000;
}

export function invertAffine4(m) {
  const det = determinant3(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('The image affine transform is singular.');
  }
  const [[a, b, c, tx], [d, e, f, ty], [g, h, i, tz]] = m;
  const r00 = (e * i - f * h) / det;
  const r01 = (c * h - b * i) / det;
  const r02 = (b * f - c * e) / det;
  const r10 = (f * g - d * i) / det;
  const r11 = (a * i - c * g) / det;
  const r12 = (c * d - a * f) / det;
  const r20 = (d * h - e * g) / det;
  const r21 = (b * g - a * h) / det;
  const r22 = (a * e - b * d) / det;
  const itx = -(r00 * tx + r01 * ty + r02 * tz);
  const ity = -(r10 * tx + r11 * ty + r12 * tz);
  const itz = -(r20 * tx + r21 * ty + r22 * tz);
  return [
    [r00, r01, r02, itx],
    [r10, r11, r12, ity],
    [r20, r21, r22, itz],
    [0, 0, 0, 1],
  ];
}

export function multiplyAffine4(a, b) {
  const out = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 1],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      out[r][c] = (
        a[r][0] * b[0][c]
        + a[r][1] * b[1][c]
        + a[r][2] * b[2][c]
        + a[r][3] * (c === 3 ? 1 : 0)
      );
    }
  }
  return out;
}

export function applyAffinePoint(affine, x, y, z) {
  return [
    affine[0][0] * x + affine[0][1] * y + affine[0][2] * z + affine[0][3],
    affine[1][0] * x + affine[1][1] * y + affine[1][2] * z + affine[1][3],
    affine[2][0] * x + affine[2][1] * y + affine[2][2] * z + affine[2][3],
  ];
}

export function validateVolume(volume, label = 'input') {
  if (!volume || !volume.data || !volume.dims || !volume.affine) {
    throw new Error(`Missing ${label} volume data.`);
  }
  const { dims, affine, data } = volume;
  if (dims.length !== 3 || dims.some((d) => !Number.isInteger(d) || d < 2)) {
    throw new Error(`The ${label} image must be a 3D volume.`);
  }
  if (data.length !== product(dims)) {
    throw new Error(`The ${label} voxel count does not match its dimensions.`);
  }
  if (!Array.isArray(affine) || affine.length !== 4) {
    throw new Error(`The ${label} image has an invalid spatial transform.`);
  }
  for (const row of affine) {
    if (!row || row.length !== 4 || Array.from(row).some((v) => !Number.isFinite(v))) {
      throw new Error(`The ${label} image has a non-finite spatial transform.`);
    }
  }
  const spacing = voxelSpacingMm(affine);
  if (spacing.some((s) => s < 0.05 || s > 20)) {
    throw new Error(`The ${label} image has unsupported voxel spacing (${spacing.map((s) => s.toFixed(2)).join(' × ')} mm).`);
  }
  invertAffine4(affine);
  return spacing;
}

// 6-connected binary_fill_holes matching scipy.ndimage.binary_fill_holes.
export function binaryFillHoles6(mask, dims) {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const outside = new Uint8Array(total);
  const queue = new Int32Array(total);
  let tail = 0;
  const seed = (idx) => {
    if (!mask[idx] && !outside[idx]) {
      outside[idx] = 1;
      queue[tail++] = idx;
    }
  };
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1) {
          seed(x + nx * (y + ny * z));
        }
      }
    }
  }
  const slice = nx * ny;
  for (let head = 0; head < tail; head++) {
    const idx = queue[head];
    const x = idx % nx;
    const rem = (idx - x) / nx;
    const y = rem % ny;
    const z = (rem - y) / ny;
    if (x > 0) seed(idx - 1);
    if (x < nx - 1) seed(idx + 1);
    if (y > 0) seed(idx - nx);
    if (y < ny - 1) seed(idx + nx);
    if (z > 0) seed(idx - slice);
    if (z < nz - 1) seed(idx + slice);
  }
  const filled = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    filled[i] = outside[i] ? 0 : 1;
  }
  return filled;
}

// Reproduces raidionicsseg/PreProcessing/brain_clipping.py crop_background_minimum.
// Preserves the input affine verbatim (as upstream nib.Nifti1Image(cropped, affine=volume.affine) does)
// so resampleToOutput and inverse resampling round-trip cleanly into cropBbox.
export function cropBackgroundMinimum(volume) {
  const { data, dims, affine } = volume;
  const [nx, ny, nz] = dims;
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || maxVal <= minVal) {
    throw new Error('The input image has no intensity variation.');
  }
  const limit = Math.trunc((maxVal - minVal) * 0.2);
  const fg = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= limit) fg[i] = 1;
  }
  const filled = binaryFillHoles6(fg, dims);
  let minX = nx;
  let minY = ny;
  let minZ = nz;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = nx * (y + ny * z);
      for (let x = 0; x < nx; x++) {
        if (!filled[base + x]) continue;
        if (x < minX) minX = x;
        if (x + 1 > maxX) maxX = x + 1;
        if (y < minY) minY = y;
        if (y + 1 > maxY) maxY = y + 1;
        if (z < minZ) minZ = z;
        if (z + 1 > maxZ) maxZ = z + 1;
      }
    }
  }
  if (maxX < 0) {
    throw new Error('No foreground region found in the input volume.');
  }
  const outDims = [maxX - minX, maxY - minY, maxZ - minZ];
  const cropped = new Float32Array(product(outDims));
  for (let z = 0; z < outDims[2]; z++) {
    for (let y = 0; y < outDims[1]; y++) {
      const srcBase = minX + nx * (minY + y + ny * (minZ + z));
      const dstBase = outDims[0] * (y + outDims[1] * z);
      cropped.set(data.subarray(srcBase, srcBase + outDims[0]), dstBase);
    }
  }
  return {
    volume: { data: cropped, dims: outDims, affine: affine.map((r) => [...r]) },
    cropBbox: [minX, minY, minZ, maxX, maxY, maxZ],
  };
}

// Reproduces nibabel.processing.vox2out_vox for 3D volumes.
export function vox2OutVox(dims, affine, voxelSizes = [1, 1, 1]) {
  const minRas = [Infinity, Infinity, Infinity];
  const maxRas = [-Infinity, -Infinity, -Infinity];
  for (const x of [0, dims[0] - 1]) {
    for (const y of [0, dims[1] - 1]) {
      for (const z of [0, dims[2] - 1]) {
        const pt = applyAffinePoint(affine, x, y, z);
        for (let a = 0; a < 3; a++) {
          if (pt[a] < minRas[a]) minRas[a] = pt[a];
          if (pt[a] > maxRas[a]) maxRas[a] = pt[a];
        }
      }
    }
  }
  const outDims = [0, 1, 2].map((a) => Math.ceil((maxRas[a] - minRas[a]) / voxelSizes[a]) + 1);
  const outAffine = [
    [voxelSizes[0], 0, 0, minRas[0]],
    [0, voxelSizes[1], 0, minRas[1]],
    [0, 0, voxelSizes[2], minRas[2]],
    [0, 0, 0, 1],
  ];
  return { dims: outDims, affine: outAffine };
}

// Reproduces nibabel.processing.resample_from_to with order=0 or order=1, mode='constant', cval=0.
export function resampleFromTo(srcVolume, targetDims, targetAffine, order = 1) {
  const { data: src, dims: srcDims, affine: srcAffine } = srcVolume;
  const [sxN, syN, szN] = srcDims;
  const [txN, tyN, tzN] = targetDims;
  const map = multiplyAffine4(invertAffine4(srcAffine), targetAffine);
  const m00 = map[0][0];
  const m01 = map[0][1];
  const m02 = map[0][2];
  const m03 = map[0][3];
  const m10 = map[1][0];
  const m11 = map[1][1];
  const m12 = map[1][2];
  const m13 = map[1][3];
  const m20 = map[2][0];
  const m21 = map[2][1];
  const m22 = map[2][2];
  const m23 = map[2][3];
  const maxX = sxN - 1;
  const maxY = syN - 1;
  const maxZ = szN - 1;
  const out = new Float32Array(txN * tyN * tzN);
  const xySrc = sxN * syN;

  if (order === 0) {
    for (let z = 0; z < tzN; z++) {
      const bz0 = m02 * z + m03;
      const bz1 = m12 * z + m13;
      const bz2 = m22 * z + m23;
      for (let y = 0; y < tyN; y++) {
        const by0 = m01 * y + bz0;
        const by1 = m11 * y + bz1;
        const by2 = m21 * y + bz2;
        const dstRow = txN * (y + tyN * z);
        for (let x = 0; x < txN; x++) {
          const sx = Math.round(m00 * x + by0);
          const sy = Math.round(m10 * x + by1);
          const sz = Math.round(m20 * x + by2);
          if (sx < 0 || sx > maxX || sy < 0 || sy > maxY || sz < 0 || sz > maxZ) continue;
          out[dstRow + x] = src[sx + sxN * sy + xySrc * sz];
        }
      }
    }
    return { data: out, dims: [...targetDims], affine: targetAffine.map((r) => [...r]) };
  }

  for (let z = 0; z < tzN; z++) {
    const bz0 = m02 * z + m03;
    const bz1 = m12 * z + m13;
    const bz2 = m22 * z + m23;
    for (let y = 0; y < tyN; y++) {
      const by0 = m01 * y + bz0;
      const by1 = m11 * y + bz1;
      const by2 = m21 * y + bz2;
      const dstRow = txN * (y + tyN * z);
      for (let x = 0; x < txN; x++) {
        const sx = m00 * x + by0;
        const sy = m10 * x + by1;
        const sz = m20 * x + by2;
        if (sx < 0 || sx > maxX || sy < 0 || sy > maxY || sz < 0 || sz > maxZ) continue;
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const z0 = Math.floor(sz);
        const x1 = x0 < maxX ? x0 + 1 : maxX;
        const y1 = y0 < maxY ? y0 + 1 : maxY;
        const z1 = z0 < maxZ ? z0 + 1 : maxZ;
        const fx = sx - x0;
        const fy = sy - y0;
        const fz = sz - z0;
        const omx = 1 - fx;
        const omy = 1 - fy;
        const omz = 1 - fz;
        const z0o = xySrc * z0;
        const z1o = xySrc * z1;
        const y0o = sxN * y0;
        const y1o = sxN * y1;
        const c000 = src[z0o + y0o + x0];
        const c100 = src[z0o + y0o + x1];
        const c010 = src[z0o + y1o + x0];
        const c110 = src[z0o + y1o + x1];
        const c001 = src[z1o + y0o + x0];
        const c101 = src[z1o + y0o + x1];
        const c011 = src[z1o + y1o + x0];
        const c111 = src[z1o + y1o + x1];
        const c00 = c000 * omx + c100 * fx;
        const c10 = c010 * omx + c110 * fx;
        const c01 = c001 * omx + c101 * fx;
        const c11 = c011 * omx + c111 * fx;
        out[dstRow + x] = (c00 * omy + c10 * fy) * omz + (c01 * omy + c11 * fy) * fz;
      }
    }
  }
  return { data: out, dims: [...targetDims], affine: targetAffine.map((r) => [...r]) };
}

export function resampleToOutput(volume, voxelSizes = [1, 1, 1], order = 1) {
  const { dims, affine } = vox2OutVox(volume.dims, volume.affine, voxelSizes);
  return resampleFromTo(volume, dims, affine, order);
}

function reflectIndex(i, n) {
  if (n <= 1) return 0;
  let p = i;
  while (p < 0 || p >= n) {
    if (p < 0) p = -p - 1;
    if (p >= n) p = 2 * n - 1 - p;
  }
  return p;
}

// Separable Gaussian smoothing with reflect boundary matching scipy/skimage anti_aliasing.
function gaussianSmooth3d(data, dims, sigmas) {
  const [nx, ny, nz] = dims;
  let current = data;
  for (let axis = 0; axis < 3; axis++) {
    const sigma = sigmas[axis];
    if (sigma <= 1e-12) continue;
    const radius = Math.floor(4 * sigma + 0.5);
    if (radius === 0) continue;
    const kernel = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const w = Math.exp(-0.5 * (k / sigma) ** 2);
      kernel[k + radius] = w;
      sum += w;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const out = new Float32Array(current.length);
    const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
    const len = dims[axis];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const pos = axis === 0 ? x : axis === 1 ? y : z;
          const idx = x + nx * (y + ny * z);
          const base = idx - pos * stride;
          let acc = 0;
          for (let k = -radius; k <= radius; k++) {
            acc += current[base + reflectIndex(pos + k, len) * stride] * kernel[k + radius];
          }
          out[idx] = acc;
        }
      }
    }
    current = out;
  }
  return current;
}

// Reproduces skimage.transform.resize(vol, dstDims, order=1, mode='reflect', anti_aliasing=True).
export function resizeLinear3d(data, srcDims, dstDims, { antiAliasing = true } = {}) {
  const [sxN, syN, szN] = srcDims;
  const [dxN, dyN, dzN] = dstDims;
  if (sxN === dxN && syN === dyN && szN === dzN) {
    return Float32Array.from(data);
  }
  const factors = [sxN / dxN, syN / dyN, szN / dzN];
  let source = data;
  if (antiAliasing) {
    const sigmas = factors.map((f) => (f > 1 ? (f - 1) / 2 : 0));
    if (sigmas.some((s) => s > 0)) {
      source = gaussianSmooth3d(data, srcDims, sigmas);
    }
  }
  const coords = [0, 1, 2].map((a) => {
    const srcLen = srcDims[a];
    const dstLen = dstDims[a];
    const scale = srcLen / dstLen;
    const c = new Float64Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      c[i] = (i + 0.5) * scale - 0.5;
    }
    return c;
  });

  const out = new Float32Array(dxN * dyN * dzN);
  const xySrc = sxN * syN;
  const clampCoord = (v, n) => {
    const i0 = Math.floor(v);
    const f = v - i0;
    return [reflectIndex(i0, n), reflectIndex(i0 + 1, n), f];
  };

  const xMap = Array.from({ length: dxN }, (_, x) => clampCoord(coords[0][x], sxN));
  const yMap = Array.from({ length: dyN }, (_, y) => clampCoord(coords[1][y], syN));
  const zMap = Array.from({ length: dzN }, (_, z) => clampCoord(coords[2][z], szN));

  for (let z = 0; z < dzN; z++) {
    const [z0, z1, fz] = zMap[z];
    const omz = 1 - fz;
    const z0o = z0 * xySrc;
    const z1o = z1 * xySrc;
    for (let y = 0; y < dyN; y++) {
      const [y0, y1, fy] = yMap[y];
      const omy = 1 - fy;
      const y0o = y0 * sxN;
      const y1o = y1 * sxN;
      const dstRow = dxN * (y + dyN * z);
      for (let x = 0; x < dxN; x++) {
        const [x0, x1, fx] = xMap[x];
        const omx = 1 - fx;
        const c00 = source[z0o + y0o + x0] * omx + source[z0o + y0o + x1] * fx;
        const c10 = source[z0o + y1o + x0] * omx + source[z0o + y1o + x1] * fx;
        const c01 = source[z1o + y0o + x0] * omx + source[z1o + y0o + x1] * fx;
        const c11 = source[z1o + y1o + x0] * omx + source[z1o + y1o + x1] * fx;
        out[dstRow + x] = (c00 * omy + c10 * fy) * omz + (c01 * omy + c11 * fy) * fz;
      }
    }
  }
  return out;
}

// Exact linear-interpolated percentile matching numpy.percentile(a, q).
export function percentileLinear(data, q) {
  const sorted = Float32Array.from(data).sort();
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Reproduces raidionics_seg_lib MRI intensity_clipping ([0, 99.5]) + zeromean_nonzero (ddof=1).
export function clipAndNormalize(data, upperPercentile = 99.5) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] < 0 ? 0 : data[i];
  }
  const hi = percentileLinear(out, upperPercentile);
  let count = 0;
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] > hi) out[i] = hi;
    if (out[i] !== 0) {
      count++;
      sum += out[i];
    }
  }
  if (count <= 1) return out;
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) {
      const diff = out[i] - mean;
      sq += diff * diff;
    }
  }
  const std = Math.sqrt(sq / (count - 1));
  if (std > 0) {
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== 0) {
        out[i] = (out[i] - mean) / std;
      }
    }
  }
  return out;
}

// Embeds a cropped volume back into full native dimensions at cropBbox.
export function uncropMask(croppedMask, cropBbox, fullDims) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = cropBbox;
  const cx = maxX - minX;
  const cy = maxY - minY;
  const cz = maxZ - minZ;
  const [nx, ny, nz] = fullDims;
  const out = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      const srcBase = cx * (y + cy * z);
      const dstBase = minX + nx * (minY + y + ny * (minZ + z));
      out.set(croppedMask.subarray(srcBase, srcBase + cx), dstBase);
    }
  }
  return out;
}

// 26-connected component labeling matching skimage.measure.label(mask, connectivity=3).
export function labelComponents26(mask, dims) {
  const [nx, ny, nz] = dims;
  const total = nx * ny * nz;
  const labels = new Int32Array(total);
  const queue = new Int32Array(total);
  const slice = nx * ny;
  let nextLabel = 0;

  for (let i = 0; i < total; i++) {
    if (!mask[i] || labels[i]) continue;
    nextLabel++;
    labels[i] = nextLabel;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    while (head < tail) {
      const cur = queue[head++];
      const x = cur % nx;
      const rem = (cur - x) / nx;
      const y = rem % ny;
      const z = (rem - y) / ny;
      const z0 = z > 0 ? z - 1 : 0;
      const z1 = z < nz - 1 ? z + 1 : nz - 1;
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < ny - 1 ? y + 1 : ny - 1;
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < nx - 1 ? x + 1 : nx - 1;
      for (let nzI = z0; nzI <= z1; nzI++) {
        const zOff = nzI * slice;
        for (let nyI = y0; nyI <= y1; nyI++) {
          const yOff = zOff + nyI * nx;
          for (let nxI = x0; nxI <= x1; nxI++) {
            const nb = yOff + nxI;
            if (mask[nb] && !labels[nb]) {
              labels[nb] = nextLabel;
              queue[tail++] = nb;
            }
          }
        }
      }
    }
  }
  return { labels, count: nextLabel };
}

// Reproduces raidionicsrads perform_brain_overlap_refinement: retains every 26-connected
// tumour component that shares at least one voxel with brainMask.
export function brainOverlapRefinement(tumourMask, brainMask, dims) {
  const { labels, count } = labelComponents26(tumourMask, dims);
  if (count === 0) return { mask: new Uint8Array(tumourMask.length), kept: 0, raw: 0 };
  const keep = new Uint8Array(count + 1);
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    if (id && brainMask[i]) keep[id] = 1;
  }
  const mask = new Uint8Array(tumourMask.length);
  for (let i = 0; i < labels.length; i++) {
    if (keep[labels[i]]) mask[i] = 1;
  }
  let kept = 0;
  for (let id = 1; id <= count; id++) kept += keep[id];
  return { mask, kept, raw: count };
}
