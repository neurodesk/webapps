// Cellpose 3.1.1.1 inference tiling, 3D ortho-plane averaging, flow dynamics and mask
// reconstruction (MouseLand/cellpose, BSD-3-Clause). Pure and DOM-free so the worker and
// Node unit tests both import it directly.

const f32 = Math.fround;

function sortedPercentile(sorted, p) {
  const index = (p / 100) * (sorted.length - 1);
  const below = Math.floor(index);
  const above = Math.min(below + 1, sorted.length - 1);
  const t = index - below;
  const a = sorted[below];
  const b = sorted[above];
  const diff = b - a;
  return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
}

/** `cellpose.transforms.normalize99(Y, lower=1, upper=99)`: float32 `(x - x01) / (x99 - x01)`. */
export function normalize99(values, lower = 1, upper = 99) {
  const sorted = Float64Array.from(values).sort();
  const low = sortedPercentile(sorted, lower);
  const high = sortedPercentile(sorted, upper);
  const out = new Float32Array(values.length);
  const span = high - low;
  if (span > 1e-3) {
    for (let i = 0; i < values.length; i++) out[i] = f32((values[i] - low) / span);
  }
  return { data: out, low: f32(low), high: f32(high) };
}

/** OpenCV `cv2.INTER_LINEAR` half-pixel-center bilinear resampling of one 2D plane. */
export function resizePlane2D(src, srcH, srcW, dstH, dstW) {
  if (srcH === dstH && srcW === dstW) return Float32Array.from(src);
  const out = new Float32Array(dstH * dstW);
  const scaleY = srcH / dstH;
  const scaleX = srcW / dstW;
  const x0Arr = new Int32Array(dstW);
  const x1Arr = new Int32Array(dstW);
  const wxArr = new Float32Array(dstW);
  for (let x = 0; x < dstW; x++) {
    const sx = (x + 0.5) * scaleX - 0.5;
    if (sx <= 0) {
      x0Arr[x] = 0;
      x1Arr[x] = 0;
      wxArr[x] = 0;
    } else if (sx >= srcW - 1) {
      x0Arr[x] = srcW - 1;
      x1Arr[x] = srcW - 1;
      wxArr[x] = 0;
    } else {
      const ix = Math.floor(sx);
      x0Arr[x] = ix;
      x1Arr[x] = ix + 1;
      wxArr[x] = sx - ix;
    }
  }
  for (let y = 0; y < dstH; y++) {
    const sy = (y + 0.5) * scaleY - 0.5;
    let y0;
    let y1;
    let wy;
    if (sy <= 0) {
      y0 = 0;
      y1 = 0;
      wy = 0;
    } else if (sy >= srcH - 1) {
      y0 = srcH - 1;
      y1 = srcH - 1;
      wy = 0;
    } else {
      y0 = Math.floor(sy);
      y1 = y0 + 1;
      wy = sy - y0;
    }
    const row0 = y0 * srcW;
    const row1 = y1 * srcW;
    const dstRow = y * dstW;
    const wy0 = 1 - wy;
    for (let x = 0; x < dstW; x++) {
      const x0 = x0Arr[x];
      const x1 = x1Arr[x];
      const wx = wxArr[x];
      const wx0 = 1 - wx;
      out[dstRow + x] =
        (src[row0 + x0] * wx0 + src[row0 + x1] * wx) * wy0 +
        (src[row1 + x0] * wx0 + src[row1 + x1] * wx) * wy;
    }
  }
  return out;
}

/** `cellpose.transforms.get_pad_yx(Ly, Lx, div=16, extra=1)`. */
export function getPadYX(Ly, Lx, div = 16, extra = 1) {
  const padY = div * Math.ceil(Ly / div) - Ly;
  const padX = div * Math.ceil(Lx / div) - Lx;
  const halfExtra = Math.floor((extra * div) / 2);
  const ypad1 = halfExtra + Math.floor(padY / 2);
  const ypad2 = halfExtra + padY - Math.floor(padY / 2);
  const xpad1 = halfExtra + Math.floor(padX / 2);
  const xpad2 = halfExtra + padX - Math.floor(padX / 2);
  return { ypad1, ypad2, xpad1, xpad2, Ly: Ly + ypad1 + ypad2, Lx: Lx + xpad1 + xpad2 };
}

/** `cellpose.transforms._taper_mask(ly, lx, sig=7.5)`. */
export function taperMask(ly, lx, sig = 7.5) {
  const bsize = Math.max(224, ly, lx);
  const mean = (bsize - 1) / 2;
  const line = new Float64Array(bsize);
  for (let i = 0; i < bsize; i++) {
    line[i] = 1 / (1 + Math.exp((Math.abs(i - mean) - (bsize / 2 - 20)) / sig));
  }
  const y0 = Math.floor(bsize / 2) - Math.floor(ly / 2);
  const x0 = Math.floor(bsize / 2) - Math.floor(lx / 2);
  const mask = new Float32Array(ly * lx);
  for (let y = 0; y < ly; y++) {
    const my = line[y0 + y];
    const row = y * lx;
    for (let x = 0; x < lx; x++) mask[row + x] = my * line[x0 + x];
  }
  return mask;
}

/** Tile start indices along one axis, matching `make_tiles(..., augment=False)`. */
export function tileStarts(len, bsize = 224, overlap = 0.1) {
  const clamped = Math.min(0.5, Math.max(0.05, overlap));
  const size = Math.min(bsize, len);
  const count = len <= bsize ? 1 : Math.ceil((1 + 2 * clamped) * len / bsize);
  const starts = [];
  if (count === 1) {
    starts.push(0);
  } else {
    for (let i = 0; i < count; i++) starts.push(Math.trunc((i * (len - size)) / (count - 1)));
  }
  return { size, starts };
}

