import assert from 'node:assert/strict';
import test from 'node:test';
import { modelAsset } from '../src/assets.js';
import { fetchVerifiedModel } from '../src/browser-loader.js';

test('the production browser loader rejects correct-size corrupted network model bytes', async () => {
  const asset = modelAsset('vesselboost.onnx');
  await assert.rejects(
    fetchVerifiedModel(asset, { fetch: async () => new Response(new Uint8Array(asset.bytes)) }),
    /SHA-256 mismatch/
  );
});
test('the production browser loader rechecks cached SHA-256 and never uses a corrupt hit', async () => {
  const asset = modelAsset('vesselboost.onnx');
  const events = [];
  const cache = {
    async get() {
      return new Uint8Array(asset.bytes);
    },
    async delete() {
      events.push('delete');
    },
  };
  await assert.rejects(
    fetchVerifiedModel(asset, {
      cache,
      fetch: async () => {
        events.push('fetch');
        return new Response(new Uint8Array(asset.bytes));
      },
    }),
    /SHA-256 mismatch/
  );
  assert.deepEqual(events, ['delete', 'fetch']);
});
