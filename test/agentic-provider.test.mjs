import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neurodeskRequest } from '../test-utils/neurodesk-request.mjs';

test('Neurodesk requests remove screenshots while preserving semantic text and tool results', () => {
  const body = {
    model: 'neurodesk',
    max_tokens: 64000,
    messages: [
      { role: 'system', content: 'Use visible controls.' },
      { role: 'user', content: [
        { type: 'text', text: 'Download the reconstructed volume.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
      ] },
      { role: 'tool', tool_call_id: 'inspection', content: 'Download is enabled.' },
    ],
  };
  const original = structuredClone(body);
  const request = neurodeskRequest(body);
  assert.deepEqual(request.messages, [
    body.messages[0],
    { role: 'user', content: [{ type: 'text', text: 'Download the reconstructed volume.' }] },
    body.messages[2],
  ]);
  assert.equal(request.max_tokens, 8192);
  assert.equal(request.model, 'neurodesk');
  assert.deepEqual(body, original);
});
