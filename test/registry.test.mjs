import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { validateAssetManifest } from '../scripts/lib/scientific-assets.mjs';

test('catalog contains every app workspace without a repeated inventory', async () => {
  const registry = await loadAppsRegistry();
  const workspaceIds = [];
  for (const entry of await readdir(join(repoRoot, 'apps'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(repoRoot, 'apps', entry.name, 'package.json'));
      workspaceIds.push(entry.name);
    } catch {}
  }
  assert.deepEqual(registry.apps.map(({ id }) => id).sort(), workspaceIds.sort());
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

test('QSMbly example data stays outside the static release artifact', async () => {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'qsmbly', 'package.json'), 'utf8'),
  );
  assert.ok(!packageJson.neurodeskWebapp.static.include.includes('data'));
});

test('CI app-test matrix covers the complete catalog', async () => {
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  assert.equal(workflow.jobs['app-tests'].needs, 'app-plan');
  assert.match(workflow.jobs['app-tests'].if, /has_apps/);
  assert.match(workflow.jobs['app-tests'].strategy.matrix, /fromJSON\(needs\.app-plan\.outputs\.apps\)/);
});

test('every declared scientific asset manifest satisfies its selected schema', async () => {
  const registry = await loadAppsRegistry();
  const errors = [];
  for (const app of registry.apps) {
    for (const error of await validateAssetManifest(repoRoot, app)) errors.push(`${app.id}: ${error}`);
  }
  assert.deepEqual(errors, []);
});

test('pnpm is the only workspace lockfile authority', async () => {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === 'package-lock.json') found.push(path.slice(repoRoot.length + 1));
    }
  }
  await visit(repoRoot);
  assert.deepEqual(found, []);
});
