import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const execute = promisify(execFile);

for (const app of ['seedseg', 'dicompare', 'easy-mp2rage']) {
  test(`the shared Playwright CLI discovers ${app}'s existing browser tests`, async () => {
    const { stdout } = await execute(process.execPath, [
      join(repoRoot, 'node_modules/playwright/cli.js'), 'test', '--list',
    ], { cwd: join(repoRoot, 'apps', app), timeout: 30000 });
    assert.match(stdout, /Total: [1-9]\d* tests?/);
  });
}
