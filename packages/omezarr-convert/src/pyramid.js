// The XY pyramid. Each level halves Y and X of the one before it (sizes rounded down, never
// below 1), as bioformats2raw and ome-zarr-py do; Z, C and T keep their size. Levels are added
// while the larger of Y and X exceeds the target, so the smallest level fits in it.

export const ARRAY_TYPES = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};

/** Downsampling methods: `nearest` keeps every second pixel; `mean` averages each 2 × 2 block. */
export const METHODS = ["mean", "nearest"];

/** [height, width] of every level, level 0 first. */
export function levelShapes(height, width, target) {
  if (!Number.isSafeInteger(target) || target < 1) throw new Error("The pyramid target must be a positive integer.");
  const shapes = [[height, width]];
  while (Math.max(...shapes.at(-1)) > target) {
    const [h, w] = shapes.at(-1);
    shapes.push([Math.max(1, Math.floor(h / 2)), Math.max(1, Math.floor(w / 2))]);
  }
  return shapes;
}

const integer = (dtype) => !dtype.startsWith("float");

/**
 * One plane of `height` × `width` (row-major) downsampled by two in Y and X.
 * `nearest` takes the pixel at (2y, 2x): bioformats2raw's SIMPLE scaler.
 * `mean` averages the block at (2y..2y+1, 2x..2x+1), the rows and columns that exist when a
 * side is 1; integer types round halves up (floor((sum + n / 2) / n)), floats keep the
 * float64 mean in their own precision. Rows and columns past twice the new size are dropped.
 */
export function downsamplePlane(plane, height, width, method, dtype) {
  const outHeight = Math.max(1, Math.floor(height / 2));
  const outWidth = Math.max(1, Math.floor(width / 2));
  const out = new ARRAY_TYPES[dtype](outHeight * outWidth);
  if (method === "nearest") {
    for (let y = 0; y < outHeight; y += 1) {
      const row = 2 * y * width;
      for (let x = 0; x < outWidth; x += 1) out[y * outWidth + x] = plane[row + 2 * x];
    }
    return out;
  }
  if (method !== "mean") throw new Error(`Unknown downsampling method ${method}.`);
  const rows = height > 1 ? 2 : 1;
  const columns = width > 1 ? 2 : 1;
  const count = rows * columns;
  const round = integer(dtype);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < rows; dy += 1) {
        const row = (2 * y + dy) * width + 2 * x;
        for (let dx = 0; dx < columns; dx += 1) sum += plane[row + dx];
      }
      out[y * outWidth + x] = round ? Math.floor((sum + count / 2) / count) : sum / count;
    }
  }
  return out;
}
