// Shared test fixtures: a folded-cortex phantom slice and Greedy's committed single-threaded
// build behind the pipeline's injected interface (the bytes the browser worker runs).
import { loadGreedySingleThread } from '@neurodesk/greedy/single';
import { registerAffineGreedy, registerRigidGreedy, registerSvfGreedy } from '@neurodesk/greedy';

/** A T1-like coronal slice: bright white matter, a folded grey-matter ribbon, dark ventricles. */
export function phantomSlice(nu = 120, nv = 100, { phase = 0, ventricles = 1 } = {}) {
  const image = new Float32Array(nu * nv);
  const cx = nu / 2;
  const cy = nv / 2;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const dx = (i - cx) / 1.15;
      const dy = j - cy;
      const r = Math.hypot(dx, dy);
      const theta = Math.atan2(dy, dx);
      const outer = 38 + 4 * Math.sin(9 * theta + phase) + 2 * Math.cos(5 * theta + 1) + 7 * Math.exp(-((theta - 2.2) ** 2) / 0.15);
      let value = 0;
      if (r < outer) value = r > outer - 6 - 2 * Math.sin(9 * theta + phase) ? 0.55 : 0.9;
      if (Math.hypot((i - cx + 9) / (4 * ventricles), (j - cy + 3) / (9 * ventricles)) < 1 || Math.hypot((i - cx - 9) / (4 * ventricles), (j - cy + 3) / (9 * ventricles)) < 1) value = 0.15;
      if (Math.abs(i - cx) < 1.2 && j < cy - 6 && r < outer) value = 0.2;
      if (Math.hypot((i - cx - 18) / 6, (j - cy - 14) / 4) < 1) value = 0.4;
      if (value) value += 0.04 * Math.sin(i / 2.3) * Math.cos(j / 3.1);
      image[j * nu + i] = 1000 * value;
    }
  }
  return image;
}

/** A volume holding `slices(k)` on each of `nz` slices, 0.6 mm isotropic. */
export function phantomVolume(nu, nv, nz, slices) {
  const data = new Float32Array(nu * nv * nz);
  for (let k = 0; k < nz; k++) data.set(slices(k), k * nu * nv);
  return { dims: [nu, nv, nz], affine: [[0.6, 0, 0, -30], [0, 0.6, 0, -25], [0, 0, 0.6, -1], [0, 0, 0, 1]], data };
}

let api = null;
export async function nodeGreedy() {
  api ??= await loadGreedySingleThread();
  return {
    api,
    rigid: async (args) => registerRigidGreedy({ api, ...args }),
    affine: async (args) => registerAffineGreedy({ api, ...args }),
    svf: async (args) => registerSvfGreedy({ api, ...args }),
  };
}