/** Zero-pad a 2-channel `[ch0, ch1]` image to `(pad.Ly, pad.Lx)`. */
function padZero2Ch(ch0, ch1, height, width, pad) {
  const out0 = new Float32Array(pad.Ly * pad.Lx);
  const out1 = new Float32Array(pad.Ly * pad.Lx);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = (pad.ypad1 + y) * pad.Lx + pad.xpad1;
    out0.set(ch0.subarray(src, src + width), dst);
    if (ch1) out1.set(ch1.subarray(src, src + width), dst);
  }
  return [out0, out1];
}

/**
 * `cellpose.core.run_net` on one 2D 2-channel image `(ch0, ch1)` of shape `(height, width)`.
 * `runBatch(tensor, batch, tileH, tileW)` returns a flat Float32Array of shape `[batch, 3, tileH, tileW]`.
 */
export async function runNet2D(ch0, ch1, height, width, options) {
  const { bsize = 224, tileOverlap = 0.1, div = 16, extra = 1, runBatch, onTile = () => {} } = options;
  const pad = getPadYX(height, width, div, extra);
  const [p0, p1] = padZero2Ch(ch0, ch1, height, width, pad);
  const { size: ly, starts: yStarts } = tileStarts(pad.Ly, bsize, tileOverlap);
  const { size: lx, starts: xStarts } = tileStarts(pad.Lx, bsize, tileOverlap);
  const mask = taperMask(ly, lx);
  const total = yStarts.length * xStarts.length;
  const yf = [new Float32Array(pad.Ly * pad.Lx), new Float32Array(pad.Ly * pad.Lx), new Float32Array(pad.Ly * pad.Lx)];
  const navg = new Float64Array(pad.Ly * pad.Lx);
  const tilePlane = ly * lx;
  const tileInput = new Float32Array(2 * tilePlane);
  let done = 0;
  for (const ys of yStarts) {
    for (const xs of xStarts) {
      for (let y = 0; y < ly; y++) {
        const src = (ys + y) * pad.Lx + xs;
        const dst = y * lx;
        tileInput.set(p0.subarray(src, src + lx), dst);
        tileInput.set(p1.subarray(src, src + lx), tilePlane + dst);
      }
      const out = await runBatch(tileInput, 1, ly, lx);
      for (let y = 0; y < ly; y++) {
        const dstRow = (ys + y) * pad.Lx + xs;
        const srcRow = y * lx;
        for (let x = 0; x < lx; x++) {
          const m = mask[srcRow + x];
          navg[dstRow + x] += m;
          yf[0][dstRow + x] += out[srcRow + x] * m;
          yf[1][dstRow + x] += out[tilePlane + srcRow + x] * m;
          yf[2][dstRow + x] += out[2 * tilePlane + srcRow + x] * m;
        }
      }
      onTile(++done, total);
    }
  }
  const crop = [new Float32Array(height * width), new Float32Array(height * width), new Float32Array(height * width)];
  for (let y = 0; y < height; y++) {
    const srcRow = (pad.ypad1 + y) * pad.Lx + pad.xpad1;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      const w = navg[srcRow + x];
      crop[0][dstRow + x] = yf[0][srcRow + x] / w;
      crop[1][dstRow + x] = yf[1][srcRow + x] / w;
      crop[2][dstRow + x] = yf[2][srcRow + x] / w;
    }
  }
  return { dY: crop[0], dX: crop[1], cellprob: crop[2], tiles: total };
}

/**
 * `cellpose.core.run_net` on a stack of `nSlices` 2D 2-channel planes, batching slices up to
 * `batchSize` when each slice fits in a single tile (the common 3D ortho-plane case).
 */
async function runNetStack(slices0, slices1, height, width, options) {
  const { bsize = 224, tileOverlap = 0.1, div = 16, extra = 1, batchSize = 8, runBatch, onSlice = () => {} } = options;
  const nSlices = slices0.length;
  const pad = getPadYX(height, width, div, extra);
  const { size: ly, starts: yStarts } = tileStarts(pad.Ly, bsize, tileOverlap);
  const { size: lx, starts: xStarts } = tileStarts(pad.Lx, bsize, tileOverlap);
  const nTiles = yStarts.length * xStarts.length;
  const plane = height * width;
  const out0 = new Float32Array(nSlices * plane);
  const out1 = new Float32Array(nSlices * plane);
  const out2 = new Float32Array(nSlices * plane);

  if (nTiles === 1) {
    const tilePlane = ly * lx;
    for (let start = 0; start < nSlices; start += batchSize) {
      const batch = Math.min(batchSize, nSlices - start);
      const input = new Float32Array(batch * 2 * tilePlane);
      for (let b = 0; b < batch; b++) {
        const [p0, p1] = padZero2Ch(slices0[start + b], slices1 ? slices1[start + b] : null, height, width, pad);
        const base = b * 2 * tilePlane;
        input.set(p0, base);
        input.set(p1, base + tilePlane);
      }
      const flows = await runBatch(input, batch, ly, lx);
      for (let b = 0; b < batch; b++) {
        const fBase = b * 3 * tilePlane;
        const oBase = (start + b) * plane;
        for (let y = 0; y < height; y++) {
          const srcRow = (pad.ypad1 + y) * lx + pad.xpad1;
          const dstRow = oBase + y * width;
          out0.set(flows.subarray(fBase + srcRow, fBase + srcRow + width), dstRow);
          out1.set(flows.subarray(fBase + tilePlane + srcRow, fBase + tilePlane + srcRow + width), dstRow);
          out2.set(flows.subarray(fBase + 2 * tilePlane + srcRow, fBase + 2 * tilePlane + srcRow + width), dstRow);
        }
      }
      onSlice(start + batch, nSlices);
    }
    return [out0, out1, out2];
  }

  for (let s = 0; s < nSlices; s++) {
    const res = await runNet2D(slices0[s], slices1 ? slices1[s] : null, height, width, options);
    const oBase = s * plane;
    out0.set(res.dY, oBase);
    out1.set(res.dX, oBase);
    out2.set(res.cellprob, oBase);
    onSlice(s + 1, nSlices);
  }
  return [out0, out1, out2];
}

