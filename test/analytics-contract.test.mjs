import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const SOURCE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set(['dist', 'legacy', 'node_modules', 'scripts', 'test', 'tests', 'tools']);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

test('all app sources rely on the shared page-view-only analytics bootstrap', async () => {
  const registry = await loadAppsRegistry();
  assert.equal(registry.site.analytics.measurement_id, 'G-4Z9774J59Y');

  for (const app of registry.apps) {
    for (const path of await sourceFiles(join(repoRoot, 'apps', app.id))) {
      const source = await readFile(path, 'utf8');
      assert.doesNotMatch(source, /googletagmanager\.com\/gtag\/js|gtag\(['"]config['"]/,
        `${path} must not embed app-local Google Analytics`);
    }
  }
});

test('deployments generate static analytics without exposing credentials to the site', async () => {
  for (const workflow of ['deploy-pages.yml']) {
    const source = await readFile(join(repoRoot, '.github', 'workflows', workflow), 'utf8');
    assert.match(source, /node scripts\/write-analytics\.mjs --allow-missing-credentials/);
    assert.match(source, /GA4_PROPERTY_ID: \$\{\{ secrets\.GA4_PROPERTY_ID \}\}/);
    assert.match(source, /GA4_SERVICE_ACCOUNT_KEY: \$\{\{ secrets\.GA4_SERVICE_ACCOUNT_KEY \}\}/);
  }
});
