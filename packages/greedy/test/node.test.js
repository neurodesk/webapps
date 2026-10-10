import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { greedyExecutable, runGreedy } from '../src/node.js';

let executable;
try { executable = greedyExecutable(); } catch { /* Native Greedy is optional locally; the tests below explicitly skip without it. */ }

test('native runner rejects shell command strings', () => {
  assert.throws(() => runGreedy('--help'), /array of strings/);
});

test('npm CLI preserves native failure status', { skip: !executable }, async () => {
  await runGreedy(['--version'], { stdio: 'ignore' });
  const direct = spawnSync(executable, ['--unsupported-flag']);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/greedy.js', import.meta.url)), '--unsupported-flag']);
  assert.notEqual(direct.status, 0);
  assert.equal(cli.status, direct.status);
});
