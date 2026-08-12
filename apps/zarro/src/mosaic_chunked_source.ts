import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
} from '@niivue/niivue'
import { AbortableTaskPool } from './abortable_task_pool.ts'
import type { Shape3 } from './logical_volume.ts'

export interface MosaicChunkedLevel {
  level: number
  shape: Shape3
  spacing: Shape3
}

interface MosaicChunkedSourceOptions<Level extends MosaicChunkedLevel> {
  datatypeCode: number
  levels: readonly Level[]
  signal: () => AbortSignal
  concurrency: number
  fetchRegion: (
    level: Level,
    request: ChunkedVolumeFetch,
    signal: AbortSignal,
  ) => Promise<Uint8Array>
}

/**
 * Adapt a translated mosaic pyramid to NiiVue's bounded multi-LOD source seam.
 * The caller owns composition; this module owns level dispatch, concurrency,
 * and reading the newest cancellation signal for every planned brick.
 */
export function createMosaicChunkedVolumeSource<
  Level extends MosaicChunkedLevel,
>(options: MosaicChunkedSourceOptions<Level>): ChunkedVolumeSource {
  const reads = new AbortableTaskPool(options.concurrency)
  return {
    datatypeCode: options.datatypeCode,
    levels: options.levels.map((level) => ({
      level: level.level,
      shape: level.shape,
      spacing: level.spacing,
    })),
    fetchChunk: (request) => {
      const signal = options.signal()
      return reads.run(signal, async () => {
        const level = options.levels[request.levelIndex]
        if (!level) {
          throw new Error(
            `Translated mosaic level index ${request.levelIndex} is unavailable`,
          )
        }
        return options.fetchRegion(level, request, signal)
      })
    },
  }
}
