import * as nifti from "nifti-reader-js";

export async function decodeMask(buffer) {
  if (buffer.byteLength > 128 * 1024 * 1024)
    throw new Error("Choose a mask smaller than 128 MB.");
  if (nifti.isCompressed(buffer)) {
    // Bound decompressed size as well as the compressed file size.
    const reader = new Blob([buffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Uncompressed mask exceeds 128 MB.");
      }
      chunks.push(value);
    }
    buffer = await new Blob(chunks).arrayBuffer();
  }
  if (!nifti.isNIFTI(buffer))
    throw new Error(
      "This is not a NIfTI file. Choose a .nii or .nii.gz vessel mask.",
    );
  const h = nifti.readHeader(buffer);
  const dims = h.dims.slice(1, 4);
  if (h.dims[0] < 3 || h.dims.slice(4, h.dims[0] + 1).some((n) => n > 1))
    throw new Error(
      "Choose a single 3D vessel mask, without time or channel dimensions.",
    );
  const count = dims.reduce((a, b) => a * b, 1);
  if (
    !dims.every((n) => Number.isInteger(n) && n > 2) ||
    count > 32 * 1024 * 1024
  )
    throw new Error(
      "Mask must have 3D dimensions and at most 32 million voxels.",
    );
  const types = {
    2: ["getUint8", 1],
    4: ["getInt16", 2],
    8: ["getInt32", 4],
    16: ["getFloat32", 4],
    64: ["getFloat64", 8],
    256: ["getInt8", 1],
    512: ["getUint16", 2],
    768: ["getUint32", 4],
  };
  const type = types[h.datatypeCode];
  if (!type)
    throw new Error(
      "Unsupported voxel type. Export a scalar binary or integer-labeled mask.",
    );
  const raw = nifti.readImage(h, buffer);
  if (raw.byteLength < count * type[1])
    throw new Error("The mask is truncated. Export it again.");
  const data = new DataView(raw),
    n = 96,
    field = new Float32Array(n * n * n);
  const spacing = h.pixDims.slice(1, 4).map((v) => Math.abs(v));
  if (!spacing.every((v) => Number.isFinite(v) && v > 0))
    throw new Error("The mask has invalid voxel spacing.");
  const stride = Math.max(1, Math.max(...dims) / (n - 6));
  const offset = dims.map((d) => Math.floor((n - d / stride) / 2));
  const scale = spacing.map((v) => v * stride);
  const slope = h.scl_slope || 1,
    intercept = h.scl_slope ? h.scl_inter || 0 : 0;
  let positive = 0;
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const value =
          data[type[0]](
            (x + dims[0] * (y + dims[1] * z)) * type[1],
            h.littleEndian,
          ) *
            slope +
          intercept;
        if (Number.isFinite(value) && value > 0) {
          field[
            Math.floor(x / stride) +
              offset[0] +
              n *
                (Math.floor(y / stride) +
                  offset[1] +
                  n * (Math.floor(z / stride) + offset[2]))
          ] = 1;
          positive++;
        }
      }
  if (!positive)
    throw new Error(
      "No positive vessel voxels found. Load a segmented mask, not an empty image.",
    );
  if (positive / count > 0.5)
    throw new Error(
      "Over half the image is foreground. Choose a segmented vessel mask, not an intensity scan.",
    );
  // Keep the largest six-connected component so all beacons are reachable.
  const seen = new Uint8Array(field.length),
    queue = new Int32Array(field.length);
  let largest = [];
  const neighbors = [1, -1, n, -n, n * n, -n * n];
  for (let i = 0; i < field.length; i++)
    if (field[i] && !seen[i]) {
      let head = 0,
        tail = 1;
      queue[0] = i;
      seen[i] = 1;
      while (head < tail) {
        const p = queue[head++];
        for (const d of neighbors) {
          const j = p + d;
          if (j >= 0 && j < field.length && field[j] && !seen[j]) {
            seen[j] = 1;
            queue[tail++] = j;
          }
        }
      }
      if (tail > largest.length) largest = queue.slice(0, tail);
    }
  if (largest.length < 24)
    throw new Error(
      "No connected vessel large enough to explore. Try a larger, connected mask.",
    );
  field.fill(0);
  for (const i of largest) field[i] = 1;
  // Find an interior spawn by distance from background (Manhattan metric).
  const depth = new Uint16Array(field.length);
  let head = 0,
    tail = 0;
  for (const i of largest)
    if (neighbors.some((d) => !field[i + d])) {
      depth[i] = 1;
      queue[tail++] = i;
    }
  let spawn = largest[0];
  while (head < tail) {
    const i = queue[head++];
    if (depth[i] > depth[spawn]) spawn = i;
    for (const d of neighbors)
      if (field[i + d] && !depth[i + d]) {
        depth[i + d] = depth[i] + 1;
        queue[tail++] = i + d;
      }
  }
  const normalized = scale.map((v) => (v * 100) / (Math.max(...scale) * n));
  const point = (i) => [
    ((i % n) - n / 2) * normalized[0],
    ((Math.floor(i / n) % n) - n / 2) * normalized[1],
    (Math.floor(i / (n * n)) - n / 2) * normalized[2],
  ];
  const targets = Array.from({ length: 8 }, (_, i) =>
    point(largest[Math.floor(((i + 1) * largest.length) / 9)]),
  );
  return {
    field,
    n,
    scale: normalized,
    spawn: point(spawn),
    targets,
    voxels: largest.length,
  };
}
// Trilinear sampling matches the rendered isosurface, unlike nearest-voxel tests.
export function sampleMask(mask, point) {
  const shape = mask.shape || [mask.n, mask.n, mask.n];
  const origin = mask.origin || mask.scale.map((v) => (-mask.n / 2) * v);
  const c = point.map((v, i) => (v - origin[i]) / mask.scale[i]);
  const low = c.map(Math.floor),
    fraction = c.map((v, i) => v - low[i]);
  if (low.some((v, i) => v < 0 || v + 1 >= shape[i])) return 0;
  let value = 0;
  for (let z = 0; z <= 1; z++)
    for (let y = 0; y <= 1; y++)
      for (let x = 0; x <= 1; x++) {
        const weight =
          (x ? fraction[0] : 1 - fraction[0]) *
          (y ? fraction[1] : 1 - fraction[1]) *
          (z ? fraction[2] : 1 - fraction[2]);
        value +=
          weight *
          mask.field[
            low[0] + x + shape[0] * (low[1] + y + shape[1] * (low[2] + z))
          ];
      }
  return value / (mask.valueScale || 1);
}
export function insideMask(mask, point) {
  return (
    sampleMask(mask, point) > 0.53 &&
    (!mask.surfaceInside || mask.surfaceInside(point))
  );
}
