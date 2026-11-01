import assert from 'node:assert/strict';
import test from 'node:test';
import { detectionsHint } from '../web/js/app/detections.js';

// Multiple networks, a long runtime and edited markers exercise the longest hint.
const det = { folds: [0, 1, 2, 3], mirror: false, backend: 'wasm', timing: { total: 600 }, others: [{ meanProb: 0.123456 }] };

test('the visible hint under the marker table stays within 90 characters', () => {
  for (const edited of [false, true]) {
    const { text, details } = detectionsHint({ ...det, edited });
    assert.ok(text.length <= 90, text);
    assert.match(details, /networks 1, 2, 3, 4 of 5, mirroring off, WebAssembly, 600 s/);
  }
  assert.equal(detectionsHint({ ...det, edited: true }).text, 'From the edited mask.');
  assert.equal(detectionsHint(det).text, 'Next candidate p 0.123.');
});
