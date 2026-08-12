export interface CrosshairAppearance {
  width: number
  gap: number
}

export interface ContrastWindow {
  min: number
  max: number
}

export interface WindowLevelWidth {
  level: number
  width: number
}

export interface ZoomLevelControlDisplay {
  value: number
  label: string
  canApply: boolean
}

export interface LodDeliveryDisplay {
  label: string
  deliveredLevel: number | null
  visibleLabel: string
}

export interface FovBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export type LodFocusInteraction = 'pan' | 'crosshair'

export interface AdaptiveLodController {
  setMaxDetail(levelIndex: number): void
}

const WHEEL_ZOOM_SENSITIVITY = 0.00075
const MAX_WHEEL_DELTA_PX = 120
export const MIN_VIEWER_ZOOM = 0.1
export const MAX_VIEWER_ZOOM = 128
const MIN_CROSSHAIR_WORLD_SIZE = 0.000001

export function axialSliceIndex(
  fraction: number,
  sliceCount: number,
): number {
  if (!Number.isFinite(sliceCount) || sliceCount <= 1) return 0
  const boundedFraction = Number.isFinite(fraction)
    ? Math.min(1, Math.max(0, fraction))
    : 0.5
  return Math.round(boundedFraction * (Math.floor(sliceCount) - 1))
}

export function axialSliceFraction(
  index: number,
  sliceCount: number,
): number {
  if (!Number.isFinite(sliceCount) || sliceCount <= 1) return 0.5
  const lastSlice = Math.floor(sliceCount) - 1
  const boundedIndex = Number.isFinite(index)
    ? Math.min(lastSlice, Math.max(0, Math.round(index)))
    : 0
  return boundedIndex / lastSlice
}

export function loadingTileCount(
  pending: number | undefined,
  inFlight: number | undefined,
): number {
  const count = (value: number | undefined): number =>
    Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? 0) : 0
  return count(pending) + count(inFlight)
}

/** Keep the finest-detail focus local on thin or small volumes. */
export function fineLodRadiusForShape(
  shape: readonly [number, number, number],
  maximum: number,
): number {
  return Math.max(1, Math.min(maximum, Math.min(...shape) / 8))
}

/**
 * Approximate the visible volume footprint in common-grid voxels. Slice views
 * reserve only their displayed plane; a null axis list reserves the full 3D
 * view box. This keeps multiplanar refinement from filling the unseen volume
 * between its three orthogonal panels.
 */
export function visibleFovBounds(
  shape: readonly [number, number, number],
  focus: readonly [number, number, number],
  cameraZoom: number,
  sliceAxes: readonly number[] | null,
): FovBounds[] {
  const zoom = Math.max(1, Number.isFinite(cameraZoom) ? cameraZoom : 1)
  const center = shape.map((size, axis) =>
    Math.max(0, Math.min(size - 0.001, focus[axis] * size)),
  ) as [number, number, number]
  const min = shape.map((size, axis) =>
    Math.max(0, center[axis] - size / (2 * zoom)),
  ) as [number, number, number]
  const max = shape.map((size, axis) =>
    Math.min(size, center[axis] + size / (2 * zoom)),
  ) as [number, number, number]
  if (sliceAxes === null) return [{ min, max }]
  return sliceAxes.map((sliceAxis) => {
    const slabMin = [...min] as [number, number, number]
    const slabMax = [...max] as [number, number, number]
    slabMin[sliceAxis] = center[sliceAxis]
    slabMax[sliceAxis] = Math.min(shape[sliceAxis], center[sliceAxis] + 0.001)
    return { min: slabMin, max: slabMax }
  })
}

export function zoomLevelControlDisplay(
  appliedLevel: number,
  pendingLevel: number | null,
  levelCount: number,
): ZoomLevelControlDisplay {
  const maximum = Math.max(0, levelCount - 1)
  const safeApplied = Number.isFinite(appliedLevel) ? appliedLevel : maximum
  const applied = Math.min(maximum, Math.max(0, Math.round(safeApplied)))
  const hasPending = pendingLevel !== null && Number.isFinite(pendingLevel)
  const value = hasPending
    ? Math.min(maximum, Math.max(0, Math.round(pendingLevel)))
    : applied
  const suffix =
    value === 0
      ? ' · finest'
      : value === maximum
        ? ' · overview'
        : ''
  const changed = hasPending && value !== applied
  return {
    value,
    label: `L${value}${suffix}${changed ? ' · pending' : ''}`,
    canApply: changed,
  }
}

export function windowLevelWidth(win: ContrastWindow): WindowLevelWidth {
  return {
    level: (win.min + win.max) * 0.5,
    width: Math.max(1, win.max - win.min),
  }
}

