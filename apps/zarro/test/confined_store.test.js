import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { confinedRequest, refuseRedirect } from '../src/confined_store.js'

async function serve(t, handler) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { origin: `http://127.0.0.1:${server.address().port}`, requests }
}

test('a confined read stays under the approved root and never follows a redirect', async (t) => {
  const elsewhere = await serve(t, (request, response) => response.writeHead(200).end('{}'))
  const store = await serve(t, (request, response) => {
    if (request.url.endsWith('/.zattrs')) response.writeHead(302, { location: `${elsewhere.origin}/synthetic-metadata.json` }).end()
    else response.writeHead(200).end('{}')
  })
  const root = `${store.origin}/review/fixture.ome.zarr`
  const read = async (address) => {
    const request = confinedRequest(root, new Request(address))
    return refuseRedirect(await fetch(request), request.url)
  }
  assert.equal((await read(`${root}/zarr.json`)).status, 200)
  assert.equal((await read(root)).status, 200, 'the root itself')
  await assert.rejects(read(`${root}/.zattrs`), /redirects to another address/)
  assert.deepEqual(elsewhere.requests, [], 'the redirect target is never asked')
  for (const outside of [`${store.origin}/review/fixture.ome.zarr-other/zarr.json`, `${store.origin}/review/zarr.json`, `${elsewhere.origin}/review/fixture.ome.zarr/zarr.json`]) {
    assert.throws(() => confinedRequest(root, new Request(outside)), /lies outside/, outside)
  }
  assert.deepEqual(store.requests, ['/review/fixture.ome.zarr/zarr.json', '/review/fixture.ome.zarr', '/review/fixture.ome.zarr/.zattrs'])
})
