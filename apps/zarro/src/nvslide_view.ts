import {
  NVSlide,
  SlideRenderer,
  type ChunkedVolumeSource,
  type NVSlideScreen,
} from '@niivue/niivue'
import './nvslide_view.css'
import {
  PLANE_DEFINITIONS,
  VolumePlaneSource,
  windowFor,
  type PlaneDefinition,
  type Shape3,
  type VolumePlane,
} from './volume_plane_source.ts'
import {
  formatMeasuredDistance,
  measurementFromSlidePoints,
  measurementIndexAtSlidePoint,
  measurementSegmentOnPlane,
  type NvSlideMeasurement,
  type NvSlideMeasurementGeometry,
  type NvSlideMeasurementSegment,
  type NvSlidePoint,
} from './nvslide_measurement.ts'
import {
  captureNvSlideFraming,
  projectNvSlideFraming,
  type NvSlideFraming,
  type NvSlideFramingSpace,
} from './nvslide_viewport.ts'
import type { NvSlideShareSnapshotV1 } from './nvslide_share_state.ts'

export type Fraction3 = readonly [number, number, number]

export type NvSlideViewState =
  | { kind: 'hidden' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'ready'
      source: ChunkedVolumeSource
      sourceId: string
      sourceName: string
      window: readonly [number, number]
      crosshair: Fraction3
      zoom: number
      showCrosshair: boolean
      showScaleBar: boolean
      interactionMode: 'navigation' | 'measurement'
      measurements: readonly NvSlideMeasurement[]
    }

export interface NvSlideMeasurementCreation extends NvSlideMeasurement {
  plane: VolumePlane
  slicePosition: number
}

export interface NvSlidePaneView {
  plane: VolumePlane
  sourceId: string
  sourceLevelIndex: number
  baseNormalIndex: number
  manifestWidth: number
  manifestHeight: number
  slideBounds: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
}

export interface NvSlideViewEvents {
  onCrosshairChange(crosshair: Fraction3, plane: VolumePlane): void
  onMeasurementCreate(measurement: NvSlideMeasurementCreation): void
  onMeasurementRemove(index: number): void
  onActivePaneChange?(pane: NvSlidePaneView | null): void
}

export interface NvSlideViewHandle {
  update(state: NvSlideViewState): void
  activePaneView(): NvSlidePaneView | null
  navigationSnapshot(): NvSlideShareSnapshotV1 | null
  dispose(): void
}

interface PaneIdentity {
  source: ChunkedVolumeSource
  sourceId: string
  normalIndex: number
}

interface NavigationPointerGesture {
  kind: 'navigation'
  id: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  distance: number
}

interface MeasurementPointerGesture {
  kind: 'measurement'
  id: number
  startClientX: number
  startClientY: number
  start: NvSlidePoint
  current: NvSlidePoint
  distance: number
}

type PointerGesture = NavigationPointerGesture | MeasurementPointerGesture

interface PaneRuntime {
  readonly definition: PlaneDefinition
  readonly element: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly crosshair: HTMLElement
  readonly measurements: SVGSVGElement
  readonly scaleBar: HTMLElement
  readonly scaleBarLine: HTMLElement
  readonly scaleBarLabel: HTMLElement
  readonly loading: HTMLOutputElement
  readonly status: HTMLOutputElement
  readonly cacheBytes: number
  gl: WebGL2RenderingContext | null
  renderer: SlideRenderer | null
  source: VolumePlaneSource | null
  slide: NVSlide | null
  identity: PaneIdentity | null
  retainedFraming: NvSlideFraming | null
  frame: number
  generation: number
  pointer: PointerGesture | null
  slideChange: (() => void) | null
}

const CACHE_BYTES: Record<VolumePlane, number> = {
  axial: 128 * 1024 * 1024,
  sagittal: 64 * 1024 * 1024,
  coronal: 64 * 1024 * 1024,
}

const SVG_NS = 'http://www.w3.org/2000/svg'

const clampFraction = (value: number): number =>
  Math.min(1, Math.max(0, value))

