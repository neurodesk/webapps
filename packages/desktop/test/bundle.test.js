import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bundlePath, canonicalUrl, verifyBundle } from '../src/bundle.js';
import { startOfflineServer } from '../src/server.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'neurodesk-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site/demo'), { recursive: true });
  await mkdir(join(root, 'assets'));
  const data = Buffer.from('test model weights');
  const sha256 = createHash('sha256').update(data).digest('hex');
  await writeFile(join(root, 'assets', sha256), data);
  await writeFile(join(root, 'site/demo/index.html'), '<html><body>Local app</body></html>');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, apps: [{ id: 'demo', path: 'demo' }], assets: { 'https://example.org/model': { path: `assets/${sha256}`, sha256, bytes: data.length } } }));
  return { root, sha256 };
}

test('validates model bytes and rejects a corrupted installation', async t => {
  const { root, sha256 } = await fixture(t);
  assert.deepEqual(await verifyBundle(root), { apps: ['demo'], assets: 1, files: 0 });
  await writeFile(join(root, 'assets', sha256), 'wrong model weights');
  await assert.rejects(verifyBundle(root), /missing or corrupt/);
});

test('asset paths cannot escape the installation', () => {
  for (const path of ['../secret', '/etc/passwd', 'assets/../../secret', 'x\0y']) assert.throws(() => bundlePath('/bundle', path));
  assert.equal(bundlePath('/bundle', 'assets/weights'), '/bundle/assets/weights');
});

test('cache parameters map to the same pinned resource without erasing semantic queries', () => {
  assert.equal(canonicalUrl('https://example.org/model?sha256=abc&download=true'), 'https://example.org/model');
  assert.notEqual(canonicalUrl('https://example.org/model?revision=1'), canonicalUrl('https://example.org/model?revision=2'));
});

test('loopback server serves the packaged app with isolation headers and rejects missing files', async t => {
  const { root } = await fixture(t);
  const { server, origin } = await startOfflineServer(root);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`${origin}/demo/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(await response.text(), /data-neurodesk-offline/);
  assert.equal((await fetch(`${origin}/missing.onnx`)).status, 404);
  assert.equal((await fetch(`${origin}/demo/`, { method: 'POST' })).status, 405);
});