/**
 * `cellpose.core.run_3D`: run the 2D network along the three orthogonal plane sets `YX`, `ZY`,
 * and `ZX` and sum `(dZ, dY, dX, cellprob)` back into the 3D volume.
 */
export async function runOrtho3D(vol0, vol1, depth, height, width, options) {
  const { onPlane = () => {} } = options;
  const voxels = depth * height * width;
  const planeYX = height * width;
  const dZ = new Float32Array(voxels);
  const dY = new Float32Array(voxels);
  const dX = new Float32Array(voxels);
  const cellprob = new Float32Array(voxels);
  const totalSlices = depth + height + width;
  let completedBase = 0;

  // 1) YX planes (z = 0..depth-1): predicts (dY, dX, cellprob)
  const yx0 = [];
  const yx1 = vol1 ? [] : null;
  for (let z = 0; z < depth; z++) {
    yx0.push(vol0.subarray(z * planeYX, (z + 1) * planeYX));
    if (yx1) yx1.push(vol1.subarray(z * planeYX, (z + 1) * planeYX));
  }
  const [yxDY, yxDX, yxCP] = await runNetStack(yx0, yx1, height, width, {
    ...options,
    onSlice: (done) => onPlane(completedBase + done, totalSlices, "YX"),
  });
  for (let i = 0; i < voxels; i++) {
    dY[i] += yxDY[i];
    dX[i] += yxDX[i];
    cellprob[i] += yxCP[i];
  }
  completedBase += depth;

  // 2) ZY planes (indexed by y = 0..height-1, each slice is [depth, width]): predicts (dZ, dX, cellprob)
  // Matches cellpose pm=(1,0,2,3) -> shape (Ly, Lz, Lx), cp=(0,2)
  const zy0 = [];
  const zy1 = vol1 ? [] : null;
  for (let y = 0; y < height; y++) {
    const s0 = new Float32Array(depth * width);
    const s1 = vol1 ? new Float32Array(depth * width) : null;
    for (let z = 0; z < depth; z++) {
      const from = z * planeYX + y * width;
      s0.set(vol0.subarray(from, from + width), z * width);
      if (s1) s1.set(vol1.subarray(from, from + width), z * width);
    }
    zy0.push(s0);
    if (zy1) zy1.push(s1);
  }
  const [zyDZ, zyDX, zyCP] = await runNetStack(zy0, zy1, depth, width, {
    ...options,
    onSlice: (done) => onPlane(completedBase + done, totalSlices, "ZY"),
  });
  for (let y = 0; y < height; y++) {
    const sBase = y * depth * width;
    for (let z = 0; z < depth; z++) {
      const dst = z * planeYX + y * width;
      const src = sBase + z * width;
      for (let x = 0; x < width; x++) {
        dZ[dst + x] += zyDZ[src + x];
        dX[dst + x] += zyDX[src + x];
        cellprob[dst + x] += zyCP[src + x];
      }
    }
  }
  completedBase += height;

  // 3) ZX planes (indexed by x = 0..width-1, each slice is [depth, height]): predicts (dZ, dY, cellprob)
  // Matches cellpose pm=(2,0,1,3) -> shape (Lx, Lz, Ly), cp=(0,1)
  const zx0 = [];
  const zx1 = vol1 ? [] : null;
  for (let x = 0; x < width; x++) {
    const s0 = new Float32Array(depth * height);
    const s1 = vol1 ? new Float32Array(depth * height) : null;
    for (let z = 0; z < depth; z++) {
      const zOff = z * planeYX;
      const dst = z * height;
      for (let y = 0; y < height; y++) {
        const at = zOff + y * width + x;
        s0[dst + y] = vol0[at];
        if (s1) s1[dst + y] = vol1[at];
      }
    }
    zx0.push(s0);
    if (zx1) zx1.push(s1);
  }
  const [zxDZ, zxDY, zxCP] = await runNetStack(zx0, zx1, depth, height, {
    ...options,
    onSlice: (done) => onPlane(completedBase + done, totalSlices, "ZX"),
  });
  for (let x = 0; x < width; x++) {
    const sBase = x * depth * height;
    for (let z = 0; z < depth; z++) {
      const zOff = z * planeYX;
      const src = sBase + z * height;
      for (let y = 0; y < height; y++) {
        const at = zOff + y * width + x;
        dZ[at] += zxDZ[src + y];
        dY[at] += zxDY[src + y];
        cellprob[at] += zxCP[src + y];
      }
    }
  }
  return { dZ, dY, dX, cellprob };
}

/** `cellpose.dynamics.steps_interp` in 2D (`map_coordinates` bilinear Euler integration). */
export function followFlows2D(dY, dX, cellprob, height, width, cellprobThresh = 0, niter = 200) {
  const n = height * width;
  const fgIndices = [];
  const sY = new Float32Array(n);
  const sX = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (cellprob[i] > cellprobThresh) {
      fgIndices.push(i);
      sY[i] = f32(dY[i] / 5);
      sX[i] = f32(dX[i] / 5);
    }
  }
  const count = fgIndices.length;
  const py = new Float32Array(count);
  const px = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const idx = fgIndices[k];
    py[k] = Math.floor(idx / width);
    px[k] = idx % width;
  }
  const maxY = height - 1;
  const maxX = width - 1;
  for (let t = 0; t < niter; t++) {
    for (let k = 0; k < count; k++) {
      const y = py[k];
      const x = px[k];
      const yfl = Math.trunc(y);
      const xfl = Math.trunc(x);
      const yf = yfl < 0 ? 0 : yfl > maxY ? maxY : yfl;
      const xf = xfl < 0 ? 0 : xfl > maxX ? maxX : xfl;
      const yf1 = yf < maxY ? yf + 1 : maxY;
      const xf1 = xf < maxX ? xf + 1 : maxX;
      const fy = y - yfl;
      const fx = x - xfl;
      const w00 = (1 - fy) * (1 - fx);
      const w01 = (1 - fy) * fx;
      const w10 = fy * (1 - fx);
      const w11 = fy * fx;
      const i00 = yf * width + xf;
      const i01 = yf * width + xf1;
      const i10 = yf1 * width + xf;
      const i11 = yf1 * width + xf1;
      const stepY = sY[i00] * w00 + sY[i01] * w01 + sY[i10] * w10 + sY[i11] * w11;
      const stepX = sX[i00] * w00 + sX[i01] * w01 + sX[i10] * w10 + sX[i11] * w11;
      const ny = y + stepY;
      const nx = x + stepX;
      py[k] = ny < 0 ? 0 : ny > maxY ? maxY : ny;
      px[k] = nx < 0 ? 0 : nx > maxX ? maxX : nx;
    }
  }
  return { inds: Int32Array.from(fgIndices), pts: [py, px] };
}

