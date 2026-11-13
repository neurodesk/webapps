import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  NVSlideTileSamples,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'

export type Shape3 = [number, number, number]
export type VolumeAxis = 0 | 1 | 2
export type VolumePlane = 'axial' | 'sagittal' | 'coronal'

export interface PlaneDefinition {
  readonly plane: VolumePlane
  readonly uAxis: VolumeAxis
  readonly vAxis: VolumeAxis
  readonly normalAxis: VolumeAxis
  readonly label: string
}

export const PLANE_DEFINITIONS = {
  axial: {
    plane: 'axial',
    uAxis: 0,
    vAxis: 1,
    normalAxis: 2,
    label: 'Axial',
  },
  sagittal: {
    plane: 'sagittal',
    uAxis: 1,
    vAxis: 2,
    normalAxis: 0,
    label: 'Sagittal',
  },
  coronal: {
    plane: 'coronal',
    uAxis: 0,
    vAxis: 2,
    normalAxis: 1,
    label: 'Coronal',
  },
} as const satisfies Record<VolumePlane, PlaneDefinition>

export interface VolumePlaneSourceOptions {
  id: string
  name: string
  plane: VolumePlane
  index: number
  window: readonly [number, number]
  tileSize?: number
}

export interface PlaneViewportExportLevel {
  level: number
  shape: Shape3
  spacing: Shape3
}

export interface PlaneViewportSlideBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface PlaneViewportExportOptions {
  plane: VolumePlane
  level: PlaneViewportExportLevel
  baseShape: Shape3
  baseNormalIndex: number
  manifestWidth: number
  manifestHeight: number
  slideBounds: PlaneViewportSlideBounds
}

const bytesPerVoxelFor = (datatypeCode: number): number => {
  if (datatypeCode === 2) return 1
  if (datatypeCode === 512) return 2
  throw new Error(
    `NVSlide supports uint8 and uint16 volumes, not datatype ${datatypeCode}`,
  )
}

/**
 * NVSlide's channel window; it needs calMax > calMin, as the old CPU path's
 * one-step minimum span did.
 */
export const windowFor = (
  window: readonly [number, number],
): { calMin: number; calMax: number } => ({
  calMin: window[0],
  calMax: window[1] > window[0] ? window[1] : window[0] + 1,
})

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export function planeSliceIndex(
  baseIndex: number,
  baseCount: number,
  levelCount: number,
): number {
  return Math.min(
    levelCount - 1,
    Math.max(0, Math.floor(((baseIndex + 0.5) * levelCount) / baseCount)),
  )
}

function axisRangeFromSlideBounds(
  minSlide: number,
  maxSlide: number,
  manifestExtent: number,
  voxelCount: number,
): { origin: number; size: number } {
  const safeExtent =
    Number.isFinite(manifestExtent) && manifestExtent > 0
      ? manifestExtent
      : voxelCount
  const first = Math.min(minSlide, maxSlide)
  const last = Math.max(minSlide, maxSlide)
  const unclampedOrigin = Math.floor((first / safeExtent) * voxelCount)
  const origin = clamp(unclampedOrigin, 0, Math.max(0, voxelCount - 1))
  const unclampedEnd = Math.ceil((last / safeExtent) * voxelCount)
  const end = clamp(unclampedEnd, origin + 1, voxelCount)
  return { origin, size: end - origin }
}

export function planeViewportExportGeometry(
  options: PlaneViewportExportOptions,
): PlaneViewportExportLevel & { origin: Shape3 } {
  const definition = PLANE_DEFINITIONS[options.plane]
  const origin: Shape3 = [0, 0, 0]
  const shape: Shape3 = [1, 1, 1]
  const uRange = axisRangeFromSlideBounds(
    options.slideBounds.minX,
    options.slideBounds.maxX,
    options.manifestWidth,
    options.level.shape[definition.uAxis],
  )
  const vRange = axisRangeFromSlideBounds(
    options.slideBounds.minY,
    options.slideBounds.maxY,
    options.manifestHeight,
    options.level.shape[definition.vAxis],
  )
  origin[definition.uAxis] = uRange.origin
  shape[definition.uAxis] = uRange.size
  origin[definition.vAxis] = vRange.origin
  shape[definition.vAxis] = vRange.size

  const normalCount = options.level.shape[definition.normalAxis]
  const baseNormalCount = options.baseShape[definition.normalAxis]
  const normalIndex = planeSliceIndex(
    options.baseNormalIndex,
    baseNormalCount,
    normalCount,
  )
  const cropFraction = Math.min(
    1,
    Math.max(
      uRange.size / options.level.shape[definition.uAxis],
      vRange.size / options.level.shape[definition.vAxis],
    ),
  )
  const normalSize = Math.max(
    1,
    Math.min(normalCount, Math.ceil(normalCount * cropFraction)),
  )
  origin[definition.normalAxis] = clamp(
    Math.round(normalIndex - normalSize * 0.5),
    0,
    normalCount - normalSize,
  )
  shape[definition.normalAxis] = normalSize

  return {
    level: options.level.level,
    shape,
    spacing: options.level.spacing,
    origin,
  }
}

export function planeChunkRequest(
  definition: PlaneDefinition,
  level: NVSlideLevelManifest,
  tile: NVSlideTileManifest,
  normalIndex: number,
  bytesPerVoxel: number,
): ChunkedVolumeFetch {
  const texOrigin: Shape3 = [0, 0, 0]
  const texDims: Shape3 = [1, 1, 1]
  texOrigin[definition.uAxis] = tile.x * (level.tileWidth ?? tile.width)
  texOrigin[definition.vAxis] = tile.y * (level.tileHeight ?? tile.height)
  texOrigin[definition.normalAxis] = normalIndex
  texDims[definition.uAxis] = tile.width
  texDims[definition.vAxis] = tile.height
  return {
    levelIndex: level.index,
    texOrigin,
    texDims,
    bytesPerVoxel,
  }
}

