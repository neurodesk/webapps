// The spectroscopy voxel in a structural image: which image voxels it covers
// and the grey matter, white matter and CSF fractions inside it. Pure and
// Node-tested.
//
// Both geometries are NIfTI affines to RAS+ mm (4x4, row-major arrays). The
// MRS voxel's affine is that of a 1x1x1 image (the header's `voxel.affine`,
// spec2nii's convention): its index coordinates -0.5..0.5 span the box. An
// image voxel can be partly inside an oblique box, so each is sampled on an
// n x n x n sub-grid and weighted by the share of samples inside.

/** 4x4 row-major inverse (general, by cofactors). */
export function invert4(m) {
  const a = m.flat();
  const inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error("The affine cannot be inverted.");
  const rows = [];
  for (let r = 0; r < 4; r += 1) rows.push([0, 1, 2, 3].map((c) => inv[r * 4 + c] / det));
  return rows;
}

export function multiply4(a, b) {
  return a.map((row) => [0, 1, 2, 3].map((c) => row.reduce((sum, v, k) => sum + v * b[k][c], 0)));
}

/** Apply a 4x4 affine to a point. */
export function apply4(m, p) {
  return [0, 1, 2].map((r) => m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3]);
}

/** Plain arrays from a NIfTI affine given as rows (arrays or typed arrays). */
export function toRows(affine) {
  return [0, 1, 2, 3].map((r) => Array.from(affine[r]).slice(0, 4).map(Number));
}

/** Box volume in mm^3 from the voxel affine (|det| of its 3x3 part). */
export function boxVolume(voxelAffine) {
  const m = voxelAffine;
  return Math.abs(
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]),
  );
}

/**
 * Weight of every image voxel inside the MRS box, 0..1.
 * @param {number[][]} voxelAffine  MRS voxel, 1x1x1 index space to RAS mm
 * @param {{affine: number[][], dims: number[]}} image  structural image grid
 * @param {{samples?: number}} [options]  sub-samples per axis (default 5)
 * @returns {{weights: Float32Array, count: number, volumeMm3: number, nominalMm3: number}}
 */
export function voxelWeights(voxelAffine, image, { samples = 5 } = {}) {
  const [nx, ny, nz] = image.dims;
  const imageAffine = toRows(image.affine);
  const box = toRows(voxelAffine);
  // Image index -> MRS index: inv(box) * image.
  const toBox = multiply4(invert4(box), imageAffine);
  // Bounding box of the MRS box in image index space.
  const toImage = multiply4(invert4(imageAffine), box);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [-0.5, 0.5]) {
    const p = apply4(toImage, [cx, cy, cz]);
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  const range = (k, n) => [Math.max(0, Math.floor(lo[k] - 1)), Math.min(n - 1, Math.ceil(hi[k] + 1))];
  const [x0, x1] = range(0, nx);
  const [y0, y1] = range(1, ny);
  const [z0, z1] = range(2, nz);
  const weights = new Float32Array(nx * ny * nz);
  const offsets = Array.from({ length: samples }, (_, s) => (s + 0.5) / samples - 0.5);
  const col = (c) => [toBox[0][c], toBox[1][c], toBox[2][c]];
  const [ex, ey, ez] = [col(0), col(1), col(2)];
  const total = samples ** 3;
  let sum = 0;
  let count = 0;
  for (let z = z0; z <= z1; z += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const c = apply4(toBox, [x, y, z]);
        let inside = 0;
        for (const dz of offsets) {
          for (const dy of offsets) {
            const bx = c[0] + ey[0] * dy + ez[0] * dz;
            const by = c[1] + ey[1] * dy + ez[1] * dz;
            const bz = c[2] + ey[2] * dy + ez[2] * dz;
            for (const dx of offsets) {
              if (Math.abs(bx + ex[0] * dx) <= 0.5 && Math.abs(by + ex[1] * dx) <= 0.5 && Math.abs(bz + ex[2] * dx) <= 0.5) inside += 1;
            }
          }
        }
        if (inside) {
          const w = inside / total;
          weights[x + nx * (y + ny * z)] = w;
          sum += w;
          count += 1;
        }
      }
    }
  }
  const voxelMm3 = boxVolume(imageAffine);
  return { weights, count, volumeMm3: sum * voxelMm3, nominalMm3: boxVolume(box) };
}

/**
 * Tissue fractions in the voxel from partial-volume maps on the same grid.
 * `coverage` is the share of the voxel the three maps account for.
 *
 * MindMap's CSF map holds the ventricles only: sulcal and interhemispheric
 * CSF, which a cortical or midline voxel contains, is in none of the maps. By
 * default (`unlabelled: "csf"`) that remainder counts as CSF, so fCSF is
 * 1 - fGM - fWM. `unlabelled: "exclude"` is Osprey's rule for SPM's maps,
 * whose CSF class reaches the skull: each map's sum over the sum of all three.
 */
export function tissueFractions(weights, maps, { unlabelled = "csf" } = {}) {
  let gm = 0;
  let wm = 0;
  let csf = 0;
  let w = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const v = weights[i];
    if (!v) continue;
    w += v;
    gm += v * maps.gm[i];
    wm += v * maps.wm[i];
    csf += v * maps.csf[i];
  }
  const all = gm + wm + csf;
  if (!(w > 0)) throw new Error("The spectroscopy voxel lies outside the structural image.");
  if (!(all > 0)) throw new Error("The segmentation finds no tissue inside the spectroscopy voxel.");
  if (unlabelled === "exclude") return { gm: gm / all, wm: wm / all, csf: csf / all, coverage: all / w };
  // Maps that overlap (sum above 1) are scaled back; the rest of the voxel is CSF.
  const scale = all > w ? w / all : 1;
  const fgm = (gm * scale) / w;
  const fwm = (wm * scale) / w;
  return { gm: fgm, wm: fwm, csf: Math.max(0, 1 - fgm - fwm), coverage: all / w };
}
