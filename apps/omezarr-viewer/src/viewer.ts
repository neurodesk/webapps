import NiiVue, {
  type ChunkedVolumeFetch,
  type ChunkedVolumeSource,
  type ChunkPlan,
  chunkVolumeGrid,
  DRAG_MODE,
  type NVChunkedVolume,
  type NVImage,
  SLICE_TYPE,
  type VolumeChunkSource,
  writeVolume,
} from '@niivue/niivue'
import '@neurodesk/webapp-components/styles/base.css'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import * as zarr from 'zarrita'
import './styles.css'
import { getBackendFromUrl } from './backend'
import {
  searchDandiZarrAssets,
  type DandiZarrAsset,
} from './dandi_archive'
import {
  IntensityWindowEstimator,
  isGenericDtypeWindow,
} from './intensity_window'
import {
  buildLogicalVolume,
  niftiDatatype,
  type Shape3,
} from './logical_volume'
import {
  layoutTranslatedBlocks,
  spatialTransformMm,
  type MosaicBlockLayout,
} from './mosaic_layout'
import {
  compositeMosaicBlocks,
  mosaicSamplingWindow,
  type FetchedMosaicBlock,
} from './mosaic_composite'
import {
  absoluteCropOrigin,
  fovCropGeometry,
  renderCropGrid,
} from './render_crop'
import {
  readShareState,
  writeShareState,
  type ShareableViewState,
} from './share_state'
import {
  crosshairAppearanceForSpacing,
  clampViewerZoom,
  detailLevelForZoom,
  lodFocusTracksInteraction,
  rangeBoundsForWindow,
  updateAdaptiveLodDetail,
  wheelZoomValue,
  windowFromLevelWidth,
  windowLevelWidth,
  zoomControlDisplay,
} from './viewer_controls'
import { withInflightReadDeduplication } from './zarr_store'

mountImagingWorkspace({
  root: '#app',
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'ZARRo',
  subtitle: 'Cloud-native multiscale imaging',
  mark: 'Z',
})

const BACKEND = getBackendFromUrl()
const MANIFEST_URL = assetUrl('range-poc/synthetic-volume.json')
const DEFAULT_RESIDENCY_BYTES = 512 * 1024 * 1024
// NiiVue's planner accounts for eight bytes per voxel regardless of source
// dtype. ZARRo supports one- and two-byte data, so this corrects that estimate
// while the stream manager still enforces DEFAULT_RESIDENCY_BYTES at runtime.
const ADAPTIVE_PLANNER_BUDGET_BYTES = DEFAULT_RESIDENCY_BYTES * 4
const STREAMING_CHUNK_EDGE = 256
const STREAMING_CHUNK_HALO: Shape3 = [3, 3, 3]
const ZARR_BYTE_CACHE_BYTES = 512 * 1024 * 1024
const LOD_DEBOUNCE_MS = 180
const ADAPTIVE_MAX_BRICKS = 512
const ADAPTIVE_CELL_EDGE = 128
// Keep the finest data local to the viewport focus. NiiVue's automatic radius
// is based on the full 3D diagonal, which overestimates the visible footprint
// for long, thin microscopy volumes and exhausts the brick budget before L2/L1.
const ADAPTIVE_FINE_RADIUS = ADAPTIVE_CELL_EDGE / 2
const MAX_IN_MEMORY_NIFTI_BYTES = 256 * 1024 * 1024
const AUTO_WINDOW_CHUNK_LIMIT = 8

type SourceKind = 'synthetic' | 'omezarr'
type OmezarrSourceId = 'dandi' | 'custom'
type SupportedDtype = 'uint8' | 'uint16'
type ZarrFetchArray = zarr.Array<zarr.DataType, zarr.AsyncReadable>

interface OmezarrProfile {
  id: string
  name: string
  storeUrl: () => string
  defaultLevel: number
  defaultWindow: DisplayWindow
  transportLabel: string
  preferCoarsestLevel?: boolean
}

interface RangeManifest {
  id: string
  name: string
  shape: Shape3
  spacing: Shape3
  dtype: 'uint8'
  chunkGrid: Shape3
  chunkShape: Shape3
  chunkBytes: number
  chunkCount: number
  byteLength: number
  dataUrl: string
  order: string
}

interface NgffCoordinateTransform {
  type: string
  scale?: number[]
  translation?: number[]
}

interface NgffDataset {
  path: string
  coordinateTransformations?: NgffCoordinateTransform[]
}

interface NgffMultiscale {
  datasets?: NgffDataset[]
  axes?: Array<{ unit?: string }>
  coordinateTransformations?: NgffCoordinateTransform[]
}

interface OmezarrRootAttributes {
  multiscales?: NgffMultiscale[]
  ome?: {
    multiscales?: NgffMultiscale[]
  }
}

interface DisplayWindow {
  min: number
  max: number
}

interface LoadedSourceBase {
  kind: SourceKind | 'omezarr-mosaic'
  id: string
  name: string
  shape: Shape3
  spacing: Shape3
  dtype: SupportedDtype
  datatypeCode: number
  numBitsPerVoxel: number
  defaultWindow: DisplayWindow
  chunkGrid: Shape3
  chunkShape: Shape3
  chunkCount: number
  sourceUrl: string
  transportLabel: string
}

interface RangeSource extends LoadedSourceBase {
  kind: 'synthetic'
  dataUrl: string
  chunkBytes: number
}

interface OmezarrSource extends LoadedSourceBase {
  kind: 'omezarr'
  baseLevel: number
  levels: OmezarrLevel[]
}

interface OmezarrLevel {
  level: number
  path: string
  array: ZarrFetchArray
  shape: Shape3
  spacing: Shape3
  translation: Shape3
  chunkGrid: Shape3
  chunkShape: Shape3
}

interface OmezarrMosaicBlock extends MosaicBlockLayout {
  source: OmezarrSource
  level: OmezarrLevel
}

interface OmezarrMosaicSource extends LoadedSourceBase {
  kind: 'omezarr-mosaic'
  baseLevel: number
  worldOrigin: Shape3
  blocks: OmezarrMosaicBlock[]
}

type LoadedSource = RangeSource | OmezarrSource | OmezarrMosaicSource

interface RangeStats {
  requested: Set<string>
  completed: Set<string>
  wireBytes: number
  decodedBytes: number
  rangeHits: number
  chunkObjectHits: number
  metadataHits: number
  cacheHits: number
  cacheBytes: number
  fullFileFallbacks: number
  failures: number
  lastRequests: string[]
}

class ByteLruCache implements zarr.ByteCache {
  private readonly entries = new Map<
    string,
    { value: Uint8Array | undefined; bytes: number }
  >()
  private totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  has(key: string): boolean {
    const hit = this.entries.has(key)
    if (hit) stats.cacheHits++
    return hit
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Uint8Array | undefined): void {
    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.bytes
      this.entries.delete(key)
    }
    const bytes = value?.byteLength ?? 0
    this.entries.set(key, { value, bytes })
    this.totalBytes += bytes
    this.evict()
    stats.cacheBytes = this.totalBytes
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const firstKey = this.entries.keys().next().value
      if (typeof firstKey !== 'string') return
      const first = this.entries.get(firstKey)
      if (!first) return
      this.entries.delete(firstKey)
      this.totalBytes -= first.bytes
    }
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  source: el<HTMLSelectElement>('source'),
  activeLevel: el<HTMLOutputElement>('activeLevel'),
  activeLevelControl: el<HTMLSpanElement>('activeLevelControl'),
  layout: el<HTMLSelectElement>('layout'),
  zoom: el<HTMLInputElement>('zoom'),
  zoomValue: el<HTMLOutputElement>('zoomValue'),
  applyZoom: el<HTMLButtonElement>('applyZoom'),
  zarrLevel: el<HTMLSelectElement>('zarrLevel'),
  zarrLevelControl: el<HTMLElement>('zarrLevelControl'),
  scrollZoomSpeed: el<HTMLInputElement>('scrollZoomSpeed'),
  scrollZoomSpeedValue: el<HTMLOutputElement>('scrollZoomSpeedValue'),
  pan: [
    el<HTMLInputElement>('panX'),
    el<HTMLInputElement>('panY'),
    el<HTMLInputElement>('panZ'),
  ],
  panValue: [
    el<HTMLOutputElement>('panXValue'),
    el<HTMLOutputElement>('panYValue'),
    el<HTMLOutputElement>('panZValue'),
  ],
  colormap: el<HTMLSelectElement>('colormap'),
  windowLevel: el<HTMLInputElement>('windowLevel'),
  windowLevelValue: el<HTMLOutputElement>('windowLevelValue'),
  windowWidth: el<HTMLInputElement>('windowWidth'),
  windowWidthValue: el<HTMLOutputElement>('windowWidthValue'),
  windowMin: el<HTMLInputElement>('windowMin'),
  windowMax: el<HTMLInputElement>('windowMax'),
  windowRangeTrack: el<HTMLDivElement>('windowRangeTrack'),
  windowRangeValue: el<HTMLOutputElement>('windowRangeValue'),
  interactionTool: el<HTMLButtonElement>('interactionTool'),
  showScaleBar: el<HTMLInputElement>('showScaleBar'),
  clearMeasurements: el<HTMLButtonElement>('clearMeasurements'),
  measurementStatus: el<HTMLOutputElement>('measurementStatus'),
  zarrUrl: el<HTMLInputElement>('zarrUrl'),
  removeZarrUrl: el<HTMLButtonElement>('removeZarrUrl'),
  zarrUrls: el<HTMLDivElement>('zarrUrls'),
  addZarrUrl: el<HTMLButtonElement>('addZarrUrl'),
  dandiArchiveControl: el<HTMLDivElement>('dandiArchiveControl'),
  zarrUrlControl: el<HTMLDivElement>('zarrUrlControl'),
  dandisetId: el<HTMLInputElement>('dandisetId'),
  dandiVersion: el<HTMLInputElement>('dandiVersion'),
  dandiQuery: el<HTMLInputElement>('dandiQuery'),
  searchDandi: el<HTMLButtonElement>('searchDandi'),
  dandiSearchStatus: el<HTMLOutputElement>('dandiSearchStatus'),
  dandiResults: el<HTMLDivElement>('dandiResults'),
  addDandiSelection: el<HTMLButtonElement>('addDandiSelection'),
  dandiSelectedStores: el<HTMLDivElement>('dandiSelectedStores'),
  showCrosshair: el<HTMLInputElement>('showCrosshair'),
  showStats: el<HTMLInputElement>('showStats'),
  reload: el<HTMLButtonElement>('reload'),
  downloadNifti: el<HTMLButtonElement>('downloadNifti'),
  copyShareLink: el<HTMLButtonElement>('copyShareLink'),
  shareStatus: el<HTMLOutputElement>('shareStatus'),
  downloadStatus: el<HTMLOutputElement>('downloadStatus'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  chunkStrip: el<HTMLDivElement>('chunkStrip'),
  fallback: el<HTMLDivElement>('fallback'),
  visibleLevel: el<HTMLOutputElement>('visibleLevel'),
}

let nv: NiiVue | null = null
let activeSource: LoadedSource | null = null
let chunkPlan: ChunkPlan | null = null
let chunkedVolume: NVChunkedVolume | null = null
let stats: RangeStats = freshStats()
let pollHandle = 0
let shouldInitializeCustomSource = true
let selectedDandiStoreUrls: string[] = []
let requestedBaseLevel: number | null = null
let fixedZarrLevel: number | null = null
let focusFraction: Shape3 = [0.5, 0.5, 0.5]
let lastPanForFocus: Shape3 = [0, 0, 0]
let suppressAdaptiveEvents = false
let downloadInProgress = false
let renderCropGeometry: ExportGeometry | null = null
let sliceViewBeforeRender: ViewState | null = null
let windowUpdateHandle = 0
let pendingZoom: number | null = null
let dandiSearchController: AbortController | null = null
let mosaicLodHandle = 0
let mosaicLodRevision = 0

function cancelMosaicLodReload(): void {
  mosaicLodRevision++
  window.clearTimeout(mosaicLodHandle)
  mosaicLodHandle = 0
}
let initialSharedView: ViewState | null = null
let initialSharedSettings: ShareableViewState | null = null
let manualWindowRevision = 0
let autoWindowSession: AutoWindowSession | null = null

interface AutoWindowSession {
  source: OmezarrSource | OmezarrMosaicSource
  estimator: IntensityWindowEstimator
  manualRevision: number
  observedChunks: number
  lastMaximum: number | null
}

interface ViewState {
  azimuth: number
  elevation: number
  scale: number
  crosshair: Shape3
  pan2D: [number, number, number, number]
  renderPan: [number, number]
}

interface CameraView {
  azimuth: number
  elevation: number
  scaleMultiplier: number
  crosshairPos: ArrayLike<number>
  pan2Dxyzmm: ArrayLike<number>
  renderPan: ArrayLike<number>
}

function defaultShareState(): ShareableViewState {
  return {
    layout: Number(els.layout.value),
    azimuth: 110,
    elevation: 15,
    scale: 1,
    crosshair: [0.5, 0.5, 0.5],
    pan2D: [0, 0, 0, 1],
    renderPan: [0, 0],
    colormap: els.colormap.value,
    windowLevel: Number(els.windowLevel.value),
    windowWidth: Number(els.windowWidth.value),
    scrollZoomSpeed: Number(els.scrollZoomSpeed.value),
    showCrosshair: els.showCrosshair.checked,
    showScaleBar: els.showScaleBar.checked,
    showStats: els.showStats.checked,
  }
}

