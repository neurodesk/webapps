import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDandiZarrAssetHierarchy,
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
  assert.equal(url.searchParams.get('page_size'), '1000')
})

test('maps DANDI assets to public S3 Zarr stores', async () => {
  const zarrId = '56509720-870c-4f43-ae41-7b75f9590722'
  const result = await searchDandiZarrAssets('000108', 'draft', 'sample-127', {
    fetch: async () =>
      new Response(
        JSON.stringify({
          count: 1,
          next: null,
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
  assert.equal(result.complete, true)
  assert.equal(result.assets[0].storeUrl, dandiZarrStoreUrl(zarrId))
  assert.equal(
    result.assets[0].storeUrl,
    `https://dandiarchive.s3.amazonaws.com/zarr/${zarrId}/`,
  )
})

test('follows DANDI pagination when loading matching asset metadata', async () => {
  const responses = [
    {
      count: 2,
      next: 'https://api.dandiarchive.org/page-2',
      results: [
        {
          asset_id: 'asset-1',
          path: 'sub-MITU01/ses-test/micr/sub-MITU01_sample-127_stain-LEC_run-1_chunk-1_SPIM.ome.zarr',
          size: 100,
          zarr: '56509720-870c-4f43-ae41-7b75f9590722',
        },
      ],
    },
    {
      count: 2,
      next: null,
      results: [
        {
          asset_id: 'asset-2',
          path: 'sub-MITU01/ses-test/micr/sub-MITU01_sample-127_stain-LEC_run-1_chunk-2_SPIM.ome.zarr',
          size: 200,
          zarr: 'b2802fac-cb30-4c25-bd16-09666706c91a',
        },
      ],
    },
  ]
  const requestedUrls = []
  const result = await searchDandiZarrAssets('000108', 'draft', '', {
    fetch: async (url) => {
      requestedUrls.push(String(url))
      return Response.json(responses.shift())
    },
  })

  assert.equal(result.assets.length, 2)
  assert.equal(result.complete, true)
  assert.equal(requestedUrls[1], 'https://api.dandiarchive.org/page-2')
})

test('marks a result incomplete when the metadata safety limit truncates a page', async () => {
  const result = await searchDandiZarrAssets('000108', 'draft', '', {
    maxAssets: 1,
    fetch: async () =>
      Response.json({
        count: 2,
        next: null,
        results: [
          {
            asset_id: 'asset-1',
            path: 'sub-MITU01/ses-test/micr/sub-MITU01_sample-127_stain-LEC_run-1_chunk-1_SPIM.ome.zarr',
            size: 100,
            zarr: '56509720-870c-4f43-ae41-7b75f9590722',
          },
          {
            asset_id: 'asset-2',
            path: 'sub-MITU01/ses-test/micr/sub-MITU01_sample-127_stain-LEC_run-1_chunk-2_SPIM.ome.zarr',
            size: 200,
            zarr: 'b2802fac-cb30-4c25-bd16-09666706c91a',
          },
        ],
      }),
  })

  assert.equal(result.assets.length, 1)
  assert.equal(result.complete, false)
})

test('groups DANDI stores by subject, session, sample, and stain', () => {
  const asset = (chunk, variant = '') => ({
    assetId: `asset-${chunk}${variant}`,
    path: `sub-MITU01/ses-20210720h20m19s32/micr/sub-MITU01_ses-20210720h20m19s32_sample-127_stain-LEC_run-1_chunk-${chunk}_SPIM${variant}.ome.zarr`,
    size: chunk * 100,
    zarrId: '56509720-870c-4f43-ae41-7b75f9590722',
    storeUrl: `https://example.test/${chunk}${variant}/`,
  })
  const hierarchy = buildDandiZarrAssetHierarchy([
    asset(10),
    asset(2),
    asset(1),
    asset(1, '_illum_corr'),
  ])

  assert.equal(hierarchy.ungrouped.length, 0)
  assert.equal(hierarchy.groups.length, 2)
  assert.deepEqual(
    hierarchy.groups[0].members.map((member) => member.chunk),
    [1, 2, 10],
  )
  assert.equal(hierarchy.groups[0].size, 1300)
  assert.equal(hierarchy.groups[1].variant, 'illum_corr')
})

test('rejects malformed Dandiset identifiers', () => {
  assert.throws(
    () => dandiAssetSearchUrl('108', 'draft', ''),
    /six digits/,
  )
})
