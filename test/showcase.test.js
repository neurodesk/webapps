import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('showcase build emits deployable static app', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'webapp-components-showcase-'));
  const result = spawnSync(process.execPath, ['scripts/build-showcase.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHOWCASE_OUT_DIR: outDir,
      SHOWCASE_BUILD_ENV: 'staging',
      SHOWCASE_VERSION_SUFFIX: '-staging+test'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const index = await readFile(join(outDir, 'index.html'), 'utf8');
  assert.match(index, /web\/js\/showcase\.js/);
  assert.match(index, /src\/styles\/base\.css/);

  const buildInfo = JSON.parse(await readFile(join(outDir, 'build-info.json'), 'utf8'));
  assert.equal(buildInfo.buildEnv, 'staging');
  assert.equal(buildInfo.versionSuffix, '-staging+test');

  await stat(join(outDir, 'src/index.js'));
  await stat(join(outDir, 'web/js/showcase.js'));
  await stat(join(outDir, 'docs/components/catalog.md'));
});
