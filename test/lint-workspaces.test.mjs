import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/lint-workspaces.mjs', import.meta.url));

for (const extension of ['js', 'cjs', 'mjs', '']) {
  test(`workspace lint launches a ${extension || 'standalone'} pnpm entry point`, {
    skip: extension === '' && process.platform === 'win32' ? 'POSIX executable fixture' : false,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lint-workspaces-'));
    try {
      const executable = join(directory, extension ? `pnpm.${extension}` : 'pnpm');
      const content = extension
        ? 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);\n'
        : '#!/bin/sh\nprintf \'%s\\n\' "$@"\nexit 7\n';
      await writeFile(executable, content, { mode: 0o755 });
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { ...process.env, npm_execpath: executable },
      });
      assert.equal(result.status, 7, result.stdout + result.stderr);
      const args = extension ? JSON.parse(result.stdout) : result.stdout.trim().split('\n');
      assert.deepEqual(args.slice(0, 4), ['exec', 'turbo', 'run', 'lint']);
      assert.ok(args.slice(4).every(arg => arg.startsWith('--filter=')));
      assert.ok(args.length > 4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
