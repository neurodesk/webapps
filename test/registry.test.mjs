import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

test('catalog contains every currently published Neurodesk webapp', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(registry.apps.map(({ id }) => id).sort(), [
    'browserqc', 'calmar', 'deface', 'dicom2vid', 'dicompare', 'easy-mp2rage', 'musclemap', 'niimath',
    'qsmbly', 'seedseg', 'spinalcordtoolbox', 'vesselboost',
  ]);
});

test('every catalog entry has a workspace and declared manifest', async () => {
  const registry = await loadAppsRegistry();
  for (const app of registry.apps) {
    await access(join(repoRoot, 'apps', app.id, 'package.json'));
    if (app.model_manifest) await access(join(repoRoot, app.model_manifest));
  }
});

test('BrowserQC scientific assets are pinned to Hugging Face and not embedded', async () => {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'models', 'browserqc.manifest.json'), 'utf8'),
  );
  const source = await readFile(join(repoRoot, 'apps', 'browserqc', 'src', 'main.ts'), 'utf8');

  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.base_url.includes(`/resolve/${manifest.revision}/browserqc/`));
  assert.ok(source.includes(manifest.base_url));

  for (const asset of manifest.assets) {
    await assert.rejects(
      access(join(repoRoot, 'apps', 'browserqc', 'public', asset.filename)),
      `${asset.filename} must be fetched from Hugging Face`,
    );
  }
});

test('CI app-test matrix covers the complete catalog', async () => {
  const registry = await loadAppsRegistry();
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(
    [...workflow.jobs['app-tests'].strategy.matrix.app].sort(),
    registry.apps.map(({ id }) => id).sort(),
  );
});
