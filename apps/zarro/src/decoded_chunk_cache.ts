import * as zarr from 'zarrita'

interface CacheEntry {
  promise: Promise<unknown>
  signal: AbortSignal | undefined
  settled: boolean
  bytes: number
}

export interface DecodedChunkCacheOptions {
  cache: DecodedChunkCache
  namespace: string
}

function estimatedByteLength(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('data' in value)) {
    return 0
  }
  const data = value.data
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (Array.isArray(data)) {
    return data.reduce(
      (bytes, item) =>
        bytes + (typeof item === 'string' ? item.length * 2 : 8),
      0,
    )
  }
  return 0
}

/** Bounded LRU of decompressed native Zarr chunks. */
export class DecodedChunkCache {
  private readonly entries = new Map<string, CacheEntry>()
  private totalBytes = 0
  private readonly maxBytes: number
  hits = 0
  misses = 0

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  get byteLength(): number {
    return this.totalBytes
  }

  getOrLoad<Value>(
    key: string,
    signal: AbortSignal | undefined,
    load: () => Promise<Value>,
  ): Promise<Value> {
    const existing = this.entries.get(key)
    if (existing && (existing.settled || existing.signal === signal)) {
      this.hits++
      this.touch(key, existing)
      return existing.promise as Promise<Value>
    }

    this.misses++
    const entry: CacheEntry = {
      promise: Promise.resolve().then(load),
      signal,
      settled: false,
      bytes: 0,
    }
    this.entries.set(key, entry)
    entry.promise.then(
      (value) => {
        if (this.entries.get(key) !== entry) return
        entry.settled = true
        entry.bytes = estimatedByteLength(value)
        this.totalBytes += entry.bytes
        this.touch(key, entry)
        this.evict()
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
      },
    )
    return entry.promise as Promise<Value>
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes) {
      const oldest = [...this.entries].find(([, entry]) => entry.settled)
      if (!oldest) return
      const [key, entry] = oldest
      this.entries.delete(key)
      this.totalBytes -= entry.bytes
    }
  }
}

export const withDecodedChunkCaching = zarr.defineArrayExtension(
  (array, options: DecodedChunkCacheOptions) => ({
    getChunk(
      coords: number[],
      readOptions?: zarr.GetOptions,
      chunkOptions?: { useSharedArrayBuffer?: boolean },
    ) {
      const memory = chunkOptions?.useSharedArrayBuffer ? 'shared' : 'local'
      const key = `${options.namespace}\0${coords.join(',')}\0${memory}`
      return options.cache.getOrLoad(key, readOptions?.signal, () =>
        array.getChunk(coords, readOptions, chunkOptions),
      )
    },
  }),
)
