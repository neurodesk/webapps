const DANDI_API = 'https://api.dandiarchive.org/api'
const DANDI_ZARR_BUCKET = 'https://dandiarchive.s3.amazonaws.com/zarr'

export interface DandiZarrAsset {
  assetId: string
  path: string
  size: number
  zarrId: string
  storeUrl: string
}

interface DandiAssetResponse {
  count: number
  results: Array<{
    asset_id: string
    path: string
    size: number
    zarr: string | null
  }>
}

export interface DandiAssetSearchResult {
  count: number
  assets: DandiZarrAsset[]
}

export function dandiZarrStoreUrl(zarrId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(zarrId)) {
    throw new Error(`Invalid DANDI Zarr identifier '${zarrId}'`)
  }
  return `${DANDI_ZARR_BUCKET}/${zarrId}/`
}

export function dandiAssetSearchUrl(
  dandisetId: string,
  version: string,
  query: string,
  pageSize = 50,
): string {
  if (!/^\d{6}$/.test(dandisetId)) {
    throw new Error('The Dandiset identifier must contain six digits')
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
    throw new Error('The Dandiset version is invalid')
  }
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[?*\[\]]/g, ''))
    .filter(Boolean)
  const glob = terms.length > 0 ? `*${terms.join('*')}*.ome.zarr` : '*.ome.zarr'
  const url = new URL(
    `${DANDI_API}/dandisets/${dandisetId}/versions/${version}/assets/`,
  )
  url.searchParams.set('glob', glob)
  url.searchParams.set('page_size', String(Math.min(100, Math.max(1, pageSize))))
  url.searchParams.set('ordering', 'path')
  return url.toString()
}

export async function searchDandiZarrAssets(
  dandisetId: string,
  version: string,
  query: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<DandiAssetSearchResult> {
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(
    dandiAssetSearchUrl(dandisetId, version, query),
    { signal: options.signal },
  )
  if (!response.ok) {
    throw new Error(
      `DANDI search failed (${response.status} ${response.statusText})`,
    )
  }
  const payload = (await response.json()) as DandiAssetResponse
  const assets = payload.results.flatMap((asset): DandiZarrAsset[] => {
    if (!asset.zarr) return []
    return [
      {
        assetId: asset.asset_id,
        path: asset.path,
        size: asset.size,
        zarrId: asset.zarr,
        storeUrl: dandiZarrStoreUrl(asset.zarr),
      },
    ]
  })
  return { count: payload.count, assets }
}
