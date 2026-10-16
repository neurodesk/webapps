import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import manifest from '../packages/synthseg/model.manifest.json' with { type: 'json' };

test('a Windows-style Git checkout preserves the checksum-pinned SynthSeg norms', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'synthseg-norms-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const directory = 'packages/synthseg/test/fixtures';
  const fixtures = {
    'ixi-fast': 'brainquant_norms.json',
    'ahead-fast': 'brainquant_norms_7t.json',
    'ixi-normal': 'brainquant_norms_normal.json',
    'ahead-normal': 'brainquant_norms_7t_normal.json',
  };
  const paths = ['.gitattributes', ...Object.values(fixtures).map((name) => `${directory}/${name}`)];
  await mkdir(join(root, directory), { recursive: true });
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
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '--no-gpg-sign', '-m', 'Seed pinned norms');
  git('config', 'core.autocrlf', 'true');
  for (const path of paths) await rm(join(root, path));
  git('checkout', '--', ...paths);
  for (const [id, name] of Object.entries(fixtures)) {
    const bytes = await readFile(join(root, directory, name));
    assert.equal(bytes.byteLength, manifest.norms[id].bytes, id);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.norms[id].sha256, id);
  }
});