export function planeTileSamples(
  voxels: Uint8Array,
  bytesPerVoxel: number,
  width: number,
  height: number,
): NVSlideTileSamples {
  const count = width * height
  const expected = count * bytesPerVoxel
  if (voxels.byteLength !== expected) {
    throw new Error(
      `Plane tile returned ${voxels.byteLength} bytes; expected ${expected}`,
    )
  }
  const copy = voxels.slice()
  const samples = bytesPerVoxel === 1
    ? copy
    : new Uint16Array(copy.buffer, 0, count)
  return {
    samples,
    width,
    height,
    bitsStored: bytesPerVoxel * 8,
    planes: 1,
  }
}

export class VolumePlaneSource implements SlideTileSource {
  readonly manifest: NVSlideManifest

  private readonly bytesPerVoxel: number
  private readonly definition: PlaneDefinition
  private readonly planeForLevel: number[] = []
  private readonly volume: ChunkedVolumeSource
  private host: SlideSourceHost | null = null

  constructor(
    volume: ChunkedVolumeSource,
    options: VolumePlaneSourceOptions,
  ) {
    this.volume = volume
    const base = volume.levels[0]
    if (!base) throw new Error('The volume source has no pyramid levels')
    this.definition = PLANE_DEFINITIONS[options.plane]
    const baseCount = base.shape[this.definition.normalAxis]
    if (options.index < 0 || options.index >= baseCount) {
      throw new Error(
        `${this.definition.label} plane ${options.index} is outside the volume`,
      )
    }

    this.bytesPerVoxel = bytesPerVoxelFor(volume.datatypeCode)
    const bitsStored = this.bytesPerVoxel * 8
    const tileSize = options.tileSize ?? 256
    const inPlaneSpacing = [
      base.spacing[this.definition.uAxis],
      base.spacing[this.definition.vAxis],
    ].map((value) => Number.isFinite(value) && value > 0 ? value : 1)
    const spacingUnit = Math.min(...inPlaneSpacing)
    const manifestWidth =
      base.shape[this.definition.uAxis] * inPlaneSpacing[0] / spacingUnit
    const manifestHeight =
      base.shape[this.definition.vAxis] * inPlaneSpacing[1] / spacingUnit

    const levels: NVSlideLevelManifest[] = []
    for (const [levelIndex, level] of volume.levels.entries()) {
      const width = level.shape[this.definition.uAxis]
      const height = level.shape[this.definition.vAxis]
      const columns = Math.ceil(width / tileSize)
      const rows = Math.ceil(height / tileSize)
      const tiles: NVSlideTileManifest[] = []
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
          tiles.push({
            x,
            y,
            width: Math.min(tileSize, width - x * tileSize),
            height: Math.min(tileSize, height - y * tileSize),
          })
        }
      }
      levels.push({
        index: levelIndex,
        width,
        height,
        downsample: Math.min(
          base.shape[this.definition.uAxis] / width,
          base.shape[this.definition.vAxis] / height,
        ),
        tileWidth: tileSize,
        tileHeight: tileSize,
        columns,
        rows,
        codec: 'raw-gray',
        bitsStored,
        tiles,
      })
      this.planeForLevel.push(
        planeSliceIndex(
          options.index,
          baseCount,
          level.shape[this.definition.normalAxis],
        ),
      )
      if (columns <= 1 && rows <= 1) break
    }

    this.manifest = {
      id: options.id,
      name: options.name,
      format: 'zarro-volume-plane',
      width: manifestWidth,
      height: manifestHeight,
      tileSize,
      dtype: this.bytesPerVoxel === 1 ? 'uint8' : 'uint16',
      channels: 'gray',
      displayYAxis: 'up',
      levels,
      channelInfo: [{
        name: options.name,
        colormap: 'gray',
        window: windowFor(options.window),
        active: true,
      }],
    }
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  fetchTileBytes(): Promise<Uint8Array> {
    return Promise.reject(
      new Error('VolumePlaneSource serves samples (fetchTileSamples)'),
    )
  }

  async fetchTileSamples(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples> {
    if (channels.length === 0) {
      return {
        samples: new Uint8Array(0),
        width: tile.width,
        height: tile.height,
        bitsStored: this.bytesPerVoxel * 8,
        planes: 0,
      }
    }
    const normalIndex = this.planeForLevel[level.index]
    if (normalIndex === undefined) {
      throw new Error(`Missing pyramid level ${level.index}`)
    }
    const request = planeChunkRequest(
      this.definition,
      level,
      tile,
      normalIndex,
      this.bytesPerVoxel,
    )
    request.signal = signal
    const label = `L${level.index}/${tile.x}/${tile.y}`
    this.host?.pushRangeEvent({ label, status: 'pending' })
    let voxels: Uint8Array
    try {
      voxels = await this.volume.fetchChunk(request)
      signal?.throwIfAborted()
    } catch (error) {
      this.host?.updateRangeEvent(label, signal?.aborted ? 'aborted' : 'failed')
      throw error
    }
    this.host?.addWireBytes(voxels.byteLength)
    this.host?.updateRangeEvent(label, 'hit')
    return planeTileSamples(
      voxels,
      this.bytesPerVoxel,
      tile.width,
      tile.height,
    )
  }

  dispose(): void {
    this.host = null
  }
}
