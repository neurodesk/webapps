import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

test('catalog contains every currently published Neurodesk webapp', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(registry.apps.map(({ id }) => id).sort(), [
    'calmar', 'deface', 'dicom2vid', 'dicompare', 'easy-mp2rage', 'musclemap', 'niimath',
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

test('CI app-test matrix covers the complete catalog', async () => {
  const registry = await loadAppsRegistry();
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(
    [...workflow.jobs['app-tests'].strategy.matrix.app].sort(),
    registry.apps.map(({ id }) => id).sort(),
  );
});
