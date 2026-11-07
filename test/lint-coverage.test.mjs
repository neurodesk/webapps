import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedLintRepository } from '../test-utils/isolated-lint-repository.mjs';

test('lint coverage canaries run in an isolated repository', async () => {
  const fixture = await isolatedLintRepository(fileURLToPath(new URL('../', import.meta.url)));
  try {
    // Dependencies are shared with the checkout; subprocesses must not reinstall them.
    const env = { ...process.env, pnpm_config_verify_deps_before_run: 'warn' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', 'test-utils/lint-coverage-suite.mjs'], {
      cwd: fixture.root,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0, 'isolated lint coverage suite failed');
  } finally {
    await fixture.cleanup();
  }
});
