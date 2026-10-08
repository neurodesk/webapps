import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FLAMES_FOLDS, manifest } from '../src/assets.js';

const repoJson = async (path) => JSON.parse(await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8'));

test('the package manifest is the browser model pin', async () => {
  assert.deepEqual(manifest, await repoJson('models/white-matter-lesions.manifest.json'));
  assert.equal(FLAMES_FOLDS.length, 5);
  assert.equal(FLAMES_FOLDS[0].url, `${manifest.base_url}flames-fold0.onnx`);
});