function applySharedControlSettings(
  settings: ShareableViewState,
  applyWindow = true,
): void {
  els.layout.value = String(settings.layout)
  if (
    [...els.colormap.options].some(
      (option) => option.value === settings.colormap,
    )
  ) {
    els.colormap.value = settings.colormap
  }
  if (applyWindow) {
    els.windowLevel.value = String(settings.windowLevel)
    els.windowWidth.value = String(Math.max(1, settings.windowWidth))
  }
  els.scrollZoomSpeed.value = String(settings.scrollZoomSpeed)
  els.showCrosshair.checked = settings.showCrosshair
  els.showScaleBar.checked = settings.showScaleBar
  els.showStats.checked = settings.showStats
  syncWindowControlValues()
  syncScrollZoomSpeed()
}

function viewFromShareState(settings: ShareableViewState): ViewState {
  return {
    azimuth: settings.azimuth,
    elevation: settings.elevation,
    scale: settings.scale,
    crosshair: settings.crosshair,
    pan2D: settings.pan2D,
    renderPan: settings.renderPan,
  }
}

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return `${normalizedBase}${path.replace(/^\//, '')}`
}

function freshStats(): RangeStats {
  return {
    requested: new Set<string>(),
    completed: new Set<string>(),
    wireBytes: 0,
    decodedBytes: 0,
    rangeHits: 0,
    chunkObjectHits: 0,
    metadataHits: 0,
    cacheHits: 0,
    cacheBytes: 0,
    fullFileFallbacks: 0,
    failures: 0,
    lastRequests: [],
  }
}

function relativeUrl(baseUrl: string, relative: string): string {
  return new URL(relative, new URL(baseUrl, window.location.href)).toString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }
  if (bytes < 1024 * 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`
}

interface ExportGeometry {
  shape: Shape3
  spacing: Shape3
  origin: Shape3
  level: OmezarrLevel | null
}

function activeExportLevel(
  source: OmezarrSource,
  plan: ChunkPlan | null = currentPlan(),
): OmezarrLevel {
  const cropLevel =
    renderCropGeometry && plan === chunkPlan
      ? renderCropGeometry.level?.level
      : undefined
  const activeLevel = plan
    ? Math.min(
        ...plan.chunks.map((chunk) => cropLevel ?? chunk.sourceLevel ?? 0),
      )
    : source.baseLevel
  const level = source.levels[activeLevel]
  if (!level) throw new Error(`OME-Zarr level ${activeLevel} is unavailable`)
  return level
}

function currentFovGeometry(source: OmezarrSource): ExportGeometry {
  const level = activeExportLevel(source)
  const crop = fovCropGeometry(level, focusFraction, viewerZoom())
  return {
    shape: crop.shape,
    spacing: crop.spacing,
    origin: crop.origin,
    level,
  }
}

function currentMosaicFovGeometry(source: OmezarrMosaicSource): ExportGeometry {
  const level = source.blocks[0]?.level
  if (!level) throw new Error('The translated mosaic has no readable blocks')
  const crop = fovCropGeometry(
    { level: source.baseLevel, shape: source.shape, spacing: source.spacing },
    focusFraction,
    viewerZoom(),
  )
  return { shape: crop.shape, spacing: crop.spacing, origin: crop.origin, level }
}

function sourceExportGeometry(source: LoadedSource): ExportGeometry {
  if (source.kind === 'synthetic') {
    return {
      shape: source.shape,
      spacing: source.spacing,
      origin: [0, 0, 0],
      level: null,
    }
  }
  if (source.kind === 'omezarr-mosaic') return currentMosaicFovGeometry(source)
  return renderCropGeometry ?? currentFovGeometry(source)
}

function exportByteLength(source: LoadedSource): number {
  return geometryByteLength(source, sourceExportGeometry(source))
}

function geometryByteLength(
  source: LoadedSource,
  geometry: ExportGeometry,
): number {
  const { shape } = geometry
  return shape[0] * shape[1] * shape[2] * Math.ceil(source.numBitsPerVoxel / 8)
}

function syncDownloadControl(): void {
  const source = activeSource
  if (!source) {
    els.downloadNifti.disabled = true
    els.downloadNifti.textContent = 'download .nii'
    els.downloadNifti.title = 'Load a volume before downloading it'
    return
  }
  const bytes = exportByteLength(source)
  const geometry = sourceExportGeometry(source)
  const levelLabel = geometry.level ? ` L${geometry.level.level}` : ''
  els.downloadNifti.textContent = downloadInProgress
    ? `preparing${levelLabel}...`
    : `download FOV${levelLabel}.nii`
  els.downloadNifti.disabled = downloadInProgress
  els.downloadNifti.title =
    bytes > MAX_IN_MEMORY_NIFTI_BYTES
      ? `Stream the ${formatBytes(bytes)} FOV export to a selected file`
      : `Download the current FOV as a 3D NIfTI (${formatBytes(bytes)})`
}

function setDownloadStatus(message: string): void {
  els.downloadStatus.textContent = message
  els.downloadStatus.hidden = message.length === 0
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseWindow(fallback: DisplayWindow): DisplayWindow {
  const level = Number(els.windowLevel.value)
  const width = Number(els.windowWidth.value)
  if (!Number.isFinite(level) || !Number.isFinite(width) || width <= 0) {
    return fallback
  }
  return windowFromLevelWidth(level, width)
}

function formatIntensity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function syncWindowControlValues(): void {
  const win = windowFromLevelWidth(
    Number(els.windowLevel.value),
    Number(els.windowWidth.value),
  )
  const bounds = rangeBoundsForWindow(
    win,
    Number(els.windowMin.min) || 0,
    Number(els.windowMax.max) || 1,
  )
  els.windowMin.min = String(bounds.min)
  els.windowMax.min = String(bounds.min)
  els.windowMin.max = String(bounds.max)
  els.windowMax.max = String(bounds.max)
  els.windowLevel.min = String(bounds.min)
  els.windowLevel.max = String(bounds.max)
  const rangeMin = win.min
  const rangeMax = win.max
  const rangeSpan = bounds.max - bounds.min
  els.windowLevelValue.value = formatIntensity(Number(els.windowLevel.value))
  els.windowWidthValue.value = formatIntensity(Number(els.windowWidth.value))
  els.windowLevelValue.title = `Visible range ${win.min} to ${win.max}`
  els.windowWidthValue.title = `Visible range ${win.min} to ${win.max}`
  els.windowMin.value = String(rangeMin)
  els.windowMax.value = String(rangeMax)
  els.windowRangeValue.value = `${formatIntensity(rangeMin)}–${formatIntensity(rangeMax)}`
  els.windowRangeTrack.style.setProperty(
    '--range-start',
    `${((rangeMin - bounds.min) / rangeSpan) * 100}%`,
  )
  els.windowRangeTrack.style.setProperty(
    '--range-end',
    `${((rangeMax - bounds.min) / rangeSpan) * 100}%`,
  )
}

function setWindowControls(win: DisplayWindow, dtype: SupportedDtype): void {
  const dtypeMaximum = dtype === 'uint8' ? 255 : 65535
  const values = windowLevelWidth(win)
  const usefulMaximum = Math.min(
    dtypeMaximum,
    Math.max(dtype === 'uint8' ? 255 : 4095, values.width, win.max * 2),
  )
  const usefulMinimum = Math.min(0, win.min)
  els.windowLevel.min = String(usefulMinimum)
  els.windowLevel.max = String(usefulMaximum)
  els.windowWidth.max = String(usefulMaximum)
  els.windowMin.max = String(usefulMaximum)
  els.windowMax.max = String(usefulMaximum)
  els.windowMin.min = String(usefulMinimum)
  els.windowMax.min = String(usefulMinimum)
  els.windowLevel.value = String(values.level)
  els.windowWidth.value = String(values.width)
  syncWindowControlValues()
}

function prepareAutoWindow(source: LoadedSource): void {
  autoWindowSession = null
  if (source.kind === 'synthetic') return
  const currentWindow = parseWindow(source.defaultWindow)
  if (!isGenericDtypeWindow(source.dtype, currentWindow)) return
  autoWindowSession = {
    source,
    estimator: new IntensityWindowEstimator(source.dtype),
    manualRevision: manualWindowRevision,
    observedChunks: 0,
    lastMaximum: null,
  }
}

function observeChunkForAutoWindow(
  source: OmezarrSource | OmezarrMosaicSource,
  bytes: Uint8Array,
): void {
  const session = autoWindowSession
  if (
    !session ||
    session.source !== source ||
    session.manualRevision !== manualWindowRevision
  ) {
    return
  }
  session.observedChunks++
  const estimated = session.estimator.observe(bytes)
  if (estimated && estimated.max !== session.lastMaximum) {
    session.lastMaximum = estimated.max
    source.defaultWindow = estimated
    setWindowControls(estimated, source.dtype)
    window.setTimeout(() => {
      if (!nv || activeSource !== source || nv.volumes.length === 0) return
      void nv
        .setVolume(0, { calMin: estimated.min, calMax: estimated.max })
        .catch((error: unknown) => {
          showFallback(
            `Automatic contrast failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }, 0)
  }
  if (session.observedChunks >= AUTO_WINDOW_CHUNK_LIMIT) {
    autoWindowSession = null
  }
}

function handleWindowInput(): void {
  manualWindowRevision++
  autoWindowSession = null
  scheduleWindowUpdate()
}

function handleWindowRangeInput(changed: 'min' | 'max'): void {
  const lower = Number(els.windowMin.min) || 0
  const upper = Math.max(lower + 1, Number(els.windowMax.max) || 1)
  let min = Math.min(upper - 1, Math.max(lower, Number(els.windowMin.value)))
  let max = Math.min(upper, Math.max(lower + 1, Number(els.windowMax.value)))
  if (min >= max) {
    if (changed === 'min') min = Math.max(lower, max - 1)
    else max = Math.min(upper, min + 1)
  }
  const values = windowLevelWidth({ min, max })
  els.windowLevel.value = String(values.level)
  els.windowWidth.value = String(values.width)
  handleWindowInput()
}

