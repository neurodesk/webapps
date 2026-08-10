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

export interface ZoomControlDisplay {
  value: number
  label: string
  canApply: boolean
}

export type LodFocusInteraction = 'pan' | 'crosshair'

export interface AdaptiveLodController {
  setMaxDetail(levelIndex: number): void
}

const WHEEL_ZOOM_SENSITIVITY = 0.00075
const MAX_WHEEL_DELTA_PX = 120
export const MIN_VIEWER_ZOOM = 0.1
export const MAX_VIEWER_ZOOM = 128

export function zoomControlDisplay(
  appliedZoom: number,
  pendingZoom: number | null,
): ZoomControlDisplay {
  const applied =
    Number.isFinite(appliedZoom) && appliedZoom > 0 ? appliedZoom : 1
  const hasPending =
    pendingZoom !== null && Number.isFinite(pendingZoom) && pendingZoom > 0
  const value = hasPending ? pendingZoom : applied
  return {
    value,
    label: `${value.toFixed(2)}x${hasPending ? ' pending' : ''}`,
    canApply: hasPending,
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
    ? Math.min(4, Math.max(0.25, speed))
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
): CrosshairAppearance {
  const voxelWidth = Math.min(
    ...spacing.filter((value) => Number.isFinite(value) && value > 0),
  )
  if (!Number.isFinite(voxelWidth)) return { width: 0.5, gap: 10 }
  return {
    width: Math.max(0.0001, voxelWidth * 1.5),
    gap: Math.max(0.0001, voxelWidth * 10),
  }
}
