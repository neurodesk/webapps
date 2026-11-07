// Deterministic test images shared by the unit tests and validation/reference.mjs.

/** A seeded uniform generator in [0, 1). */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Point-sampled 3D Gaussian beads on a constant background: value = background +
 * amplitude · exp(−Δx²/2σx² − Δy²/2σy² − Δz²/2σz²) per bead, plus optional uniform noise of
 * ±noise/2, rounded when `integer`. σ in µm; spacing in µm.
 */
export function beadStack({ nx, ny, nz, spacing, beads, sigma, background = 100, noise = 0, seed = 1, integer = true }) {
  const data = new Float32Array(nx * ny * nz);
  const next = random(seed);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let value = background + (noise ? (next() - 0.5) * noise : 0);
        for (const bead of beads) {
          const dx = (x - bead.x) * spacing.x;
          const dy = (y - bead.y) * spacing.y;
          const dz = (z - bead.z) * spacing.z;
          value += bead.amplitude * Math.exp(-(dx * dx) / (2 * sigma.x ** 2) - (dy * dy) / (2 * sigma.y ** 2) - (dz * dz) / (2 * sigma.z ** 2));
        }
        data[(z * ny + y) * nx + x] = integer ? Math.round(value) : value;
      }
    }
  }
  return data;
}

/** A 61 × 47 uint16 field image: off-centre Gaussian illumination plus a fixed pseudo-noise pattern. */
export function smallField() {
  const width = 61;
  const height = 47;
  const data = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = 3000 * Math.exp(-((x - 36) ** 2 + (y - 20) ** 2) / (2 * 28 ** 2));
      data[y * width + x] = Math.round(1000 + light + ((x * 7 + y * 13) % 17) * 3);
    }
  }
  return { width, height, data };
}

/** A 64 × 64 × 21 uint16 bead stack with five beads (two close together) and pseudo-noise. */
export function smallBeads() {
  const nx = 64;
  const ny = 64;
  const nz = 21;
  const spacing = { x: 0.1, y: 0.1, z: 0.2 };
  const beads = [
    { x: 14.3, y: 15.6, z: 9.4, amplitude: 900 },
    { x: 45.0, y: 12.2, z: 10.1, amplitude: 600 },
    { x: 20.7, y: 47.9, z: 11.6, amplitude: 1200 },
    { x: 47.2, y: 44.4, z: 8.8, amplitude: 700 },
    { x: 52.1, y: 48.3, z: 9.9, amplitude: 400 },
  ];
  const data = beadStack({ nx, ny, nz, spacing, beads, sigma: { x: 0.11, y: 0.12, z: 0.45 }, background: 200, noise: 30, seed: 7 });
  return { nx, ny, nz, spacing, data: Uint16Array.from(data) };
}
