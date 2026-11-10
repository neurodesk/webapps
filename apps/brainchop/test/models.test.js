import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, REVISION } from '../src/models.js';

test('six distinct segmentation networks, without extraction or masking entries', () => {
  assert.equal(MODELS.length, 6);
  assert.equal(new Set(MODELS.map(model => model.entry.path)).size, 6);
  for (const { entry } of MODELS) {
    assert.ok(['Segmentation', 'Atlas'].includes(entry.type));
    assert.ok(entry.colormapPath);
  }
  assert.match(REVISION, /^[a-f0-9]{40}$/);
});
