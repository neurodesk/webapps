import {
  type AbsolutePath,
  type AsyncReadable,
  defineStoreExtension,
  type GetOptions,
  type RangeQuery,
  withMaybeConsolidatedMetadata,
} from 'zarrita'

type ReadResult = Promise<Uint8Array | undefined>

interface PendingRead {
  result: ReadResult
  signal: AbortSignal | undefined
}

function rangeKey(path: AbsolutePath, range: RangeQuery): string {
  if ('suffixLength' in range) return `${path}\0suffix:${range.suffixLength}`
  return `${path}\0range:${range.offset}:${range.length}`
}

/** Prefer a single consolidated metadata document, with Zarrita's fallback. */
const withDefaultSignal = defineStoreExtension(
  (store: AsyncReadable, signal: AbortSignal) => {
    const getRange = store.getRange?.bind(store)
    const options = (provided?: GetOptions): GetOptions => ({
      ...provided,
      signal: provided?.signal ?? signal,
    })
    return {
      get(path: AbsolutePath, provided?: GetOptions): ReadResult {
        return store.get(path, options(provided))
      },
      ...(getRange && {
        getRange(
          path: AbsolutePath,
          range: RangeQuery,
          provided?: GetOptions,
        ): ReadResult {
          return getRange(path, range, options(provided))
        },
      }),
    }
  },
)

export async function withOptionalConsolidatedMetadata<
  Store extends AsyncReadable,
>(
  store: Store,
  signal?: AbortSignal,
) {
  const readable = signal ? withDefaultSignal(store, signal) : store
  const consolidated = await withMaybeConsolidatedMetadata(readable, {
    format: ['v2', 'v3'],
  })
  return consolidated === readable ? store : consolidated
}

/**
 * Coalesce concurrent reads for the same native Zarr key. Completed reads are
 * deliberately forgotten: the outer byte cache owns durable retention, while
 * this layer only closes the window where overlapping virtual bricks all miss
 * that cache before the first native request settles.
 */
export const withInflightReadDeduplication = defineStoreExtension(
  (store: AsyncReadable) => {
    const pending = new Map<string, PendingRead>()
    const share = (
      key: string,
      signal: AbortSignal | undefined,
      read: () => ReadResult,
    ): ReadResult => {
      const existing = pending.get(key)
      if (existing && existing.signal === signal) return existing.result
      const entry: PendingRead = { result: read(), signal }
      pending.set(key, entry)
      const cleanup = (): void => {
        if (pending.get(key) === entry) pending.delete(key)
      }
      entry.result.then(cleanup, cleanup)
      return entry.result
    }
    const getRange = store.getRange?.bind(store)
    return {
      get(path: AbsolutePath, options?: GetOptions): ReadResult {
        return share(`get:${path}`, options?.signal, () =>
          store.get(path, options),
        )
      },
      ...(getRange && {
        getRange(
          path: AbsolutePath,
          range: RangeQuery,
          options?: GetOptions,
        ): ReadResult {
          return share(rangeKey(path, range), options?.signal, () =>
            getRange(path, range, options),
          )
        },
      }),
    }
  },
)
