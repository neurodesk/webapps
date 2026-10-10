import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a Windows-style Git checkout preserves checksum-pinned VesselBoost artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vesselboost-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const directory = 'packages/vesselboost/preprocessing';
  const manifestUrl = new URL(`../${directory}/artifact.json`, import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const paths = [
    '.gitattributes',
    `${directory}/artifact.json`,
    ...manifest.files.map((asset) => `${directory}/${asset.filename}`),
    'packages/vesselboost/scripts/verify-preprocessing.mjs',
  ];
  await mkdir(join(root, directory), { recursive: true });
  await mkdir(join(root, 'packages/vesselboost/scripts'), { recursive: true });
  for (const path of paths) await cp(new URL(`../${path}`, import.meta.url), join(root, path));
  function git(...args) {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  git('init');
  git('config', 'user.name', 'Checkout test');
  git('config', 'user.email', 'checkout@example.invalid');
  git('add', '.');
  git('commit', '--no-gpg-sign', '-m', 'Seed pinned artifacts');
  git('config', 'core.autocrlf', 'true');
  for (const path of paths) await rm(join(root, path));
  git('checkout', '--', ...paths);
  for (const path of paths.filter((path) => path.startsWith(directory))) {
    assert.deepEqual(
      await readFile(join(root, path)),
      await readFile(new URL(`../${path}`, import.meta.url)),
      path
    );
  }
  const verified = spawnSync(
    process.execPath,
    [join(root, 'packages/vesselboost/scripts/verify-preprocessing.mjs')],
    { encoding: 'utf8' }
  );
  assert.equal(verified.status, 0, verified.stderr);
});
