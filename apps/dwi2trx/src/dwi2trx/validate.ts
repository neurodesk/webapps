/**
 * Pure validation helpers for diffusion inputs — no DOM, no NiiVue, no async,
 * so they unit-test in plain node (see validate.test.ts).
 */

import { parseNumbers } from '@neurodesk/dwi2trx/gradients'

/** Strip the recognized diffusion-file extension to group a series' sidecars. */
export function baseName(name: string): string {
  return name.replace(/\.(nii\.gz|nii|bval|bvec|json)$/i, '')
}

export const isNifti = (name: string): boolean => /\.nii(\.gz)?$/i.test(name)
export const isBval = (name: string): boolean => /\.bval$/i.test(name)
export const isBvec = (name: string): boolean => /\.bvec$/i.test(name)
export const isJson = (name: string): boolean => /\.json$/i.test(name)

/** A diffusion-series candidate: gradient directions (bval) vs NIfTI 4D volumes. */
export interface SeriesCounts {
  directions: number
  volumes: number
}

/**
 * Pick the best series: among candidates whose NIfTI volume count matches their
 * bval/bvec direction count, return the index with the most directions (README:
 * "the diffusion series ... with the most volumes"). Returns -1 if none match —
 * so a series with a broken NIfTI never shadows a valid smaller one.
 */
export function chooseBestSeries(candidates: SeriesCounts[]): number {
  let best = -1
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (c.directions !== c.volumes) continue
    if (best < 0 || c.directions > candidates[best].directions) best = i
  }
  return best
}

/** Negate the x row of FSL bvec text (rows x, y, z); other rows pass through verbatim. */
export function flipBvecX(bvecText: string): string {
  const rows = bvecText.trim().split(/\r?\n/)
  rows[0] = parseNumbers(rows[0])
    .map((v) => (v === 0 ? '0' : String(-v)))
    .join(' ')
  return rows.join('\n')
}
