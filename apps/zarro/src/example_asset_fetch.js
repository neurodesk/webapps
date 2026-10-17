import { fetchWithRetry } from '@neurodesk/webapp-components/fetch'
import { fetchModel } from '@neurodesk/webapp-components/worker'

/** @typedef {{ url: string, sha256: string, bytes: number }} ExampleAsset */

/**
 * @param {ExampleAsset[]} assets
 * @param {import('@neurodesk/webapp-components/fetch').RetryOptions} options
 */
export function createExampleAssetFetch(assets, options = {}) {
  const declaredAssets = new Map(assets.map((asset) => [asset.url, asset]))

  /** @param {Request} request */
  return async (request) => {
    const asset = declaredAssets.get(request.url)
    const fetchRequest = () => fetchWithRetry(request, {}, options)
    if (
      !asset || request.method !== 'GET' ||
      ['Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since']
        .some((header) => request.headers.has(header))
    ) {
      const response = await fetchRequest()
      return { response, wireBytes: networkBytes(response, request.method) }
    }

    /** @type {Response | undefined} */
    let networkResponse
    let wireBytes = 0
    try {
      const bytes = await fetchModel({
        url: asset.url,
        integrity: { sha256: asset.sha256, bytes: asset.bytes },
      }, {
        signal: request.signal,
        async fetch() {
          networkResponse = await fetchRequest()
          wireBytes = networkBytes(networkResponse, request.method)
          // fetchModel cancels failed responses; retain the caller's HTTP error body.
          return networkResponse.ok ? networkResponse : new Response(null, {
            status: networkResponse.status,
            headers: networkResponse.headers,
          })
        },
      })
      const headers = new Headers(networkResponse?.headers)
      headers.set('Content-Length', String(bytes.byteLength))
      return {
        response: new Response(bytes, { status: networkResponse?.status ?? 200, headers }),
        wireBytes,
      }
    } catch (error) {
      request.signal.throwIfAborted()
      if (networkResponse && !networkResponse.ok) {
        return { response: networkResponse, wireBytes }
      }
      throw error
    }
  }
}

/** @param {Response} response @param {string} method */
function networkBytes(response, method) {
  const length = Number(response.headers.get('Content-Length') ?? 0)
  return method !== 'HEAD' && Number.isFinite(length) && length > 0 ? length : 0
}