/** `cellpose.dynamics.steps_interp` in 3D (matches `torch.nn.functional.grid_sample(..., align_corners=False)`). */
export function followFlows3D(dZ, dY, dX, cellprob, depth, height, width, cellprobThresh = 0, niter = 200) {
  const plane = height * width;
  const n = depth * plane;
  const fgIndices = [];
  const sZ = new Float32Array(n);
  const sY = new Float32Array(n);
  const sX = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (cellprob[i] > cellprobThresh) {
      fgIndices.push(i);
      sZ[i] = f32(dZ[i] / 5);
      sY[i] = f32(dY[i] / 5);
      sX[i] = f32(dX[i] / 5);
    }
  }
  const count = fgIndices.length;
  const pz = new Float32Array(count);
  const py = new Float32Array(count);
  const px = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const idx = fgIndices[k];
    const z = Math.floor(idx / plane);
    const rem = idx - z * plane;
    pz[k] = z;
    py[k] = Math.floor(rem / width);
    px[k] = rem % width;
  }
  const maxZ = depth - 1;
  const maxY = height - 1;
  const maxX = width - 1;
  const scaleZ = maxZ > 0 ? depth / maxZ : 1;
  const scaleY = maxY > 0 ? height / maxY : 1;
  const scaleX = maxX > 0 ? width / maxX : 1;

  for (let t = 0; t < niter; t++) {
    for (let k = 0; k < count; k++) {
      // grid_sample(align_corners=False) maps normalized coordinate u = 2*p/(L-1)-1 to ((u+1)*L - 1)/2 = p*L/(L-1) - 0.5
      const gz = pz[k] * scaleZ - 0.5;
      const gy = py[k] * scaleY - 0.5;
      const gx = px[k] * scaleX - 0.5;
      const z0 = Math.floor(gz);
      const y0 = Math.floor(gy);
      const x0 = Math.floor(gx);
      const fz = gz - z0;
      const fy = gy - y0;
      const fx = gx - x0;
      let dz = 0;
      let dy = 0;
      let dx = 0;
      for (let iz = 0; iz <= 1; iz++) {
        const zz = z0 + iz;
        if (zz < 0 || zz > maxZ) continue;
        const wz = iz === 0 ? 1 - fz : fz;
        const zOff = zz * plane;
        for (let iy = 0; iy <= 1; iy++) {
          const yy = y0 + iy;
          if (yy < 0 || yy > maxY) continue;
          const wzy = wz * (iy === 0 ? 1 - fy : fy);
          const yOff = zOff + yy * width;
          for (let ix = 0; ix <= 1; ix++) {
            const xx = x0 + ix;
            if (xx < 0 || xx > maxX) continue;
            const w = wzy * (ix === 0 ? 1 - fx : fx);
            const at = yOff + xx;
            dz += sZ[at] * w;
            dy += sY[at] * w;
            dx += sX[at] * w;
          }
        }
      }
      const nz = pz[k] + dz;
      const ny = py[k] + dy;
      const nx = px[k] + dx;
      pz[k] = nz < 0 ? 0 : nz > maxZ ? maxZ : nz;
      py[k] = ny < 0 ? 0 : ny > maxY ? maxY : ny;
      px[k] = nx < 0 ? 0 : nx > maxX ? maxX : nx;
    }
  }
  return { inds: Int32Array.from(fgIndices), pts: [pz, py, px] };
}

/** Separable 1D max filter of width 5 (radius 2) along all axes of a 2D or 3D Int32Array. */
function maxPool5ND(src, shape) {
  const ndim = shape.length;
  let current = src;
  const total = src.length;
  for (let axis = 0; axis < ndim; axis++) {
    const out = new Int32Array(total);
    const len = shape[axis];
    let stride = 1;
    for (let d = axis + 1; d < ndim; d++) stride *= shape[d];
    const outerStride = stride * len;
    const outerCount = total / outerStride;
    for (let o = 0; o < outerCount; o++) {
      const base = o * outerStride;
      for (let s = 0; s < stride; s++) {
        for (let i = 0; i < len; i++) {
          const i0 = Math.max(0, i - 2);
          const i1 = Math.min(len - 1, i + 2);
          let best = 0;
          for (let j = i0; j <= i1; j++) {
            const v = current[base + j * stride + s];
            if (v > best) best = v;
          }
          out[base + i * stride + s] = best;
        }
      }
    }
    current = out;
  }
  return current;
}

/**
 * `cellpose.dynamics.get_masks_torch`: histogram peak detection + 5-step local dilation +
 * max-size-fraction filtering and sequential renumbering. Works in both 2D and 3D.
 */
