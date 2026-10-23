import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppContract } from '../scripts/lib/app-automation.mjs';

test('every catalog app declares explicit automation operations', async () => {
  for (const app of (await loadAppsRegistry()).apps) {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
    const contract = await loadAppContract(app, version);
    assert.ok(contract, `${app.id}: missing automation.json`);
    assert.equal(contract.schemaVersion, 2, app.id);
    assert.ok(contract.operations[contract.defaultOperation], app.id);
  }
});

test('static builds publish current contracts with clean or stale vendored sources', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'neurodesk-static-contract-'));
  try {
    const app = join(scratch, 'apps', 'mri2vid');
    await mkdir(join(app, 'web'), { recursive: true });
    await symlink(join(repoRoot, 'packages'), join(scratch, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');
    const manifest = JSON.parse(await readFile(join(repoRoot, 'apps/mri2vid/package.json'), 'utf8'));
    await writeFile(join(app, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(app, 'web/index.html'), '<!doctype html><title>Static contract check</title>');
    await writeFile(join(app, 'examples.json'), '[]');
    const expected = await loadAppContract({ id: 'mri2vid' }, manifest.version);
    for (const state of ['clean', 'stale']) {
      if (state === 'stale') {
        await mkdir(join(app, 'web/vendor'), { recursive: true });
        for (const name of ['automation.json', 'automation.schema.json']) {
          await writeFile(join(app, 'web/vendor', name), '{"obsolete":true}');
        }
      }
      await promisify(execFile)(process.execPath, [join(repoRoot, 'scripts/build-static.mjs')], { cwd: app });
      const read = file => readFile(join(app, 'dist', file), 'utf8').then(JSON.parse);
      assert.deepEqual(await read('automation.json'), expected, state);
      assert.deepEqual(await read('vendor/automation.json'), expected, state);
      assert.deepEqual(await read('vendor/automation.schema.json'), await read('automation.schema.json'), state);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
