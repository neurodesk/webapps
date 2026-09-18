import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const dist = join(repoRoot, 'dist');

test('composite site contains one checksum-verified runtime store', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
  for (const family of manifest.families) {
    for (const file of family.files) {
      await access(join(dist, '_runtime', family.target, file.name));
    }
  }
});

test('only declared app-scoped runtime families remain in composite app copies', async () => {
  const registry = await loadAppsRegistry();
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
  const ortHashes = new Map(manifest.families.find(family => family.id === 'ort-web').files.map(file => [file.name, file.sha256]));
  for (const app of registry.apps) {
    const appDist = join(dist, app.path);
    if (app.app_scoped_runtime_families.includes('dcm2niix')) {
      for (const file of ['index.js', 'worker.js', 'dcm2niix.js', 'dcm2niix.wasm']) {
        assert.deepEqual(await readFile(join(appDist, 'dcm2niix', file)),
          await readFile(join(dist, '_runtime', 'dcm2niix', '1', file)), `${app.id}: scoped ${file}`);
      }
    } else await assert.rejects(access(join(appDist, 'dcm2niix')));
    await assert.rejects(access(join(appDist, 'nifti-js')));
    await assert.rejects(access(join(appDist, 'vendor', 'webapp-components')));
    try {
      const wasm = await readdir(join(appDist, 'wasm'));
      const ortFiles = wasm.filter((name) => name.startsWith('ort')).sort();
      if (app.app_scoped_runtime_families.includes('ort-web')) {
        const standaloneWasm = await readdir(join(repoRoot, 'apps', app.id, 'dist', 'wasm'));
        const expectedFiles = standaloneWasm.filter(name => name.startsWith('ort')).sort();
        assert.ok(expectedFiles.length > 0, `${app.id}: standalone ORT files are missing`);
        assert.deepEqual(ortFiles, expectedFiles, `${app.id}: composite must preserve its standalone ORT files`);
        for (const name of ortFiles) {
          assert.ok(ortHashes.has(name), `${app.id}: unpinned ORT file ${name}`);
          const bytes = await readFile(join(appDist, 'wasm', name));
          assert.equal(createHash('sha256').update(bytes).digest('hex'), ortHashes.get(name), `${app.id}: scoped ${name} checksum`);
        }
      } else {
        assert.deepEqual(ortFiles, [], `${app.id} retains app-local ORT files`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || app.app_scoped_runtime_families.includes('ort-web')) throw error;
    }
  }
});

test('composite references shared runtimes from the root store', async () => {
  const registry = await loadAppsRegistry();
  let workers = 0;
  for (const app of registry.apps) {
    let source;
    try {
      source = await readFile(join(dist, app.path, 'js', 'inference-worker.js'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    workers += 1;
    assert.match(source, /_runtime\/(?:ort-web|nifti-reader)\//, `${app.id} worker does not use shared runtime`);
    if (app.app_scoped_runtime_families.includes('ort-web')) {
      assert.match(source, /\.\.\/wasm\/ort\.webgpu\.bundle\.min\.mjs/);
      assert.doesNotMatch(source, /_runtime\/ort-web/);
    }
  }
  assert.ok(workers >= 5, `expected at least five composite inference workers, found ${workers}`);
});
