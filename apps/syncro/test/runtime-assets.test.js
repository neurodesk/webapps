import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

await import('../scripts/copy-runtime-assets.mjs');

test('the Vite dev server exposes executable runtime assets below /syncro', async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await server.listen(0);
    const base = server.resolvedUrls.local[0];
    for (const path of ['mindgrab/brainchop-mindgrab-gl.js', 'mindgrab/brainchop-mindgrab.js', 'greedy-wasm/greedy_rs_wasm.js', 'greedy-wasm/snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.no-bundler.js', 'registration/syncro-registration.mjs']) {
      const response = await fetch(new URL(path, base));
      assert.equal(response.ok, true, `${path} returned ${response.status}`);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.doesNotMatch(await response.text(), /<!doctype html>/i);
    }
    for (const path of ['mindgrab/brainchop-mindgrab-gl.wasm', 'mindgrab/brainchop-mindgrab.wasm', 'greedy-wasm/greedy_rs_wasm_bg.wasm', 'registration/syncro-registration.wasm']) {
      const response = await fetch(new URL(path, base));
      assert.equal(response.ok, true, `${path} returned ${response.status}`);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)], [0, 97, 115, 109]);
    }
    const weights = await fetch(new URL('mindgrab/models/mindgrab.bin', base));
    assert.equal(weights.ok, true, `mindgrab/models/mindgrab.bin returned ${weights.status}`);
    assert.ok((await weights.arrayBuffer()).byteLength > 100_000);
  } finally {
    await server.close();
  }
});
