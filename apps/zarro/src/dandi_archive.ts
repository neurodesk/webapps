const DANDI_API = 'https://api.dandiarchive.org/api'
const DANDI_ZARR_BUCKET = 'https://dandiarchive.s3.amazonaws.com/zarr'

export interface DandiZarrAsset {
  assetId: string
  path: string
  size: number
  zarrId: string
  storeUrl: string
}

interface DandiZarrAssetGroupMember {
  asset: DandiZarrAsset
  chunk: number
}

export interface DandiZarrAssetGroup {
  subject: string
  session: string
  sample: string
  stain: string
  run: string | null
  variant: string | null
  size: number
  members: DandiZarrAssetGroupMember[]
}

export interface DandiZarrAssetHierarchy {
  groups: DandiZarrAssetGroup[]
  ungrouped: DandiZarrAsset[]
}

interface DandiAssetResponse {
  count: number
  next: string | null
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
  complete: boolean
}

const DANDI_ASSET_PAGE_SIZE = 1000
const DANDI_MAX_SEARCH_ASSETS = 10_000

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
  pageSize = DANDI_ASSET_PAGE_SIZE,
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
  url.searchParams.set('page_size', String(Math.min(1000, Math.max(1, pageSize))))
  url.searchParams.set('ordering', 'path')
  return url.toString()
}

export async function searchDandiZarrAssets(
  dandisetId: string,
  version: string,
  query: string,
  options: {
    signal?: AbortSignal
    fetch?: typeof fetch
    maxAssets?: number
  } = {},
): Promise<DandiAssetSearchResult> {
  const fetchImpl = options.fetch ?? fetch
  const maxAssets = Math.max(1, options.maxAssets ?? DANDI_MAX_SEARCH_ASSETS)
  const assets: DandiZarrAsset[] = []
  let count = 0
  let nextUrl: string | null = dandiAssetSearchUrl(dandisetId, version, query)

  while (nextUrl && assets.length < maxAssets) {
    const response = await fetchImpl(nextUrl, { signal: options.signal })
    if (!response.ok) {
      throw new Error(
        `DANDI search failed (${response.status} ${response.statusText})`,
      )
    }
    const payload = (await response.json()) as DandiAssetResponse
    count = payload.count
    for (const asset of payload.results) {
      if (!asset.zarr) continue
      assets.push({
        assetId: asset.asset_id,
        path: asset.path,
        size: asset.size,
        zarrId: asset.zarr,
        storeUrl: dandiZarrStoreUrl(asset.zarr),
      })
      if (assets.length >= maxAssets) break
    }
    nextUrl = payload.next
  }

  return { count, assets, complete: nextUrl === null && assets.length >= count }
}

interface ParsedDandiZarrAssetPath {
  subject: string
  session: string
  sample: string
  stain: string
  run: string | null
  chunk: number
  variant: string | null
}

function parseDandiZarrAssetPath(
  asset: DandiZarrAsset,
): ParsedDandiZarrAssetPath | null {
  const segments = asset.path.split('/')
  const subject = segments.find((segment) => segment.startsWith('sub-'))
  const session = segments.find((segment) => segment.startsWith('ses-'))
  const filename = segments.at(-1) ?? ''
  const entities = filename.match(
    /(?:^|_)sample-(.+?)_stain-([^_]+)(?:_run-([^_]+))?_chunk-(\d+)_SPIM(?:_(.+))?\.ome\.zarr$/,
  )
  if (!subject || !session || !entities) return null

  return {
    subject: subject.slice(4),
    session: session.slice(4),
    sample: entities[1]!,
    stain: entities[2]!,
    run: entities[3] ?? null,
    chunk: Number(entities[4]),
    variant: entities[5] ?? null,
  }
}

function compareNatural(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

/** Parse DANDI microscopy filenames into spatially coherent stain groups. */
export function buildDandiZarrAssetHierarchy(
  assets: DandiZarrAsset[],
): DandiZarrAssetHierarchy {
  const groupsByKey = new Map<string, DandiZarrAssetGroup>()
  const ungrouped: DandiZarrAsset[] = []

  for (const asset of assets) {
    const parsed = parseDandiZarrAssetPath(asset)
    if (!parsed) {
      ungrouped.push(asset)
      continue
    }
    const key = JSON.stringify([
      parsed.subject,
      parsed.session,
      parsed.sample,
      parsed.stain,
      parsed.run,
      parsed.variant,
    ])
    let group = groupsByKey.get(key)
    if (!group) {
      group = {
        subject: parsed.subject,
        session: parsed.session,
        sample: parsed.sample,
        stain: parsed.stain,
        run: parsed.run,
        variant: parsed.variant,
        size: 0,
        members: [],
      }
      groupsByKey.set(key, group)
    }
    group.size += asset.size
    group.members.push({ asset, chunk: parsed.chunk })
  }

  const groups = [...groupsByKey.values()]
  for (const group of groups) {
    group.members.sort((left, right) => left.chunk - right.chunk)
  }
  groups.sort(
    (left, right) =>
      compareNatural(left.subject, right.subject) ||
      compareNatural(left.sample, right.sample) ||
      compareNatural(left.session, right.session) ||
      compareNatural(left.stain, right.stain) ||
      compareNatural(left.run ?? '', right.run ?? '') ||
      compareNatural(left.variant ?? '', right.variant ?? ''),
  )
  ungrouped.sort((left, right) => compareNatural(left.path, right.path))
  return { groups, ungrouped }
}