export function clusterMasks(pts, inds, shape, options = {}) {
  const { rpad = 20, maxSizeFraction = 0.4 } = options;
  const ndim = shape.length;
  const totalPixels = shape.reduce((a, b) => a * b, 1);
  if (!inds.length) return new Int32Array(totalPixels);

  const hShape = shape.map((s) => s + 2 * rpad);
  const strides = new Int32Array(ndim);
  strides[ndim - 1] = 1;
  for (let d = ndim - 2; d >= 0; d--) strides[d] = strides[d + 1] * hShape[d + 1];
  const hTotal = hShape.reduce((a, b) => a * b, 1);
  const h1 = new Int32Array(hTotal);
  const ptFlat = new Int32Array(inds.length);
  for (let i = 0; i < inds.length; i++) {
    let flat = 0;
    for (let d = 0; d < ndim; d++) {
      let c = Math.trunc(pts[d][i]) + rpad;
      if (c < 0) c = 0;
      else if (c > shape[d] + rpad - 1) c = shape[d] + rpad - 1;
      flat += c * strides[d];
    }
    ptFlat[i] = flat;
    h1[flat]++;
  }

  const hmax = maxPool5ND(h1, hShape);
  const seeds = [];
  for (let i = 0; i < hTotal; i++) {
    if (h1[i] > 10 && h1[i] >= hmax[i]) seeds.push(i);
  }
  if (!seeds.length) return new Int32Array(totalPixels);
  seeds.sort((a, b) => h1[a] - h1[b] || a - b);

  const M1 = new Int32Array(hTotal);
  if (ndim === 2) {
    const W = hShape[1];
    const patch = new Uint8Array(121);
    const next = new Uint8Array(121);
    const localH = new Uint8Array(121);
    for (let k = 0; k < seeds.length; k++) {
      const s = seeds[k];
      const sy = Math.floor(s / W);
      const sx = s - sy * W;
      for (let dy = -5; dy <= 5; dy++) {
        const row = (sy + dy) * W + (sx - 5);
        const pRow = (dy + 5) * 11;
        for (let dx = 0; dx < 11; dx++) localH[pRow + dx] = h1[row + dx] > 2 ? 1 : 0;
      }
      patch.fill(0);
      patch[5 * 11 + 5] = 1;
      for (let iter = 0; iter < 5; iter++) {
        next.fill(0);
        for (let py = 0; py < 11; py++) {
          for (let px = 0; px < 11; px++) {
            const at = py * 11 + px;
            if (!localH[at]) continue;
            let hit = 0;
            const y0 = Math.max(0, py - 1);
            const y1 = Math.min(10, py + 1);
            const x0 = Math.max(0, px - 1);
            const x1 = Math.min(10, px + 1);
            for (let ny = y0; ny <= y1 && !hit; ny++) {
              for (let nx = x0; nx <= x1; nx++) {
                if (patch[ny * 11 + nx]) {
                  hit = 1;
                  break;
                }
              }
            }
            next[at] = hit;
          }
        }
        patch.set(next);
      }
      const label = k + 1;
      for (let py = 0; py < 11; py++) {
        const dstRow = (sy + py - 5) * W + (sx - 5);
        const pRow = py * 11;
        for (let px = 0; px < 11; px++) {
          if (patch[pRow + px]) M1[dstRow + px] = label;
        }
      }
    }
  } else {
    const H = hShape[1];
    const W = hShape[2];
    const plane = H * W;
    const patch = new Uint8Array(1331);
    const next = new Uint8Array(1331);
    const localH = new Uint8Array(1331);
    for (let k = 0; k < seeds.length; k++) {
      const s = seeds[k];
      const sz = Math.floor(s / plane);
      const rem = s - sz * plane;
      const sy = Math.floor(rem / W);
      const sx = rem - sy * W;
      for (let dz = -5; dz <= 5; dz++) {
        const zOff = (sz + dz) * plane;
        const pzOff = (dz + 5) * 121;
        for (let dy = -5; dy <= 5; dy++) {
          const row = zOff + (sy + dy) * W + (sx - 5);
          const pRow = pzOff + (dy + 5) * 11;
          for (let dx = 0; dx < 11; dx++) localH[pRow + dx] = h1[row + dx] > 2 ? 1 : 0;
        }
      }
      patch.fill(0);
      patch[5 * 121 + 5 * 11 + 5] = 1;
      for (let iter = 0; iter < 5; iter++) {
        next.fill(0);
        for (let pz = 0; pz < 11; pz++) {
          const z0 = Math.max(0, pz - 1);
          const z1 = Math.min(10, pz + 1);
          for (let py = 0; py < 11; py++) {
            const y0 = Math.max(0, py - 1);
            const y1 = Math.min(10, py + 1);
            for (let px = 0; px < 11; px++) {
              const at = pz * 121 + py * 11 + px;
              if (!localH[at]) continue;
              const x0 = Math.max(0, px - 1);
              const x1 = Math.min(10, px + 1);
              let hit = 0;
              for (let nz = z0; nz <= z1 && !hit; nz++) {
                for (let ny = y0; ny <= y1 && !hit; ny++) {
                  for (let nx = x0; nx <= x1; nx++) {
                    if (patch[nz * 121 + ny * 11 + nx]) {
                      hit = 1;
                      break;
                    }
                  }
                }
              }
              next[at] = hit;
            }
          }
        }
        patch.set(next);
      }
      const label = k + 1;
      for (let pz = 0; pz < 11; pz++) {
        const zOff = (sz + pz - 5) * plane;
        const pzOff = pz * 121;
        for (let py = 0; py < 11; py++) {
          const dstRow = zOff + (sy + py - 5) * W + (sx - 5);
          const pRow = pzOff + py * 11;
          for (let px = 0; px < 11; px++) {
            if (patch[pRow + px]) M1[dstRow + px] = label;
          }
        }
      }
    }
  }

  const M0 = new Int32Array(totalPixels);
  const counts = new Int32Array(seeds.length + 1);
  for (let i = 0; i < inds.length; i++) {
    const label = M1[ptFlat[i]];
    if (label) {
      M0[inds[i]] = label;
      counts[label]++;
    }
  }

  const maxPixels = totalPixels * maxSizeFraction;
  const remap = new Int32Array(seeds.length + 1);
  let nextLabel = 0;
  for (let label = 1; label <= seeds.length; label++) {
    if (counts[label] > 0 && counts[label] <= maxPixels) remap[label] = ++nextLabel;
  }
  for (let i = 0; i < totalPixels; i++) {
    const label = M0[i];
    if (label) M0[i] = remap[label];
  }
  return M0;
}

