const NX = 64;
const NY = 64;
const PHASES = 24;

export function tiltedPhantom() {
  const series = {
    nx: NX, ny: NY, phases: PHASES,
    amplitude: new Float32Array(NX * NY * PHASES),
    phase: new Float32Array(NX * NY * PHASES),
    affine: [[-1, 0, 0, 30], [0, 1, 0, -30], [0, 0, 2, 0], [0, 0, 0, 1]],
    voxelSize: [1, 1, 2],
  };
  const angle = 20 * Math.PI / 180;
  for (let t = 0; t < PHASES; t++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const u = Math.cos(angle) * (x - 32) - Math.sin(angle) * (y - 32);
        const w = Math.sin(angle) * (x - 32) + Math.cos(angle) * (y - 32);
        const v = t * NX * NY + y * NX + x;
        const head = (u / 24) ** 2 + (w / 29) ** 2 < 1;
        series.amplitude[v] = head ? 300 : 0;
        series.phase[v] = head ? 100 : 0;
        for (const [cx, cy, direction] of [[-11, 0, 1], [11, 0, 1], [-11, -8, -1]]) {
          if ((u - cx) ** 2 + (w - cy) ** 2 > 4) continue;
          series.phase[v] = 100 + direction * (20 + (direction > 0 ? 60 : 40) * Math.exp(-(((t - 10) / 2) ** 2)));
        }
      }
    }
  }
  return series;
}

