import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContainerReference } from '../validation/reference.mjs';
import reference from '../validation/container-reference.json' with { type: 'json' };

test('container references reject unrecorded files before fetching', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected request'));
  await assert.rejects(readContainerReference('../unknown.nii.gz'), /Unknown container reference/);
});

test('container references reject failed downloads and corrupted bytes', async (t) => {
  const file = reference.runs[0].file;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url.href, /\/resolve\/[a-f0-9]{40}\/gliomoda\/validation\/container\//);
    return new Response('', { status: 404 });
  });
  await assert.rejects(readContainerReference(file), /HTTP 404/);
  fetchMock.mock.mockImplementation(async () => new Response('corrupt'));
  await assert.rejects(readContainerReference(file), /checksum mismatch/);
});