const niceScaleLength = (targetMM: number): number => {
  if (!Number.isFinite(targetMM) || targetMM <= 0) return 1
  const exponent = Math.floor(Math.log10(targetMM))
  const magnitude = 10 ** exponent
  const normalized = targetMM / magnitude
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1
  return factor * magnitude
}

const formatScaleLength = (millimetres: number): string => {
  if (millimetres < 1) {
    const micrometres = millimetres * 1000
    return `${Number(micrometres.toPrecision(3))} µm`
  }
  return `${Number(millimetres.toPrecision(3))} mm`
}

const screenFor = (canvas: HTMLCanvasElement): NVSlideScreen => {
  const rect = canvas.getBoundingClientRect()
  return {
    widthCss: Math.max(1, rect.width),
    heightCss: Math.max(1, rect.height),
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

const framingSpaceFor = (
  slide: NVSlide,
  screen: NVSlideScreen,
): NvSlideFramingSpace => ({
  manifestWidth: slide.manifest.width,
  manifestHeight: slide.manifest.height,
  fitScale: slide.fitScaleFor(screen),
})

const normalIndexFor = (
  definition: PlaneDefinition,
  crosshair: Fraction3,
  shape: readonly [number, number, number],
): number => {
  const count = shape[definition.normalAxis]
  return Math.min(
    count - 1,
    Math.max(
      0,
      Math.round(clampFraction(crosshair[definition.normalAxis]) * (count - 1)),
    ),
  )
}

const sameIdentity = (
  left: PaneIdentity | null,
  right: PaneIdentity,
): boolean =>
  left?.source === right.source &&
  left.sourceId === right.sourceId &&
  left.normalIndex === right.normalIndex

const sameCrosshair = (left: Fraction3, right: Fraction3): boolean =>
  left.every((value, axis) => value === right[axis])

export const mountNvSlideView = (
  root: HTMLElement,
  events: NvSlideViewEvents,
  initialNavigation: NvSlideShareSnapshotV1 | null = null,
): NvSlideViewHandle => {
  let state: NvSlideViewState = { kind: 'hidden' }
  let disposed = false
  let activePlane: VolumePlane = initialNavigation?.activePlane ?? 'axial'

  const panes: PaneRuntime[] = (['axial', 'sagittal', 'coronal'] as const).map(
    (plane): PaneRuntime => {
      const element = root.querySelector<HTMLElement>(`[data-plane="${plane}"]`)
      if (!element) throw new Error(`Missing NVSlide ${plane} pane`)
      const canvas = element.querySelector<HTMLCanvasElement>('.nvslide-canvas')
      const crosshair = element.querySelector<HTMLElement>('.nvslide-crosshair')
      const measurements = element.querySelector<SVGSVGElement>('.nvslide-measurements')
      const scaleBar = element.querySelector<HTMLElement>('.nvslide-scale-bar')
      const scaleBarLine = element.querySelector<HTMLElement>('.nvslide-scale-bar-line')
      const scaleBarLabel = element.querySelector<HTMLElement>('.nvslide-scale-bar-label')
      const loading = element.querySelector<HTMLOutputElement>('.nvslide-pane-loading')
      const status = element.querySelector<HTMLOutputElement>('.nvslide-pane-status')
      if (
        !canvas ||
        !crosshair ||
        !measurements ||
        !scaleBar ||
        !scaleBarLine ||
        !scaleBarLabel ||
        !loading ||
        !status
      ) {
        throw new Error(`The NVSlide ${plane} pane is incomplete`)
      }
      return {
        definition: PLANE_DEFINITIONS[plane],
        element,
        canvas,
        crosshair,
        measurements,
        scaleBar,
        scaleBarLine,
        scaleBarLabel,
        loading,
        status,
        cacheBytes: CACHE_BYTES[plane],
        gl: null,
        renderer: null,
        source: null,
        slide: null,
        identity: null,
        retainedFraming: initialNavigation?.framings[plane] ?? null,
        frame: 0,
        generation: 0,
        pointer: null,
        slideChange: null,
      }
    },
  )

  const paneViewFor = (pane: PaneRuntime): NvSlidePaneView | null => {
    if (!pane.slide || !pane.identity) return null
    const level = pane.slide.selectLevel()
    if (!level) return null
    const screen = screenFor(pane.canvas)
    const topLeft = pane.slide.screenToSlide(0, 0, screen)
    const bottomRight = pane.slide.screenToSlide(
      screen.widthCss,
      screen.heightCss,
      screen,
    )
    return {
      plane: pane.definition.plane,
      sourceId: pane.identity.sourceId,
      sourceLevelIndex: level.index,
      baseNormalIndex: pane.identity.normalIndex,
      manifestWidth: pane.slide.manifest.width,
      manifestHeight: pane.slide.manifest.height,
      slideBounds: {
        minX: Math.min(topLeft.x, bottomRight.x),
        maxX: Math.max(topLeft.x, bottomRight.x),
        minY: Math.min(topLeft.y, bottomRight.y),
        maxY: Math.max(topLeft.y, bottomRight.y),
      },
    }
  }

  const activePaneView = (): NvSlidePaneView | null => {
    const pane = panes.find(({ definition }) => definition.plane === activePlane)
    return pane ? paneViewFor(pane) : null
  }

  const navigationSnapshot = (): NvSlideShareSnapshotV1 | null => {
    const framings = panes.map((pane) =>
      pane.slide
        ? captureNvSlideFraming(
            pane.slide.viewport,
            framingSpaceFor(pane.slide, screenFor(pane.canvas)),
          )
        : pane.retainedFraming,
    )
    const [axial, sagittal, coronal] = framings
    if (!axial || !sagittal || !coronal) return null
    return {
      version: 1,
      activePlane,
      framings: { axial, sagittal, coronal },
    }
  }

  const notifyActivePaneChange = (): void => {
    events.onActivePaneChange?.(activePaneView())
  }

  const setActivePane = (pane: PaneRuntime): void => {
    activePlane = pane.definition.plane
    for (const candidate of panes) {
      candidate.element.dataset.active =
        candidate.definition.plane === activePlane ? 'true' : 'false'
    }
    notifyActivePaneChange()
  }

  const updateCrosshair = (pane: PaneRuntime): void => {
    const slide = pane.slide
    if (!slide || state.kind !== 'ready') {
      pane.crosshair.hidden = true
      return
    }
    pane.crosshair.hidden = !state.showCrosshair
    if (!state.showCrosshair) return
    const screen = screenFor(pane.canvas)
    const rect = slide.screenRectForSlide(screen)
    const dpr = screen.devicePixelRatio ?? 1
    const u = clampFraction(state.crosshair[pane.definition.uAxis])
    const v = clampFraction(state.crosshair[pane.definition.vAxis])
    pane.crosshair.style.setProperty(
      '--crosshair-x',
      `${(rect.x + rect.width * u) / dpr}px`,
    )
    pane.crosshair.style.setProperty(
      '--crosshair-y',
      `${(rect.y + rect.height * (1 - v)) / dpr}px`,
    )
  }

  const updateScaleBar = (pane: PaneRuntime): void => {
    const slide = pane.slide
    if (!slide || state.kind !== 'ready' || !state.showScaleBar) {
      pane.scaleBar.hidden = true
      return
    }
    const base = state.source.levels[0]
    const spacing = base?.spacing
    const horizontalSpacing = spacing?.[pane.definition.uAxis] ?? 1
    const verticalSpacing = spacing?.[pane.definition.vAxis] ?? horizontalSpacing
    const spacingUnit = Math.min(horizontalSpacing, verticalSpacing)
    if (!Number.isFinite(spacingUnit) || spacingUnit <= 0) {
      pane.scaleBar.hidden = true
      return
    }
    const screen = screenFor(pane.canvas)
    const targetCss = Math.min(120, Math.max(40, screen.widthCss * 0.22))
    const physicalTarget = (targetCss / slide.viewport.scale) * spacingUnit
    const physicalLength = niceScaleLength(physicalTarget)
    const widthCss = (physicalLength / spacingUnit) * slide.viewport.scale
    if (!Number.isFinite(widthCss) || widthCss < 8) {
      pane.scaleBar.hidden = true
      return
    }
    pane.scaleBarLine.style.width = `${widthCss}px`
    pane.scaleBarLabel.textContent = formatScaleLength(physicalLength)
    pane.scaleBar.hidden = false
  }

  const centerPaneOnCrosshair = (
    pane: PaneRuntime,
    crosshair: Fraction3,
  ): void => {
    if (!pane.slide) return
    centerSlideOnCrosshair(pane.slide, pane.definition, crosshair)
  }

  const centerSlideOnCrosshair = (
    slide: NVSlide,
    definition: PlaneDefinition,
    crosshair: Fraction3,
  ): void => {
    slide.setViewport({
      ...slide.viewport,
      centerX:
        clampFraction(crosshair[definition.uAxis]) * slide.manifest.width,
      centerY:
        clampFraction(crosshair[definition.vAxis]) * slide.manifest.height,
    })
  }

  const measurementGeometryFor = (
    pane: PaneRuntime,
  ): NvSlideMeasurementGeometry | null => {
    if (state.kind !== 'ready' || !pane.slide || !pane.identity) return null
    const base = state.source.levels[0]
    if (!base) return null
    return {
      plane: pane.definition.plane,
      shape: [base.shape[0], base.shape[1], base.shape[2]],
      spacing: [base.spacing[0], base.spacing[1], base.spacing[2]],
      normalIndex: pane.identity.normalIndex,
      manifestWidth: pane.slide.manifest.width,
      manifestHeight: pane.slide.manifest.height,
    }
  }

  const screenPointForSlide = (
    pane: PaneRuntime,
    point: NvSlidePoint,
    screen: NVSlideScreen,
  ): NvSlidePoint | null => {
    if (!pane.slide) return null
    const rect = pane.slide.screenRectForSlide(screen)
    const dpr = screen.devicePixelRatio ?? 1
    return {
      x:
        (rect.x +
          rect.width * (point.x / pane.slide.manifest.width)) /
        dpr,
      y:
        (rect.y +
          rect.height * (1 - point.y / pane.slide.manifest.height)) /
        dpr,
    }
  }

  const svgLine = (
    start: NvSlidePoint,
    end: NvSlidePoint,
    className: string,
  ): SVGLineElement => {
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(start.x))
    line.setAttribute('y1', String(start.y))
    line.setAttribute('x2', String(end.x))
    line.setAttribute('y2', String(end.y))
    line.setAttribute('class', className)
    return line
  }

  const measurementGroup = (
    pane: PaneRuntime,
    segment: NvSlideMeasurementSegment,
    distance: number,
    draft: boolean,
    screen: NVSlideScreen,
  ): SVGGElement | null => {
    const start = screenPointForSlide(pane, segment.start, screen)
    const end = screenPointForSlide(pane, segment.end, screen)
    if (!start || !end) return null
    const group = document.createElementNS(SVG_NS, 'g')
    const draftClass = draft ? ' nvslide-measurement-draft' : ''
    group.append(svgLine(
      start,
      end,
      `nvslide-measurement-line${draftClass}`,
    ))
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length > 0) {
      const capX = (-dy / length) * 6
      const capY = (dx / length) * 6
      group.append(
        svgLine(
          { x: start.x - capX, y: start.y - capY },
          { x: start.x + capX, y: start.y + capY },
          `nvslide-measurement-cap${draftClass}`,
        ),
        svgLine(
          { x: end.x - capX, y: end.y - capY },
          { x: end.x + capX, y: end.y + capY },
          `nvslide-measurement-cap${draftClass}`,
        ),
      )
    }
    const label = document.createElementNS(SVG_NS, 'text')
    label.setAttribute('x', String((start.x + end.x) * 0.5))
    label.setAttribute('y', String((start.y + end.y) * 0.5 - 8))
    label.setAttribute(
      'class',
      `nvslide-measurement-label${draftClass}`,
    )
    label.textContent = formatMeasuredDistance(distance)
    group.append(label)
    return group
  }

  const updateMeasurements = (pane: PaneRuntime): void => {
    if (state.kind !== 'ready' || !pane.slide) {
      pane.measurements.replaceChildren()
      return
    }
    const geometry = measurementGeometryFor(pane)
    if (!geometry) {
      pane.measurements.replaceChildren()
      return
    }
    const screen = screenFor(pane.canvas)
    pane.measurements.setAttribute(
      'viewBox',
      `0 0 ${screen.widthCss} ${screen.heightCss}`,
    )
    const groups: SVGGElement[] = []
    for (const measurement of state.measurements) {
      const segment = measurementSegmentOnPlane(measurement, geometry)
      if (!segment) continue
      const group = measurementGroup(
        pane,
        segment,
        measurement.distance,
        false,
        screen,
      )
      if (group) groups.push(group)
    }
    if (pane.pointer?.kind === 'measurement') {
      const draft = measurementFromSlidePoints(
        pane.pointer.start,
        pane.pointer.current,
        geometry,
      )
      const segment = measurementSegmentOnPlane(draft, geometry)
      if (segment) {
        const group = measurementGroup(
          pane,
          segment,
          draft.distance,
          true,
          screen,
        )
        if (group) groups.push(group)
      }
    }
    pane.measurements.replaceChildren(...groups)
  }

  const drawPane = (pane: PaneRuntime): void => {
    pane.frame = 0
    if (!pane.slide || !pane.renderer || !pane.gl || root.hidden) return
    const screen = screenFor(pane.canvas)
    const dpr = screen.devicePixelRatio ?? 1
    const width = Math.max(1, Math.round(screen.widthCss * dpr))
    const height = Math.max(1, Math.round(screen.heightCss * dpr))
    if (pane.canvas.width !== width) pane.canvas.width = width
    if (pane.canvas.height !== height) pane.canvas.height = height
    pane.renderer.render([pane.slide], screen)
    updateCrosshair(pane)
    updateScaleBar(pane)
    updateMeasurements(pane)
    const level = pane.slide.selectLevel()
    pane.element.dataset.level = level ? String(level.index) : ''
    const framing = captureNvSlideFraming(
      pane.slide.viewport,
      framingSpaceFor(pane.slide, screen),
    )
    if (framing) {
      pane.element.dataset.framing = [
        framing.centerU,
        framing.centerV,
        framing.zoomOverFit,
      ].map((value) => value.toFixed(9)).join(',')
    } else {
      delete pane.element.dataset.framing
    }
    const pendingCount = pane.slide.pendingCount
    pane.element.dataset.pending = String(pendingCount)
    pane.element.dataset.cacheBytes = String(pane.slide.cacheBytes)
    pane.element.dataset.tileRequests = String(pane.slide.stats.requested)
    pane.loading.value = pendingCount > 0
      ? `${pendingCount} tile${pendingCount === 1 ? '' : 's'} loading`
      : ''
    pane.loading.hidden = pendingCount === 0
    if (pane.definition.plane === activePlane) notifyActivePaneChange()
  }

  const requestDraw = (pane: PaneRuntime): void => {
    if (pane.frame === 0 && !disposed) {
      pane.frame = requestAnimationFrame(() => drawPane(pane))
    }
  }

  const ensureRenderer = (pane: PaneRuntime): boolean => {
    if (pane.renderer && pane.gl) return true
    const gl = pane.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    })
    if (!gl) {
      pane.status.value = 'NVSlide needs WebGL 2.'
      return false
    }
    const renderer = new SlideRenderer()
    renderer.init(gl)
    pane.gl = gl
    pane.renderer = renderer
    return true
  }

  const checkpointPaneFraming = (pane: PaneRuntime): void => {
    if (!pane.slide) return
    const framing = captureNvSlideFraming(
      pane.slide.viewport,
      framingSpaceFor(pane.slide, screenFor(pane.canvas)),
    )
    if (framing) pane.retainedFraming = framing
  }

  const releasePaneResources = (
    pane: PaneRuntime,
    destroyRenderer: boolean,
  ): void => {
    if (pane.frame !== 0) cancelAnimationFrame(pane.frame)
    pane.frame = 0
    if (pane.slide && pane.slideChange) {
      pane.slide.removeEventListener('change', pane.slideChange)
    }
    pane.source?.dispose()
    pane.source = null
    pane.slide?.dispose()
    pane.slide = null
    pane.slideChange = null
    pane.identity = null
    pane.renderer?.clearTextures()
    if (destroyRenderer) {
      pane.renderer?.destroy()
      pane.renderer = null
      pane.gl = null
    }
  }

  const disposePane = (
    pane: PaneRuntime,
    destroyRenderer: boolean,
    resetFraming: boolean,
  ): void => {
    if (resetFraming) pane.retainedFraming = null
    else checkpointPaneFraming(pane)
    releasePaneResources(pane, destroyRenderer)
    pane.crosshair.hidden = true
    pane.measurements.replaceChildren()
    pane.scaleBar.hidden = true
    pane.loading.hidden = true
    pane.loading.value = ''
    delete pane.element.dataset.level
    delete pane.element.dataset.framing
    pane.element.dataset.pending = '0'
    pane.element.dataset.cacheBytes = '0'
  }

  const applyWindow = (
    pane: PaneRuntime,
    window: readonly [number, number],
  ): void => {
    const slide = pane.slide
    if (!slide) return
    const { calMin, calMax } = windowFor(window)
    const channel = slide.channels[0]
    if (channel && (channel.calMin !== calMin || channel.calMax !== calMax)) {
      slide.setChannel(0, { calMin, calMax })
    }
    pane.element.dataset.window = `${window[0]}:${window[1]}`
  }

  const buildPane = (
    pane: PaneRuntime,
    ready: Extract<NvSlideViewState, { kind: 'ready' }>,
    identity: PaneIdentity,
  ): void => {
    checkpointPaneFraming(pane)
    releasePaneResources(pane, false)
    pane.generation += 1
    if (!ensureRenderer(pane)) return

    const source = new VolumePlaneSource(ready.source, {
      id: `${ready.sourceId}-${pane.definition.plane}-${identity.normalIndex}-g${pane.generation}`,
      name: `${ready.sourceName} · ${pane.definition.label} ${identity.normalIndex + 1}`,
      plane: pane.definition.plane,
      index: identity.normalIndex,
      window: ready.window,
    })
    let slide: NVSlide | null = null
    try {
      slide = NVSlide.fromSource(source, {
        maxCacheBytes: pane.cacheBytes,
        maxScale: 64,
        targetScreenPixelsPerTilePixel: 0.75,
        backgroundColor: [0.01, 0.015, 0.015, 1],
        placeholderColor: [0.03, 0.04, 0.04, 1],
      })
      const screen = screenFor(pane.canvas)
      const restoredViewport = pane.retainedFraming
        ? projectNvSlideFraming(
            pane.retainedFraming,
            framingSpaceFor(slide, screen),
          )
        : null
      if (restoredViewport) {
        slide.setViewport(restoredViewport)
      } else {
        slide.fitToScreen(screen)
        slide.setViewport({
          ...slide.viewport,
          scale: Math.min(
            slide.maxScale,
            slide.fitScaleFor(screen) * Math.max(0.01, ready.zoom),
          ),
        })
        centerSlideOnCrosshair(slide, pane.definition, ready.crosshair)
      }
      slide.clampViewport(screen)
      const generation = pane.generation
      const slideChange = (): void => {
        if (pane.generation !== generation) return
        requestDraw(pane)
        if (pane.definition.plane === activePlane) notifyActivePaneChange()
      }
      slide.addEventListener('change', slideChange)
      pane.source = source
      pane.slide = slide
      pane.slideChange = slideChange
      pane.identity = identity
      pane.retainedFraming = null
      pane.status.value = ''
      pane.element.dataset.slice = String(identity.normalIndex)
      pane.element.dataset.generation = String(pane.generation)
      applyWindow(pane, ready.window)
      requestDraw(pane)
    } catch (error) {
      slide?.dispose()
      source.dispose()
      throw error
    }
  }

  const updateReady = (
    ready: Extract<NvSlideViewState, { kind: 'ready' }>,
    previous: NvSlideViewState,
  ): void => {
    root.hidden = false
    root.setAttribute('aria-hidden', 'false')
    root.dataset.interaction = ready.interactionMode
    const base = ready.source.levels[0]
    if (!base) {
      for (const pane of panes) {
        disposePane(pane, false, false)
        pane.status.value = 'This volume has no pyramid levels.'
      }
      return
    }
    const crosshairChanged =
      previous.kind === 'ready' &&
      !sameCrosshair(previous.crosshair, ready.crosshair)

    for (const pane of panes) {
      const identity: PaneIdentity = {
        source: ready.source,
        sourceId: ready.sourceId,
        normalIndex: normalIndexFor(
          pane.definition,
          ready.crosshair,
          base.shape as Shape3,
        ),
      }
      try {
        const rebuild = !sameIdentity(pane.identity, identity)
        if (rebuild) {
          buildPane(pane, ready, identity)
        } else {
          applyWindow(pane, ready.window)
        }
        if (
          !rebuild &&
          pane.slide &&
          previous.kind === 'ready' &&
          previous.zoom !== ready.zoom
        ) {
          const screen = screenFor(pane.canvas)
          pane.slide.setViewport({
            ...pane.slide.viewport,
            scale: Math.min(
              pane.slide.maxScale,
              pane.slide.fitScaleFor(screen) * Math.max(0.01, ready.zoom),
            ),
          })
          pane.slide.clampViewport(screen)
        }
        if (crosshairChanged) {
          centerPaneOnCrosshair(pane, ready.crosshair)
        }
        updateCrosshair(pane)
        updateScaleBar(pane)
        updateMeasurements(pane)
        requestDraw(pane)
      } catch (error) {
        disposePane(pane, false, false)
        pane.status.value = error instanceof Error ? error.message : String(error)
      }
    }
  }

  const update = (next: NvSlideViewState): void => {
    if (disposed) return
    const previous = state
    state = next
    if (next.kind === 'hidden') {
      root.hidden = true
      root.setAttribute('aria-hidden', 'true')
      delete root.dataset.interaction
      for (const pane of panes) {
        disposePane(pane, true, true)
        pane.status.value = ''
      }
      notifyActivePaneChange()
      return
    }
    if (next.kind === 'unavailable') {
      root.hidden = false
      root.setAttribute('aria-hidden', 'false')
      delete root.dataset.interaction
      for (const pane of panes) {
        disposePane(pane, true, false)
        pane.status.value = next.reason
      }
      notifyActivePaneChange()
      return
    }
    updateReady(next, previous)
  }

  const slidePointForEvent = (
    pane: PaneRuntime,
    event: { clientX: number; clientY: number },
    clampToManifest: boolean,
  ): NvSlidePoint | null => {
    if (!pane.slide) return null
    const rect = pane.canvas.getBoundingClientRect()
    const point = pane.slide.screenToSlide(
      event.clientX - rect.left,
      event.clientY - rect.top,
      screenFor(pane.canvas),
    )
    const width = pane.slide.manifest.width
    const height = pane.slide.manifest.height
    if (
      !clampToManifest &&
      (point.x < 0 || point.x > width || point.y < 0 || point.y > height)
    ) {
      return null
    }
    return {
      x: Math.min(width, Math.max(0, point.x)),
      y: Math.min(height, Math.max(0, point.y)),
    }
  }

  for (const pane of panes) {
    pane.element.dataset.active =
      pane.definition.plane === activePlane ? 'true' : 'false'
    pane.canvas.addEventListener('focus', () => {
      setActivePane(pane)
    })
    pane.canvas.addEventListener('pointerdown', (event) => {
      if (!pane.slide || state.kind !== 'ready') return
      setActivePane(pane)
      pane.canvas.focus({ preventScroll: true })
      if (state.interactionMode === 'measurement') {
        const start = slidePointForEvent(pane, event, false)
        if (!start) return
        pane.canvas.setPointerCapture(event.pointerId)
        pane.pointer = {
          kind: 'measurement',
          id: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          start,
          current: start,
          distance: 0,
        }
        updateMeasurements(pane)
        return
      }
      pane.canvas.setPointerCapture(event.pointerId)
      pane.pointer = {
        kind: 'navigation',
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        distance: 0,
      }
    })
    pane.canvas.addEventListener('pointermove', (event) => {
      const pointer = pane.pointer
      if (!pointer || pointer.id !== event.pointerId || !pane.slide) return
      if (pointer.kind === 'measurement') {
        pointer.distance = Math.max(
          pointer.distance,
          Math.hypot(
            event.clientX - pointer.startClientX,
            event.clientY - pointer.startClientY,
          ),
        )
        const current = slidePointForEvent(pane, event, true)
        if (current) pointer.current = current
        updateMeasurements(pane)
        return
      }
      const dx = event.clientX - pointer.lastX
      const dy = event.clientY - pointer.lastY
      pointer.distance = Math.max(
        pointer.distance,
        Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY),
      )
      pane.slide.panByScreenDelta(dx, dy, screenFor(pane.canvas))
      pointer.lastX = event.clientX
      pointer.lastY = event.clientY
      requestDraw(pane)
    })
    const endPointer = (event: PointerEvent): void => {
      const pointer = pane.pointer
      pane.pointer = null
      if (
        !pointer ||
        pointer.id !== event.pointerId ||
        !pane.slide ||
        state.kind !== 'ready'
      ) return
      if (pointer.kind === 'measurement') {
        updateMeasurements(pane)
        if (pointer.distance <= 4) return
        const geometry = measurementGeometryFor(pane)
        if (!geometry) return
        const measurement = measurementFromSlidePoints(
          pointer.start,
          pointer.current,
          geometry,
        )
        events.onMeasurementCreate({
          ...measurement,
          plane: pane.definition.plane,
          slicePosition: state.crosshair[pane.definition.normalAxis],
        })
        return
      }
      if (pointer.distance > 4) return
      const point = slidePointForEvent(pane, event, true)
      if (!point) return
      const crosshair: [number, number, number] = [
        state.crosshair[0],
        state.crosshair[1],
        state.crosshair[2],
      ]
      crosshair[pane.definition.uAxis] = clampFraction(
        point.x / pane.slide.manifest.width,
      )
      crosshair[pane.definition.vAxis] = clampFraction(
        point.y / pane.slide.manifest.height,
      )
      events.onCrosshairChange(crosshair, pane.definition.plane)
    }
    pane.canvas.addEventListener('pointerup', endPointer)
    pane.canvas.addEventListener('pointercancel', (event) => {
      if (pane.pointer?.id === event.pointerId) {
        pane.pointer = null
        updateMeasurements(pane)
      }
    })
    pane.canvas.addEventListener('contextmenu', (event) => {
      if (
        !pane.slide ||
        state.kind !== 'ready' ||
        event.shiftKey ||
        state.measurements.length === 0
      ) return
      const point = slidePointForEvent(pane, event, false)
      const geometry = measurementGeometryFor(pane)
      if (!point || !geometry) return
      const index = measurementIndexAtSlidePoint(
        state.measurements,
        geometry,
        point,
        12 / pane.slide.viewport.scale,
      )
      if (index < 0) return
      event.preventDefault()
      setActivePane(pane)
      events.onMeasurementRemove(index)
    })
    pane.canvas.addEventListener('wheel', (event) => {
      if (!pane.slide) return
      event.preventDefault()
      setActivePane(pane)
      const rect = pane.canvas.getBoundingClientRect()
      pane.slide.zoomBy(
        Math.exp(-event.deltaY * 0.002),
        event.clientX - rect.left,
        event.clientY - rect.top,
        screenFor(pane.canvas),
      )
      requestDraw(pane)
      notifyActivePaneChange()
    }, { passive: false })
    pane.canvas.addEventListener('dblclick', () => {
      if (
        !pane.slide ||
        state.kind !== 'ready' ||
        state.interactionMode === 'measurement'
      ) return
      setActivePane(pane)
      const screen = screenFor(pane.canvas)
      pane.slide.fitToScreen(screen)
      centerPaneOnCrosshair(pane, state.crosshair)
      pane.slide.clampViewport(screen)
      requestDraw(pane)
      notifyActivePaneChange()
    })
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const pane = panes.find((candidate) => candidate.element === entry.target)
      if (pane) requestDraw(pane)
    }
  })
  for (const pane of panes) resizeObserver.observe(pane.element)

  return {
    update,
    activePaneView,
    navigationSnapshot,
    dispose: () => {
      if (disposed) return
      disposed = true
      resizeObserver.disconnect()
      for (const pane of panes) disposePane(pane, true, true)
      root.hidden = true
      root.setAttribute('aria-hidden', 'true')
    },
  }
}
