/**
 * Back-project a conformed-space (256³ 1 mm) label volume onto the native input
 * grid — so the segmentation displays/saves at the input resolution instead of the
 * model's conformed space.
 *
 * Cloned from brainchop-test main.js `resliceLabelsToNative()` (the "Segmentation:
 * native space" Save action): nearest-neighbour with 2× supersampling and a
 * per-output-voxel majority vote for crisp categorical boundaries. The only change
 * is the coordinate map: brainchop probed NiiVue's `seg.mm2vox`/`seg.toRASvox`, but
 * our NiiVue (rc.9) exposes no such methods on a volume — so we compose the two
 * volumes' `hdr.affine` (voxel→mm) directly, which is the identical mapping:
 *   native voxel → mm → conformed voxel = inv(A_conf) · A_native · v
 */
import { mat4 } from 'gl-matrix'

export type ResliceHdr = { dims: number[]; affine: number[][] }

// NiiVue hdr.affine is row-major number[][]; gl-matrix mat4 is column-major.
function toMat4(affine: number[][]): mat4 {
  const m = mat4.create()
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = affine[r][c]
  return m
}

export function resliceToNative(
  native: ResliceHdr,
  conf: ResliceHdr,
  labels: ArrayLike<number>,
): Uint8Array {
  const nx = native.dims[1]
  const ny = native.dims[2]
  const nz = native.dims[3]
  const snx = conf.dims[1]
  const sny = conf.dims[2]
  const snz = conf.dims[3]

  // native voxel → conformed voxel (fractional) = inv(A_conf) · A_native
  const confInv = mat4.invert(mat4.create(), toMat4(conf.affine))
  if (!confInv) throw new Error('resliceToNative: conformed affine is singular')
  const M = mat4.multiply(mat4.create(), confInv, toMat4(native.affine))
  const o = [M[12], M[13], M[14]]
  const ex = [M[0], M[1], M[2]] // step per +1 native i
  const ey = [M[4], M[5], M[6]] // step per +1 native j
  const ez = [M[8], M[9], M[10]] // step per +1 native k

  const sample = (x: number, y: number, z: number): number =>
    x >= 0 && x < snx && y >= 0 && y < sny && z >= 0 && z < snz
      ? labels[x + y * snx + z * snx * sny]
      : 0

  // 2× supersample: 8 offsets at ±0.25 native voxel, expressed in conformed space.
  const deltas: number[][] = []
  for (const dx of [-0.25, 0.25])
    for (const dy of [-0.25, 0.25])
      for (const dz of [-0.25, 0.25])
        deltas.push([
          dx * ex[0] + dy * ey[0] + dz * ez[0],
          dx * ex[1] + dy * ey[1] + dz * ez[1],
          dx * ex[2] + dy * ey[2] + dz * ez[2],
        ])

  const out = new Uint8Array(nx * ny * nz) // labels are 0-17, so uint8 suffices
  const tv = new Int32Array(8) // tally values (≤8 distinct)
  const tc = new Int32Array(8) // tally counts
  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let bx = o[0] + j * ey[0] + k * ez[0]
      let by = o[1] + j * ey[1] + k * ez[1]
      let bz = o[2] + j * ey[2] + k * ez[2]
      for (let i = 0; i < nx; i++) {
        let nt = 0
        for (let s = 0; s < 8; s++) {
          const lbl = sample(
            Math.round(bx + deltas[s][0]),
            Math.round(by + deltas[s][1]),
            Math.round(bz + deltas[s][2]),
          )
          let t = -1
          for (let q = 0; q < nt; q++)
            if (tv[q] === lbl) {
              t = q
              break
            }
          if (t < 0) {
            tv[nt] = lbl
            tc[nt] = 1
            nt++
          } else {
            tc[t]++
          }
        }
        let best = tv[0]
        let bc = tc[0]
        for (let q = 1; q < nt; q++)
          if (tc[q] > bc) {
            bc = tc[q]
            best = tv[q]
          }
        out[idx++] = best
        bx += ex[0]
        by += ex[1]
        bz += ex[2]
      }
    }
  }
  return out
}
