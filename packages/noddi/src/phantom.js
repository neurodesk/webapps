// A synthetic two-shell DWI with a known microstructure, for the command line's self-check and
// the release checks' NODDI comparison (the pinned example has one shell). Every voxel inside a
// one-voxel border holds NODDI's model without dispersion: a stick (intra-neurite) and a
// tortuous zeppelin (extra-neurite) along a direction that turns across the grid, with a free
// water fraction. Rician noise comes from a seeded generator, so the bytes are reproducible.
import { createNiftiFromData, createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io/nifti';

const D_PARALLEL = 1.7e-3;
const D_ISO = 3e-3;

/** Two b0 volumes, then `directions` spiral directions on each shell. */
export function phantomScheme({ shells = [1000, 2000], directions = 30 } = {}) {
  const bvals = [0, 0];
  const bvecs = [[0, 0], [0, 0], [0, 0]];
  for (const b of shells) {
    for (let i = 0; i < directions; i++) {
      const z = 1 - (2 * (i + 0.5)) / directions;
      const r = Math.sqrt(1 - z * z);
      const phi = i * 2.399963229728653;
      bvals.push(b);
      bvecs[0].push(r * Math.cos(phi));
      bvecs[1].push(r * Math.sin(phi));
      bvecs[2].push(z);
    }
  }
  return { bvals, bvecs };
}

// mulberry32: a small seeded generator with a fixed sequence on every platform.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next) {
  const u = Math.max(next(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** The tissue of voxel (x, y, z) inside the border: fibre direction, ICVF and free water. */
export function phantomTissue(x, y, z, size) {
  const t = (value) => (value - 1) / Math.max(1, size - 3);
  const theta = (Math.PI / 2) * t(x);
  const phi = Math.PI * t(y);
  return {
    direction: [Math.cos(theta), Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi)],
    icvf: 0.3 + 0.4 * t(z),
    isovf: 0.2 * t(y),
  };
}

/**
 * @returns {{ nifti: Uint8Array, bval: string, bvec: string, dims: number[], voxels: number, inside: number[] }}
 *   `nifti` is uncompressed float32 NIfTI-1 on a 2 mm grid
 */
export function multiShellPhantom({ size = 16, noise = 0.02, seed = 1 } = {}) {
  const { bvals, bvecs } = phantomScheme();
  const voxels = size ** 3;
  const data = new Float32Array(voxels * bvals.length);
  const next = random(seed);
  const s0 = 1000;
  const inside = [];
  for (let z = 1; z < size - 1; z++) {
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const voxel = x + size * (y + size * z);
        inside.push(voxel);
        const { direction: [dx, dy, dz], icvf, isovf } = phantomTissue(x, y, z, size);
        const perpendicular = D_PARALLEL * (1 - icvf);
        bvals.forEach((b, v) => {
          const cos2 = (bvecs[0][v] * dx + bvecs[1][v] * dy + bvecs[2][v] * dz) ** 2;
          const intra = Math.exp(-b * D_PARALLEL * cos2);
          const extra = Math.exp(-b * (perpendicular + (D_PARALLEL - perpendicular) * cos2));
          const signal = s0 * ((1 - isovf) * (icvf * intra + (1 - icvf) * extra) + isovf * Math.exp(-b * D_ISO));
          const real = signal + noise * s0 * gaussian(next);
          const imaginary = noise * s0 * gaussian(next);
          data[v * voxels + voxel] = Math.hypot(real, imaginary);
        });
      }
    }
  }
  const header = createNiftiHeaderFromVolume({
    hdr: { dims: [4, size, size, size, bvals.length, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] },
  });
  const nifti = new Uint8Array(createNiftiFromData(data, header, { dims: [size, size, size, bvals.length] }));
  return {
    nifti,
    bval: `${bvals.join(' ')}\n`,
    bvec: `${bvecs.map((row) => row.join(' ')).join('\n')}\n`,
    dims: [size, size, size],
    voxels,
    inside,
  };
}
