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
import {
  prototypeStreamingFovBoundsFromScreenSlices,
  type PrototypeFovBounds,
} from './adaptive_streaming_fov_prototype.ts'
import { AbortableTaskPool } from './abortable_task_pool'
import { getBackendFromUrl } from './backend'
import { LAYOUT_PRESET, viewerLayoutConfig } from './viewer_layout'
import {
  buildDandiZarrAssetHierarchy,
  searchDandiZarrAssets,
  type DandiZarrAssetGroup,
  type DandiZarrAsset,
} from './dandi_archive'
import {
  IntensityWindowEstimator,
  isGenericDtypeWindow,
} from './intensity_window'
import {
  DecodedChunkCache,
  withDecodedChunkCaching,
} from './decoded_chunk_cache'
import {
  buildLogicalVolume,
  niftiDatatype,
  type Shape3,
} from './logical_volume'
import { LatestTaskQueue } from './latest_task_queue'
import { measurementIndexAtCanvasPoint } from './measurement_hit_test'
import {
  layoutTranslatedBlocks,
  spatialTransformMm,
  translatedMosaicId,
  type MosaicBlockLayout,
} from './mosaic_layout'
import { createMosaicChunkedVolumeSource } from './mosaic_chunked_source.ts'
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
  axialSliceFraction,
  axialSliceIndex,
  crosshairAppearanceForSpacing,
  clampViewerZoom,
  detailLevelForZoom,
  fineLodRadiusForShape,
  lodDeliveryDisplay,
  lodFocusTracksInteraction,
  loadingTileCount,
  rangeBoundsForWindow,
  updateAdaptiveLodDetail,
  visibleFovBounds,
  wheelZoomValue,
  windowFromLevelWidth,
  windowLevelWidth,
  zoomForDetailLevel,
  zoomLevelControlDisplay,
} from './viewer_controls'
import { ZarrReadSession } from './zarr_read_session'
import {
  withInflightReadDeduplication,
  withOptionalConsolidatedMetadata,
} from './zarr_store'

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
const DEFAULT_DETAIL_BUDGET_GIB = 8
// NiiVue's planner accounts for eight bytes per voxel regardless of source
// dtype. ZARRo supports one- and two-byte data, so this corrects that estimate
// while the stream manager still enforces DEFAULT_RESIDENCY_BYTES at runtime.
const STREAMING_CHUNK_EDGE = 256
const STREAMING_CHUNK_HALO: Shape3 = [3, 3, 3]
const ZARR_BYTE_CACHE_BYTES = 512 * 1024 * 1024
const DECODED_CHUNK_CACHE_BYTES = 256 * 1024 * 1024
const ZARR_REGION_CONCURRENCY = 6
const LOD_DEBOUNCE_MS = 180
// Match NiiVue's renderer-side ceiling. GPU residency remains independently
// bounded by DEFAULT_RESIDENCY_BYTES, so this only permits a larger plan.
const ADAPTIVE_MAX_BRICKS = 1024
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
  crosshairSpacing: Shape3
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
  decodedCache: DecodedChunkCache
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

interface OmezarrMosaicLevel {
  level: number
  shape: Shape3
  spacing: Shape3
  worldOrigin: Shape3
  blocks: OmezarrMosaicBlock[]
}

interface OmezarrMosaicSource extends LoadedSourceBase {
  kind: 'omezarr-mosaic'
  baseLevel: number
  worldOrigin: Shape3
  levels: OmezarrMosaicLevel[]
  decodedCache: DecodedChunkCache
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
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

function el<T extends Element>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as unknown as T
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
  scrollZoomSpeed: el<HTMLInputElement>('scrollZoomSpeed'),
  scrollZoomSpeedValue: el<HTMLOutputElement>('scrollZoomSpeedValue'),
  detailBudget: el<HTMLInputElement>('detailBudget'),
  detailBudgetValue: el<HTMLOutputElement>('detailBudgetValue'),
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
  axialSlice: el<HTMLInputElement>('axialSlice'),
  axialSliceValue: el<HTMLOutputElement>('axialSliceValue'),
  axialSliceHelp: el<HTMLElement>('axialSliceHelp'),
  colormap: el<HTMLSelectElement>('colormap'),
  autoContrast: el<HTMLButtonElement>('autoContrast'),
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
  clearDandiSelection: el<HTMLButtonElement>('clearDandiSelection'),
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
  crosshairOverlay: el<SVGSVGElement>('crosshairOverlay'),
  crosshairOutline: el<SVGPathElement>('crosshairOutline'),
  crosshairLines: el<SVGPathElement>('crosshairLines'),
  scaleIndicators: el<HTMLDivElement>('scaleIndicators'),
  visibleLevel: el<HTMLOutputElement>('visibleLevel'),
  tileLoading: el<HTMLOutputElement>('tileLoading'),
}

let nv: NiiVue | null = null
let activeSource: LoadedSource | null = null
let activeReadSession: ZarrReadSession | null = null
let chunkPlan: ChunkPlan | null = null
let chunkedVolume: NVChunkedVolume | null = null
let stats: RangeStats = freshStats()
let pollHandle = 0
let displayedLoadingTiles = -1
let displayedCrosshairPath = ''
let shouldInitializeCustomSource = true
let selectedDandiStoreUrls: string[] = []
let requestedBaseLevel: number | null = null
let fixedZarrLevel: number | null = null
let focusFraction: Shape3 = [0.5, 0.5, 0.5]
let lastPanForFocus: Shape3 = [0, 0, 0]
let lastAdaptiveRequestKey: string | null = null
let suppressAdaptiveEvents = false
let deferredAdaptiveLod = false
let deferredAdaptiveFocusMoved = false
let downloadInProgress = false
let renderCropGeometry: ExportGeometry | null = null
let sliceViewBeforeRender: ViewState | null = null
let windowUpdateHandle = 0
let pendingZoomLevel: number | null = null
let dandiSearchController: AbortController | null = null
const dandiAssetByStoreUrl = new Map<string, DandiZarrAsset>()
const dandiGroupByAddButton = new WeakMap<HTMLButtonElement, DandiZarrAssetGroup>()
const reloadQueue = new LatestTaskQueue()
let initialSharedView: ViewState | null = null
let initialSharedSettings: ShareableViewState | null = null
let manualWindowRevision = 0
let autoWindowSession: AutoWindowSession | null = null
let autoContrastState: AutoContrastState | null = null

interface AutoContrastState {
  source: OmezarrSource | OmezarrMosaicSource
  estimator: IntensityWindowEstimator
  window: DisplayWindow | null
}

interface AutoWindowSession {
  source: OmezarrSource | OmezarrMosaicSource
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
    detailBudgetGiB: Number(els.detailBudget.value),
    showCrosshair: els.showCrosshair.checked,
    showScaleBar: els.showScaleBar.checked,
    showStats: els.showStats.checked,
  }
}

