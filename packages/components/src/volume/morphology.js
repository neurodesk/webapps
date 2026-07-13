import { assertDims, index3D, voxelCount } from './geometry.js';

export function erodeMask3D(mask, dims, OutputCtor = mask.constructor) {
  assertDims(dims);
  const [nx, ny, nz] = dims;
  const out = new OutputCtor(mask.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = index3D(x, y, z, dims);
        if (!mask[idx]) continue;
        let keep = true;
        if (x > 0 && !mask[idx - 1]) keep = false;
        if (x < nx - 1 && !mask[idx + 1]) keep = false;
        if (y > 0 && !mask[idx - nx]) keep = false;
        if (y < ny - 1 && !mask[idx + nx]) keep = false;
        if (z > 0 && !mask[idx - nx * ny]) keep = false;
        if (z < nz - 1 && !mask[idx + nx * ny]) keep = false;
        out[idx] = keep ? 1 : 0;
      }
    }
  }
  return out;
}

export function dilateMask3D(mask, dims, iterations = 1, OutputCtor = mask.constructor) {
  assertDims(dims);
  let current = new OutputCtor(mask.length);
  current.set(mask);
  for (let step = 0; step < iterations; step++) {
    const out = new OutputCtor(current.length);
    const [nx, ny, nz] = dims;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = index3D(x, y, z, dims);
          if (current[idx]) {
            out[idx] = 1;
            if (x > 0) out[idx - 1] = 1;
            if (x < nx - 1) out[idx + 1] = 1;
            if (y > 0) out[idx - nx] = 1;
            if (y < ny - 1) out[idx + nx] = 1;
            if (z > 0) out[idx - nx * ny] = 1;
            if (z < nz - 1) out[idx + nx * ny] = 1;
          }
        }
      }
    }
    current = out;
  }
  return current;
}

export function fillHoles3D(mask, dims, OutputCtor = mask.constructor) {
  assertDims(dims);
  const [nx, ny, nz] = dims;
  const outside = new Uint8Array(voxelCount(dims));
  const queue = [];
  const pushIfOutside = idx => {
    if (!mask[idx] && !outside[idx]) {
      outside[idx] = 1;
      queue.push(idx);
    }
  };

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      pushIfOutside(index3D(0, y, z, dims));
      pushIfOutside(index3D(nx - 1, y, z, dims));
    }
    for (let x = 0; x < nx; x++) {
      pushIfOutside(index3D(x, 0, z, dims));
      pushIfOutside(index3D(x, ny - 1, z, dims));
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      pushIfOutside(index3D(x, y, 0, dims));
      pushIfOutside(index3D(x, y, nz - 1, dims));
    }
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % nx;
    const y = Math.floor((idx % (nx * ny)) / nx);
    const z = Math.floor(idx / (nx * ny));
    if (x > 0) pushIfOutside(idx - 1);
    if (x < nx - 1) pushIfOutside(idx + 1);
    if (y > 0) pushIfOutside(idx - nx);
    if (y < ny - 1) pushIfOutside(idx + nx);
    if (z > 0) pushIfOutside(idx - nx * ny);
    if (z < nz - 1) pushIfOutside(idx + nx * ny);
  }

  const result = new OutputCtor(mask.length);
  for (let i = 0; i < mask.length; i++) result[i] = mask[i] || !outside[i] ? 1 : 0;
  return result;
}

export function robustMask(mask, dims, options = {}) {
  const dilations = options.dilations ?? 2;
  const erosions = options.erosions ?? 2;
  let out = mask;
  if (dilations) out = dilateMask3D(out, dims, dilations);
  if (options.fillHoles ?? true) out = fillHoles3D(out, dims);
  for (let i = 0; i < erosions; i++) out = erodeMask3D(out, dims);
  return out;
}