/**
 * `cellpose.dynamics.remove_bad_flow_masks` + `masks_to_flows_cpu` + `metrics.flow_error`:
 * computes heat-diffusion flows for each 2D mask and discards masks whose mean squared flow
 * error against `dP / 5` exceeds `threshold`.
 */
export function removeBadFlowMasks2D(labels, dY, dX, height, width, threshold = 0.4) {
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  if (!maxLabel || !(threshold > 0)) return labels;

  const rMin = new Int32Array(maxLabel + 1).fill(height);
  const rMax = new Int32Array(maxLabel + 1).fill(-1);
  const cMin = new Int32Array(maxLabel + 1).fill(width);
  const cMax = new Int32Array(maxLabel + 1).fill(-1);
  for (let r = 0; r < height; r++) {
    const row = r * width;
    for (let c = 0; c < width; c++) {
      const label = labels[row + c];
      if (!label) continue;
      if (r < rMin[label]) rMin[label] = r;
      if (r > rMax[label]) rMax[label] = r;
      if (c < cMin[label]) cMin[label] = c;
      if (c > cMax[label]) cMax[label] = c;
    }
  }

  const keep = new Uint8Array(maxLabel + 1);
  for (let label = 1; label <= maxLabel; label++) {
    if (rMax[label] < 0) continue;
    const r0 = rMin[label];
    const c0 = cMin[label];
    const ly = rMax[label] - r0 + 3;
    const lx = cMax[label] - c0 + 3;
    const ys = [];
    const xs = [];
    let sumY = 0;
    let sumX = 0;
    for (let r = r0; r <= rMax[label]; r++) {
      const row = r * width;
      for (let c = c0; c <= cMax[label]; c++) {
        if (labels[row + c] !== label) continue;
        const y = r - r0 + 1;
        const x = c - c0 + 1;
        ys.push(y);
        xs.push(x);
        sumY += y;
        sumX += x;
      }
    }
    const count = ys.length;
    const meanY = sumY / count;
    const meanX = sumX / count;
    let bestD2 = Infinity;
    let medIdx = 0;
    for (let k = 0; k < count; k++) {
      const dy = ys[k] - meanY;
      const dx = xs[k] - meanX;
      const d2 = dy * dy + dx * dx;
      if (d2 < bestD2) {
        bestD2 = d2;
        medIdx = k;
      }
    }
    const medOff = ys[medIdx] * lx + xs[medIdx];
    const T = new Float64Array(ly * lx);
    const nIter = 2 * (ly + lx);
    const offsets = new Int32Array(count);
    for (let k = 0; k < count; k++) offsets[k] = ys[k] * lx + xs[k];
    for (let t = 0; t < nIter; t++) {
      T[medOff] += 1;
      for (let k = 0; k < count; k++) {
        const off = offsets[k];
        T[off] =
          (T[off] +
            T[off - lx] +
            T[off + lx] +
            T[off - 1] +
            T[off + 1] +
            T[off - lx - 1] +
            T[off - lx + 1] +
            T[off + lx - 1] +
            T[off + lx + 1]) /
          9;
      }
    }
    let errSum = 0;
    for (let k = 0; k < count; k++) {
      const off = offsets[k];
      const gy = T[off + lx] - T[off - lx];
      const gx = T[off + 1] - T[off - 1];
      const norm = 1e-60 + Math.hypot(gy, gx);
      const muY = gy / norm;
      const muX = gx / norm;
      const imgIdx = (r0 + ys[k] - 1) * width + (c0 + xs[k] - 1);
      const eY = muY - dY[imgIdx] / 5;
      const eX = muX - dX[imgIdx] / 5;
      errSum += eY * eY + eX * eX;
    }
    if (errSum / count <= threshold) keep[label] = 1;
  }

  const remap = new Int32Array(maxLabel + 1);
  let nextLabel = 0;
  for (let label = 1; label <= maxLabel; label++) if (keep[label]) remap[label] = ++nextLabel;
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label) out[i] = remap[label];
  }
  return out;
}

/** 2D binary hole filling on a `(bh × bw)` Uint8Array mask via exterior 4-connected BFS. */
function fillHoles2D(mask, bh, bw) {
  const ph = bh + 2;
  const pw = bw + 2;
  const visited = new Uint8Array(ph * pw);
  const queue = new Int32Array(ph * pw);
  let head = 0;
  let tail = 0;
  visited[0] = 1;
  queue[tail++] = 0;
  while (head < tail) {
    const at = queue[head++];
    const r = Math.floor(at / pw);
    const c = at - r * pw;
    const neighbors = [
      r > 0 ? at - pw : -1,
      r + 1 < ph ? at + pw : -1,
      c > 0 ? at - 1 : -1,
      c + 1 < pw ? at + 1 : -1,
    ];
    for (const next of neighbors) {
      if (next < 0 || visited[next]) continue;
      const nr = Math.floor(next / pw);
      const nc = next - nr * pw;
      const inside = nr >= 1 && nr <= bh && nc >= 1 && nc <= bw && mask[(nr - 1) * bw + (nc - 1)];
      if (inside) continue;
      visited[next] = 1;
      queue[tail++] = next;
    }
  }
  for (let r = 0; r < bh; r++) {
    const pRow = (r + 1) * pw + 1;
    const mRow = r * bw;
    for (let c = 0; c < bw; c++) {
      if (!visited[pRow + c]) mask[mRow + c] = 1;
    }
  }
}

