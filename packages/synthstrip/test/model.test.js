import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SYNTHSTRIP_MODEL, SYNTHSTRIP_NOCSF_MODEL } from '../src/model.js';

test('the SynthStrip pin is the graph SYNcro publishes', async () => {
  const syncro = JSON.parse(await readFile(new URL('../../../models/syncro.manifest.json', import.meta.url), 'utf8'));
  const published = syncro.assets.find((asset) => asset.filename === SYNTHSTRIP_MODEL.filename);
  assert.deepEqual(SYNTHSTRIP_MODEL, { ...published, url: syncro.base_url + published.filename });
});

test('the no-CSF model is pinned to a Hugging Face commit', () => {
  assert.match(SYNTHSTRIP_NOCSF_MODEL.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/synthstrip\/models\/synthstrip-nocsf-browser\.onnx$/);
});

test('the offline brain extraction bundle includes the pinned no-CSF model', async () => {
  const sources = JSON.parse(await readFile(new URL('../../../registry/offline-assets.sources.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
  const { url, bytes, sha256, license } = SYNTHSTRIP_NOCSF_MODEL;
  assert.deepEqual(sources.apps['brain-extraction'].find(asset => asset.url === url), {
    url, bytes, sha256, license, kind: 'model',
  });
  assert.ok(lock.apps['brain-extraction'].includes(url));
  assert.equal(lock.assets[url].bytes, bytes);
  assert.equal(lock.assets[url].sha256, sha256);
});
