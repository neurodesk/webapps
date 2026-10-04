import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const execute = promisify(execFile);

for (const app of ['seedseg', 'dicompare', 'easy-mp2rage', 'calmar']) {
  test(`the app's Playwright CLI discovers ${app}'s existing browser tests`, async () => {
    const require = createRequire(join(repoRoot, 'apps', app, 'package.json'));
    const playwright = dirname(require.resolve('playwright/package.json'));
    const { stdout } = await execute(process.execPath, [
      join(playwright, 'cli.js'), 'test', '--list',
    ], { cwd: join(repoRoot, 'apps', app), timeout: 30000 });
    assert.match(stdout, /Total: [1-9]\d* tests?/);
  });
}
