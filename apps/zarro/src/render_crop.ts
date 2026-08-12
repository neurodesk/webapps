import type { Shape3 } from './logical_volume'

export interface RenderCropLevel {
  level: number
  shape: Shape3
  spacing: Shape3
}

export interface RenderCropGeometry extends RenderCropLevel {
  origin: Shape3
}

export function fovCropGeometry(
  level: RenderCropLevel,
  focusFraction: Shape3,
  zoom: number,
): RenderCropGeometry {
  const safeZoom = Math.max(1, zoom)
  const shape = level.shape.map((size) =>
    Math.max(1, Math.min(size, Math.ceil(size / safeZoom))),
  ) as Shape3
  const origin = level.shape.map((size, axis) =>
    Math.max(
      0,
      Math.min(
        size - shape[axis],
        Math.round(focusFraction[axis] * size - shape[axis] * 0.5),
      ),
    ),
  ) as Shape3
  return {
    level: level.level,
    shape,
    spacing: level.spacing,
    origin,
  }
}

export function renderCropGrid(
  shape: Shape3,
  deviceLimit: number,
  halo: Shape3,
): Shape3 {
  return shape.map((size, axis) => {
    const dataLimit = deviceLimit - 2 * halo[axis]
    if (dataLimit < 1) {
      throw new Error(
        `Render crop device limit ${deviceLimit} is too small for halo ${halo[axis]} on axis ${axis}`,
      )
    }
    return Math.max(1, Math.ceil(size / dataLimit))
  }) as Shape3
}

export function absoluteCropOrigin(
  cropOrigin: Shape3,
  localOrigin: Shape3,
): Shape3 {
  return localOrigin.map((value, axis) => cropOrigin[axis] + value) as Shape3
}
