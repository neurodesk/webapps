import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dandiAssetSearchUrl,
  dandiZarrStoreUrl,
  searchDandiZarrAssets,
} from '../src/dandi_archive.ts'

test('builds a DANDI OME-Zarr asset search from path terms', () => {
  const url = new URL(
    dandiAssetSearchUrl('000108', 'draft', 'sample-127 LEC chunk-1'),
  )
  assert.equal(
    url.pathname,
    '/api/dandisets/000108/versions/draft/assets/',
  )
  assert.equal(
    url.searchParams.get('glob'),
    '*sample-127*LEC*chunk-1*.ome.zarr',
  )
  assert.equal(url.searchParams.get('page_size'), '50')
})

test('maps DANDI assets to public S3 Zarr stores', async () => {
  const zarrId = '56509720-870c-4f43-ae41-7b75f9590722'
  const result = await searchDandiZarrAssets('000108', 'draft', 'sample-127', {
    fetch: async () =>
      new Response(
        JSON.stringify({
          count: 1,
          results: [
            {
              asset_id: 'e6b42a63-f854-420b-bd11-9530c7d3c6c1',
              path: 'sub-MITU01/sample-127_SPIM.ome.zarr',
              size: 1234,
              zarr: zarrId,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  assert.equal(result.count, 1)
  assert.equal(result.assets[0].storeUrl, dandiZarrStoreUrl(zarrId))
  assert.equal(
    result.assets[0].storeUrl,
    `https://dandiarchive.s3.amazonaws.com/zarr/${zarrId}/`,
  )
})

test('rejects malformed Dandiset identifiers', () => {
  assert.throws(
    () => dandiAssetSearchUrl('108', 'draft', ''),
    /six digits/,
  )
})
