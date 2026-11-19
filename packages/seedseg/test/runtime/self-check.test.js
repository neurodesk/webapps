import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The self-check loads the pinned QSM WebAssembly that `test:runtime` downloads first, so this
// runs in `test:runtime`, which the seedseg app's tests run, and not in the every-run
// `pnpm test:packages`.
const cli = fileURLToPath(new URL('../../bin/seedseg.js', import.meta.url));

test('source CPU/QSM self-check leaves a fresh HOME and Windows app-data directories empty without CI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'seedseg-no-ci-home-'));
  const env = { ...process.env };
  for (const key of ['CI', 'ORT_DISABLE_TELEMETRY', 'NEURODESK_SEEDSEG_MODEL_DIR']) delete env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = home;
  try {
    const run = spawnSync(process.execPath, [cli, 'self-check'], { encoding: 'utf8', env, timeout: 30_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.executable, process.execPath);
    assert.equal(report.node, process.version);
    assert.equal(report.onnxRuntime, '1.30.0');
    assert.equal(report.qsmVersion, '0.9.2');
    assert.deepEqual(await readdir(home, { recursive: true }), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
