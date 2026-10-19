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
  // Fails until the model's upload to neurodeskorg/webapps is pinned in src/model.js.
  assert.match(SYNTHSTRIP_NOCSF_MODEL.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/synthstrip\/models\/synthstrip-nocsf-browser\.onnx$/);
});
