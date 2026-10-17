import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { writeCompositeRuntimeCacheManifests, writeRuntimeCacheManifest } from '../scripts/lib/runtime-cache.mjs';
import { writeCoiServiceWorker } from '../scripts/lib/runtime-support.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, path, body) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}

test('runtime allowlist hashes final binary assets and excludes documents, code and patient/example directories', async t => {
  const root = await fixture(t);
  const candidates = new Map([
    ['assets/engine #1.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ['models/network.onnx', Buffer.from('model bytes')],
    ['runtime/engine.data', Buffer.from('runtime package bytes')],
    ['models/network.bin', Buffer.from('weight shard')],
  ]);
  for (const [path, body] of candidates) await put(root, path, body);
  for (const path of ['examples/private.bin', 'patients/input.bin', 'input/private.data', 'outputs/result.bin', 'fixtures/image.bin', 'image.nii.gz', 'app.js']) {
    await put(root, path, 'excluded');
  }
  await put(root, 'index.html', '<html><head></head><body></body></html>');
  const manifest = await writeRuntimeCacheManifest({ distDir: root });
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.assets.length, candidates.size);
  for (const asset of manifest.assets) {
    const path = decodeURIComponent(asset.url.slice(2));
    const body = candidates.get(path);
    assert.ok(body, `${asset.url} is a declared runtime candidate`);
    assert.equal(asset.bytes, body.length);
    assert.equal(asset.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(asset.contentType, path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
  }
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const manifestName = html.match(/content="\.\/(runtime-cache-manifest\.[a-f0-9]{64}\.json)"/)[1];
  const serialized = await readFile(join(root, manifestName));
  assert.equal(createHash('sha256').update(serialized).digest('hex'), manifestName.match(/\.([a-f0-9]{64})\.json/)[1]);
  assert.deepEqual(JSON.parse(serialized), manifest);
  assert.match(html, /<script src="\.\/coi-serviceworker\.js"><\/script>/);
});

test('manifest regeneration preserves Calmar worker configuration and changes no worker bytes on a runtime deployment', async t => {
  const root = await fixture(t);
  await put(root, 'index.html', '<html><head><script src="./coi-serviceworker.js"></script></head></html>');
  await put(root, 'engine.wasm', 'first binary');
  await writeCoiServiceWorker({
    repoRoot,
    destination: join(root, 'coi-serviceworker.js'),
    config: { cacheRoute: '/__lnm_downloads/', cacheName: 'lnm-mask-downloads-v1', alwaysRegister: true },
  });
  const first = await writeRuntimeCacheManifest({ distDir: root });
  const worker = await readFile(join(root, 'coi-serviceworker.js'), 'utf8');
  const config = JSON.parse(worker.match(/const coiRuntimeConfig = (\{[^\n]*\});/)[1]);
  assert.deepEqual(config, {
    cacheRoute: '/__lnm_downloads/',
    cacheName: 'lnm-mask-downloads-v1',
    alwaysRegister: true,
    runtimeCache: true,
  });
  await put(root, 'engine.wasm', 'second binary');
  const second = await writeRuntimeCacheManifest({ distDir: root });
  assert.notEqual(first.assets[0].sha256, second.assets[0].sha256);
  assert.equal(await readFile(join(root, 'coi-serviceworker.js'), 'utf8'), worker);
  assert.equal((await readFile(join(root, 'index.html'), 'utf8')).match(/coi-serviceworker\.js/g).length, 1);
});

test('composite allowlists cover final app and shared runtime paths under root and nested deployment bases', async t => {
  const siteDist = await fixture(t);
  const apps = [{ path: 'app' }, { path: 'imaging/second' }];
  await put(siteDist, '_runtime/engine/1/engine.wasm', 'shared binary');
  await put(siteDist, '_runtime/engine/1/loader.js', 'export {};');
  for (const app of apps) {
    await put(siteDist, `${app.path}/index.html`, '<html><head></head></html>');
    await put(siteDist, `${app.path}/assets/local.wasm`, 'app binary');
  }
  await writeCompositeRuntimeCacheManifests({ siteDist, registry: { apps } });
  for (const app of apps) {
    const html = await readFile(join(siteDist, app.path, 'index.html'), 'utf8');
    const manifestName = html.match(/content="\.\/(runtime-cache-manifest\.[a-f0-9]{64}\.json)"/)[1];
    const manifest = JSON.parse(await readFile(join(siteDist, app.path, manifestName), 'utf8'));
    assert.equal(manifest.assets.length, 2);
    for (const base of ['https://example.test/', 'https://example.test/webapps/']) {
      const workerUrl = new URL(`${app.path}/coi-serviceworker.js`, base);
      const expected = [
        new URL('_runtime/engine/1/engine.wasm', base).href,
        new URL(`${app.path}/assets/local.wasm`, base).href,
      ].sort();
      assert.deepEqual(manifest.assets.map(asset => new URL(asset.url, workerUrl).href).sort(), expected);
    }
  }
});
