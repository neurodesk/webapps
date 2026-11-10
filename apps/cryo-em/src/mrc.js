// MRC2014 reading for display: micrographs, power spectra, image stacks and
// maps. Modes 0 (int8), 1 (int16), 2 (float32), 6 (uint16) and 12 (float16),
// either byte order (MACHST). Pure, so the tests run it under Node.

const HEADER_BYTES = 1024;

const MODES = {
  0: { bytes: 1, read: (view, offset) => view.getInt8(offset) },
  1: { bytes: 2, read: (view, offset, little) => view.getInt16(offset, little) },
  2: { bytes: 4, read: (view, offset, little) => view.getFloat32(offset, little) },
  6: { bytes: 2, read: (view, offset, little) => view.getUint16(offset, little) },
  12: { bytes: 2, read: (view, offset, little) => float16(view.getUint16(offset, little)) },
};

function float16(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Read an MRC file. `stack` is true for an image stack (ISPG 0 with MZ 1, as
 * RELION writes .mrcs); `angpix` is the cell size over the sampling, 1 when
 * the header has none. Data are float32 in file order (x fastest).
 * @param {ArrayBuffer} buffer
 */
export function readMrc(buffer) {
  if (buffer.byteLength < HEADER_BYTES) throw new Error('Not an MRC file: shorter than its 1024-byte header');
  const view = new DataView(buffer);
  const little = view.getUint8(212) !== 0x11;
  const nx = view.getInt32(0, little);
  const ny = view.getInt32(4, little);
  const nz = view.getInt32(8, little);
  const mode = view.getInt32(12, little);
  const format = MODES[mode];
  if (!format) throw new Error(`MRC mode ${mode} is not supported`);
  if (!(nx > 0 && ny > 0 && nz > 0)) throw new Error('MRC dimensions must be positive');
  const extended = view.getInt32(92, little);
  const offset = HEADER_BYTES + Math.max(0, extended);
  const count = nx * ny * nz;
  if (offset + count * format.bytes > buffer.byteLength) throw new Error('MRC file is shorter than its dimensions');
  const mx = view.getInt32(28, little);
  const mz = view.getInt32(36, little);
  const cell = view.getFloat32(40, little);
  const ispg = view.getInt32(88, little);
  const data = new Float32Array(count);
  if (mode === 2 && little && offset % 4 === 0) {
    data.set(new Float32Array(buffer, offset, count));
  } else {
    for (let index = 0; index < count; index += 1) data[index] = format.read(view, offset + index * format.bytes, little);
  }
  return {
    nx,
    ny,
    nz,
    mode,
    angpix: mx > 0 && cell > 0 ? cell / mx : 1,
    stack: nz > 1 && ispg === 0 && mz === 1,
    data,
  };
}

/** One image of a stack (or the only image of a 2D file). */
export function mrcImage(mrc, index = 0) {
  const size = mrc.nx * mrc.ny;
  return mrc.data.subarray(index * size, (index + 1) * size);
}

/** The 1st and 99th percentiles of up to 100 000 evenly strided samples. */
export function displayRange(data) {
  const step = Math.max(1, Math.floor(data.length / 100000));
  const sample = [];
  for (let index = 0; index < data.length; index += step) if (Number.isFinite(data[index])) sample.push(data[index]);
  if (!sample.length) return [0, 1];
  sample.sort((a, b) => a - b);
  const low = sample[Math.floor(0.01 * (sample.length - 1))];
  const high = sample[Math.ceil(0.99 * (sample.length - 1))];
  return high > low ? [low, high] : [sample[0], sample[0] + 1];
}

/**
 * Greyscale RGBA pixels of one image, row 0 of the file at the bottom as MRC
 * images are shown (origin lower left).
 */
export function imagePixels(image, nx, ny, [low, high] = displayRange(image)) {
  const pixels = new Uint8ClampedArray(nx * ny * 4);
  const scale = 255 / (high - low);
  for (let y = 0; y < ny; y += 1) {
    const row = (ny - 1 - y) * nx;
    for (let x = 0; x < nx; x += 1) {
      const value = (image[y * nx + x] - low) * scale;
      const target = (row + x) * 4;
      pixels[target] = value;
      pixels[target + 1] = value;
      pixels[target + 2] = value;
      pixels[target + 3] = 255;
    }
  }
  return pixels;
}
