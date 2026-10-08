import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const MONOREPO = 'https://github.com/neurodesk/webapps';

// Historical repositories from which the browser apps were imported. These
// are provenance, not the current home of the app source. User-facing source,
// issue, and release links must point at this monorepo instead. The registry's
// `source` field is the canonical record; only repositories that were renamed
// before the registry pinned them need listing here by hand.
const RENAMED_LEGACY_REPOSITORIES = {
  'neurodesk/lesion-network-mapping-webapp': 'calmar',
  'astewartau/seedseg': 'seedseg',
};

async function legacyAppRepositories() {
  const registry = await loadAppsRegistry();
  const repositories = new Map(Object.entries(RENAMED_LEGACY_REPOSITORIES));
  for (const app of registry.apps) {
    const repository = app.source.split('@')[0].toLowerCase();
    if (repository === 'neurodesk/webapps') continue;
    repositories.set(repository, app.id);
  }
  return repositories;
}

const SOURCE_EXTENSIONS = new Set(['.cff', '.css', '.html', '.js', '.md', '.toml', '.ts', '.tsx']);
const SKIP_DIRECTORIES = new Set([
  '.git', '.turbo', 'dist', 'legacy-ci', 'node_modules', 'niivue', 'test',
  'test-results', 'tests', 'vendor',
]);

async function browserSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await browserSourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

test('app-facing GitHub links use the monorepo as the current source home', async () => {
  const legacyRepositories = await legacyAppRepositories();
  const stale = [];
  const repositoryUrls = [
    /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/gi,
    /https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)/gi,
  ];

  for (const path of await browserSourceFiles(join(repoRoot, 'apps'))) {
    // Upstream-synced apps (apps/<id>/upstream.json) keep their upstream repository as the
    // source (AGENTS.md); their README credits it, which is provenance, not a stale home.
    const [, appId, file] = relative(join(repoRoot, 'apps'), path).match(/^([^/]+)\/(.+)$/) ?? [];
    if (file === 'README.md' && await readFile(join(repoRoot, 'apps', appId, 'upstream.json')).then(() => true, () => false)) continue;
    const source = await readFile(path, 'utf8');
    for (const repositoryUrl of repositoryUrls) {
      for (const match of source.matchAll(repositoryUrl)) {
        const repository = `${match[1]}/${match[2]}`.toLowerCase();
        const app = legacyRepositories.get(repository);
        if (!app) continue;
        stale.push({
          file: relative(repoRoot, path),
          url: match[0],
          replacement: `${MONOREPO}/tree/main/apps/${app}`,
        });
      }
    }
  }

  assert.deepEqual(stale, [], `Legacy app repositories remain:\n${stale
    .map(({ file, url, replacement }) => `- ${file}: ${url} -> ${replacement}`)
    .join('\n')}`);
});
