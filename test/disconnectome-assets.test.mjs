import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url)));

test('disconnectome offline inventory contains every runtime asset with matching integrity', async () => {
  const sources = await readJson('../registry/offline-assets.sources.json');
  const lock = await readJson('../registry/offline-assets.lock.json');
  const manifest = await readJson('../models/disconnectome.manifest.json');
  const declared = sources.apps.disconnectome;
  assert.deepEqual(new Set(lock.apps.disconnectome), new Set(declared.map(asset => asset.url)));
  for (const source of declared) {
    const locked = lock.assets[source.url];
    assert.ok(locked, `Missing offline asset: ${source.url}`);
    assert.equal(locked.sha256, source.sha256);
    assert.equal(locked.bytes, source.bytes);
  }
  for (const atlas of manifest.atlases) {
    for (const filename of [atlas.tvx, atlas.trx]) {
      const asset = manifest.assets.find(entry => entry.filename === filename);
      const url = manifest.base_url + filename;
      assert.ok(lock.apps.disconnectome.includes(url), `Missing runtime asset: ${filename}`);
      assert.equal(lock.assets[url].sha256, asset.sha256);
      assert.equal(lock.assets[url].bytes, asset.bytes);
    }
  }
});
