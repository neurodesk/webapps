// Synthetic mosaics with exact ground truth: a texture of Gaussian blobs defined in continuous
// coordinates, rendered analytically into each tile at its true (sub-pixel) position, plus
// independent Gaussian noise per tile. No interpolation is involved, so the true offsets are
// exact.

export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
}

/** Blobs filling `extent` ([w, h] or [w, h, d]). */
export function blobField(extent, { seed = 1, density = 0.004, sigma = [1.5, 4] } = {}) {
  const rand = random(seed);
  const volume = extent.reduce((a, b) => a * b, 1);
  const count = Math.round(volume * density);
  return Array.from({ length: count }, () => ({
    centre: extent.map((n) => rand() * n),
    sigma: sigma[0] + rand() * (sigma[1] - sigma[0]),
    amplitude: 50 + rand() * 200,
  }));
}

/** A tile of `shape` whose pixel (x, y, z) samples the field at position + (x, y, z). */
export function renderTile(blobs, shape, position, { noise = 0, seed = 7, baseline = 100 } = {}) {
  const [nx, ny, nz = 1] = shape;
  const dims = shape.length;
  const data = new Float32Array(nx * ny * nz).fill(baseline);
  for (const blob of blobs) {
    const radius = 3.5 * blob.sigma;
    const local = blob.centre.map((c, d) => c - position[d]);
    const lo = local.map((c) => Math.max(0, Math.floor(c - radius)));
    const hi = local.map((c, d) => Math.min(shape[d] - 1, Math.ceil(c + radius)));
    if (lo.some((v, d) => v > hi[d])) continue;
    const s2 = 2 * blob.sigma * blob.sigma;
    for (let z = dims > 2 ? lo[2] : 0; z <= (dims > 2 ? hi[2] : 0); z++) {
      const dz = dims > 2 ? (z - local[2]) ** 2 : 0;
      for (let y = lo[1]; y <= hi[1]; y++) {
        const dy = (y - local[1]) ** 2;
        for (let x = lo[0]; x <= hi[0]; x++) {
          data[(z * ny + y) * nx + x] += blob.amplitude * Math.exp(-((x - local[0]) ** 2 + dy + dz) / s2);
        }
      }
    }
  }
  if (noise > 0) {
    const rand = random(seed);
    for (let i = 0; i < data.length; i++) data[i] += noise * gaussian(rand);
  }
  return { shape, data };
}

/**
 * A columns × rows mosaic with stage error: the approximate layout is the regular grid, the
 * true positions are the grid moved by up to `jitter` pixels (fractional) per axis.
 */
export function syntheticMosaic({ columns, rows, shape, overlap, jitter = 6, noise = 4, seed = 3, depth = 0 }) {
  const rand = random(seed);
  const step = [Math.trunc(shape[0] * (1 - overlap)), Math.trunc(shape[1] * (1 - overlap))];
  const approximate = [];
  const truth = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const grid = [column * step[0], row * step[1]];
      if (shape.length > 2) grid.push(0);
      approximate.push(grid);
      truth.push(grid.map((v, d) => (d < 2 ? v + jitter + (rand() * 2 - 1) * jitter : v + depth * (rand() * 2 - 1))));
    }
  }
  const extent = shape.map((n, d) => (d < 2 ? (d === 0 ? columns : rows) * n + 4 * jitter : n + 2 * depth + 2));
  const blobs = blobField(extent, { seed: seed + 11, density: shape.length > 2 ? 0.0006 : 0.004 });
  const tiles = truth.map((position, k) => renderTile(blobs, shape, position.map((v, d) => (d < 2 ? v : v + depth + 1)), { noise, seed: seed * 100 + k }));
  return { tiles, approximate, truth };
}