function scheduleWindowUpdate(): void {
  syncWindowControlValues()
  window.clearTimeout(windowUpdateHandle)
  windowUpdateHandle = window.setTimeout(() => {
    const source = activeSource
    if (!nv || !source || nv.volumes.length === 0) return
    const win = parseWindow(source.defaultWindow)
    void nv
      .setVolume(0, { calMin: win.min, calMax: win.max })
      .catch((error: unknown) => {
        showFallback(
          `Window update failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }, 60)
}

function currentSourceKind(): SourceKind {
  return els.source.value === 'synthetic' ? 'synthetic' : 'omezarr'
}

function isOmezarrSourceId(value: string): value is OmezarrSourceId {
  return value === 'dandi' || value === 'custom'
}

function customStoreUrls(): string[] {
  const values = [...els.zarrUrls.querySelectorAll<HTMLInputElement>('input[type="url"]')]
    .map((input) => input.value.trim())
    .filter(Boolean)
  return [...new Set(values)]
}

function customProfile(rawUrl: string): OmezarrProfile {
  return {
    id: rawUrl || 'custom-omezarr',
    name: customStoreName(rawUrl),
    storeUrl: () => normalizeZarrStoreUrl(rawUrl),
    defaultLevel: 0,
    defaultWindow: { min: 0, max: 65535 },
    transportLabel: 'custom S3 OME-Zarr chunk objects',
    preferCoarsestLevel: true,
  }
}

function currentStoreUrls(): string[] {
  return els.source.value === 'dandi'
    ? selectedDandiStoreUrls
    : customStoreUrls()
}

function syncUrlRowControls(): void {
  const rows = [...els.zarrUrls.querySelectorAll<HTMLElement>('.zarr-url-row')]
  rows.forEach((row, index) => {
    const input = row.querySelector<HTMLInputElement>('input[type="url"]')
    if (input) input.setAttribute('aria-label', `OME-Zarr store URL ${index + 1}`)
    const remove = row.querySelector<HTMLButtonElement>('.remove-url-button')
    if (remove) {
      remove.hidden = false
      remove.disabled = rows.length === 1 && !input?.value.trim()
      remove.setAttribute('aria-label', `Remove OME-Zarr store ${index + 1}`)
    }
  })
}

function createStoreRemoveButton(
  accessibleLabel: string,
  onRemove: () => void,
): HTMLButtonElement {
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'remove-url-button'
  remove.textContent = 'Remove'
  remove.setAttribute('aria-label', accessibleLabel)
  remove.addEventListener('click', onRemove)
  return remove
}

async function reloadAfterStoreRemoval(): Promise<void> {
  updateUrlFromControls()
  if (currentStoreUrls().length > 0) {
    await reloadVolume({ reloadSource: true, preserveView: true })
    return
  }
  cancelMosaicLodReload()
  await disposeChunkedVolume()
  activeSource = null
  chunkPlan = null
  syncZarrLevelControl()
  syncActiveLodIndicator(null)
  syncDownloadControl()
  showFallback(
    els.source.value === 'dandi'
      ? 'Search DANDI and select an OME-Zarr asset, then press Load volume'
      : 'Add an OME-Zarr store URL, then press Load volume',
  )
}

function removeCustomUrlRow(row: HTMLElement, input: HTMLInputElement): void {
  const rows = [...els.zarrUrls.querySelectorAll<HTMLElement>('.zarr-url-row')]
  if (rows.length === 1) input.value = ''
  else row.remove()
  shouldInitializeCustomSource = true
  syncUrlRowControls()
  void reloadAfterStoreRemoval()
}

function addCustomUrlInput(value = ''): HTMLInputElement {
  const row = document.createElement('div')
  row.className = 'zarr-url-row'
  const input = document.createElement('input')
  input.type = 'url'
  input.inputMode = 'url'
  input.placeholder = 'https://example.org/image.ome.zarr'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = value
  const remove = createStoreRemoveButton('Remove OME-Zarr store', () => {
    removeCustomUrlRow(row, input)
  })
  input.addEventListener('input', () => {
    shouldInitializeCustomSource = true
    syncUrlRowControls()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    loadCustomSourceFromInput()
  })
  row.append(input, remove)
  els.zarrUrls.append(row)
  syncUrlRowControls()
  return input
}

function setCustomStoreUrls(urls: string[]): void {
  const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
  const rows = [...els.zarrUrls.querySelectorAll<HTMLElement>('.zarr-url-row')]
  for (const row of rows.slice(1)) row.remove()
  els.zarrUrl.value = uniqueUrls[0] ?? ''
  for (const url of uniqueUrls.slice(1)) addCustomUrlInput(url)
  shouldInitializeCustomSource = true
  syncUrlRowControls()
}

function syncDandiSelection(): void {
  const selected = els.dandiResults.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]:checked',
  ).length
  els.addDandiSelection.disabled = selected === 0
  els.addDandiSelection.textContent =
    selected === 0
      ? 'Add selected stores'
      : `Add ${selected} selected store${selected === 1 ? '' : 's'}`
}

function renderSelectedDandiStores(): void {
  els.dandiSelectedStores.replaceChildren()
  els.dandiSelectedStores.hidden = selectedDandiStoreUrls.length === 0
  if (selectedDandiStoreUrls.length === 0) return

  const heading = document.createElement('strong')
  heading.className = 'selected-store-heading'
  heading.textContent = 'Selected stores'
  els.dandiSelectedStores.append(heading)

  selectedDandiStoreUrls.forEach((storeUrl, index) => {
    const row = document.createElement('div')
    row.className = 'selected-store-row'
    const name = document.createElement('span')
    name.textContent = customStoreName(storeUrl)
    name.title = storeUrl
    const remove = createStoreRemoveButton(`Remove DANDI store ${index + 1}`, () => {
      selectedDandiStoreUrls = selectedDandiStoreUrls.filter(
        (selectedUrl) => selectedUrl !== storeUrl,
      )
      const matchingResult = [...els.dandiResults.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      )].find((input) => input.value === storeUrl)
      if (matchingResult) matchingResult.checked = false
      shouldInitializeCustomSource = true
      renderSelectedDandiStores()
      syncDandiSelection()
      els.dandiSearchStatus.value = 'Store removed. Updating the viewer…'
      void reloadAfterStoreRemoval().then(() => {
        els.dandiSearchStatus.value = 'Store removed.'
      })
    })
    row.append(name, remove)
    els.dandiSelectedStores.append(row)
  })
}

function renderDandiResults(assets: DandiZarrAsset[]): void {
  els.dandiResults.replaceChildren()
  for (const asset of assets) {
    const label = document.createElement('label')
    label.className = 'dandi-result'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = asset.storeUrl
    checkbox.addEventListener('change', syncDandiSelection)
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = asset.path.split('/').at(-1) ?? asset.path
    const metadata = document.createElement('small')
    metadata.textContent = `${formatBytes(asset.size)} · ${asset.path}`
    copy.append(title, metadata)
    label.append(checkbox, copy)
    els.dandiResults.append(label)
  }
  syncDandiSelection()
}

async function searchDandiAssets(): Promise<void> {
  dandiSearchController?.abort()
  const controller = new AbortController()
  dandiSearchController = controller
  els.searchDandi.disabled = true
  els.dandiSearchStatus.value = 'Searching DANDI…'
  els.dandiResults.replaceChildren()
  syncDandiSelection()
  try {
    const result = await searchDandiZarrAssets(
      els.dandisetId.value.trim(),
      els.dandiVersion.value.trim(),
      els.dandiQuery.value,
      { signal: controller.signal },
    )
    if (controller.signal.aborted) return
    renderDandiResults(result.assets)
    els.dandiSearchStatus.value =
      result.count === 0
        ? 'No matching OME-Zarr assets.'
        : `Showing ${result.assets.length} of ${result.count.toLocaleString()} matching OME-Zarr assets.`
  } catch (error) {
    if (controller.signal.aborted) return
    els.dandiSearchStatus.value =
      error instanceof Error ? error.message : String(error)
  } finally {
    if (dandiSearchController === controller) {
      dandiSearchController = null
      els.searchDandi.disabled = false
    }
  }
}

function addSelectedDandiAssets(): void {
  const selectedUrls = [
    ...els.dandiResults.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:checked',
    ),
  ].map((input) => input.value)
  if (selectedUrls.length === 0) return
  selectedDandiStoreUrls = [...new Set([...selectedDandiStoreUrls, ...selectedUrls])]
  shouldInitializeCustomSource = true
  renderSelectedDandiStores()
  updateUrlFromControls()
  els.dandiSearchStatus.value = `${selectedUrls.length} store${selectedUrls.length === 1 ? '' : 's'} selected. Press Load volume when ready.`
}

function normalizeZarrStoreUrl(rawUrl: string): string {
  if (!rawUrl) {
    throw new Error('Paste an S3 OME-Zarr store URL before loading')
  }
  const parsed = new URL(rawUrl)
  if (parsed.protocol === 's3:') {
    if (!parsed.hostname) throw new Error('The S3 URL is missing a bucket name')
    parsed.protocol = 'https:'
    parsed.hostname = `${parsed.hostname}.s3.amazonaws.com`
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The Zarr URL must use https://, http://, or s3://')
  }
  parsed.pathname = parsed.pathname.replace(
    /\/(?:\.zattrs|\.zgroup|\.zmetadata|zarr\.json)$/,
    '',
  )
  return parsed.toString().replace(/\/$/, '')
}

function customStoreName(rawUrl: string): string {
  if (!rawUrl) return 'Custom S3 OME-Zarr'
  try {
    const parts = new URL(rawUrl).pathname.split('/').filter(Boolean)
    return decodeURIComponent(parts.at(-1) ?? 'Custom S3 OME-Zarr')
  } catch {
    return 'Custom S3 OME-Zarr'
  }
}

function showFallback(message: string): void {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function hideFallback(): void {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

function syncSourceControls(): void {
  const isOmezarr = currentSourceKind() === 'omezarr'
  els.activeLevelControl.hidden = !isOmezarr
  if (!isOmezarr) {
    els.activeLevel.value = ''
    els.activeLevel.removeAttribute('data-levels')
  } else if (
    activeSource?.kind !== 'omezarr' &&
    activeSource?.kind !== 'omezarr-mosaic'
  ) {
    setActiveLodLoading()
  }
  els.dandiArchiveControl.hidden = els.source.value !== 'dandi'
  els.zarrUrlControl.hidden = els.source.value !== 'custom'
  syncZarrLevelControl()
}

function pyramidLevels(source: LoadedSource | null): OmezarrLevel[] {
  if (source?.kind === 'omezarr') return source.levels
  if (source?.kind === 'omezarr-mosaic') {
    return source.blocks[0]?.source.levels ?? []
  }
  return []
}

function syncZarrLevelControl(): void {
  const isOmezarr = currentSourceKind() === 'omezarr'
  els.zarrLevelControl.hidden = !isOmezarr
  const levels = pyramidLevels(activeSource)
  const options = [new Option('Auto — adapt while zooming', 'auto')]
  for (const level of levels) {
    const suffix =
      level.level === 0
        ? ' — finest'
        : level.level === levels.length - 1
          ? ' — overview'
          : ''
    options.push(new Option(`L${level.level}${suffix}`, String(level.level)))
  }
  els.zarrLevel.replaceChildren(...options)
  const fixedIsAvailable =
    fixedZarrLevel !== null && levels.some((level) => level.level === fixedZarrLevel)
  els.zarrLevel.value = fixedIsAvailable ? String(fixedZarrLevel) : 'auto'
  els.zarrLevel.disabled = !isOmezarr || levels.length === 0
}

function setDefaultWindowForSelectedSource(): void {
  setWindowControls({ min: 24, max: 210 }, 'uint8')
  if (currentSourceKind() === 'omezarr') {
    setWindowControls({ min: 0, max: 65535 }, 'uint16')
  }
}

function initControlsFromUrl(): void {
  const params = new URLSearchParams(window.location.search)
  const requestedSource = params.get('source')
  if (requestedSource && isOmezarrSourceId(requestedSource)) {
    els.source.value = requestedSource
  }
  const storeUrls = params.getAll('url').filter(Boolean)
  if (storeUrls.length > 0) {
    if (els.source.value === 'dandi') {
      selectedDandiStoreUrls = [...new Set(storeUrls)]
      renderSelectedDandiStores()
    } else {
      els.source.value = 'custom'
      setCustomStoreUrls(storeUrls)
    }
  }
  els.dandisetId.value = params.get('dandiset') || '000108'
  els.dandiVersion.value = params.get('dandiVersion') || 'draft'
  els.dandiQuery.value = params.get('dandiQuery') || ''
  const level = params.get('level')
  if (level && /^\d+$/.test(level)) {
    requestedBaseLevel = Number(level)
  } else if (currentSourceKind() === 'omezarr') {
    requestedBaseLevel = null
  }
  const zarrLevel = params.get('zarrLevel')
  if (zarrLevel && /^\d+$/.test(zarrLevel)) {
    fixedZarrLevel = Number(zarrLevel)
    requestedBaseLevel = fixedZarrLevel
  }
  setDefaultWindowForSelectedSource()
  const shareKeys = [
    'layout',
    'zoom',
    'pan',
    'crosshair',
    'azimuth',
    'elevation',
    'scale',
    'renderPan',
    'colormap',
    'wl',
    'ww',
    'scrollZoomSpeed',
    'crosshairVisible',
    'scaleBar',
    'stats',
  ]
  if (shareKeys.some((key) => params.has(key))) {
    initialSharedSettings = readShareState(params, defaultShareState())
    applySharedControlSettings(initialSharedSettings)
    initialSharedView = viewFromShareState(initialSharedSettings)
  }
  syncSourceControls()
}

function updateUrlFromControls(): void {
  const url = new URL(window.location.href)
  const kind = currentSourceKind()
  url.searchParams.set('source', els.source.value)
  if (kind === 'omezarr') {
    const level = requestedBaseLevel ?? 0
    url.searchParams.set('level', String(level))
    if (fixedZarrLevel === null) {
      url.searchParams.delete('zarrLevel')
    } else {
      url.searchParams.set('zarrLevel', String(fixedZarrLevel))
    }
  } else {
    url.searchParams.delete('level')
    url.searchParams.delete('zarrLevel')
  }
  url.searchParams.delete('url')
  if (kind === 'omezarr') {
    for (const storeUrl of currentStoreUrls()) url.searchParams.append('url', storeUrl)
  }
  if (els.source.value === 'dandi') {
    url.searchParams.set('dandiset', els.dandisetId.value.trim() || '000108')
    url.searchParams.set('dandiVersion', els.dandiVersion.value.trim() || 'draft')
    if (els.dandiQuery.value.trim()) {
      url.searchParams.set('dandiQuery', els.dandiQuery.value.trim())
    } else {
      url.searchParams.delete('dandiQuery')
    }
  } else {
    url.searchParams.delete('dandiset')
    url.searchParams.delete('dandiVersion')
    url.searchParams.delete('dandiQuery')
  }
  window.history.replaceState(null, '', url)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

async function fetchManifest(): Promise<RangeManifest> {
  return fetchJson<RangeManifest>(MANIFEST_URL)
}

async function fetchByteRange(
  url: string,
  start: number,
  length: number,
): Promise<Uint8Array> {
  const end = start + length - 1
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  })
  if (!res.ok) {
    stats.failures++
    throw new Error(`GET ${url} range ${start}-${end} -> ${res.status}`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  stats.wireBytes += bytes.byteLength

  if (res.status === 206) {
    stats.rangeHits++
    if (bytes.byteLength !== length) {
      stats.failures++
      throw new Error(
        `range ${start}-${end} returned ${bytes.byteLength}B, expected ${length}B`,
      )
    }
    recordRequest(`206 ${start}-${end}`)
    return bytes
  }

  stats.fullFileFallbacks++
  if (bytes.byteLength < end + 1) {
    stats.failures++
    throw new Error(
      `full response had ${bytes.byteLength}B, cannot slice ${start}-${end}`,
    )
  }
  recordRequest(`200 ${start}-${end}`)
  return bytes.slice(start, end + 1)
}

function recordRequest(label: string): void {
  stats.lastRequests.unshift(label)
  if (stats.lastRequests.length > 5) stats.lastRequests.pop()
}

function createTrackedZarrFetch(): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const response = await fetch(request)
    const method = request.method || 'GET'
    const url = new URL(response.url || request.url)
    const pathname = url.pathname
    const range = request.headers.get('Range')
    const contentLength = Number(response.headers.get('Content-Length') ?? 0)

    if (
      method !== 'HEAD' &&
      Number.isFinite(contentLength) &&
      contentLength > 0
    ) {
      stats.wireBytes += contentLength
    }
    if (response.status === 206) {
      stats.rangeHits++
    } else if (response.status === 200 && method !== 'HEAD') {
      if (isZarrMetadataPath(pathname)) {
        stats.metadataHits++
      } else {
        stats.chunkObjectHits++
      }
    }
    if (!response.ok && response.status !== 404) {
      stats.failures++
    }

    recordRequest(
      `${response.status}${range ? ` ${range.replace(/^bytes=/, '')}` : ''} ${shortZarrPath(pathname)}`,
    )
    renderHud()
    return response
  }
}

function isZarrMetadataPath(pathname: string): boolean {
  return (
    pathname.endsWith('/zarr.json') ||
    pathname.endsWith('/.zarray') ||
    pathname.endsWith('/.zattrs') ||
    pathname.endsWith('/.zgroup') ||
    pathname.endsWith('/.zmetadata')
  )
}

function shortZarrPath(pathname: string): string {
  const marker = '/zarr/'
  const idx = pathname.indexOf(marker)
  if (idx >= 0) return pathname.slice(idx + marker.length)
  return pathname.split('/').filter(Boolean).slice(-5).join('/')
}

function multiscalesFromAttrs(attrs: OmezarrRootAttributes): NgffMultiscale[] {
  return attrs.ome?.multiscales ?? attrs.multiscales ?? []
}

function unitToMm(unit: string | undefined): number {
  switch (unit?.toLowerCase()) {
    case 'angstrom':
      return 1e-7
    case 'nanometer':
      return 1e-6
    case 'micrometer':
    case 'micron':
      return 1e-3
    case 'centimeter':
      return 10
    case 'meter':
      return 1000
    default:
      return 1
  }
}

function transformFromDataset(
  dataset: NgffDataset,
  multiscale: NgffMultiscale,
): { spacing: Shape3; translation: Shape3 } {
  const axisUnits = multiscale.axes?.map((axis) => unitToMm(axis.unit)) ?? []
  return spatialTransformMm(
    [
      dataset.coordinateTransformations,
      multiscale.coordinateTransformations,
    ],
    axisUnits,
  )
}

function trailingSpatial(
  nums: number[],
  label: string,
): [number, number, number] {
  if (nums.length < 3) {
    throw new Error(`${label} has ${nums.length} dimension(s), expected 3D`)
  }
  const spatial = nums.slice(-3)
  return [spatial[0], spatial[1], spatial[2]]
}

function assertSupportedDtype(dtype: string): SupportedDtype {
  if (dtype === 'uint8' || dtype === 'uint16') return dtype
  throw new Error(`OME-Zarr dtype '${dtype}' is not supported by this demo`)
}

async function loadSyntheticSource(): Promise<RangeSource> {
  const manifest = await fetchManifest()
  const dtypeInfo = niftiDatatype(manifest.dtype)
  return {
    kind: 'synthetic',
    id: manifest.id,
    name: manifest.name,
    shape: manifest.shape,
    spacing: manifest.spacing,
    dtype: manifest.dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow: { min: 24, max: 210 },
    chunkGrid: manifest.chunkGrid,
    chunkShape: manifest.chunkShape,
    chunkCount: manifest.chunkCount,
    sourceUrl: manifest.dataUrl,
    transportLabel: 'single shard + HTTP Range',
    dataUrl: relativeUrl(MANIFEST_URL, manifest.dataUrl),
    chunkBytes: manifest.chunkBytes,
  }
}

async function openOmezarrSource(
  profile: OmezarrProfile,
  requestedLevelInput: number | null,
  initializeWindow: boolean,
): Promise<OmezarrSource> {
  const isInitialCustomLoad = initializeWindow
  const storeUrl = profile.storeUrl()
  const baseStore = new zarr.FetchStore(storeUrl, {
    fetch: createTrackedZarrFetch(),
  })
  const store = zarr.withByteCaching(withInflightReadDeduplication(baseStore), {
    cache: new ByteLruCache(ZARR_BYTE_CACHE_BYTES),
  })
  const root = zarr.root(store)
  const group = await zarr.open(root, { kind: 'group' })
  const attrs = group.attrs as OmezarrRootAttributes
  const multiscale = multiscalesFromAttrs(attrs)[0]
  const levelCount = multiscale?.datasets?.length ?? 0
  const requestedLevel =
    requestedLevelInput ??
    (profile.preferCoarsestLevel ? levelCount - 1 : profile.defaultLevel)
  const level = Number.isInteger(requestedLevel)
    ? Math.min(Math.max(requestedLevel, 0), Math.max(levelCount - 1, 0))
    : profile.defaultLevel
  const datasets = multiscale?.datasets
  const dataset = datasets?.[level]
  if (!dataset || !datasets) {
    throw new Error(`OME-Zarr level ${level} not found in ${profile.id}`)
  }

  const levels = await Promise.all(
    datasets.map(async (levelDataset, levelIndex): Promise<OmezarrLevel> => {
      const array = await zarr.open(root.resolve(`/${levelDataset.path}`), {
        kind: 'array',
      })
      const [shapeZ, shapeY, shapeX] = trailingSpatial(array.shape, 'shape')
      const [chunkZ, chunkY, chunkX] = trailingSpatial(array.chunks, 'chunks')
      const shape: Shape3 = [shapeX, shapeY, shapeZ]
      const chunkShape: Shape3 = [chunkX, chunkY, chunkZ]
      const chunkGrid: Shape3 = [
        Math.ceil(shape[0] / chunkShape[0]),
        Math.ceil(shape[1] / chunkShape[1]),
        Math.ceil(shape[2] / chunkShape[2]),
      ]
      const transform = transformFromDataset(levelDataset, multiscale)
      return {
        level: levelIndex,
        path: levelDataset.path,
        array,
        shape,
        spacing: transform.spacing,
        translation: transform.translation,
        chunkGrid,
        chunkShape,
      }
    }),
  )
  const selected = levels[level]
  const finest = levels[0]
  if (!selected || !finest) {
    throw new Error(`OME-Zarr pyramid ${profile.id} has no readable levels`)
  }
  const dtype = assertSupportedDtype(finest.array.dtype)
  for (const pyramidLevel of levels) {
    if (pyramidLevel.array.dtype !== dtype) {
      throw new Error(
        `OME-Zarr level ${pyramidLevel.level} uses ${pyramidLevel.array.dtype}; all levels must use ${dtype}`,
      )
    }
  }
  const dtypeInfo = niftiDatatype(dtype)
  const defaultWindow = isInitialCustomLoad
    ? { min: dtypeInfo.displayMin, max: dtypeInfo.displayMax }
    : profile.defaultWindow
  if (isInitialCustomLoad) {
    setWindowControls(defaultWindow, dtype)
    shouldInitializeCustomSource = false
  }
  return {
    kind: 'omezarr',
    id: profile.id,
    name: profile.name,
    shape: finest.shape,
    spacing: finest.spacing,
    dtype,
    datatypeCode: dtypeInfo.code,
    numBitsPerVoxel: dtypeInfo.bits,
    defaultWindow,
    chunkGrid: selected.chunkGrid,
    chunkShape: selected.chunkShape,
    chunkCount:
      selected.chunkGrid[0] * selected.chunkGrid[1] * selected.chunkGrid[2],
    sourceUrl: storeUrl,
    transportLabel: profile.transportLabel,
    baseLevel: level,
    levels,
  }
}

async function loadOmezarrSource(): Promise<OmezarrSource | OmezarrMosaicSource> {
  const profiles = currentStoreUrls().map(customProfile)
  if (profiles.length === 0) {
    throw new Error(
      els.source.value === 'dandi'
        ? 'Search DANDI and select at least one OME-Zarr asset before loading'
        : 'Add at least one OME-Zarr store URL before loading',
    )
  }
  const initializeWindow = shouldInitializeCustomSource
  const first = await openOmezarrSource(
    profiles[0] as OmezarrProfile,
    requestedBaseLevel,
    initializeWindow,
  )
  requestedBaseLevel = first.baseLevel
  if (fixedZarrLevel !== null) fixedZarrLevel = first.baseLevel
  updateUrlFromControls()
  shouldInitializeCustomSource = false
  if (profiles.length === 1) return first
  const rest = await Promise.all(
    profiles.slice(1).map((profile) =>
      openOmezarrSource(profile, first.baseLevel, false),
    ),
  )
  const sources = [first, ...rest]
  for (const source of sources) {
    if (source.dtype !== first.dtype) {
      throw new Error(
        `Store ${source.id} uses ${source.dtype}; all translated stores must use ${first.dtype}`,
      )
    }
  }
  const levels = sources.map((source) => {
    const level = source.levels[first.baseLevel]
    if (!level) {
      throw new Error(`Store ${source.id} has no pyramid level ${first.baseLevel}`)
    }
    return { source, level }
  })
  const layout = layoutTranslatedBlocks(
    levels.map(({ source, level }) => ({
      id: source.id,
      shape: level.shape,
      spacing: level.spacing,
      translation: level.translation,
    })),
  )
  const grid = renderCropGrid(
    layout.shape,
    STREAMING_CHUNK_EDGE,
    STREAMING_CHUNK_HALO,
  )
  const blocks = layout.blocks.map((block, index): OmezarrMosaicBlock => {
    const sourceLevel = levels[index]
    if (!sourceLevel) throw new Error('Translated store layout is incomplete')
    return { ...block, source: sourceLevel.source, level: sourceLevel.level }
  })
  return {
    kind: 'omezarr-mosaic',
    id: `translated-${sources.length}-store-mosaic`,
    name: `${sources.length}-store translated OME-Zarr mosaic`,
    shape: layout.shape,
    spacing: layout.spacing,
    dtype: first.dtype,
    datatypeCode: first.datatypeCode,
    numBitsPerVoxel: first.numBitsPerVoxel,
    defaultWindow: first.defaultWindow,
    chunkGrid: grid,
    chunkShape: layout.shape.map((size, axis) =>
      Math.ceil(size / grid[axis]),
    ) as Shape3,
    chunkCount: grid[0] * grid[1] * grid[2],
    sourceUrl: sources.map((source) => source.sourceUrl).join(' + '),
    transportLabel: `${sources.length} translated OME-Zarr stores`,
    baseLevel: first.baseLevel,
    worldOrigin: layout.worldOrigin,
    blocks,
  }
}

async function loadActiveSource(): Promise<LoadedSource> {
  return currentSourceKind() === 'omezarr'
    ? loadOmezarrSource()
    : loadSyntheticSource()
}

function createChunkPlan(source: RangeSource): ChunkPlan {
  const plan = chunkVolumeGrid(
    source.shape,
    source.chunkGrid,
    Math.max(...source.chunkShape),
    [0, 0, 0],
  )
  if (plan.chunks.length !== source.chunkCount) {
    throw new Error(
      `chunk plan produced ${plan.chunks.length} chunks, source has ${source.chunkCount}`,
    )
  }
  return plan
}

function createRangeChunkSource(source: RangeSource): VolumeChunkSource {
  const cache = new Map<number, Promise<Uint8Array>>()
  return (request) => {
    const cached = cache.get(request.chunkIndex)
    if (cached) return cached

    const desc = request.desc
    const requestedBytes =
      desc.texDims[0] *
      desc.texDims[1] *
      desc.texDims[2] *
      request.bytesPerVoxel
    if (requestedBytes !== source.chunkBytes) {
      throw new Error(
        `chunk ${request.chunkIndex} asks for ${requestedBytes}B, fixture chunks are ${source.chunkBytes}B`,
      )
    }

    const requestKey = rangeRequestKey(request.chunkIndex)
    stats.requested.add(requestKey)
    const start = request.chunkIndex * source.chunkBytes
    const next = fetchByteRange(source.dataUrl, start, source.chunkBytes).then(
      (bytes) => {
        stats.completed.add(requestKey)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      },
    )
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
}

function rangeRequestKey(chunkIndex: number): string {
  return `range:${chunkIndex}`
}

function omezarrRequestKey(
  levelIndex: number,
  texOrigin: Shape3,
  texDims: Shape3,
): string {
  return `zarr:${levelIndex}:${texOrigin.join(',')}:${texDims.join(',')}`
}

async function fetchOmezarrRegion(
  level: OmezarrLevel,
  request: ChunkedVolumeFetch,
): Promise<Uint8Array> {
  const [x0, y0, z0] = request.texOrigin
  const [sx, sy, sz] = request.texDims
  const selection: Array<number | zarr.Slice> = []
  for (let i = 0; i < level.array.shape.length - 3; i++) selection.push(0)
  selection.push(zarr.slice(z0, z0 + sz))
  selection.push(zarr.slice(y0, y0 + sy))
  selection.push(zarr.slice(x0, x0 + sx))

  const view = await zarr.get(level.array, selection)
  const bytes = bytesFromZarrView(view)
  const expectedBytes = sx * sy * sz * request.bytesPerVoxel
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `OME-Zarr L${level.level} region ${request.texOrigin.join(',')} returned ${bytes.byteLength}B, expected ${expectedBytes}B`,
    )
  }
  return bytes
}

function mosaicRequestKey(
  source: OmezarrMosaicSource,
  origin: Shape3,
  dims: Shape3,
): string {
  return `mosaic:${source.baseLevel}:${origin.join(',')}:${dims.join(',')}`
}

async function fetchMosaicRegion(
  source: OmezarrMosaicSource,
  origin: Shape3,
  dims: Shape3,
  bytesPerVoxel: number,
): Promise<Uint8Array> {
  const fetched = await Promise.all(
    source.blocks.map(async (block): Promise<FetchedMosaicBlock | null> => {
      const window = mosaicSamplingWindow(
        block.voxelOrigin,
        block.shape,
        origin,
        dims,
      )
      if (!window) return null
      const bytes = await fetchOmezarrRegion(block.level, {
        levelIndex: block.level.level,
        texOrigin: window.sourceOrigin,
        texDims: window.sourceDims,
        bytesPerVoxel,
      })
      return {
        voxelOrigin: block.voxelOrigin,
        shape: block.shape,
        ...window,
        bytes,
      }
    }),
  )
  return compositeMosaicBlocks(
    origin,
    dims,
    bytesPerVoxel,
    fetched.filter((block): block is FetchedMosaicBlock => block !== null),
  )
}

function createMosaicVolume(
  source: OmezarrMosaicSource,
): { volume: NVImage; plan: ChunkPlan } {
  const plan = chunkVolumeGrid(
    source.shape,
    source.chunkGrid,
    STREAMING_CHUNK_EDGE,
    STREAMING_CHUNK_HALO,
  )
  const win = parseWindow(source.defaultWindow)
  const volume = buildLogicalVolume({
    id: source.name,
    url: `client-zarr-mosaic://${source.id}?level=${source.baseLevel}`,
    shape: source.shape,
    spacing: source.spacing,
    origin: source.worldOrigin,
    datatypeCode: source.datatypeCode,
    numBitsPerVoxel: source.numBitsPerVoxel,
    calMin: win.min,
    calMax: win.max,
    colormap: els.colormap.value,
    chunkSource: async (request) => {
      const origin = request.desc.texOrigin
      const dims = request.desc.texDims
      const key = mosaicRequestKey(source, origin, dims)
      stats.requested.add(key)
      renderHud()
      try {
        const bytes = await fetchMosaicRegion(
          source,
          origin,
          dims,
          request.bytesPerVoxel,
        )
        observeChunkForAutoWindow(source, bytes)
        stats.completed.add(key)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      } catch (error) {
        stats.failures++
        renderHud()
        throw error
      }
    },
  })
  volume.chunkPlan = plan
  volume.chunkExplode = { enabled: false }
  return { volume, plan }
}

function createOmezarrPyramidSource(
  source: OmezarrSource,
): ChunkedVolumeSource {
  return {
    datatypeCode: source.datatypeCode,
    levels: source.levels.map((level) => ({
      level: level.level,
      shape: level.shape,
      spacing: level.spacing,
    })),
    fetchChunk: async (request) => {
      const level = source.levels[request.levelIndex]
      if (!level) {
        throw new Error(
          `OME-Zarr pyramid level ${request.levelIndex} is missing`,
        )
      }
      const key = omezarrRequestKey(
        request.levelIndex,
        request.texOrigin,
        request.texDims,
      )
      stats.requested.add(key)
      renderHud()
      try {
        const bytes = await fetchOmezarrRegion(level, request)
        observeChunkForAutoWindow(source, bytes)
        stats.completed.add(key)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      } catch (err) {
        stats.failures++
        renderHud()
        throw err
      }
    },
  }
}

function createOmezarrRenderCropVolume(
  source: OmezarrSource,
  geometry: ExportGeometry,
): { volume: NVImage; plan: ChunkPlan } {
  const level = geometry.level
  if (!level) throw new Error('The 3D render crop level is unavailable')
  const grid = renderCropGrid(
    geometry.shape,
    STREAMING_CHUNK_EDGE,
    STREAMING_CHUNK_HALO,
  )
  const plan = chunkVolumeGrid(
    geometry.shape,
    grid,
    STREAMING_CHUNK_EDGE,
    STREAMING_CHUNK_HALO,
  )
  const win = parseWindow(source.defaultWindow)
  const volume = buildLogicalVolume({
    id: `${source.name} current FOV L${level.level}`,
    url:
      `client-zarr-crop://${source.id}/L${level.level}` +
      `/${geometry.origin.join(',')}/${geometry.shape.join(',')}` +
      `?cm=${encodeURIComponent(els.colormap.value)}` +
      `&w=${win.min}-${win.max}`,
    shape: geometry.shape,
    spacing: geometry.spacing,
    datatypeCode: source.datatypeCode,
    numBitsPerVoxel: source.numBitsPerVoxel,
    calMin: win.min,
    calMax: win.max,
    colormap: els.colormap.value,
    chunkSource: async (request) => {
      const texOrigin = absoluteCropOrigin(
        geometry.origin,
        request.desc.texOrigin,
      )
      const texDims = request.desc.texDims
      const key = omezarrRequestKey(level.level, texOrigin, texDims)
      stats.requested.add(key)
      renderHud()
      try {
        const bytes = await fetchOmezarrRegion(level, {
          levelIndex: level.level,
          texOrigin,
          texDims,
          bytesPerVoxel: request.bytesPerVoxel,
        })
        observeChunkForAutoWindow(source, bytes)
        stats.completed.add(key)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      } catch (error) {
        stats.failures++
        renderHud()
        throw error
      }
    },
  })
  volume.chunkPlan = plan
  volume.chunkExplode = { enabled: false }
  return { volume, plan }
}

function bytesFromZarrView(view: unknown): Uint8Array {
  if (typeof view !== 'object' || view === null || !('data' in view)) {
    throw new Error('OME-Zarr selection returned a scalar instead of a chunk')
  }
  const data = (view as { data: unknown }).data
  if (!ArrayBuffer.isView(data)) {
    throw new Error('OME-Zarr chunk data is not buffer-backed')
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

async function readOmezarrGeometry(
  source: OmezarrSource,
  geometry: ExportGeometry,
): Promise<Uint8Array> {
  const level = geometry.level
  if (!level) throw new Error('The OME-Zarr export level is unavailable')
  const selection: Array<number | zarr.Slice> = []
  for (let i = 0; i < level.array.shape.length - 3; i++) selection.push(0)
  const [originX, originY, originZ] = geometry.origin
  const [shapeX, shapeY, shapeZ] = geometry.shape
  selection.push(zarr.slice(originZ, originZ + shapeZ))
  selection.push(zarr.slice(originY, originY + shapeY))
  selection.push(zarr.slice(originX, originX + shapeX))
  setDownloadStatus(`Fetching L${level.level} voxels...`)
  const view = await zarr.get(level.array, selection)
  const bytes = bytesFromZarrView(view)
  const expectedBytes = geometryByteLength(source, geometry)
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `OME-Zarr L${level.level} returned ${formatBytes(bytes.byteLength)}, expected ${formatBytes(expectedBytes)}`,
    )
  }
  return bytes.slice()
}

async function readMosaicGeometry(
  source: OmezarrMosaicSource,
  geometry: ExportGeometry,
): Promise<Uint8Array> {
  setDownloadStatus(
    `Fetching translated L${source.baseLevel} field of view...`,
  )
  return fetchMosaicRegion(
    source,
    geometry.origin,
    geometry.shape,
    source.numBitsPerVoxel / 8,
  )
}

async function readWholeRangeSource(source: RangeSource): Promise<Uint8Array> {
  const output = new Uint8Array(
    source.shape[0] * source.shape[1] * source.shape[2],
  )
  const plan = createChunkPlan(source)
  const sliceStride = source.shape[0] * source.shape[1]
  for (let chunkIndex = 0; chunkIndex < plan.chunks.length; chunkIndex++) {
    const chunk = plan.chunks[chunkIndex]
    if (!chunk) continue
    setDownloadStatus(
      `Fetching chunk ${chunkIndex + 1} of ${plan.chunks.length}...`,
    )
    const bytes = await fetchByteRange(
      source.dataUrl,
      chunkIndex * source.chunkBytes,
      source.chunkBytes,
    )
    const [originX, originY, originZ] = chunk.texOrigin
    const [sizeX, sizeY, sizeZ] = chunk.texDims
    for (let z = 0; z < sizeZ; z++) {
      for (let y = 0; y < sizeY; y++) {
        const sourceOffset = (z * sizeY + y) * sizeX
        const destinationOffset =
          (originZ + z) * sliceStride +
          (originY + y) * source.shape[0] +
          originX
        output.set(
          bytes.subarray(sourceOffset, sourceOffset + sizeX),
          destinationOffset,
        )
      }
    }
  }
  return output
}

function niftiFilename(source: LoadedSource, geometry: ExportGeometry): string {
  const cleanId = source.id
    .replace(/\.ome\.zarr$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  const levelSuffix = geometry.level ? `-L${geometry.level.level}` : ''
  return `${cleanId || 'volume'}${levelSuffix}-fov.nii`
}

function downloadBuffer(buffer: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([buffer], { type: 'application/octet-stream' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

interface WritableNiftiFile {
  write(
    data: Uint8Array | { type: 'write'; position: number; data: Uint8Array },
  ): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

interface NiftiFileHandle {
  createWritable(): Promise<WritableNiftiFile>
}

interface NiftiPickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: Array<{
      description: string
      accept: Record<string, string[]>
    }>
  }) => Promise<NiftiFileHandle>
}

async function niftiHeader(
  source: LoadedSource,
  geometry: ExportGeometry,
): Promise<Uint8Array> {
  const win = parseWindow(source.defaultWindow)
  const volume = buildLogicalVolume({
    id: source.name,
    url: source.sourceUrl,
    shape: geometry.shape,
    spacing: geometry.spacing,
    origin:
      source.kind === 'omezarr-mosaic'
        ? geometry.origin.map(
            (value, axis) =>
              source.worldOrigin[axis] + value * geometry.spacing[axis],
          ) as Shape3
        : undefined,
    datatypeCode: source.datatypeCode,
    numBitsPerVoxel: source.numBitsPerVoxel,
    calMin: win.min,
    calMax: win.max,
    colormap: els.colormap.value,
    img: null,
  })
  if (source.kind !== 'omezarr-mosaic') {
    for (let axis = 0; axis < 3; axis++) {
      const row = volume.hdr.affine[axis]
      if (row) row[3] = geometry.origin[axis] * geometry.spacing[axis]
    }
  }
  return new Uint8Array(
    await writeVolume('header.nii', volume.hdr, new ArrayBuffer(0)),
  )
}

async function saveInMemoryNifti(
  source: LoadedSource,
  geometry: ExportGeometry,
  imageBytes: Uint8Array,
  filename: string,
): Promise<void> {
  const header = await niftiHeader(source, geometry)
  const nifti = new Uint8Array(header.byteLength + imageBytes.byteLength)
  nifti.set(header)
  nifti.set(imageBytes, header.byteLength)
  downloadBuffer(nifti.buffer as ArrayBuffer, filename)
}

async function pickWritableFile(filename: string): Promise<WritableNiftiFile> {
  const picker = (window as NiftiPickerWindow).showSaveFilePicker
  if (!picker) {
    throw new Error(
      'This export is too large for memory and needs a browser with Save File Picker support',
    )
  }
  const handle = await picker.call(window, {
    suggestedName: filename,
    types: [
      {
        description: 'NIfTI volume',
        accept: { 'application/octet-stream': ['.nii'] },
      },
    ],
  })
  return handle.createWritable()
}

async function streamUniformOmezarr(
  source: OmezarrSource | OmezarrMosaicSource,
  geometry: ExportGeometry,
  filename: string,
): Promise<void> {
  const level = geometry.level
  if (!level) throw new Error('The OME-Zarr export level is unavailable')
  const writable = await pickWritableFile(filename)
  try {
    const header = await niftiHeader(source, geometry)
    const totalBytes = header.byteLength + geometryByteLength(source, geometry)
    await writable.truncate(totalBytes)
    await writable.write({ type: 'write', position: 0, data: header })
    const planeBytes =
      geometry.shape[0] * geometry.shape[1] * (source.numBitsPerVoxel / 8)
    const slabDepth = Math.max(1, Math.floor((32 * 1024 * 1024) / planeBytes))
    let position = header.byteLength
    for (let z = 0; z < geometry.shape[2]; z += slabDepth) {
      const depth = Math.min(slabDepth, geometry.shape[2] - z)
      setDownloadStatus(`Writing slice ${z + 1} of ${geometry.shape[2]}...`)
      const slabGeometry: ExportGeometry = {
        shape: [geometry.shape[0], geometry.shape[1], depth],
        spacing: geometry.spacing,
        origin: [
          geometry.origin[0],
          geometry.origin[1],
          geometry.origin[2] + z,
        ],
        level,
      }
      const bytes =
        source.kind === 'omezarr-mosaic'
          ? await readMosaicGeometry(source, slabGeometry)
          : await readOmezarrGeometry(source, slabGeometry)
      await writable.write({ type: 'write', position, data: bytes })
      position += bytes.byteLength
    }
    await writable.close()
  } catch (error) {
    await writable.abort(error)
    throw error
  }
}

async function downloadNifti(): Promise<void> {
  const source = activeSource
  if (!source || downloadInProgress) return
  const bytes = exportByteLength(source)
  downloadInProgress = true
  syncDownloadControl()
  try {
    const geometry = sourceExportGeometry(source)
    const filename = niftiFilename(source, geometry)
    if (source.kind !== 'synthetic' && bytes > MAX_IN_MEMORY_NIFTI_BYTES) {
      await streamUniformOmezarr(source, geometry, filename)
    } else {
      const imageBytes =
        source.kind === 'omezarr-mosaic'
          ? await readMosaicGeometry(source, geometry)
          : source.kind === 'omezarr'
          ? await readOmezarrGeometry(source, geometry)
          : await readWholeRangeSource(source)
      setDownloadStatus('Writing NIfTI header...')
      await saveInMemoryNifti(source, geometry, imageBytes, filename)
    }
    setDownloadStatus(`Downloaded ${filename}`)
  } catch (error) {
    const cancelled =
      error instanceof DOMException && error.name === 'AbortError'
    setDownloadStatus(
      cancelled
        ? 'Download cancelled'
        : `Download failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    downloadInProgress = false
    syncDownloadControl()
  }
}

function createStreamingVolume(source: RangeSource): NVImage {
  const win = parseWindow(source.defaultWindow)
  const vol = buildLogicalVolume({
    id: source.name,
    url:
      `client-chunk://${source.id}` +
      `?source=${source.kind}` +
      `&cm=${encodeURIComponent(els.colormap.value)}` +
      `&w=${win.min}-${win.max}` +
      '&chunks=joined',
    shape: source.shape,
    spacing: source.spacing,
    datatypeCode: source.datatypeCode,
    numBitsPerVoxel: source.numBitsPerVoxel,
    calMin: win.min,
    calMax: win.max,
    colormap: els.colormap.value,
    chunkSource: createRangeChunkSource(source),
  })
  vol.chunkPlan = chunkPlan ?? undefined
  vol.chunkExplode = { enabled: false }
  return vol
}

function renderChunkStrip(): void {
  const source = activeSource
  if (!source) return
  const plan = currentPlan()
  const gridDims = plan?.gridDims ?? source.chunkGrid
  const chunkCount = plan?.chunks.length ?? source.chunkCount
  const columns = Math.min(16, Math.max(4, gridDims[0] * gridDims[1]))
  els.chunkStrip.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
  const nodes: HTMLSpanElement[] = []
  for (let i = 0; i < chunkCount; i++) {
    const span = document.createElement('span')
    const requestKey = planRequestKey(source, plan, i)
    if (requestKey && stats.completed.has(requestKey)) span.className = 'hit'
    nodes.push(span)
  }
  els.chunkStrip.replaceChildren(...nodes)
}

function currentPlan(): ChunkPlan | null {
  return chunkedVolume?.currentPlan ?? chunkPlan
}

function planRequestKey(
  source: LoadedSource,
  plan: ChunkPlan | null,
  chunkIndex: number,
): string | null {
  if (source.kind === 'synthetic') return rangeRequestKey(chunkIndex)
  const chunk = plan?.chunks[chunkIndex]
  if (!chunk) return null
  if (source.kind === 'omezarr-mosaic') {
    return mosaicRequestKey(source, chunk.texOrigin, chunk.texDims)
  }
  const cropGeometry = renderCropGeometry
  const cropLevel = cropGeometry?.level
  if (cropLevel) {
    return omezarrRequestKey(
      cropLevel.level,
      absoluteCropOrigin(cropGeometry.origin, chunk.texOrigin),
      chunk.texDims,
    )
  }
  return omezarrRequestKey(
    chunk.sourceLevel ?? 0,
    chunk.texOrigin,
    chunk.texDims,
  )
}

function requestCountsForPlan(
  source: LoadedSource,
  plan: ChunkPlan | null,
): { requested: number; completed: number } {
  const count = plan?.chunks.length ?? source.chunkCount
  let requested = 0
  let completed = 0
  for (let index = 0; index < count; index++) {
    const key = planRequestKey(source, plan, index)
    if (!key) continue
    if (stats.requested.has(key)) requested++
    if (stats.completed.has(key)) completed++
  }
  return { requested, completed }
}

function lodCounts(plan: ChunkPlan | null): Array<[number, number]> {
  if (!plan) return []
  const cropLevel = renderCropGeometry?.level
  if (cropLevel) return [[cropLevel.level, plan.chunks.length]]
  if (!plan.levelDims) return []
  const counts = new Map<number, number>()
  for (const chunk of plan.chunks) {
    const level = chunk.sourceLevel ?? 0
    counts.set(level, (counts.get(level) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([left], [right]) => left - right)
}

function lodSummary(plan: ChunkPlan | null): string {
  return lodCounts(plan)
    .map(([level, count]) => `L${level}: ${count}`)
    .join(', ')
}

function visibleFovLevels(plan: ChunkPlan | null): number[] {
  if (!plan) return []
  const cropLevel = renderCropGeometry?.level
  if (cropLevel) return [cropLevel.level]
  const zoom = Math.max(1, viewerZoom())
  const lo = plan.volumeDims.map((size, axis) =>
    Math.max(0, focusFraction[axis] * size - size / (2 * zoom)),
  )
  const hi = plan.volumeDims.map((size, axis) =>
    Math.min(size, focusFraction[axis] * size + size / (2 * zoom)),
  )
  const levels = new Set<number>()
  for (const chunk of plan.chunks) {
    const intersects = chunk.voxelOrigin.every(
      (origin, axis) =>
        origin < hi[axis] && origin + chunk.voxelDims[axis] > lo[axis],
    )
    if (intersects) levels.add(chunk.sourceLevel ?? 0)
  }
  return [...levels].sort((left, right) => left - right)
}

function setActiveLodLoading(target?: number): void {
  if (currentSourceKind() !== 'omezarr') return
  els.activeLevelControl.hidden = false
  els.activeLevel.value =
    typeof target === 'number' ? `target L${target}...` : 'loading...'
  els.activeLevel.title =
    typeof target === 'number'
      ? `Preparing a mixed-resolution plan with L${target} as its finest level`
      : 'Reading the OME-Zarr pyramid and preparing its GPU brick plan'
  els.activeLevel.removeAttribute('data-levels')
  els.activeLevel.removeAttribute('data-fov-levels')
}

function setVisibleLevel(level: number | null): void {
  els.visibleLevel.hidden = level === null
  els.visibleLevel.value = level === null ? '' : `L${level}`
  els.visibleLevel.title =
    level === null ? '' : `Finest Zarr level currently visible: L${level}`
}

function syncActiveLodIndicator(plan: ChunkPlan | null): void {
  if (activeSource?.kind === 'omezarr-mosaic') {
    els.activeLevelControl.hidden = false
    els.activeLevel.value = `L${activeSource.baseLevel} · ${activeSource.blocks.length} translated stores`
    els.activeLevel.dataset.levels = String(activeSource.baseLevel)
    els.activeLevel.dataset.fovLevels = String(activeSource.baseLevel)
    els.activeLevel.title = `One composite volume positioned from ${activeSource.blocks.length} OME-NGFF translation transforms`
    setVisibleLevel(activeSource.baseLevel)
    return
  }
  if (activeSource?.kind !== 'omezarr') {
    els.activeLevelControl.hidden = true
    els.activeLevel.value = ''
    els.activeLevel.removeAttribute('data-levels')
    els.activeLevel.removeAttribute('data-fov-levels')
    setVisibleLevel(null)
    return
  }
  const counts = lodCounts(plan)
  if (counts.length === 0) {
    setActiveLodLoading(currentDetailLevel ?? undefined)
    return
  }
  const levels = counts.map(([level]) => level)
  const fovLevels = visibleFovLevels(plan)
  const contextLevels = levels.filter((level) => !fovLevels.includes(level))
  const fovLabel = fovLevels.map((level) => `L${level}`).join(' · ')
  const contextLabel = contextLevels.map((level) => `L${level}`).join(' · ')
  els.activeLevelControl.hidden = false
  els.activeLevel.value = contextLabel
    ? `FOV ${fovLabel} · context ${contextLabel}`
    : `FOV ${fovLabel}`
  els.activeLevel.dataset.levels = levels.join(',')
  els.activeLevel.dataset.fovLevels = fovLevels.join(',')
  setVisibleLevel(fovLevels[0] ?? currentDetailLevel)
  els.activeLevel.title = `Visible FOV: ${fovLabel}. Whole plan: ${counts
    .map(([level, count]) => `L${level}: ${count} bricks`)
    .join(', ')}`
}

function httpSummary(): string {
  if (stats.rangeHits > 0) {
    return `<span class="ok">${stats.rangeHits} range 206</span>`
  }
  if (stats.chunkObjectHits > 0) {
    return `<span class="ok">${stats.chunkObjectHits} chunk objects</span>`
  }
  if (stats.fullFileFallbacks > 0) {
    return `<span class="warn">${stats.fullFileFallbacks} full-file 200</span>`
  }
  if (stats.metadataHits > 0) {
    return `<span class="warn">${stats.metadataHits} metadata</span>`
  }
  return '<span class="warn">pending</span>'
}

function renderHud(): void {
  const source = activeSource
  if (!source) return
  if (els.hud.hidden) return
  renderChunkStrip()
  const plan = currentPlan()
  const gridDims = plan?.gridDims ?? source.chunkGrid
  const planChunkShape = plan ? chunkShapeFromPlan(plan) : source.chunkShape
  const chunkCount = plan?.chunks.length ?? source.chunkCount
  const planCounts = requestCountsForPlan(source, plan)
  const lods = lodSummary(plan)
  const nativeRow =
    source.kind === 'omezarr'
      ? `<div class="row"><span class="key">base chunks</span><span>L${source.baseLevel}: ${source.chunkGrid.join(' x ')} @ ${source.chunkShape.join(' x ')}</span></div>`
      : source.kind === 'omezarr-mosaic'
        ? `<div class="row"><span class="key">translated stores</span><span>${source.blocks.length} stores · world origin ${source.worldOrigin.join(', ')} mm</span></div>`
      : ''
  const stream = nv?.chunkStreamStats()
  const failures =
    stats.failures > 0
      ? `<span class="bad">${stats.failures}</span>`
      : '<span class="ok">0</span>'
  els.hud.innerHTML = `
    <div class="title">${html(source.name)}</div>
    <div class="row"><span class="key">source</span><span>${html(source.sourceUrl)}</span></div>
    <div class="row"><span class="key">shape</span><span>${source.shape.join(' x ')} ${source.dtype}</span></div>
    <div class="row"><span class="key">viewer chunks</span><span>${gridDims.join(' x ')} @ ${planChunkShape.join(' x ')}</span></div>
    ${lods ? `<div class="row"><span class="key">active LODs</span><span>${lods}</span></div>` : ''}
    ${nativeRow}
    <div class="row"><span class="key">transport</span><span>${html(source.transportLabel)}</span></div>
    <div class="row"><span class="key">HTTP</span><span>${httpSummary()}</span></div>
    <div class="row"><span class="key">requested</span><span>${planCounts.requested} / ${chunkCount}</span></div>
    <div class="row"><span class="key">completed</span><span>${planCounts.completed} / ${chunkCount}</span></div>
    <div class="row"><span class="key">wire</span><span>${formatBytes(stats.wireBytes)}</span></div>
    <div class="row"><span class="key">decoded</span><span>${formatBytes(stats.decodedBytes)}</span></div>
    <div class="row"><span class="key">cache</span><span>${stats.cacheHits} hits, ${formatBytes(stats.cacheBytes)}</span></div>
    <div class="row"><span class="key">resident</span><span>${stream ? `${stream.resident} resident, ${stream.pending} pending, ${stream.inFlight} in flight` : 'pending'}</span></div>
    <div class="row"><span class="key">failures</span><span>${failures}</span></div>
    <div class="row"><span class="key">last requests</span><span>${html(stats.lastRequests.join(' | ') || 'none')}</span></div>
  `
}

function syncStatsVisibility(): void {
  const isVisible = els.showStats.checked
  els.hud.hidden = !isVisible
  els.hud.setAttribute('aria-hidden', String(!isVisible))
  els.chunkStrip.hidden = !isVisible
  els.chunkStrip.setAttribute('aria-hidden', String(!isVisible))
  if (isVisible) renderHud()
}

function syncCrosshairVisibility(): void {
  if (!nv) return
  nv.is3DCrosshairVisible = els.showCrosshair.checked
  nv.drawScene()
}

function formatMeasuredDistance(distanceMM: number): string {
  if (distanceMM < 1) {
    const micrometres = distanceMM * 1000
    return `${micrometres.toFixed(micrometres < 10 ? 1 : 0)} µm`
  }
  return `${distanceMM.toFixed(distanceMM < 10 ? 2 : 1)} mm`
}

function syncInteractionTool(): void {
  if (!nv) return
  const isRender = nv.sliceType === SLICE_TYPE.RENDER
  const measureRequested = els.interactionTool.getAttribute('aria-pressed') === 'true'
  const isMeasuring = measureRequested && !isRender
  nv.primaryDragMode = isMeasuring
    ? DRAG_MODE.measurement
    : DRAG_MODE.crosshairPan
  els.interactionTool.disabled = isRender
  els.canvas.style.cursor = isMeasuring ? 'crosshair' : 'default'
  if (isRender) {
    els.measurementStatus.value = 'measure in a slice view'
  } else if (isMeasuring && els.clearMeasurements.disabled) {
    els.measurementStatus.value = 'drag across a structure'
  } else if (!isMeasuring) {
    els.measurementStatus.value = 'crosshair movement active'
  }
}

function toggleInteractionTool(): void {
  const isMeasuring = els.interactionTool.getAttribute('aria-pressed') === 'true'
  els.interactionTool.setAttribute('aria-pressed', String(!isMeasuring))
  syncInteractionTool()
}

function clearMeasurements(): void {
  nv?.clearMeasurements()
  els.clearMeasurements.disabled = true
  els.measurementStatus.value =
    els.interactionTool.getAttribute('aria-pressed') === 'true'
      ? 'drag across a structure'
      : 'crosshair movement active'
}

function resetRenderCropForSourceChange(): void {
  clearMeasurements()
  renderCropGeometry = null
  sliceViewBeforeRender = null
  if (!nv || nv.sliceType !== SLICE_TYPE.RENDER) return
  els.layout.value = String(SLICE_TYPE.MULTIPLANAR)
  nv.renderPivotMM = null
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
}

function loadCustomSourceFromInput(): void {
  resetRenderCropForSourceChange()
  shouldInitializeCustomSource = true
  els.source.value = 'custom'
  syncSourceControls()
  updateUrlFromControls()
  void reloadVolume({ reloadSource: true })
}

function chunkShapeFromPlan(plan: ChunkPlan): Shape3 {
  return plan.chunks.reduce<Shape3>(
    (max, chunk) => [
      Math.max(max[0], chunk.texDims[0]),
      Math.max(max[1], chunk.texDims[1]),
      Math.max(max[2], chunk.texDims[2]),
    ],
    [0, 0, 0],
  )
}

function startHudPolling(): void {
  if (pollHandle !== 0) cancelAnimationFrame(pollHandle)
  const tick = (): void => {
    const plan = chunkedVolume?.currentPlan
    if (plan && plan !== chunkPlan) {
      chunkPlan = plan
      syncActiveLodIndicator(plan)
      syncDownloadControl()
    }
    renderHud()
    pollHandle = requestAnimationFrame(tick)
  }
  pollHandle = requestAnimationFrame(tick)
}

function applyLayout(): void {
  if (!nv) return
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  syncViewControls()
  syncInteractionTool()
  renderHud()
}

async function enterOmezarrRenderCrop(source: OmezarrSource): Promise<void> {
  if (!nv) return
  const view = captureView()
  if (!view) return
  const geometry = currentFovGeometry(source)
  sliceViewBeforeRender = view
  renderCropGeometry = geometry
  stats = freshStats()
  suppressAdaptiveEvents = true
  try {
    setActiveLodLoading(geometry.level?.level)
    await disposeChunkedVolume()
    nv.sliceType = SLICE_TYPE.RENDER
    await loadOmezarrRenderCrop(source, geometry)
    const camera = nv as unknown as CameraView
    camera.crosshairPos = [0.5, 0.5, 0.5]
    nv.renderPivotMM = null
    nv.renderPan = [0, 0]
    nv.scaleMultiplier = 1
    nv.drawScene()
    syncViewControls()
    syncInteractionTool()
    syncDownloadControl()
  } finally {
    suppressAdaptiveEvents = false
  }
}

async function leaveOmezarrRenderCrop(targetLayout: number): Promise<void> {
  if (!nv) return
  const view = sliceViewBeforeRender
  renderCropGeometry = null
  nv.renderPivotMM = null
  nv.sliceType = targetLayout
  await reloadVolume({ view })
  sliceViewBeforeRender = null
}

async function applyLayoutControl(): Promise<void> {
  if (!nv) return
  const targetLayout = Number(els.layout.value)
  els.layout.disabled = true
  try {
    if (
      targetLayout === SLICE_TYPE.RENDER &&
      activeSource?.kind === 'omezarr' &&
      !renderCropGeometry
    ) {
      await enterOmezarrRenderCrop(activeSource)
      return
    }
    if (renderCropGeometry && targetLayout !== SLICE_TYPE.RENDER) {
      await leaveOmezarrRenderCrop(targetLayout)
      return
    }
    applyLayout()
    scheduleAdaptiveLod(true)
  } catch (error) {
    const view = sliceViewBeforeRender
    renderCropGeometry = null
    sliceViewBeforeRender = null
    els.layout.value = String(SLICE_TYPE.MULTIPLANAR)
    nv.sliceType = SLICE_TYPE.MULTIPLANAR
    await reloadVolume({ view })
    showFallback(
      `3D current FOV failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    els.layout.disabled = false
  }
}

function captureView(): ViewState | null {
  if (!nv) return null
  const camera = nv as unknown as CameraView
  const crosshair = camera.crosshairPos
  const pan = camera.pan2Dxyzmm
  return {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    scale: camera.scaleMultiplier,
    crosshair: [crosshair[0] ?? 0.5, crosshair[1] ?? 0.5, crosshair[2] ?? 0.5],
    pan2D: [pan?.[0] ?? 0, pan?.[1] ?? 0, pan?.[2] ?? 0, pan?.[3] ?? 1],
    renderPan: [camera.renderPan[0] ?? 0, camera.renderPan[1] ?? 0],
  }
}

function currentShareState(): ShareableViewState {
  const view = captureView()
  const defaults = defaultShareState()
  return {
    ...defaults,
    layout: nv?.sliceType ?? Number(els.layout.value),
    azimuth: view?.azimuth ?? defaults.azimuth,
    elevation: view?.elevation ?? defaults.elevation,
    scale: view?.scale ?? defaults.scale,
    crosshair: view?.crosshair ?? defaults.crosshair,
    pan2D: view?.pan2D ?? defaults.pan2D,
    renderPan: view?.renderPan ?? defaults.renderPan,
    colormap: els.colormap.value,
    windowLevel: Number(els.windowLevel.value),
    windowWidth: Number(els.windowWidth.value),
    scrollZoomSpeed: currentScrollZoomSpeed(),
    showCrosshair: els.showCrosshair.checked,
    showScaleBar: els.showScaleBar.checked,
    showStats: els.showStats.checked,
  }
}

function setShareStatus(message: string): void {
  els.shareStatus.value = message
  els.shareStatus.hidden = message.length === 0
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const input = document.createElement('textarea')
    input.value = text
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    input.select()
    const copied = document.execCommand('copy')
    input.remove()
    if (!copied) throw new Error('The browser blocked clipboard access')
  }
}

async function copyShareLink(): Promise<void> {
  updateUrlFromControls()
  const url = writeShareState(new URL(window.location.href), currentShareState())
  window.history.replaceState(null, '', url)
  try {
    await writeClipboard(url.toString())
    setShareStatus('Link copied — opening it restores these stores and viewer settings.')
  } catch (error) {
    setShareStatus(
      error instanceof Error ? error.message : 'Unable to copy the share link',
    )
  }
}

function restoreView(view: ViewState | null): void {
  if (!nv || !view) return
  const camera = nv as unknown as CameraView
  camera.azimuth = view.azimuth
  camera.elevation = view.elevation
  camera.scaleMultiplier = clampViewerZoom(view.scale)
  camera.crosshairPos = view.crosshair
  camera.pan2Dxyzmm = [
    view.pan2D[0],
    view.pan2D[1],
    view.pan2D[2],
    clampViewerZoom(view.pan2D[3]),
  ]
  camera.renderPan = view.renderPan
}

function viewerZoom(): number {
  if (!nv) return 1
  const zoom =
    nv.sliceType === SLICE_TYPE.RENDER ? nv.scaleMultiplier : nv.pan2Dxyzmm[3]
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

function panExtent(axis: number): number {
  const volume = nv?.volumes[0]
  const min = volume?.extentsMin
  const max = volume?.extentsMax
  if (!min || !max) return 1
  const extent = Math.abs((max[axis] ?? 0) - (min[axis] ?? 0))
  return Number.isFinite(extent) && extent > 0 ? extent : 1
}

function syncFocusFromPan(): boolean {
  if (!nv) return false
  const pan = nv.pan2Dxyzmm
  const nextPan: Shape3 = [pan[0] ?? 0, pan[1] ?? 0, pan[2] ?? 0]
  const changed = nextPan.some(
    (value, axis) => Math.abs(value - lastPanForFocus[axis]) > 0.0001,
  )
  if (!changed) return false
  lastPanForFocus = nextPan
  focusFraction = [0, 1, 2].map((axis) =>
    Math.min(1, Math.max(0, 0.5 - (pan[axis] ?? 0) / panExtent(axis))),
  ) as Shape3
  return true
}

function syncViewControls(): void {
  const zoom = viewerZoom()
  const zoomDisplay = zoomControlDisplay(zoom, pendingZoom)
  els.zoom.value = String(clampViewerZoom(zoomDisplay.value))
  els.zoomValue.value = zoomDisplay.label
  const isRender = nv?.sliceType === SLICE_TYPE.RENDER
  const pan = isRender ? nv?.renderPan : nv?.pan2Dxyzmm
  for (let axis = 0; axis < 3; axis++) {
    const percent = pan
      ? Math.min(
          100,
          Math.max(
            -100,
            isRender
              ? (pan[axis] ?? 0) * 100
              : ((pan[axis] ?? 0) / panExtent(axis)) * 100,
          ),
        )
      : 0
    els.pan[axis].value = String(Math.round(percent))
    els.panValue[axis].value = `${Math.round(percent)}%`
    els.pan[axis].disabled =
      !nv || nv.volumes.length === 0 || (isRender && axis === 2)
  }
  const zoomDisabled = !nv || nv.volumes.length === 0
  els.zoom.disabled = zoomDisabled
  els.applyZoom.disabled = zoomDisabled || !zoomDisplay.canApply
}

function currentScrollZoomSpeed(): number {
  const speed = Number(els.scrollZoomSpeed.value)
  return Number.isFinite(speed) ? Math.min(4, Math.max(0.25, speed)) : 2
}

function syncScrollZoomSpeed(): void {
  const speed = currentScrollZoomSpeed()
  els.scrollZoomSpeed.value = String(speed)
  els.scrollZoomSpeedValue.value = `${Number(speed.toFixed(2))}×`
}

function updateZoomSelection(): void {
  const zoom = Number(els.zoom.value)
  pendingZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : null
  syncViewControls()
}

function applyZoomControl(): void {
  if (!nv) return
  const zoom = pendingZoom
  if (zoom === null) return
  pendingZoom = null
  if (nv.sliceType === SLICE_TYPE.RENDER) {
    nv.scaleMultiplier = zoom
  } else {
    const pan = nv.pan2Dxyzmm
    nv.pan2Dxyzmm = [pan[0], pan[1], pan[2], zoom]
    nv.scaleMultiplier = zoom
  }
  nv.drawScene()
  syncViewControls()
  syncDownloadControl()
  scheduleAdaptiveLod()
}

async function applyZarrLevelControl(): Promise<void> {
  const selected = els.zarrLevel.value
  fixedZarrLevel = /^\d+$/.test(selected) ? Number(selected) : null
  requestedBaseLevel = fixedZarrLevel
  updateUrlFromControls()
  els.zarrLevel.disabled = true
  await reloadVolume({ reloadSource: true, preserveView: true })
}

function applyPanControls(): void {
  if (!nv) return
  if (nv.sliceType === SLICE_TYPE.RENDER) {
    nv.renderPan = [
      Number(els.pan[0].value) * 0.01,
      Number(els.pan[1].value) * 0.01,
    ]
    syncViewControls()
    return
  }
  const pan = els.pan.map((control, axis) => {
    const percent = Number(control.value)
    return (Number.isFinite(percent) ? percent : 0) * panExtent(axis) * 0.01
  }) as Shape3
  nv.pan2Dxyzmm = [pan[0], pan[1], pan[2], viewerZoom()]
  syncFocusFromPan()
  nv.drawScene()
  syncViewControls()
  syncDownloadControl()
  scheduleAdaptiveLod(true)
}

function panForCrosshair(): Shape3 {
  if (!nv) return [0, 0, 0]
  const volume = nv.volumes[0]
  const crosshair = nv.crosshairPos
  const min = volume?.extentsMin
  const max = volume?.extentsMax
  if (!min || !max) return [0, 0, 0]
  return [
    (max[0] - min[0]) * (0.5 - (crosshair[0] ?? 0.5)),
    (max[1] - min[1]) * (0.5 - (crosshair[1] ?? 0.5)),
    (max[2] - min[2]) * (0.5 - (crosshair[2] ?? 0.5)),
  ]
}

function handleWheelZoom(event: WheelEvent): void {
  if (!nv) return
  event.preventDefault()
  event.stopImmediatePropagation()
  pendingZoom = null
  if (nv.sliceType === SLICE_TYPE.RENDER) {
    nv.scaleMultiplier = wheelZoomValue(
      nv.scaleMultiplier,
      event.deltaY,
      event.deltaMode,
      els.canvas.clientHeight,
      currentScrollZoomSpeed(),
    )
  } else {
    const current = nv.pan2Dxyzmm[3] || 1
    const zoom = wheelZoomValue(
      current,
      event.deltaY,
      event.deltaMode,
      els.canvas.clientHeight,
      currentScrollZoomSpeed(),
    )
    const pan = zoom > 1 ? panForCrosshair() : ([0, 0, 0] as Shape3)
    nv.pan2Dxyzmm = [pan[0], pan[1], pan[2], zoom]
    nv.scaleMultiplier = zoom
  }
  nv.drawScene()
  syncViewControls()
  syncDownloadControl()
  scheduleAdaptiveLod()
}

function detailLevelForView(source: OmezarrSource, zoom: number): number {
  if (fixedZarrLevel !== null) {
    return Math.min(
      source.levels.length - 1,
      Math.max(0, fixedZarrLevel),
    )
  }
  return detailLevelForZoom(source.baseLevel, zoom, source.levels.length)
}

let currentDetailLevel: number | null = null

function scheduleAdaptiveLod(focusMoved = false): void {
  if (suppressAdaptiveEvents) return
  if (activeSource?.kind === 'omezarr' && chunkedVolume) {
    const target = detailLevelForView(activeSource, viewerZoom())
    const targetChanged = updateAdaptiveLodDetail(
      chunkedVolume,
      currentDetailLevel,
      target,
    )
    currentDetailLevel = target
    if (targetChanged) setActiveLodLoading(target)
    if (focusMoved) chunkedVolume.setFocus(focusFraction)
    return
  }
  if (activeSource?.kind !== 'omezarr-mosaic' || fixedZarrLevel !== null) return
  const firstBlock = activeSource.blocks[0]
  const levelCount = firstBlock?.source.levels.length ?? 0
  if (levelCount === 0) return
  const target = detailLevelForZoom(levelCount - 1, viewerZoom(), levelCount)
  cancelMosaicLodReload()
  if (target === activeSource.baseLevel) return
  const revision = mosaicLodRevision
  mosaicLodHandle = window.setTimeout(() => {
    if (revision !== mosaicLodRevision) return
    mosaicLodHandle = 0
    requestedBaseLevel = target
    setActiveLodLoading(target)
    void reloadVolume({ reloadSource: true, preserveView: true })
  }, LOD_DEBOUNCE_MS)
}

async function disposeChunkedVolume(): Promise<void> {
  chunkedVolume?.dispose()
  chunkedVolume = null
  currentDetailLevel = null
  if (nv && nv.volumes.length > 0) await nv.removeAllVolumes()
}

async function loadOmezarrVolume(
  source: OmezarrSource,
  view: ViewState | null,
): Promise<void> {
  if (!nv) return
  const win = parseWindow(source.defaultWindow)
  const zoom = view
    ? nv.sliceType === SLICE_TYPE.RENDER
      ? view.scale
      : view.pan2D[3]
    : viewerZoom()
  const minLevel = detailLevelForView(source, zoom)
  currentDetailLevel = minLevel
  chunkedVolume = await nv.loadChunkedVolume(
    createOmezarrPyramidSource(source),
    {
      id: source.id,
      name: source.name,
      calMin: win.min,
      calMax: win.max,
      colormap: els.colormap.value,
      focus: focusFraction,
      radius: ADAPTIVE_FINE_RADIUS,
      minLevel,
      budgetBytes: ADAPTIVE_PLANNER_BUDGET_BYTES,
      maxBricks: ADAPTIVE_MAX_BRICKS,
      cellEdge: ADAPTIVE_CELL_EDGE,
      halo: STREAMING_CHUNK_HALO,
      detail: 0.1,
      debounceMs: LOD_DEBOUNCE_MS,
    },
  )
  chunkedVolume.volume.chunkExplode = { enabled: false }
  chunkPlan = chunkedVolume.currentPlan
  syncActiveLodIndicator(chunkPlan)
  restoreView(view)
  nv.drawScene()
}

async function loadMosaicVolume(
  source: OmezarrMosaicSource,
  view: ViewState | null,
): Promise<void> {
  if (!nv) return
  currentDetailLevel = source.baseLevel
  const { volume, plan } = createMosaicVolume(source)
  await nv.loadVolumes([volume])
  chunkPlan = plan
  syncActiveLodIndicator(plan)
  restoreView(view)
  nv.drawScene()
}

async function loadOmezarrRenderCrop(
  source: OmezarrSource,
  geometry: ExportGeometry,
): Promise<void> {
  if (!nv) return
  const level = geometry.level
  if (!level) throw new Error('The 3D current FOV has no pyramid level')
  currentDetailLevel = level.level
  const { volume, plan } = createOmezarrRenderCropVolume(source, geometry)
  await nv.loadVolumes([volume])
  chunkPlan = plan
  syncActiveLodIndicator(plan)
  nv.drawScene()
}

async function reloadVolume(
  options: {
    reloadSource?: boolean
    preserveView?: boolean
    view?: ViewState | null
  } = {},
): Promise<void> {
  if (!nv) return
  if (options.reloadSource) cancelMosaicLodReload()
  hideFallback()
  setDownloadStatus('')
  stats = freshStats()
  const view =
    options.view !== undefined
      ? options.view
      : options.preserveView
        ? captureView()
        : null
  const cropGeometry = renderCropGeometry
  suppressAdaptiveEvents = true
  try {
    if (options.reloadSource || !activeSource) {
      activeSource = null
      autoWindowSession = null
      chunkPlan = null
      syncDownloadControl()
      const source = await loadActiveSource()
      activeSource = source
      syncZarrLevelControl()
      prepareAutoWindow(source)
      if (cropGeometry?.level && source.kind === 'omezarr') {
        const level = source.levels[cropGeometry.level.level]
        if (!level) {
          throw new Error(
            `OME-Zarr level ${cropGeometry.level.level} for the 3D current FOV is unavailable`,
          )
        }
        renderCropGeometry = { ...cropGeometry, level }
      }
    }
    if (!activeSource) {
      throw new Error('No active source selected')
    }
    const crosshair = crosshairAppearanceForSpacing(activeSource.spacing)
    nv.crosshairWidth = crosshair.width
    nv.crosshairGap = crosshair.gap
    syncCrosshairVisibility()
    await disposeChunkedVolume()
    if (activeSource.kind === 'omezarr') {
      if (renderCropGeometry && nv.sliceType === SLICE_TYPE.RENDER) {
        await loadOmezarrRenderCrop(activeSource, renderCropGeometry)
      } else {
        await loadOmezarrVolume(activeSource, view)
      }
    } else if (activeSource.kind === 'omezarr-mosaic') {
      renderCropGeometry = null
      await loadMosaicVolume(activeSource, view)
    } else {
      chunkPlan = createChunkPlan(activeSource)
      await nv.loadVolumes([createStreamingVolume(activeSource)])
      syncActiveLodIndicator(chunkPlan)
    }
    applyLayout()
    syncViewControls()
  } catch (err) {
    if (!activeSource) {
      await disposeChunkedVolume()
      chunkPlan = null
      setVisibleLevel(null)
    }
    if (currentSourceKind() === 'omezarr') {
      els.activeLevel.value = 'unavailable'
      els.activeLevel.title = 'The OME-Zarr volume did not load'
    }
    showFallback(err instanceof Error ? err.message : String(err))
  } finally {
    suppressAdaptiveEvents = false
    syncDownloadControl()
    syncZarrLevelControl()
  }
}

async function main(): Promise<void> {
  initControlsFromUrl()
  updateUrlFromControls()
  syncStatsVisibility()

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    is3DCrosshairVisible: els.showCrosshair.checked,
    isRulerVisible: els.showScaleBar.checked,
    crosshairWidth: 0.5,
    primaryDragMode: DRAG_MODE.crosshairPan,
    sliceType: Number(els.layout.value),
    maxTextureDimension3D: STREAMING_CHUNK_EDGE,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)
  els.canvas.addEventListener('wheel', handleWheelZoom, {
    capture: true,
    passive: false,
  })
  nv.addEventListener('change', (event) => {
    if (event.detail.property === 'pan2Dxyzmm') {
      const focusMoved = lodFocusTracksInteraction('pan') && syncFocusFromPan()
      syncViewControls()
      syncDownloadControl()
      scheduleAdaptiveLod(focusMoved)
    } else if (event.detail.property === 'scaleMultiplier') {
      syncViewControls()
      syncDownloadControl()
      scheduleAdaptiveLod()
    } else if (event.detail.property === 'renderPan') {
      syncViewControls()
    }
  })
  nv.addEventListener('measurementCompleted', (event) => {
    els.measurementStatus.value = `${formatMeasuredDistance(event.detail.distance)} · right-click to remove`
    els.clearMeasurements.disabled = false
  })
  const measurementEvents = nv as unknown as EventTarget
  measurementEvents.addEventListener(
    'measurementRemoved',
    (event) => {
      const { remaining } = (event as CustomEvent<{ remaining: number }>).detail
      els.clearMeasurements.disabled = remaining === 0
      els.measurementStatus.value =
        remaining === 0
          ? 'drag across a structure'
          : `${remaining} measurement${remaining === 1 ? '' : 's'} · right-click to remove`
    },
  )
  // Crosshair locationChange events intentionally do not refocus LOD. A click
  // moves the marker without moving the viewport; following it would shift the
  // fine box away from the visible field and expose coarse context rectangles.

  els.source.addEventListener('change', () => {
    cancelMosaicLodReload()
    resetRenderCropForSourceChange()
    fixedZarrLevel = null
    shouldInitializeCustomSource = true
    requestedBaseLevel = null
    setDefaultWindowForSelectedSource()
    syncSourceControls()
    updateUrlFromControls()
    if (currentStoreUrls().length === 0) {
      showFallback(
        els.source.value === 'dandi'
          ? 'Search DANDI and select an OME-Zarr asset, then press Load volume'
          : 'Add an OME-Zarr store URL, then press Load volume',
      )
      return
    }
    void reloadVolume({ reloadSource: true })
  })
  els.layout.addEventListener('change', () => {
    void applyLayoutControl()
  })
  els.zoom.addEventListener('input', updateZoomSelection)
  els.zarrLevel.addEventListener('change', () => {
    void applyZarrLevelControl()
  })
  els.scrollZoomSpeed.addEventListener('input', syncScrollZoomSpeed)
  els.zoom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    applyZoomControl()
  })
  els.applyZoom.addEventListener('click', applyZoomControl)
  for (const control of els.pan) {
    control.addEventListener('input', applyPanControls)
  }
  els.colormap.addEventListener('change', () => {
    void reloadVolume()
  })
  els.windowLevel.addEventListener('input', handleWindowInput)
  els.windowWidth.addEventListener('input', handleWindowInput)
  els.windowMin.addEventListener('input', () => {
    handleWindowRangeInput('min')
  })
  els.windowMax.addEventListener('input', () => {
    handleWindowRangeInput('max')
  })
  els.interactionTool.addEventListener('click', toggleInteractionTool)
  els.showScaleBar.addEventListener('change', () => {
    if (nv) nv.isRulerVisible = els.showScaleBar.checked
  })
  els.clearMeasurements.addEventListener('click', clearMeasurements)
  els.showCrosshair.addEventListener('change', syncCrosshairVisibility)
  els.showStats.addEventListener('change', syncStatsVisibility)
  els.zarrUrl.addEventListener('input', () => {
    shouldInitializeCustomSource = true
    syncUrlRowControls()
  })
  els.zarrUrl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    loadCustomSourceFromInput()
  })
  els.addZarrUrl.addEventListener('click', () => {
    addCustomUrlInput().focus()
  })
  els.removeZarrUrl.addEventListener('click', () => {
    removeCustomUrlRow(els.zarrUrl.closest<HTMLElement>('.zarr-url-row')!, els.zarrUrl)
  })
  els.searchDandi.addEventListener('click', () => {
    void searchDandiAssets()
  })
  for (const input of [els.dandisetId, els.dandiVersion, els.dandiQuery]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      void searchDandiAssets()
    })
  }
  els.addDandiSelection.addEventListener('click', addSelectedDandiAssets)
  els.reload.addEventListener('click', () => {
    void reloadVolume({ reloadSource: true })
  })
  els.downloadNifti.addEventListener('click', () => {
    void downloadNifti()
  })
  els.copyShareLink.addEventListener('click', () => {
    void copyShareLink()
  })

  await reloadVolume({ reloadSource: true, view: initialSharedView })
  if (initialSharedSettings && nv.volumes.length > 0) {
    const sharedWindow = windowFromLevelWidth(
      initialSharedSettings.windowLevel,
      initialSharedSettings.windowWidth,
    )
    const preserveSharedWindow =
      !activeSource ||
      activeSource.kind === 'synthetic' ||
      !isGenericDtypeWindow(activeSource.dtype, sharedWindow)
    applySharedControlSettings(initialSharedSettings, preserveSharedWindow)
    nv.isRulerVisible = initialSharedSettings.showScaleBar
    syncCrosshairVisibility()
    if (preserveSharedWindow) {
      manualWindowRevision++
      autoWindowSession = null
      if (activeSource) activeSource.defaultWindow = sharedWindow
      await nv.setVolume(0, {
        calMin: sharedWindow.min,
        calMax: sharedWindow.max,
      })
    }
    restoreView(initialSharedView)
    applyLayout()
    const focusMoved = syncFocusFromPan()
    scheduleAdaptiveLod(focusMoved)
  }
  startHudPolling()
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