function applySharedControlSettings(
  settings: ShareableViewState,
  applyWindow = true,
): void {
  if (
    [...els.layout.options].some(
      (option) => option.value === String(settings.layout),
    )
  ) {
    els.layout.value = String(settings.layout)
  }
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
  els.detailBudget.value = String(settings.detailBudgetGiB)
  els.showCrosshair.checked = settings.showCrosshair
  els.showScaleBar.checked = settings.showScaleBar
  els.showStats.checked = settings.showStats
  syncWindowControlValues()
  syncScrollZoomSpeed()
  syncDetailBudget()
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
  const plan = currentPlan()
  const activeLevel = plan
    ? Math.min(...plan.chunks.map((chunk) => chunk.sourceLevel ?? 0))
    : source.baseLevel
  const mosaicLevel = source.levels[activeLevel]
  const level = mosaicLevel?.blocks[0]?.level
  if (!level) throw new Error('The translated mosaic has no readable blocks')
  const crop = fovCropGeometry(
    {
      level: mosaicLevel.level,
      shape: mosaicLevel.shape,
      spacing: mosaicLevel.spacing,
    },
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
  autoContrastState = null
  els.autoContrast.disabled = true
  if (source.kind === 'synthetic') return
  autoContrastState = {
    source,
    estimator: new IntensityWindowEstimator(source.dtype),
    window: null,
  }
  const currentWindow = parseWindow(source.defaultWindow)
  if (!isGenericDtypeWindow(source.dtype, currentWindow)) return
  autoWindowSession = {
    source,
    manualRevision: manualWindowRevision,
    observedChunks: 0,
    lastMaximum: null,
  }
}

function observeChunkForAutoWindow(
  source: OmezarrSource | OmezarrMosaicSource,
  bytes: Uint8Array,
): void {
  const contrast = autoContrastState
  if (!contrast || contrast.source !== source) return
  const estimated = contrast.estimator.observe(bytes)
  if (estimated) {
    contrast.window = estimated
    els.autoContrast.disabled = false
  }
  const session = autoWindowSession
  if (
    !session ||
    session.source !== source ||
    session.manualRevision !== manualWindowRevision
  ) {
    return
  }
  session.observedChunks++
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

function applyAutoContrast(): void {
  const contrast = autoContrastState
  if (
    !contrast?.window ||
    !activeSource ||
    activeSource !== contrast.source ||
    !nv ||
    nv.volumes.length === 0
  ) {
    return
  }
  manualWindowRevision++
  autoWindowSession = null
  contrast.source.defaultWindow = contrast.window
  setWindowControls(contrast.window, contrast.source.dtype)
  scheduleWindowUpdate()
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
  delete els.canvas.dataset.windowMin
  delete els.canvas.dataset.windowMax
  window.clearTimeout(windowUpdateHandle)
  windowUpdateHandle = window.setTimeout(() => {
    const source = activeSource
    if (!nv || !source || nv.volumes.length === 0) return
    const revision = manualWindowRevision
    const win = windowFromLevelWidth(
      Number(els.windowLevel.value),
      Number(els.windowWidth.value),
    )
    source.defaultWindow = win
    void nv
      .setVolume(0, { calMin: win.min, calMax: win.max })
      .then(() => {
        if (activeSource !== source || manualWindowRevision !== revision) return
        els.canvas.dataset.windowMin = String(win.min)
        els.canvas.dataset.windowMax = String(win.max)
      })
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
  activeReadSession?.abort('OME-Zarr store removed')
  activeReadSession = null
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

function syncDandiGroupActions(): void {
  const selectedUrls = new Set(selectedDandiStoreUrls)
  for (const button of els.dandiResults.querySelectorAll<HTMLButtonElement>(
    '.dandi-add-store',
  )) {
    const added = selectedUrls.has(button.dataset.storeUrl ?? '')
    button.disabled = added
    button.textContent = added ? 'Added' : 'Add'
  }
  for (const button of els.dandiResults.querySelectorAll<HTMLButtonElement>(
    '.dandi-add-group',
  )) {
    const group = dandiGroupByAddButton.get(button)
    if (!group) continue
    const missing = group.members.filter(
      ({ asset }) => !selectedUrls.has(asset.storeUrl),
    ).length
    button.disabled = missing === 0
    button.textContent =
      missing === 0
        ? `All ${group.members.length} added`
        : missing === group.members.length
          ? `Add all ${group.members.length}`
          : `Add remaining ${missing}`
  }
}

function renderSelectedDandiStores(): void {
  els.dandiSelectedStores.replaceChildren()
  els.dandiSelectedStores.hidden = selectedDandiStoreUrls.length === 0
  els.clearDandiSelection.disabled = selectedDandiStoreUrls.length === 0
  if (selectedDandiStoreUrls.length === 0) return

  const heading = document.createElement('strong')
  heading.className = 'selected-store-heading'
  heading.textContent = 'Selected stores'
  els.dandiSelectedStores.append(heading)

  selectedDandiStoreUrls.forEach((storeUrl, index) => {
    const row = document.createElement('div')
    row.className = 'selected-store-row'
    const name = document.createElement('span')
    const asset = dandiAssetByStoreUrl.get(storeUrl)
    name.textContent =
      asset?.path.split('/').at(-1) ?? customStoreName(storeUrl)
    name.title = storeUrl
    const remove = createStoreRemoveButton(`Remove DANDI store ${index + 1}`, () => {
      selectedDandiStoreUrls = selectedDandiStoreUrls.filter(
        (selectedUrl) => selectedUrl !== storeUrl,
      )
      shouldInitializeCustomSource = true
      renderSelectedDandiStores()
      syncDandiGroupActions()
      els.dandiSearchStatus.value = 'Store removed. Updating the viewer…'
      void reloadAfterStoreRemoval().then(() => {
        els.dandiSearchStatus.value = 'Store removed.'
      })
    })
    row.append(name, remove)
    els.dandiSelectedStores.append(row)
  })
}

async function clearSelectedDandiAssets(): Promise<void> {
  if (selectedDandiStoreUrls.length === 0) return
  selectedDandiStoreUrls = []
  shouldInitializeCustomSource = true
  renderSelectedDandiStores()
  syncDandiGroupActions()
  els.dandiSearchStatus.value = 'All selected stores cleared. Updating the viewer…'
  await reloadAfterStoreRemoval()
  els.dandiSearchStatus.value = 'All selected stores cleared.'
}

function createDandiChunkResult(
  asset: DandiZarrAsset,
  chunk: number | null = null,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'dandi-result'
  const copy = document.createElement('span')
  const title = document.createElement('strong')
  title.textContent =
    chunk === null ? (asset.path.split('/').at(-1) ?? asset.path) : `Chunk ${chunk}`
  const metadata = document.createElement('small')
  metadata.textContent = `${formatBytes(asset.size)} · ${asset.path.split('/').at(-1) ?? asset.path}`
  copy.append(title, metadata)
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'dandi-add-store'
  add.dataset.storeUrl = asset.storeUrl
  add.textContent = 'Add'
  add.setAttribute('aria-label', `Add ${title.textContent} store`)
  add.addEventListener('click', () => addDandiAssets([asset]))
  row.append(copy, add)
  return row
}

function addDandiAssets(assets: DandiZarrAsset[]): void {
  const existing = new Set(selectedDandiStoreUrls)
  const added = assets.filter((asset) => !existing.has(asset.storeUrl))
  if (added.length === 0) {
    els.dandiSearchStatus.value = 'All stores in this stain group are already selected.'
    return
  }
  selectedDandiStoreUrls = [
    ...new Set([...selectedDandiStoreUrls, ...added.map((asset) => asset.storeUrl)]),
  ]
  shouldInitializeCustomSource = true
  renderSelectedDandiStores()
  syncDandiGroupActions()
  updateUrlFromControls()
  els.dandiSearchStatus.value = `${added.length} store${added.length === 1 ? '' : 's'} selected. Press Load volume when ready.`
}

function createDandiStainGroup(group: DandiZarrAssetGroup): HTMLElement {
  const article = document.createElement('article')
  article.className = 'dandi-stain-group'

  const header = document.createElement('div')
  header.className = 'dandi-stain-heading'
  const copy = document.createElement('span')
  const title = document.createElement('strong')
  title.textContent = group.stain
  const metadata = document.createElement('small')
  const acquisition = [
    group.run ? `run ${group.run}` : null,
    group.variant?.replaceAll('_', ' ') ?? null,
  ].filter(Boolean)
  metadata.textContent = `${group.members.length} chunk${group.members.length === 1 ? '' : 's'} · ${formatBytes(group.size)}${acquisition.length > 0 ? ` · ${acquisition.join(' · ')}` : ''}`
  copy.append(title, metadata)

  const addAll = document.createElement('button')
  addAll.type = 'button'
  addAll.className = 'dandi-add-group'
  addAll.setAttribute(
    'aria-label',
    `Add all ${group.members.length} ${group.stain} chunks from sample ${group.sample}`,
  )
  dandiGroupByAddButton.set(addAll, group)
  addAll.addEventListener('click', () => {
    addDandiAssets(group.members.map(({ asset }) => asset))
  })
  header.append(copy, addAll)

  const chunks = document.createElement('details')
  chunks.className = 'dandi-chunk-details'
  const summary = document.createElement('summary')
  summary.textContent = `Review ${group.members.length} chunks`
  const chunkList = document.createElement('div')
  chunkList.className = 'dandi-chunk-list'
  chunkList.append(
    ...group.members.map(({ asset, chunk }) =>
      createDandiChunkResult(asset, chunk),
    ),
  )
  chunks.append(summary, chunkList)
  article.append(header, chunks)
  return article
}

function renderDandiResults(assets: DandiZarrAsset[]): {
  groupCount: number
  ungroupedCount: number
} {
  els.dandiResults.replaceChildren()
  dandiAssetByStoreUrl.clear()
  for (const asset of assets) dandiAssetByStoreUrl.set(asset.storeUrl, asset)

  const hierarchy = buildDandiZarrAssetHierarchy(assets)
  const groupsBySubject = new Map<string, DandiZarrAssetGroup[]>()
  for (const group of hierarchy.groups) {
    const subjectGroups = groupsBySubject.get(group.subject) ?? []
    subjectGroups.push(group)
    groupsBySubject.set(group.subject, subjectGroups)
  }

  for (const [subject, subjectGroups] of groupsBySubject) {
    const subjectDetails = document.createElement('details')
    subjectDetails.className = 'dandi-subject'
    subjectDetails.open = groupsBySubject.size === 1
    const subjectSummary = document.createElement('summary')
    const subjectName = document.createElement('strong')
    subjectName.textContent = `Subject ${subject}`
    const sampleKeys = new Set(
      subjectGroups.map((group) => `${group.session}\u0000${group.sample}`),
    )
    const subjectMetadata = document.createElement('small')
    subjectMetadata.textContent = `${sampleKeys.size} sample session${sampleKeys.size === 1 ? '' : 's'} · ${subjectGroups.reduce((sum, group) => sum + group.members.length, 0).toLocaleString()} stores`
    subjectSummary.append(subjectName, subjectMetadata)
    subjectDetails.append(subjectSummary)

    const groupsBySample = new Map<string, DandiZarrAssetGroup[]>()
    for (const group of subjectGroups) {
      const sampleKey = `${group.session}\u0000${group.sample}`
      const sampleGroups = groupsBySample.get(sampleKey) ?? []
      sampleGroups.push(group)
      groupsBySample.set(sampleKey, sampleGroups)
    }

    for (const sampleGroups of groupsBySample.values()) {
      const first = sampleGroups[0]!
      const sampleDetails = document.createElement('details')
      sampleDetails.className = 'dandi-sample'
      sampleDetails.open = groupsBySample.size === 1
      const sampleSummary = document.createElement('summary')
      const sampleName = document.createElement('strong')
      sampleName.textContent = `Sample ${first.sample}`
      const sampleMetadata = document.createElement('small')
      sampleMetadata.textContent = `Session ${first.session} · ${sampleGroups.length} stain group${sampleGroups.length === 1 ? '' : 's'}`
      sampleSummary.append(sampleName, sampleMetadata)
      sampleDetails.append(sampleSummary)
      for (const group of sampleGroups) {
        sampleDetails.append(createDandiStainGroup(group))
      }
      subjectDetails.append(sampleDetails)
    }
    els.dandiResults.append(subjectDetails)
  }

  if (hierarchy.ungrouped.length > 0) {
    const ungrouped = document.createElement('details')
    ungrouped.className = 'dandi-subject'
    const summary = document.createElement('summary')
    summary.textContent = `Other results · ${hierarchy.ungrouped.length}`
    ungrouped.append(summary)
    for (const asset of hierarchy.ungrouped) {
      ungrouped.append(createDandiChunkResult(asset))
    }
    els.dandiResults.append(ungrouped)
  }

  syncDandiGroupActions()
  return {
    groupCount: hierarchy.groups.length,
    ungroupedCount: hierarchy.ungrouped.length,
  }
}

async function searchDandiAssets(): Promise<void> {
  dandiSearchController?.abort()
  const controller = new AbortController()
  dandiSearchController = controller
  els.searchDandi.disabled = true
  els.dandiSearchStatus.value = 'Searching DANDI…'
  els.dandiResults.replaceChildren()
  try {
    const result = await searchDandiZarrAssets(
      els.dandisetId.value.trim(),
      els.dandiVersion.value.trim(),
      els.dandiQuery.value,
      { signal: controller.signal },
    )
    if (controller.signal.aborted) return
    const hierarchy = renderDandiResults(result.assets)
    els.dandiSearchStatus.value =
      result.count === 0
        ? 'No matching OME-Zarr assets.'
        : result.complete
          ? `Showing ${result.assets.length.toLocaleString()} OME-Zarr stores in ${hierarchy.groupCount.toLocaleString()} stain group${hierarchy.groupCount === 1 ? '' : 's'}${hierarchy.ungroupedCount > 0 ? `, plus ${hierarchy.ungroupedCount.toLocaleString()} other result${hierarchy.ungroupedCount === 1 ? '' : 's'}` : ''}.`
          : `Showing the first ${result.assets.length.toLocaleString()} of ${result.count.toLocaleString()} matching OME-Zarr stores. Refine the search to browse complete stain groups.`
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

function pyramidLevels(
  source: LoadedSource | null,
): readonly { level: number }[] {
  if (source?.kind === 'omezarr') return source.levels
  if (source?.kind === 'omezarr-mosaic') return source.levels
  return []
}

function syncZarrLevelControl(): void {
  const isOmezarr = currentSourceKind() === 'omezarr'
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
  els.zoom.min = '0'
  els.zoom.max = String(Math.max(0, levels.length - 1))
  els.zoom.step = '1'
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
    'detailBudget',
    'equalViews',
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
  url.searchParams.set('detailBudget', String(currentDetailBudgetGiB()))
  url.searchParams.set('layout', String(Number(els.layout.value)))
  url.searchParams.delete('equalViews')
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
    crosshairSpacing: manifest.spacing,
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
  decodedCache: DecodedChunkCache,
  readSession: ZarrReadSession,
): Promise<OmezarrSource> {
  const isInitialCustomLoad = initializeWindow
  const storeUrl = profile.storeUrl()
  const baseStore = new zarr.FetchStore(storeUrl, {
    fetch: createTrackedZarrFetch(),
  })
  const cachedStore = zarr.withByteCaching(
    withInflightReadDeduplication(baseStore),
    { cache: new ByteLruCache(ZARR_BYTE_CACHE_BYTES) },
  )
  const store = await withOptionalConsolidatedMetadata(
    cachedStore,
    readSession.signal,
  )
  const root = zarr.root(store)
  const group = await zarr.open(root, {
    kind: 'group',
    signal: readSession.signal,
  })
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
      const openedArray = await zarr.open(
        root.resolve(`/${levelDataset.path}`),
        {
          kind: 'array',
          signal: readSession.signal,
        },
      )
      const array = withDecodedChunkCaching(openedArray, {
        cache: decodedCache,
        namespace: `${profile.id}\0${levelDataset.path}`,
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
    crosshairSpacing: finest.spacing,
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
    decodedCache,
  }
}

async function loadOmezarrSource(
  readSession: ZarrReadSession,
): Promise<OmezarrSource | OmezarrMosaicSource> {
  const profiles = currentStoreUrls().map(customProfile)
  if (profiles.length === 0) {
    throw new Error(
      els.source.value === 'dandi'
        ? 'Search DANDI and select at least one OME-Zarr asset before loading'
        : 'Add at least one OME-Zarr store URL before loading',
    )
  }
  const decodedCache = new DecodedChunkCache(DECODED_CHUNK_CACHE_BYTES)
  const initializeWindow = shouldInitializeCustomSource
  const first = await openOmezarrSource(
    profiles[0] as OmezarrProfile,
    requestedBaseLevel,
    initializeWindow,
    decodedCache,
    readSession,
  )
  requestedBaseLevel = first.baseLevel
  if (fixedZarrLevel !== null) fixedZarrLevel = first.baseLevel
  updateUrlFromControls()
  shouldInitializeCustomSource = false
  if (profiles.length === 1) return first
  const rest = await Promise.all(
    profiles.slice(1).map((profile) =>
      openOmezarrSource(
        profile,
        first.baseLevel,
        false,
        decodedCache,
        readSession,
      ),
    ),
  )
  const sources = [first, ...rest]
  for (const source of sources) {
    if (source.dtype !== first.dtype) {
      throw new Error(
        `Store ${source.id} uses ${source.dtype}; all translated stores must use ${first.dtype}`,
      )
    }
    if (source.levels.length !== first.levels.length) {
      throw new Error(
        `Store ${source.id} has ${source.levels.length} pyramid levels; all translated stores must have ${first.levels.length}`,
      )
    }
  }
  const mosaicLevels = first.levels.map(
    (_, levelIndex): OmezarrMosaicLevel => {
      const sourceLevels = sources.map((source) => {
        const level = source.levels[levelIndex]
        if (!level) {
          throw new Error(`Store ${source.id} has no pyramid level ${levelIndex}`)
        }
        return { source, level }
      })
      const layout = layoutTranslatedBlocks(
        sourceLevels.map(({ source, level }) => ({
          id: source.id,
          shape: level.shape,
          spacing: level.spacing,
          translation: level.translation,
        })),
      )
      const blocks = layout.blocks.map(
        (block, index): OmezarrMosaicBlock => {
          const sourceLevel = sourceLevels[index]
          if (!sourceLevel) {
            throw new Error('Translated store layout is incomplete')
          }
          return {
            ...block,
            source: sourceLevel.source,
            level: sourceLevel.level,
          }
        },
      )
      return {
        level: levelIndex,
        shape: layout.shape,
        spacing: layout.spacing,
        worldOrigin: layout.worldOrigin,
        blocks,
      }
    },
  )
  const finest = mosaicLevels[0]
  const selected = mosaicLevels[first.baseLevel]
  if (!finest || !selected) {
    throw new Error('The translated mosaic has no readable pyramid levels')
  }
  const grid = renderCropGrid(
    selected.shape,
    STREAMING_CHUNK_EDGE,
    STREAMING_CHUNK_HALO,
  )
  return {
    kind: 'omezarr-mosaic',
    id: translatedMosaicId(sources.map((source) => source.id)),
    name: `${sources.length}-store translated OME-Zarr mosaic`,
    shape: finest.shape,
    spacing: finest.spacing,
    crosshairSpacing: first.crosshairSpacing,
    dtype: first.dtype,
    datatypeCode: first.datatypeCode,
    numBitsPerVoxel: first.numBitsPerVoxel,
    defaultWindow: first.defaultWindow,
    chunkGrid: grid,
    chunkShape: selected.shape.map((size, axis) =>
      Math.ceil(size / grid[axis]),
    ) as Shape3,
    chunkCount: grid[0] * grid[1] * grid[2],
    sourceUrl: sources.map((source) => source.sourceUrl).join(' + '),
    transportLabel: `${sources.length} translated OME-Zarr stores`,
    baseLevel: first.baseLevel,
    worldOrigin: finest.worldOrigin,
    levels: mosaicLevels,
    decodedCache,
  }
}

async function loadActiveSource(
  readSession: ZarrReadSession,
): Promise<LoadedSource> {
  return currentSourceKind() === 'omezarr'
    ? loadOmezarrSource(readSession)
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
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const [x0, y0, z0] = request.texOrigin
  const [sx, sy, sz] = request.texDims
  const selection: Array<number | zarr.Slice> = []
  for (let i = 0; i < level.array.shape.length - 3; i++) selection.push(0)
  selection.push(zarr.slice(z0, z0 + sz))
  selection.push(zarr.slice(y0, y0 + sy))
  selection.push(zarr.slice(x0, x0 + sx))

  const view = await zarr.get(level.array, selection, { signal })
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
  level: number,
  origin: Shape3,
  dims: Shape3,
): string {
  return `mosaic:${level}:${origin.join(',')}:${dims.join(',')}`
}

async function fetchMosaicRegion(
  level: OmezarrMosaicLevel,
  origin: Shape3,
  dims: Shape3,
  bytesPerVoxel: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const fetched = await Promise.all(
    level.blocks.map(async (block): Promise<FetchedMosaicBlock | null> => {
      const window = mosaicSamplingWindow(
        block.voxelOrigin,
        block.shape,
        origin,
        dims,
      )
      if (!window) return null
      const bytes = await fetchOmezarrRegion(
        block.level,
        {
          levelIndex: block.level.level,
          texOrigin: window.sourceOrigin,
          texDims: window.sourceDims,
          bytesPerVoxel,
        },
        signal,
      )
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

function createMosaicPyramidSource(
  source: OmezarrMosaicSource,
  readSession: ZarrReadSession,
): ChunkedVolumeSource {
  return createMosaicChunkedVolumeSource({
    datatypeCode: source.datatypeCode,
    levels: source.levels,
    signal: () => readSession.signal,
    concurrency: ZARR_REGION_CONCURRENCY,
    fetchRegion: async (level, request, signal) => {
      const key = mosaicRequestKey(
        level.level,
        request.texOrigin,
        request.texDims,
      )
      stats.requested.add(key)
      renderHud()
      try {
        const bytes = await fetchMosaicRegion(
          level,
          request.texOrigin,
          request.texDims,
          request.bytesPerVoxel,
          signal,
        )
        observeChunkForAutoWindow(source, bytes)
        stats.completed.add(key)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      } catch (error) {
        if (!isAbortError(error)) {
          stats.failures++
          renderHud()
        }
        throw error
      }
    },
  })
}

function createOmezarrPyramidSource(
  source: OmezarrSource,
  readSession: ZarrReadSession,
): ChunkedVolumeSource {
  const reads = new AbortableTaskPool(ZARR_REGION_CONCURRENCY)
  return {
    datatypeCode: source.datatypeCode,
    levels: source.levels.map((level) => ({
      level: level.level,
      shape: level.shape,
      spacing: level.spacing,
    })),
    fetchChunk: (request) => {
      const signal = readSession.signal
      return reads.run(signal, async () => {
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
          const bytes = await fetchOmezarrRegion(level, request, signal)
          observeChunkForAutoWindow(source, bytes)
          stats.completed.add(key)
          stats.decodedBytes += bytes.byteLength
          renderHud()
          return bytes
        } catch (err) {
          if (!isAbortError(err)) {
            stats.failures++
            renderHud()
          }
          throw err
        }
      })
    },
  }
}

function createOmezarrRenderCropVolume(
  source: OmezarrSource,
  geometry: ExportGeometry,
  readSession: ZarrReadSession,
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
        const bytes = await fetchOmezarrRegion(
          level,
          {
            levelIndex: level.level,
            texOrigin,
            texDims,
            bytesPerVoxel: request.bytesPerVoxel,
          },
          readSession.signal,
        )
        observeChunkForAutoWindow(source, bytes)
        stats.completed.add(key)
        stats.decodedBytes += bytes.byteLength
        renderHud()
        return bytes
      } catch (error) {
        if (!isAbortError(error)) {
          stats.failures++
          renderHud()
        }
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
  const levelIndex = geometry.level?.level ?? source.baseLevel
  const level = source.levels[levelIndex]
  if (!level) {
    throw new Error(`Translated mosaic level ${levelIndex} is unavailable`)
  }
  setDownloadStatus(
    `Fetching translated L${level.level} field of view...`,
  )
  return fetchMosaicRegion(
    level,
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
  const sourceName =
    source.kind === 'omezarr-mosaic'
      ? `omezarr-mosaic-${source.levels[0]?.blocks.length ?? 0}-stores`
      : source.id
  const cleanId = sourceName
    .replace(/\.ome\.zarr$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '')
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
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
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
  const mosaicLevel =
    source.kind === 'omezarr-mosaic'
      ? source.levels[geometry.level?.level ?? source.baseLevel]
      : undefined
  const volume = buildLogicalVolume({
    id: source.name,
    url: source.sourceUrl,
    shape: geometry.shape,
    spacing: geometry.spacing,
    origin:
      source.kind === 'omezarr-mosaic'
        ? geometry.origin.map(
            (value, axis) =>
              (mosaicLevel?.worldOrigin[axis] ?? source.worldOrigin[axis]) +
              value * geometry.spacing[axis],
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
    const streamsToSelectedFile =
      source.kind !== 'synthetic' && bytes > MAX_IN_MEMORY_NIFTI_BYTES
    if (streamsToSelectedFile) {
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
    setDownloadStatus(
      streamsToSelectedFile
        ? `Saved ${filename}`
        : `Download started: ${filename}`,
    )
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
    return mosaicRequestKey(
      chunk.sourceLevel ?? 0,
      chunk.texOrigin,
      chunk.texDims,
    )
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
  const bounds = currentVisibleFovBounds(plan.volumeDims)
  const levels = new Set<number>()
  for (const chunk of plan.chunks) {
    const intersects = bounds.some((box) =>
      chunk.voxelOrigin.every(
        (origin, axis) =>
          origin < box.max[axis] &&
          origin + chunk.voxelDims[axis] > box.min[axis],
      ),
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
  els.activeLevel.removeAttribute('data-requested-level')
  els.activeLevel.removeAttribute('data-delivered-level')
}

function setVisibleLevel(
  level: number | null,
  label = level === null ? '' : `L${level}`,
  requestedLevel: number | null = null,
): void {
  els.visibleLevel.hidden = level === null || !els.showScaleBar.checked
  els.visibleLevel.value = label
  els.visibleLevel.title =
    level === null
      ? ''
      : requestedLevel !== null && requestedLevel !== level
        ? `Finest Zarr level currently visible: L${level}; camera requested L${requestedLevel}`
        : `Finest Zarr level currently visible: L${level}`
  syncScaleIndicatorVisibility()
}

function syncActiveLodIndicator(plan: ChunkPlan | null): void {
  if (
    activeSource?.kind !== 'omezarr' &&
    activeSource?.kind !== 'omezarr-mosaic'
  ) {
    els.activeLevelControl.hidden = true
    els.activeLevel.value = ''
    els.activeLevel.removeAttribute('data-levels')
    els.activeLevel.removeAttribute('data-fov-levels')
    els.activeLevel.removeAttribute('data-requested-level')
    els.activeLevel.removeAttribute('data-delivered-level')
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
  const display = lodDeliveryDisplay(
    currentDetailLevel,
    fovLevels,
    contextLevels,
  )
  els.activeLevelControl.hidden = false
  els.activeLevel.value = display.visibleLabel
  els.activeLevel.dataset.levels = levels.join(',')
  els.activeLevel.dataset.fovLevels = fovLevels.join(',')
  if (currentDetailLevel === null) {
    els.activeLevel.removeAttribute('data-requested-level')
  } else {
    els.activeLevel.dataset.requestedLevel = String(currentDetailLevel)
  }
  if (display.deliveredLevel === null) {
    els.activeLevel.removeAttribute('data-delivered-level')
  } else {
    els.activeLevel.dataset.deliveredLevel = String(display.deliveredLevel)
  }
  setVisibleLevel(
    display.deliveredLevel,
    display.visibleLabel,
    currentDetailLevel,
  )
  const sourceDetail =
    activeSource.kind === 'omezarr-mosaic'
      ? ` Composite of ${activeSource.levels[0]?.blocks.length ?? 0} translated stores.`
      : ''
  els.activeLevel.title = `Visible FOV: ${fovLabel}.${sourceDetail} Whole plan: ${counts
    .map(([level, count]) => `L${level}: ${count} bricks`)
    .join(', ')}`
}

function httpSummary(): string {
  const metadata =
    stats.metadataHits > 0 ? `${stats.metadataHits} metadata` : ''
  if (stats.rangeHits > 0) {
    const summary = [metadata, `${stats.rangeHits} range 206`]
      .filter(Boolean)
      .join(' + ')
    return `<span class="ok">${summary}</span>`
  }
  if (stats.chunkObjectHits > 0) {
    const summary = [metadata, `${stats.chunkObjectHits} chunk objects`]
      .filter(Boolean)
      .join(' + ')
    return `<span class="ok">${summary}</span>`
  }
  if (stats.fullFileFallbacks > 0) {
    return `<span class="warn">${stats.fullFileFallbacks} full-file 200</span>`
  }
  if (stats.metadataHits > 0) {
    return `<span class="ok">${metadata}</span>`
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
        ? `<div class="row"><span class="key">translated stores</span><span>${source.levels[0]?.blocks.length ?? 0} stores · world origin ${source.worldOrigin.join(', ')} mm</span></div>`
      : ''
  const stream = nv?.chunkStreamStats()
  const decodedCache =
    source.kind === 'synthetic' ? null : source.decodedCache
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
    <div class="row"><span class="key">byte cache</span><span>${stats.cacheHits} hits, ${formatBytes(stats.cacheBytes)}</span></div>
    ${decodedCache ? `<div class="row"><span class="key">decoded cache</span><span>${decodedCache.hits} hits / ${decodedCache.misses} misses, ${formatBytes(decodedCache.byteLength)}</span></div>` : ''}
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

function syncScaleIndicatorVisibility(): void {
  els.scaleIndicators.hidden =
    !els.showScaleBar.checked || !nv || nv.volumes.length === 0
  els.visibleLevel.hidden =
    els.scaleIndicators.hidden || els.visibleLevel.value.length === 0
}

function syncTileLoadingIndicator(): void {
  const stream = nv?.chunkStreamStats()
  const count = loadingTileCount(stream?.pending, stream?.inFlight)
  if (count !== displayedLoadingTiles) {
    displayedLoadingTiles = count
    els.tileLoading.value = `${count} tile${count === 1 ? '' : 's'} loading`
    els.tileLoading.dataset.loading = String(count)
  }
  syncScaleIndicatorVisibility()
}

function syncScaleBarVisibility(): void {
  if (nv) {
    nv.isRulerVisible = els.showScaleBar.checked
    nv.drawScene()
  }
  els.visibleLevel.hidden =
    !els.showScaleBar.checked || els.visibleLevel.value.length === 0
  syncScaleIndicatorVisibility()
  syncTileLoadingIndicator()
}

function syncCrosshairVisibility(): void {
  if (!nv) return
  // Slice crosshairs are measured in screen pixels while the 3D crosshair is
  // measured in world units. Do not draw the world-space cylinder in the
  // multiplanar preview, where a readable slice crosshair would be enormous.
  nv.is3DCrosshairVisible =
    els.showCrosshair.checked && nv.sliceType === SLICE_TYPE.RENDER
  nv.isCrossLinesVisible = false
  els.canvas.dataset.crosshairVisible = els.showCrosshair.checked ? '1' : '0'
  syncCrosshairAppearance()
  nv.drawScene()
  syncCrosshairOverlay()
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

function handleMeasurementContextMenu(event: MouseEvent): void {
  if (!nv || event.shiftKey || nv.model.completedMeasurements.length === 0) return
  const rect = els.canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const scaleX = els.canvas.width / rect.width
  const scaleY = els.canvas.height / rect.height
  const point: [number, number] = [
    (event.clientX - rect.left) * scaleX,
    (event.clientY - rect.top) * scaleY,
  ]
  const planeTolerance =
    Math.max(...(activeSource?.crosshairSpacing ?? [1, 1, 1])) * 0.5
  const index = measurementIndexAtCanvasPoint(
    nv.model.completedMeasurements,
    nv.view?.screenSlices ?? [],
    point,
    12 * Math.max(scaleX, scaleY),
    planeTolerance,
  )
  if (index < 0) return
  event.preventDefault()
  nv.model.completedMeasurements.splice(index, 1)
  nv.drawScene()
  const remaining = nv.model.completedMeasurements.length
  els.clearMeasurements.disabled = remaining === 0
  els.measurementStatus.value =
    remaining === 0
      ? 'drag across a structure'
      : `${remaining} measurement${remaining === 1 ? '' : 's'} · right-click to remove`
}

function resetRenderCropForSourceChange(): void {
  clearMeasurements()
  renderCropGeometry = null
  sliceViewBeforeRender = null
  if (!nv || nv.sliceType !== SLICE_TYPE.RENDER) return
  els.layout.value = String(LAYOUT_PRESET.AXIAL_FOCUS)
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
    syncTileLoadingIndicator()
    syncCrosshairOverlay()
    renderHud()
    pollHandle = requestAnimationFrame(tick)
  }
  pollHandle = requestAnimationFrame(tick)
}

function selectedLayoutConfig() {
  return viewerLayoutConfig(Number(els.layout.value))
}

function selectedSliceType(): number {
  return selectedLayoutConfig().sliceType
}

function applyLayout(): void {
  if (!nv) return
  const layout = selectedLayoutConfig()
  nv.customLayout = null
  nv.showRender = layout.showRender
  nv.multiplanarType = layout.multiplanarType
  nv.isEqualSize = layout.isEqualSize
  nv.sliceType = layout.sliceType
  nv.customLayout = layout.customLayout
  requestAnimationFrame(() => {
    syncPrototypeStreamingState()
    scheduleAdaptiveLod(true)
  })
  syncCrosshairVisibility()
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
    if (activeReadSession) activeReadSession.renew()
    else activeReadSession = new ZarrReadSession()
    setActiveLodLoading(geometry.level?.level)
    await disposeChunkedVolume()
    nv.sliceType = SLICE_TYPE.RENDER
    await loadOmezarrRenderCrop(source, geometry, activeReadSession)
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
  const targetLayout = selectedSliceType()
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
  } catch (error) {
    const view = sliceViewBeforeRender
    renderCropGeometry = null
    sliceViewBeforeRender = null
    els.layout.value = String(LAYOUT_PRESET.AXIAL_FOCUS)
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
    layout: Number(els.layout.value),
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
    detailBudgetGiB: currentDetailBudgetGiB(),
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

function visibleSliceAxes(): number[] | null {
  const sliceType = nv?.sliceType ?? selectedSliceType()
  if (sliceType === SLICE_TYPE.MULTIPLANAR) return [0, 1, 2]
  if (sliceType === SLICE_TYPE.SAGITTAL) return [0]
  if (sliceType === SLICE_TYPE.CORONAL) return [1]
  if (sliceType === SLICE_TYPE.AXIAL) return [2]
  return null
}

function currentVisibleFovBounds(
  shape: Shape3,
  focus: Shape3 = focusFraction,
  zoom = viewerZoom(),
) {
  const sliceAxes = visibleSliceAxes()
  if ((nv?.sliceType ?? selectedSliceType()) !== SLICE_TYPE.MULTIPLANAR) {
    return visibleFovBounds(shape, focus, zoom, sliceAxes)
  }
  return screenSliceStreamingBounds(shape, focus, zoom) ??
    visibleFovBounds(shape, focus, zoom, sliceAxes)
}

function screenSliceStreamingBounds(
  shape: Shape3,
  focus: Shape3 = focusFraction,
  zoom = viewerZoom(),
): PrototypeFovBounds[] | null {
  if (!nv || nv.sliceType !== SLICE_TYPE.MULTIPLANAR) return null
  const screenSlices = nv.view?.screenSlices ?? []
  const pan = nv.pan2Dxyzmm
  const volume = nv.volumes[0]
  const volumeMin = volume?.extentsMin
  const volumeMax = volume?.extentsMax
  if (!volumeMin || !volumeMax) return null
  const crosshair = nv.crosshairPos
  const sliceFractions = [0, 1, 2].map((axis) => {
    const fraction = crosshair[axis]
    return Number.isFinite(fraction) ? fraction : focus[axis]
  }) as Shape3
  const bounds = prototypeStreamingFovBoundsFromScreenSlices(
    shape,
    [volumeMin[0], volumeMin[1], volumeMin[2]],
    [volumeMax[0], volumeMax[1], volumeMax[2]],
    sliceFractions,
    [pan[0] ?? 0, pan[1] ?? 0, pan[2] ?? 0, zoom],
    screenSlices,
  )
  return bounds.length === 3 ? bounds : null
}

function syncPrototypeStreamingState(): void {
  if (!activeSource) return
  const bounds = screenSliceStreamingBounds(activeSource.shape)
  els.canvas.dataset.streamingFovMode = bounds ? 'screen-slices' : 'fallback'
  els.canvas.dataset.streamingSlabSpans = (bounds ?? [])
    .map((slab) =>
      slab.max
        .map((maximum, axis) =>
          Number((maximum - slab.min[axis]).toFixed(3)),
        )
        .join('x'),
    )
    .join(';')
  els.canvas.dataset.streamingSlabBounds = (bounds ?? [])
    .map(
      (slab) =>
        `${slab.min.map((value) => Number(value.toFixed(3))).join(',')}:` +
        slab.max.map((value) => Number(value.toFixed(3))).join(','),
    )
    .join(';')
  els.canvas.dataset.streamingScreenRects = (nv?.view?.screenSlices ?? [])
    .filter((tile) => tile.axCorSag !== SLICE_TYPE.RENDER)
    .map((tile) =>
      (tile.leftTopWidthHeight ?? [])
        .map((value) => Number(value.toFixed(1)))
        .join(','),
    )
    .join(';')
  els.canvas.dataset.streamingScreenLayout = (nv?.view?.screenSlices ?? [])
    .map(
      (tile) =>
        `${tile.axCorSag}:` +
        (tile.leftTopWidthHeight ?? [])
          .map((value) => Number(value.toFixed(1)))
          .join(','),
    )
    .join(';')
  delete els.canvas.dataset.streamingPrimaryPlane
  delete els.canvas.dataset.streamingAxisZooms
}

function syncCrosshairAppearance(): void {
  if (!nv || !activeSource) return
  const isRender = nv.sliceType === SLICE_TYPE.RENDER
  const cameraZoom = Number.isFinite(nv.scaleMultiplier) && nv.scaleMultiplier > 0
    ? nv.scaleMultiplier
    : 1
  const crosshair = !els.showCrosshair.checked
    ? { width: 0, gap: 0 }
    : isRender
      ? crosshairAppearanceForSpacing(activeSource.crosshairSpacing, cameraZoom)
      : { width: 2, gap: 8 }
  // Update both related values before the next frame. The individual NiiVue
  // setters each redraw, which would add two redundant renders per wheel event.
  nv.model.ui.crosshairWidth = crosshair.width
  nv.model.ui.crosshairGap = crosshair.gap
  els.canvas.dataset.crosshairWidth = String(crosshair.width)
  els.canvas.dataset.crosshairGap = String(crosshair.gap)
}

function syncCrosshairOverlay(): void {
  if (!nv || !els.showCrosshair.checked || nv.volumes.length === 0) {
    els.crosshairOverlay.setAttribute('hidden', '')
    return
  }
  const point = nv.getCrosshairPos()
  const paths: string[] = []
  const deviceScale = els.canvas.width / Math.max(1, els.canvas.clientWidth)
  const gap = 8 * deviceScale
  for (const tile of nv.view?.screenSlices ?? []) {
    const rect = tile.leftTopWidthHeight
    const matrix = tile.mvpMatrix
    if (!rect || !matrix || tile.axCorSag === SLICE_TYPE.RENDER) continue
    const [worldX, worldY, worldZ] = point
    const clipX =
      matrix[0] * worldX +
      matrix[4] * worldY +
      matrix[8] * worldZ +
      matrix[12]
    const clipY =
      matrix[1] * worldX +
      matrix[5] * worldY +
      matrix[9] * worldZ +
      matrix[13]
    const clipW =
      matrix[3] * worldX +
      matrix[7] * worldY +
      matrix[11] * worldZ +
      matrix[15]
    if (!Number.isFinite(clipW) || Math.abs(clipW) < 1e-8) continue
    const x = rect[0] + ((clipX / clipW + 1) * rect[2]) / 2
    const y = rect[1] + ((1 - clipY / clipW) * rect[3]) / 2
    const left = rect[0]
    const top = rect[1]
    const right = left + rect[2]
    const bottom = top + rect[3]
    if (x < left || x > right || y < top || y > bottom) continue
    paths.push(
      `M${left},${y}L${Math.max(left, x - gap)},${y}`,
      `M${Math.min(right, x + gap)},${y}L${right},${y}`,
      `M${x},${top}L${x},${Math.max(top, y - gap)}`,
      `M${x},${Math.min(bottom, y + gap)}L${x},${bottom}`,
    )
  }
  const path = paths.join('')
  els.crosshairOverlay.setAttribute(
    'viewBox',
    `0 0 ${els.canvas.width} ${els.canvas.height}`,
  )
  els.crosshairOverlay.toggleAttribute('hidden', path.length === 0)
  if (path === displayedCrosshairPath) return
  displayedCrosshairPath = path
  els.crosshairOutline.setAttribute('d', path)
  els.crosshairLines.setAttribute('d', path)
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

function axialSliceCount(): number {
  const count = activeSource?.shape[2] ?? 0
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

function axialSliceNavigationEnabled(): boolean {
  if (!nv || nv.volumes.length === 0 || axialSliceCount() <= 1) return false
  return nv.sliceType !== SLICE_TYPE.RENDER
}

function syncAxialSliceControl(): void {
  const count = axialSliceCount()
  const fraction = nv?.crosshairPos[2] ?? 0.5
  const index = axialSliceIndex(fraction, count)
  els.axialSlice.min = '0'
  els.axialSlice.max = String(Math.max(0, count - 1))
  els.axialSlice.value = String(index)
  els.axialSlice.disabled = !axialSliceNavigationEnabled()
  els.axialSliceValue.value = count > 0 ? `${index + 1} / ${count}` : '—'
  els.axialSliceHelp.textContent =
    'Use the slider or arrow keys in the viewer to move through axial slices.'
}

function setAxialSlice(index: number): void {
  if (!nv || !axialSliceNavigationEnabled()) return
  const count = axialSliceCount()
  const boundedIndex = Math.min(count - 1, Math.max(0, index))
  const fraction = axialSliceFraction(boundedIndex, count)
  const current = nv.crosshairPos
  nv.crosshairPos = [current[0] ?? 0.5, current[1] ?? 0.5, fraction]
  focusFraction = [focusFraction[0], focusFraction[1], fraction]
  // At detail zooms, sagittal and coronal panels show only a narrow Z span.
  // Follow the selected axial slice on that shared axis while preserving the
  // user's X/Y framing. At overview zoom, zero pan keeps the full range visible.
  const pan = nv.pan2Dxyzmm
  const centeredZ = pan[3] > 1 ? panForCrosshair()[2] : 0
  nv.pan2Dxyzmm = [pan[0], pan[1], centeredZ, pan[3]]
  syncPrototypeStreamingState()
  syncViewControls()
  syncDownloadControl()
  scheduleAdaptiveLod(true)
}

function applyAxialSliceControl(): void {
  setAxialSlice(Number(els.axialSlice.value))
}

function handleAxialSliceKeys(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('input, select, textarea, button'))
  ) {
    return
  }
  const direction =
    event.key === 'ArrowRight' || event.key === 'ArrowUp'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? -1
        : 0
  if (direction === 0 || !axialSliceNavigationEnabled()) return
  event.preventDefault()
  event.stopPropagation()
  const next = Math.min(
    Number(els.axialSlice.max),
    Math.max(0, Number(els.axialSlice.value) + direction),
  )
  setAxialSlice(next)
}

function syncViewControls(): void {
  const levels = pyramidLevels(activeSource)
  const levelCount = levels.length
  const appliedLevel =
    levelCount === 0
      ? 0
      : fixedZarrLevel ??
        detailLevelForZoom(levelCount - 1, viewerZoom(), levelCount)
  const zoomDisplay = zoomLevelControlDisplay(
    appliedLevel,
    pendingZoomLevel,
    levelCount,
  )
  els.zoom.value = String(zoomDisplay.value)
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
  const zoomDisabled = !nv || nv.volumes.length === 0 || levelCount === 0
  els.zoom.disabled = zoomDisabled
  els.applyZoom.disabled = zoomDisabled || !zoomDisplay.canApply
  syncAxialSliceControl()
}

function currentScrollZoomSpeed(): number {
  const speed = Number(els.scrollZoomSpeed.value)
  return Number.isFinite(speed) ? Math.min(10, Math.max(0.25, speed)) : 5
}

function syncScrollZoomSpeed(): void {
  const speed = currentScrollZoomSpeed()
  els.scrollZoomSpeed.value = String(speed)
  els.scrollZoomSpeedValue.value = `${Number(speed.toFixed(2))}×`
}

function currentDetailBudgetGiB(): number {
  const budget = Number(els.detailBudget.value)
  return Number.isFinite(budget)
    ? Math.min(8, Math.max(0.5, budget))
    : DEFAULT_DETAIL_BUDGET_GIB
}

function currentDetailBudgetBytes(): number {
  return currentDetailBudgetGiB() * 1024 * 1024 * 1024
}

function syncDetailBudget(): void {
  const budget = currentDetailBudgetGiB()
  els.detailBudget.value = String(budget)
  els.detailBudgetValue.value = `${Number(budget.toFixed(1))} GiB`
}

function applyDetailBudget(): void {
  syncDetailBudget()
  updateUrlFromControls()
  if (!chunkedVolume) return
  activeReadSession?.renew()
  setActiveLodLoading(currentDetailLevel ?? undefined)
  chunkedVolume.setBudget(currentDetailBudgetBytes())
  syncDownloadControl()
}

function updateZoomSelection(): void {
  const level = Number(els.zoom.value)
  pendingZoomLevel = Number.isInteger(level) && level >= 0 ? level : null
  syncViewControls()
}

function applyZoomControl(): void {
  if (!nv) return
  const level = pendingZoomLevel
  const levelCount = pyramidLevels(activeSource).length
  if (level === null || levelCount === 0) return
  pendingZoomLevel = null
  fixedZarrLevel = null
  const zoom = zoomForDetailLevel(level, levelCount)
  if (nv.sliceType === SLICE_TYPE.RENDER) {
    nv.scaleMultiplier = zoom
  } else {
    const pan = nv.pan2Dxyzmm
    nv.pan2Dxyzmm = [pan[0], pan[1], pan[2], zoom]
    nv.scaleMultiplier = zoom
  }
  syncCrosshairAppearance()
  syncPrototypeStreamingState()
  nv.drawScene()
  updateUrlFromControls()
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
  pendingZoomLevel = null
  if (fixedZarrLevel !== null) {
    fixedZarrLevel = null
    updateUrlFromControls()
  }
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
  syncCrosshairAppearance()
  syncPrototypeStreamingState()
  nv.drawScene()
  syncViewControls()
  syncDownloadControl()
  scheduleAdaptiveLod()
}

function detailLevelForView(
  source: OmezarrSource | OmezarrMosaicSource,
  zoom: number,
): number {
  if (fixedZarrLevel !== null) {
    return Math.min(
      source.levels.length - 1,
      Math.max(0, fixedZarrLevel),
    )
  }
  return detailLevelForZoom(
    source.levels.length - 1,
    zoom,
    source.levels.length,
  )
}

let currentDetailLevel: number | null = null

function adaptiveRequestKey(
  targetLevel: number,
  focus: Shape3,
  bounds: PrototypeFovBounds[],
): string {
  const roundedFocus = focus.map((value) => value.toFixed(6)).join(',')
  const roundedBounds = bounds
    .map((slab) =>
      [...slab.min, ...slab.max]
        .map((value) => value.toFixed(3))
        .join(','),
    )
    .join(';')
  return `${targetLevel}|${roundedFocus}|${roundedBounds}`
}

function scheduleAdaptiveLod(focusMoved = false): void {
  if (suppressAdaptiveEvents) {
    deferredAdaptiveLod = true
    deferredAdaptiveFocusMoved ||= focusMoved
    return
  }
  if (
    (activeSource?.kind === 'omezarr' ||
      activeSource?.kind === 'omezarr-mosaic') &&
    chunkedVolume
  ) {
    const target = detailLevelForView(activeSource, viewerZoom())
    const bounds = currentVisibleFovBounds(activeSource.shape)
    const requestKey = adaptiveRequestKey(target, focusFraction, bounds)
    if (requestKey === lastAdaptiveRequestKey) return
    lastAdaptiveRequestKey = requestKey
    activeReadSession?.renew()
    const targetChanged = updateAdaptiveLodDetail(
      chunkedVolume,
      currentDetailLevel,
      target,
    )
    currentDetailLevel = target
    if (targetChanged) setActiveLodLoading(target)
    chunkedVolume.setFocus(
      focusFraction,
      bounds,
    )
    return
  }
}

async function disposeChunkedVolume(): Promise<void> {
  chunkedVolume?.dispose()
  chunkedVolume = null
  currentDetailLevel = null
  lastAdaptiveRequestKey = null
  if (nv && nv.volumes.length > 0) await nv.removeAllVolumes()
}

async function loadOmezarrVolume(
  source: OmezarrSource,
  view: ViewState | null,
  readSession: ZarrReadSession,
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
    createOmezarrPyramidSource(source, readSession),
    {
      id: source.id,
      name: source.name,
      calMin: win.min,
      calMax: win.max,
      colormap: els.colormap.value,
      focus: focusFraction,
      focusBounds: currentVisibleFovBounds(source.shape, focusFraction, zoom),
      radius: fineLodRadiusForShape(source.shape, ADAPTIVE_FINE_RADIUS),
      minLevel,
      budgetBytes: currentDetailBudgetBytes(),
      maxBricks: ADAPTIVE_MAX_BRICKS,
      cellEdge: ADAPTIVE_CELL_EDGE,
      halo: STREAMING_CHUNK_HALO,
      detail: 0.1,
      debounceMs: LOD_DEBOUNCE_MS,
      // Let requests reach the abort-aware pool immediately. The pool preserves
      // the measured-optimal six-wide network/decode concurrency.
      maxConcurrentLoads: ADAPTIVE_MAX_BRICKS,
    },
  )
  chunkedVolume.volume.chunkExplode = { enabled: false }
  chunkPlan = chunkedVolume.currentPlan
  syncActiveLodIndicator(chunkPlan)
  restoreView(view)
  syncCrosshairAppearance()
  nv.drawScene()
}

async function loadMosaicVolume(
  source: OmezarrMosaicSource,
  view: ViewState | null,
  readSession: ZarrReadSession,
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
    createMosaicPyramidSource(source, readSession),
    {
      id: source.id,
      name: source.name,
      calMin: win.min,
      calMax: win.max,
      colormap: els.colormap.value,
      focus: focusFraction,
      focusBounds: currentVisibleFovBounds(source.shape, focusFraction, zoom),
      radius: fineLodRadiusForShape(source.shape, ADAPTIVE_FINE_RADIUS),
      minLevel,
      budgetBytes: currentDetailBudgetBytes(),
      maxBricks: ADAPTIVE_MAX_BRICKS,
      cellEdge: ADAPTIVE_CELL_EDGE,
      halo: STREAMING_CHUNK_HALO,
      detail: 0.1,
      debounceMs: LOD_DEBOUNCE_MS,
      maxConcurrentLoads: ADAPTIVE_MAX_BRICKS,
    },
  )
  chunkedVolume.volume.chunkExplode = { enabled: false }
  chunkPlan = chunkedVolume.currentPlan
  syncActiveLodIndicator(chunkPlan)
  restoreView(view)
  syncCrosshairAppearance()
  nv.drawScene()
}

async function loadOmezarrRenderCrop(
  source: OmezarrSource,
  geometry: ExportGeometry,
  readSession: ZarrReadSession,
): Promise<void> {
  if (!nv) return
  const level = geometry.level
  if (!level) throw new Error('The 3D current FOV has no pyramid level')
  currentDetailLevel = level.level
  const { volume, plan } = createOmezarrRenderCropVolume(
    source,
    geometry,
    readSession,
  )
  await nv.loadVolumes([volume])
  chunkPlan = plan
  syncActiveLodIndicator(plan)
  nv.drawScene()
}

interface ReloadOptions {
  reloadSource?: boolean
  preserveView?: boolean
  view?: ViewState | null
}

function reloadVolume(options: ReloadOptions = {}): Promise<void> {
  const requestState = {
    requestedBaseLevel,
    fixedZarrLevel,
    shouldInitializeCustomSource,
  }
  return reloadQueue
    .run(async (signal) => {
      requestedBaseLevel = requestState.requestedBaseLevel
      fixedZarrLevel = requestState.fixedZarrLevel
      shouldInitializeCustomSource = requestState.shouldInitializeCustomSource
      await performReloadVolume(options, signal)
    })
    .then(() => undefined)
}

async function performReloadVolume(
  options: ReloadOptions,
  taskSignal: AbortSignal,
): Promise<void> {
  if (!nv) return
  hideFallback()
  setDownloadStatus('')
  stats = freshStats()
  let view = options.view !== undefined ? options.view : null
  const cropGeometry = renderCropGeometry
  const nextReadSession = new ZarrReadSession(taskSignal)
  suppressAdaptiveEvents = true
  try {
    if (options.reloadSource || !activeSource) {
      activeSource = null
      autoWindowSession = null
      autoContrastState = null
      els.autoContrast.disabled = true
      chunkPlan = null
      syncDownloadControl()
      const source = await loadActiveSource(nextReadSession)
      taskSignal.throwIfAborted()
      activeReadSession?.abort('OME-Zarr source superseded')
      activeReadSession = nextReadSession
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
    } else {
      activeReadSession?.abort('OME-Zarr view superseded')
      activeReadSession = nextReadSession
    }
    if (!activeSource) {
      throw new Error('No active source selected')
    }
    // Metadata reads can take long enough for the user to move the crosshair.
    // Preserve the newest camera state immediately before swapping volumes,
    // rather than restoring the stale state captured when the reload started.
    if (options.view === undefined && options.preserveView) view = captureView()
    syncCrosshairVisibility()
    await disposeChunkedVolume()
    if (activeSource.kind === 'omezarr') {
      if (renderCropGeometry && nv.sliceType === SLICE_TYPE.RENDER) {
        await loadOmezarrRenderCrop(
          activeSource,
          renderCropGeometry,
          nextReadSession,
        )
      } else {
        await loadOmezarrVolume(activeSource, view, nextReadSession)
      }
    } else if (activeSource.kind === 'omezarr-mosaic') {
      renderCropGeometry = null
      await loadMosaicVolume(activeSource, view, nextReadSession)
    } else {
      chunkPlan = createChunkPlan(activeSource)
      await nv.loadVolumes([createStreamingVolume(activeSource)])
      syncActiveLodIndicator(chunkPlan)
    }
    applyLayout()
    syncViewControls()
  } catch (err) {
    if (taskSignal.aborted) {
      nextReadSession.abort('OME-Zarr reload superseded')
      throw taskSignal.reason
    }
    nextReadSession.abort('OME-Zarr reload failed')
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
    if (taskSignal.aborted) {
      deferredAdaptiveLod = false
      deferredAdaptiveFocusMoved = false
    } else if (deferredAdaptiveLod) {
      const focusMoved = deferredAdaptiveFocusMoved
      deferredAdaptiveLod = false
      deferredAdaptiveFocusMoved = false
      scheduleAdaptiveLod(focusMoved)
    }
  }
}

async function main(): Promise<void> {
  initControlsFromUrl()
  updateUrlFromControls()
  syncStatsVisibility()

  const initialLayout = selectedLayoutConfig()
  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    is3DCrosshairVisible: els.showCrosshair.checked,
    isCrossLinesVisible: false,
    isRulerVisible: els.showScaleBar.checked,
    crosshairWidth: 0.5,
    primaryDragMode: DRAG_MODE.crosshairPan,
    sliceType: initialLayout.sliceType,
    showRender: initialLayout.showRender,
    multiplanarType: initialLayout.multiplanarType,
    isEqualSize: initialLayout.isEqualSize,
    customLayout: initialLayout.customLayout,
    maxTextureDimension3D: STREAMING_CHUNK_EDGE,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)
  syncCrosshairVisibility()
  els.canvas.addEventListener('pointerdown', () => {
    els.canvas.focus({ preventScroll: true })
  })
  els.canvas.addEventListener('contextmenu', handleMeasurementContextMenu)
  els.canvas.addEventListener('wheel', handleWheelZoom, {
    capture: true,
    passive: false,
  })
  nv.addEventListener('change', (event) => {
    if (event.detail.property === 'pan2Dxyzmm') {
      const focusMoved = lodFocusTracksInteraction('pan') && syncFocusFromPan()
      syncCrosshairAppearance()
      syncViewControls()
      syncDownloadControl()
      scheduleAdaptiveLod(focusMoved)
    } else if (event.detail.property === 'scaleMultiplier') {
      syncCrosshairAppearance()
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
  nv.addEventListener('locationChange', () => {
    syncAxialSliceControl()
    syncPrototypeStreamingState()
    scheduleAdaptiveLod(true)
  })

  els.source.addEventListener('change', () => {
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
    updateUrlFromControls()
    void applyLayoutControl()
  })
  els.zoom.addEventListener('input', updateZoomSelection)
  els.zarrLevel.addEventListener('change', () => {
    void applyZarrLevelControl()
  })
  els.scrollZoomSpeed.addEventListener('input', syncScrollZoomSpeed)
  els.detailBudget.addEventListener('input', syncDetailBudget)
  els.detailBudget.addEventListener('change', applyDetailBudget)
  els.zoom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    applyZoomControl()
  })
  els.applyZoom.addEventListener('click', applyZoomControl)
  els.axialSlice.addEventListener('input', applyAxialSliceControl)
  document.addEventListener('keydown', handleAxialSliceKeys, { capture: true })
  for (const control of els.pan) {
    control.addEventListener('input', applyPanControls)
  }
  els.colormap.addEventListener('change', () => {
    void reloadVolume()
  })
  els.autoContrast.addEventListener('click', applyAutoContrast)
  els.windowLevel.addEventListener('input', handleWindowInput)
  els.windowWidth.addEventListener('input', handleWindowInput)
  els.windowMin.addEventListener('input', () => {
    handleWindowRangeInput('min')
  })
  els.windowMax.addEventListener('input', () => {
    handleWindowRangeInput('max')
  })
  els.interactionTool.addEventListener('click', toggleInteractionTool)
  els.showScaleBar.addEventListener('change', syncScaleBarVisibility)
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
  els.clearDandiSelection.addEventListener('click', () => {
    void clearSelectedDandiAssets()
  })
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
    syncScaleBarVisibility()
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