/** `cellpose.utils.fill_holes_and_remove_small_masks(masks, min_size=15)` in 2D or 3D. */
export function fillHolesAndRemoveSmallMasks(labels, shape, minSize = 15) {
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  if (!maxLabel) return new Int32Array(labels.length);

  const is3d = shape.length === 3;
  const depth = is3d ? shape[0] : 1;
  const height = is3d ? shape[1] : shape[0];
  const width = is3d ? shape[2] : shape[1];
  const plane = height * width;

  const zMin = new Int32Array(maxLabel + 1).fill(depth);
  const zMax = new Int32Array(maxLabel + 1).fill(-1);
  const yMin = new Int32Array(maxLabel + 1).fill(height);
  const yMax = new Int32Array(maxLabel + 1).fill(-1);
  const xMin = new Int32Array(maxLabel + 1).fill(width);
  const xMax = new Int32Array(maxLabel + 1).fill(-1);
  const counts = new Int32Array(maxLabel + 1);

  for (let z = 0; z < depth; z++) {
    const zOff = z * plane;
    for (let y = 0; y < height; y++) {
      const yOff = zOff + y * width;
      for (let x = 0; x < width; x++) {
        const label = labels[yOff + x];
        if (!label) continue;
        counts[label]++;
        if (z < zMin[label]) zMin[label] = z;
        if (z > zMax[label]) zMax[label] = z;
        if (y < yMin[label]) yMin[label] = y;
        if (y > yMax[label]) yMax[label] = y;
        if (x < xMin[label]) xMin[label] = x;
        if (x > xMax[label]) xMax[label] = x;
      }
    }
  }

  const out = new Int32Array(labels.length);
  let nextLabel = 0;
  for (let label = 1; label <= maxLabel; label++) {
    if (counts[label] === 0 || (minSize > 0 && counts[label] < minSize)) continue;
    nextLabel++;
    const bh = yMax[label] - yMin[label] + 1;
    const bw = xMax[label] - xMin[label] + 1;
    const sliceMask = new Uint8Array(bh * bw);
    for (let z = zMin[label]; z <= zMax[label]; z++) {
      const zOff = z * plane;
      let any = false;
      sliceMask.fill(0);
      for (let y = 0; y < bh; y++) {
        const row = zOff + (yMin[label] + y) * width + xMin[label];
        const mRow = y * bw;
        for (let x = 0; x < bw; x++) {
          if (labels[row + x] === label) {
            sliceMask[mRow + x] = 1;
            any = true;
          }
        }
      }
      if (!any) continue;
      fillHoles2D(sliceMask, bh, bw);
      for (let y = 0; y < bh; y++) {
        const row = zOff + (yMin[label] + y) * width + xMin[label];
        const mRow = y * bw;
        for (let x = 0; x < bw; x++) {
          if (sliceMask[mRow + x]) out[row + x] = nextLabel;
        }
      }
    }
  }
  return out;
}

/** Per-cell 2D measurements: centroid (x, y), area in pixels, mean intensity in primary channel. */
export function measureCells2D(labels, primary, width) {
  let count = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > count) count = labels[i];
  const area = new Float64Array(count + 1);
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  const sum = new Float64Array(count + 1);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    area[label]++;
    sumX[label] += i % width;
    sumY[label] += Math.floor(i / width);
    sum[label] += primary[i];
  }
  const rows = [];
  for (let label = 1; label <= count; label++) {
    if (!area[label]) continue;
    rows.push({ id: label, x: sumX[label] / area[label], y: sumY[label] / area[label], area: area[label], mean: sum[label] / area[label] });
  }
  return rows;
}

/** Per-cell 3D measurements: centroid (x, y, z), volume in voxels, mean intensity in primary channel. */
export function measureCells3D(labels, primary, depth, height, width) {
  let count = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > count) count = labels[i];
  const area = new Float64Array(count + 1);
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  const sumZ = new Float64Array(count + 1);
  const sum = new Float64Array(count + 1);
  const plane = height * width;
  for (let z = 0; z < depth; z++) {
    const zOff = z * plane;
    for (let y = 0; y < height; y++) {
      const yOff = zOff + y * width;
      for (let x = 0; x < width; x++) {
        const at = yOff + x;
        const label = labels[at];
        if (!label) continue;
        area[label]++;
        sumX[label] += x;
        sumY[label] += y;
        sumZ[label] += z;
        sum[label] += primary[at];
      }
    }
  }
  const rows = [];
  for (let label = 1; label <= count; label++) {
    if (!area[label]) continue;
    rows.push({
      id: label,
      x: sumX[label] / area[label],
      y: sumY[label] / area[label],
      z: sumZ[label] / area[label],
      volume: area[label],
      mean: sum[label] / area[label],
    });
  }
  return rows;
}

