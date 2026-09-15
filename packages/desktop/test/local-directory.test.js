import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startOfflineServer } from '../src/server.js';

test('local datasets require an explicit grant and cannot escape through symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'offline-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'scan.zarr');
  await mkdir(folder);
  await writeFile(join(folder, '.zattrs'), '{"multiscales":[]}');
  await writeFile(join(root, 'private.txt'), 'not a dataset');
  if (process.platform !== 'win32') await symlink(join(root, 'private.txt'), join(folder, 'outside'));
  const server = await startOfflineServer(root);
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  assert.equal((await fetch(`${server.origin}/_local/not-granted/.zattrs`)).status, 404);
  const url = await server.mountDirectory(folder);
  assert.deepEqual(await (await fetch(`${url}/.zattrs`)).json(), { multiscales: [] });
  assert.equal((await fetch(`${url}/%2e%2e%2fprivate.txt`)).status, 404);
  if (process.platform !== 'win32') assert.equal((await fetch(`${url}/outside`)).status, 404);
  assert.equal((await fetch(`${url}/.zattrs`, { method: 'PUT', body: '{}' })).status, 405);
});