export function windowFromLevelWidth(
  level: number,
  width: number,
): ContrastWindow {
  const safeLevel = Number.isFinite(level) ? level : 0
  const safeWidth = Number.isFinite(width) ? Math.max(1, width) : 1
  const min = Math.round(safeLevel - safeWidth * 0.5) || 0
  return { min, max: min + Math.round(safeWidth) }
}

/** Re-plan every changed view, even when its finest-level cap is unchanged. */
export function updateAdaptiveLodDetail(
  controller: AdaptiveLodController,
  currentLevel: number | null,
  targetLevel: number,
): boolean {
  controller.setMaxDetail(targetLevel)
  return currentLevel !== targetLevel
}

/** LOD follows the viewport centre; moving only the crosshair must not refocus it. */
export function lodFocusTracksInteraction(
  interaction: LodFocusInteraction,
): boolean {
  return interaction === 'pan'
}

/** Smooth wheel zoom across pixel, line, and page delta modes. */
export function wheelZoomValue(
  current: number,
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
  speed = 1,
): number {
  const pixelsPerUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1
  const pixelDelta = Math.min(
    MAX_WHEEL_DELTA_PX,
    Math.max(-MAX_WHEEL_DELTA_PX, deltaY * pixelsPerUnit),
  )
  const safeSpeed = Number.isFinite(speed)
    ? Math.min(10, Math.max(0.25, speed))
    : 1
  const zoom =
    current * Math.exp(-pixelDelta * WHEEL_ZOOM_SENSITIVITY * safeSpeed)
  return clampViewerZoom(zoom)
}

export function clampViewerZoom(zoom: number): number {
  const finiteZoom = Number.isFinite(zoom) ? zoom : 1
  return Math.min(MAX_VIEWER_ZOOM, Math.max(MIN_VIEWER_ZOOM, finiteZoom))
}

export function detailLevelForZoom(
  baseLevel: number,
  zoom: number,
  levelCount: number,
): number {
  const zoomStops = Math.round(Math.log2(Math.max(MIN_VIEWER_ZOOM, zoom)))
  return Math.min(levelCount - 1, Math.max(0, baseLevel - zoomStops))
}

/** Map a pyramid level to its canonical 2x camera stop from the overview. */
export function zoomForDetailLevel(level: number, levelCount: number): number {
  const overviewLevel = Math.max(0, levelCount - 1)
  const selectedLevel = Math.min(
    overviewLevel,
    Math.max(0, Math.round(Number.isFinite(level) ? level : overviewLevel)),
  )
  return clampViewerZoom(2 ** (overviewLevel - selectedLevel))
}

/** Distinguish the camera-requested level from the finest planned FOV level. */
export function lodDeliveryDisplay(
  requestedLevel: number | null,
  fovLevels: readonly number[],
  contextLevels: readonly number[],
): LodDeliveryDisplay {
  const deliveredLevel = fovLevels[0] ?? null
  const requestedLabel =
    requestedLevel === null ? '' : `Requested L${requestedLevel} · `
  const fovLabel =
    fovLevels.length > 0
      ? fovLevels.map((level) => `L${level}`).join(' · ')
      : 'unavailable'
  const contextLabel = contextLevels
    .map((level) => `L${level}`)
    .join(' · ')
  return {
    label: `${requestedLabel}FOV ${fovLabel}${contextLabel ? ` · context ${contextLabel}` : ''}`,
    deliveredLevel,
    visibleLabel:
      deliveredLevel === null
        ? ''
        : requestedLevel !== null && requestedLevel !== deliveredLevel
          ? `L${deliveredLevel} · requested L${requestedLevel}`
          : `L${deliveredLevel}`,
  }
}

export function rangeBoundsForWindow(
  window: ContrastWindow,
  configuredMinimum: number,
  configuredMaximum: number,
): { min: number; max: number } {
  return {
    min: Math.min(0, configuredMinimum, window.min),
    max: Math.max(1, configuredMaximum, window.max),
  }
}

export function crosshairAppearanceForSpacing(
  spacing: readonly number[],
  cameraZoom = 1,
): CrosshairAppearance {
  const voxelWidth = Math.min(
    ...spacing.filter((value) => Number.isFinite(value) && value > 0),
  )
  const zoom =
    Number.isFinite(cameraZoom) && cameraZoom > 0 ? cameraZoom : 1
  if (!Number.isFinite(voxelWidth)) {
    return { width: 0.5 / zoom, gap: 10 / zoom }
  }
  return {
    width: Math.max(
      MIN_CROSSHAIR_WORLD_SIZE,
      (voxelWidth * 1.5) / zoom,
    ),
    gap: Math.max(
      MIN_CROSSHAIR_WORLD_SIZE,
      (voxelWidth * 10) / zoom,
    ),
  }
}
