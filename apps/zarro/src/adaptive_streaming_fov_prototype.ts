/**
 * PROTOTYPE — screen-layout-derived high-detail streaming coverage.
 *
 * Question: can NiiVue's rendered screen-slice geometry define the three
 * protected streaming slabs without changing the shared camera, adding aspect
 * ratio presets, or changing the NIfTI export crop?
 *
 * NiiVue stores each slice's full in-plane millimetre extents in orientation
 * order. Applying the shared millimetre pan and zoom to those extents gives the
 * exact visible interval on each world axis. This module maps those intervals
 * back to common-grid voxels and keeps the slice-normal axis one voxel thin.
 */

export type PrototypeShape3 = readonly [number, number, number]

export interface PrototypeFovBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface PrototypeScreenSlice {
  axCorSag: number
  leftTopWidthHeight?: ArrayLike<number>
  sliceMM?: number
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

function finiteValue(values: ArrayLike<number>, index: number): number | null {
  const value = values[index]
  return Number.isFinite(value) ? value : null
}

function visibleVoxelInterval(
  size: number,
  screenMinMM: number,
  screenMaxMM: number,
  volumeMinMM: number,
  volumeMaxMM: number,
  panMM: number,
  zoom: number,
): [number, number] | null {
  const screenMinimum = Math.min(screenMinMM, screenMaxMM)
  const screenMaximum = Math.max(screenMinMM, screenMaxMM)
  const screenExtent = screenMaximum - screenMinimum
  const volumeMinimum = Math.min(volumeMinMM, volumeMaxMM)
  const volumeMaximum = Math.max(volumeMinMM, volumeMaxMM)
  const volumeExtent = volumeMaximum - volumeMinimum
  if (!(screenExtent > 0) || !(volumeExtent > 0) || !(size > 0)) return null

  const center = (screenMinimum + screenMaximum) / 2 - panMM
  const halfVisible = screenExtent / (2 * zoom)
  const toVoxel = (millimetres: number): number =>
    Math.min(
      size,
      Math.max(
        0,
        ((millimetres - volumeMinimum) / volumeExtent) * size,
      ),
    )
  return [toVoxel(center - halfVisible), toVoxel(center + halfVisible)]
}

export function prototypeStreamingFovBoundsFromScreenSlices(
  shape: PrototypeShape3,
  volumeMinMM: PrototypeShape3,
  volumeMaxMM: PrototypeShape3,
  sliceFractions: PrototypeShape3,
  pan2Dxyzmm: ArrayLike<number>,
  screenSlices: readonly PrototypeScreenSlice[],
): PrototypeFovBounds[] {
  const zoomValue = finiteValue(pan2Dxyzmm, 3) ?? 1
  const zoom = Math.max(1, zoomValue)
  const center = shape.map((size, axis) =>
    Math.max(0, Math.min(size - 0.001, sliceFractions[axis] * size)),
  ) as [number, number, number]
  const bounds: PrototypeFovBounds[] = []

  for (const tile of screenSlices) {
    const axes = SLICE_WORLD_AXES[tile.axCorSag]
    const rect = tile.leftTopWidthHeight
    const screen = tile.screen
    if (
      !axes ||
      !rect ||
      !screen ||
      !(Number(rect[2]) > 0) ||
      !(Number(rect[3]) > 0)
    ) {
      continue
    }

    const min = [...center] as [number, number, number]
    const max = [...center] as [number, number, number]
    let valid = true
    for (let screenAxis = 0; screenAxis < 2; screenAxis++) {
      const worldAxis = axes[screenAxis]
      const screenMin = finiteValue(screen.mnMM, screenAxis)
      const screenMax = finiteValue(screen.mxMM, screenAxis)
      const pan = finiteValue(pan2Dxyzmm, worldAxis) ?? 0
      if (screenMin === null || screenMax === null) {
        valid = false
        break
      }
      const interval = visibleVoxelInterval(
        shape[worldAxis],
        screenMin,
        screenMax,
        volumeMinMM[worldAxis],
        volumeMaxMM[worldAxis],
        pan,
        zoom,
      )
      if (!interval) {
        valid = false
        break
      }
      min[worldAxis] = interval[0]
      max[worldAxis] = interval[1]
    }
    if (!valid) continue

    const normalAxis = axes[2]
    let normalCenter = center[normalAxis]
    const sliceMM = Number(tile.sliceMM)
    const normalMinMM = finiteValue(screen.mnMM, 2)
    const normalMaxMM = finiteValue(screen.mxMM, 2)
    if (
      Number.isFinite(sliceMM) &&
      normalMinMM !== null &&
      normalMaxMM !== null &&
      normalMaxMM !== normalMinMM
    ) {
      const minimum = Math.min(volumeMinMM[normalAxis], volumeMaxMM[normalAxis])
      const maximum = Math.max(volumeMinMM[normalAxis], volumeMaxMM[normalAxis])
      normalCenter = Math.max(
        0,
        Math.min(
          shape[normalAxis] - 0.001,
          ((sliceMM - minimum) / (maximum - minimum)) * shape[normalAxis],
        ),
      )
    }
    min[normalAxis] = normalCenter
    max[normalAxis] = Math.min(shape[normalAxis], normalCenter + 0.001)
    bounds.push({ min, max })
  }

  return bounds
}
