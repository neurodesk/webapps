// The before/after preview's frames: one axial slice of every volume, shown with a grey
// scale that is the same for both images of a volume.

/** The slice z (default the middle) of every volume of a series (x fastest, volumes last). */
export function axialSlices(data, dims, frames, z = Math.floor(dims[2] / 2)) {
  const [nx, ny] = dims;
  const plane = nx * ny;
  const volume = plane * dims[2];
  return Array.from({ length: frames }, (_, v) => Float32Array.from(data.subarray(v * volume + z * plane, v * volume + (z + 1) * plane)));
}

/** The 99.5th percentile of the positive values of the slices: the top of the grey scale. */
export function greyScale(...slices) {
  const values = [];
  for (const slice of slices) for (const x of slice) if (x > 0 && Number.isFinite(x)) values.push(x);
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(0.995 * values.length))] || 1;
}

/** RGBA pixels of a slice, anterior up (NIfTI rows run from posterior, so rows are reversed). */
export function greyPixels(slice, [nx, ny], scale) {
  const pixels = new Uint8ClampedArray(nx * ny * 4);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const value = Math.max(0, Math.min(255, (255 * slice[x + nx * y]) / scale));
      const o = 4 * (x + nx * (ny - 1 - y));
      pixels[o] = value;
      pixels[o + 1] = value;
      pixels[o + 2] = value;
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}