/** Full Cellpose 3 2D segmentation pipeline. */
export async function segment2D(primaryRaw, nuclearRaw, height, width, model, options) {
  const {
    diameter = model.diamMean,
    flowThresh = model.defaults.flowThresh,
    cellprobThresh = model.defaults.cellprobThresh,
    minSize = model.defaults.minSize,
    runBatch,
    onTile = () => {},
    onStage = () => {},
  } = options;
  const norm0 = normalize99(primaryRaw, 1, 99);
  const norm1 = nuclearRaw ? normalize99(nuclearRaw, 1, 99) : null;
  const rescale = model.diamMean / diameter;
  const resH = rescale !== 1 ? Math.max(16, Math.floor(height * rescale)) : height;
  const resW = rescale !== 1 ? Math.max(16, Math.floor(width * rescale)) : width;
  const in0 = rescale !== 1 ? resizePlane2D(norm0.data, height, width, resH, resW) : norm0.data;
  const in1 = norm1 ? (rescale !== 1 ? resizePlane2D(norm1.data, height, width, resH, resW) : norm1.data) : null;

  const netOut = await runNet2D(in0, in1, resH, resW, {
    bsize: model.bsize,
    tileOverlap: model.tileOverlap,
    div: model.divBy,
    extra: model.extraPad,
    runBatch,
    onTile,
  });

  const dY = rescale !== 1 ? resizePlane2D(netOut.dY, resH, resW, height, width) : netOut.dY;
  const dX = rescale !== 1 ? resizePlane2D(netOut.dX, resH, resW, height, width) : netOut.dX;
  const cellprob = rescale !== 1 ? resizePlane2D(netOut.cellprob, resH, resW, height, width) : netOut.cellprob;

  const niter = Math.max(1, Math.trunc((1 / rescale) * 200));
  onStage("dynamics", niter);
  const { inds, pts } = followFlows2D(dY, dX, cellprob, height, width, cellprobThresh, niter);
  onStage("masks", inds.length);
  let labels = clusterMasks(pts, inds, [height, width], { maxSizeFraction: model.defaults.maxSizeFraction });
  if (flowThresh > 0) {
    onStage("qc", 0);
    labels = removeBadFlowMasks2D(labels, dY, dX, height, width, flowThresh);
  }
  labels = fillHolesAndRemoveSmallMasks(labels, [height, width], minSize);
  const cells = measureCells2D(labels, primaryRaw, width);
  return {
    labels,
    cells,
    count: cells.length,
    tiles: netOut.tiles,
    normalization: { low: norm0.low, high: norm0.high },
  };
}

/** Resize a 3D volume plane-by-plane along XY and optionally along Z. */
function resizeVolume3D(vol, srcD, srcH, srcW, dstD, dstH, dstW) {
  let current = vol;
  let curH = srcH;
  let curW = srcW;
  if (srcH !== dstH || srcW !== dstW) {
    const xy = new Float32Array(srcD * dstH * dstW);
    const srcPlane = srcH * srcW;
    const dstPlane = dstH * dstW;
    for (let z = 0; z < srcD; z++) {
      xy.set(resizePlane2D(current.subarray(z * srcPlane, (z + 1) * srcPlane), srcH, srcW, dstH, dstW), z * dstPlane);
    }
    current = xy;
    curH = dstH;
    curW = dstW;
  }
  if (srcD === dstD) return current;
  const out = new Float32Array(dstD * curH * curW);
  const dstPlane = curH * curW;
  const srcPlane = curH * curW;
  const zxSrc = new Float32Array(srcD * curW);
  for (let y = 0; y < curH; y++) {
    for (let z = 0; z < srcD; z++) {
      const from = z * srcPlane + y * curW;
      zxSrc.set(current.subarray(from, from + curW), z * curW);
    }
    const zxDst = resizePlane2D(zxSrc, srcD, curW, dstD, curW);
    for (let z = 0; z < dstD; z++) {
      out.set(zxDst.subarray(z * curW, (z + 1) * curW), z * dstPlane + y * curW);
    }
  }
  return out;
}

/** Full Cellpose 3 3D ortho-plane segmentation pipeline (`do_3D=True`). */
export async function segment3D(primaryRaw, nuclearRaw, depth, height, width, model, options) {
  const {
    diameter = model.diamMean,
    anisotropy = 1,
    cellprobThresh = model.defaults.cellprobThresh,
    minSize = model.defaults.minSize,
    runBatch,
    onPlane = () => {},
    onStage = () => {},
  } = options;
  const norm0 = normalize99(primaryRaw, 1, 99);
  const norm1 = nuclearRaw ? normalize99(nuclearRaw, 1, 99) : null;
  const rescale = model.diamMean / diameter;
  const resD = rescale !== 1 || anisotropy !== 1 ? Math.max(4, Math.floor(depth * anisotropy * rescale)) : depth;
  const resH = rescale !== 1 ? Math.max(16, Math.floor(height * rescale)) : height;
  const resW = rescale !== 1 ? Math.max(16, Math.floor(width * rescale)) : width;
  const in0 = resD !== depth || resH !== height || resW !== width ? resizeVolume3D(norm0.data, depth, height, width, resD, resH, resW) : norm0.data;
  const in1 = norm1 ? (resD !== depth || resH !== height || resW !== width ? resizeVolume3D(norm1.data, depth, height, width, resD, resH, resW) : norm1.data) : null;

  const netOut = await runOrtho3D(in0, in1, resD, resH, resW, {
    bsize: model.bsize,
    tileOverlap: model.tileOverlap,
    div: model.divBy,
    extra: model.extraPad,
    runBatch,
    onPlane,
  });

  const needUnresize = resD !== depth || resH !== height || resW !== width;
  const dZ = needUnresize ? resizeVolume3D(netOut.dZ, resD, resH, resW, depth, height, width) : netOut.dZ;
  const dY = needUnresize ? resizeVolume3D(netOut.dY, resD, resH, resW, depth, height, width) : netOut.dY;
  const dX = needUnresize ? resizeVolume3D(netOut.dX, resD, resH, resW, depth, height, width) : netOut.dX;
  const cellprob = needUnresize ? resizeVolume3D(netOut.cellprob, resD, resH, resW, depth, height, width) : netOut.cellprob;

  const niter = 200;
  onStage("dynamics", niter);
  const { inds, pts } = followFlows3D(dZ, dY, dX, cellprob, depth, height, width, cellprobThresh, niter);
  onStage("masks", inds.length);
  let labels = clusterMasks(pts, inds, [depth, height, width], { maxSizeFraction: model.defaults.maxSizeFraction });
  labels = fillHolesAndRemoveSmallMasks(labels, [depth, height, width], minSize);
  const cells = measureCells3D(labels, primaryRaw, depth, height, width);
  return {
    labels,
    cells,
    count: cells.length,
    normalization: { low: norm0.low, high: norm0.high },
  };
}
