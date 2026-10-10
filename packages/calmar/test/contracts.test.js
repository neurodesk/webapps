import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import manifest from '../model.manifest.json' with { type: 'json' };
import assets from '../assets.lock.json' with { type: 'json' };

test('CLI model pins and defaults equal the browser manifest', async () => {
  const browser = JSON.parse(
    await readFile(new URL('../../../apps/calmar/web/models/manifest.json', import.meta.url))
  );
  assert.deepEqual(manifest, browser);
  for (const id of ['lnm-synthstrip', 'lnm-stroke-lesion', 'lnm-synthmorph-mni']) {
    const model = manifest.modelAssets.find((asset) => asset.id === id);
    assert.equal(assets.find((asset) => asset.id === id).sha256, model.checksum.replace(/^sha256:/, ''));
  }
  assert.equal(assets.length, 20);
  const filenames = new Set();
  for (const asset of assets) {
    assert.match(asset.url, /(?:\/resolve\/|raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)[0-9a-f]{40}\//);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    assert.equal(filenames.has(asset.filename), false);
    filenames.add(asset.filename);
    assert.equal(asset.filename.includes('..'), false);
  }
});

test('command parser refuses unknown, repeated and missing-value flags', () => {
  for (const args of [
    ['prepare', 'input', 'output', '--threads', '4', '--threads', '2'],
    ['prepare', 'input', 'output', '--threads'],
    ['map', 'input', 'output', '--reviewed', '--reviewed'],
    ['map', 'input', 'output', '--deepisles'],
    ['download-models', 'extra'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL('../bin/calmar.js', import.meta.url).pathname, ...args],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid option|Repeated option|Unexpected positional/);
    assert.equal(result.stdout, '');
  }
});
