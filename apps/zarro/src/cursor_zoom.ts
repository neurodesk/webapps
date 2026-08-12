export interface CursorZoomSlice {
  axCorSag: number
  screen?: {
    mnMM: ArrayLike<number>
    mxMM: ArrayLike<number>
  }
}

const SLICE_WORLD_AXES = [
  [0, 1, 2], // axial: X/Y in-plane, Z normal
  [0, 2, 1], // coronal: X/Z in-plane, Y normal
  [1, 2, 0], // sagittal: Y/Z in-plane, X normal
] as const

function inverseMatrix4(matrix: ArrayLike<number>): number[] | null {
  const a00 = matrix[0]
  const a01 = matrix[1]
  const a02 = matrix[2]
  const a03 = matrix[3]
  const a10 = matrix[4]
  const a11 = matrix[5]
  const a12 = matrix[6]
  const a13 = matrix[7]
  const a20 = matrix[8]
  const a21 = matrix[9]
  const a22 = matrix[10]
  const a23 = matrix[11]
  const a30 = matrix[12]
  const a31 = matrix[13]
  const a32 = matrix[14]
  const a33 = matrix[15]

  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32

  const determinant =
    b00 * b11 - b01 * b10 + b02 * b09 +
    b03 * b08 - b04 * b07 + b05 * b06
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return null
  }

  const inverseDeterminant = 1 / determinant
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * inverseDeterminant,
    (a02 * b10 - a01 * b11 - a03 * b09) * inverseDeterminant,
    (a31 * b05 - a32 * b04 + a33 * b03) * inverseDeterminant,
    (a22 * b04 - a21 * b05 - a23 * b03) * inverseDeterminant,
    (a12 * b08 - a10 * b11 - a13 * b07) * inverseDeterminant,
    (a00 * b11 - a02 * b08 + a03 * b07) * inverseDeterminant,
    (a32 * b02 - a30 * b05 - a33 * b01) * inverseDeterminant,
    (a20 * b05 - a22 * b02 + a23 * b01) * inverseDeterminant,
    (a10 * b10 - a11 * b08 + a13 * b06) * inverseDeterminant,
    (a01 * b08 - a00 * b10 - a03 * b06) * inverseDeterminant,
    (a30 * b04 - a31 * b02 + a33 * b00) * inverseDeterminant,
    (a21 * b02 - a20 * b04 - a23 * b00) * inverseDeterminant,
    (a11 * b07 - a10 * b09 - a12 * b06) * inverseDeterminant,
    (a00 * b09 - a01 * b07 + a02 * b06) * inverseDeterminant,
    (a31 * b01 - a30 * b03 - a32 * b00) * inverseDeterminant,
    (a20 * b03 - a21 * b01 + a22 * b00) * inverseDeterminant,
  ]
}

function unproject(
  normalizedX: number,
  normalizedY: number,
  depth: number,
  inverse: ArrayLike<number>,
): [number, number, number] | null {
  const x = normalizedX * 2 - 1
  const y = 1 - normalizedY * 2
  const z = depth * 2 - 1
  const w =
    inverse[3] * x + inverse[7] * y + inverse[11] * z + inverse[15]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null
  return [
    (inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12]) / w,
    (inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13]) / w,
    (inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14]) / w,
  ]
}

/** Resolve a tile-local cursor position to its point on the displayed slice. */
export function pointOnSlicePlane(
  normalizedX: number,
  normalizedY: number,
  mvpMatrix: ArrayLike<number>,
  planeNormal: ArrayLike<number>,
  planePoint: ArrayLike<number>,
): [number, number, number] | null {
  const inverse = inverseMatrix4(mvpMatrix)
  if (!inverse) return null
  const near = unproject(normalizedX, normalizedY, 0, inverse)
  const far = unproject(normalizedX, normalizedY, 1, inverse)
  if (!near || !far) return null

  const ray = [far[0] - near[0], far[1] - near[1], far[2] - near[2]]
  const denominator =
    ray[0] * planeNormal[0] +
    ray[1] * planeNormal[1] +
    ray[2] * planeNormal[2]
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
    return null
  }
  const distance =
    ((planePoint[0] - near[0]) * planeNormal[0] +
      (planePoint[1] - near[1]) * planeNormal[1] +
      (planePoint[2] - near[2]) * planeNormal[2]) /
    denominator
  return [
    near[0] + ray[0] * distance,
    near[1] + ray[1] * distance,
    near[2] + ray[2] * distance,
  ]
}

/** Change zoom while keeping an image point beneath the cursor. */
export function anchoredSlicePan(
  currentPan: ArrayLike<number>,
  slice: CursorZoomSlice,
  anchorMM: ArrayLike<number>,
  nextZoom: number,
): [number, number, number, number] {
  if (!(nextZoom > 1)) return [0, 0, 0, nextZoom]
  const axes = SLICE_WORLD_AXES[slice.axCorSag]
  const screen = slice.screen
  const currentZoom = Number(currentPan[3])
  if (!axes || !screen || !(currentZoom > 0)) {
    return [
      Number(currentPan[0]) || 0,
      Number(currentPan[1]) || 0,
      Number(currentPan[2]) || 0,
      nextZoom,
    ]
  }

  const next: [number, number, number, number] = [
    Number(currentPan[0]) || 0,
    Number(currentPan[1]) || 0,
    Number(currentPan[2]) || 0,
    nextZoom,
  ]
  const zoomFraction = 1 - currentZoom / nextZoom
  for (let screenAxis = 0; screenAxis < 2; screenAxis++) {
    const worldAxis = axes[screenAxis]
    const baseCenter =
      (Number(screen.mnMM[screenAxis]) + Number(screen.mxMM[screenAxis])) / 2
    const currentCenter = baseCenter - next[worldAxis]
    const anchor = Number(anchorMM[worldAxis])
    if (!Number.isFinite(currentCenter) || !Number.isFinite(anchor)) continue
    next[worldAxis] += (currentCenter - anchor) * zoomFraction
  }
  return next
}
