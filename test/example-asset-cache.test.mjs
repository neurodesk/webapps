import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadVerifiedExampleCache } from '../scripts/lib/example-asset-cache.mjs';

const url = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/1234567890123456789012345678901234567890/scan.nii';
const body = Buffer.from([0, 1, 127, 255]);
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = { [url]: { sha256: hash(body), bytes: body.length, contentType: 'application/octet-stream' } };

test('cache mode returns the exact locked bytes for their original URL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verified-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, hash(url)), body);
  const result = await loadVerifiedExampleCache([{ url }, { url }], { directory, assets });
  assert.equal(result.size, 1);
  assert.deepEqual(result.get(url).body, Buffer.from([0, 1, 127, 255]));
});

test('cache mode rejects missing, corrupt, or incorrectly sized assets without fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verified-examples-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const load = locked => loadVerifiedExampleCache([{ url }], { directory, assets: locked });
  await assert.rejects(load(assets), /does not fall back to the network/);
  await writeFile(join(directory, hash(url)), Buffer.from([255, 127, 1, 0]));
  await assert.rejects(load(assets), /checksum or size mismatch/);
  await writeFile(join(directory, hash(url)), body);
  await assert.rejects(load({ [url]: { ...assets[url], bytes: 3 } }), /checksum or size mismatch/);
  await assert.rejects(load({}), /Missing locked SHA-256/);
});
