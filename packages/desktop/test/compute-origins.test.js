import assert from 'node:assert/strict';
import test from 'node:test';
import { parseComputeOrigins } from '../src/server.js';

test('compute origins come only from absolute http(s) URLs in the environment', () => {
  assert.deepEqual([...parseComputeOrigins(undefined)], []);
  assert.deepEqual([...parseComputeOrigins(' http://127.0.0.1:8766/ , https://compute.clinic.local:8765/nesvor/')], ['http://127.0.0.1:8766', 'https://compute.clinic.local:8765']);
  assert.throws(() => parseComputeOrigins('compute.clinic.local:8765'), /not a URL|http/);
  assert.throws(() => parseComputeOrigins('file:///etc/passwd'), /http/);
});
