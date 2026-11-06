import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

// Ratchet for app-local copies of shared browser-imaging modules. Every file
// listed here shadows a module that already exists in packages/components (or
// is a thin app-specific shim over one). The list may only shrink: extracting
// a fork behind parity tests removes its entry; adding a new shadow of a
// shared module fails this test instead of silently starting a new fork.
const KNOWN_FORKS = new Set();
const GENERATED_MIRRORS = new Map([
  ['apps/dicompare/public/embed/DicompareReportRenderer.js', 'packages/components/src/ui/DicompareReportRenderer.js'],
]);

// App-local names that reimplement a shared module under a different filename.
const FORK_ALIASES = new Map(Object.entries({
  'InferenceExecutor.js': 'inference/PipelineExecutor.js',
  'connected-components.js': 'volume/connectedComponents.js',
  'MorphologyOps.js': 'volume/morphology.js',
  'ThresholdUtils.js': 'volume/normalization.js',
}));

const SKIP_DIRECTORIES = new Set([
  '.git', '.tmp_model_env', '.turbo', 'coverage', 'dist', 'dist-sites', 'fixtures',
  'legacy-ci', 'node_modules', 'test-results', 'vendor',
]);

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...await collectFiles(join(directory, entry.name)));
    } else if (entry.name.endsWith('.js')) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

async function sharedModuleBasenames() {
  const basenames = new Set(FORK_ALIASES.keys());
  for (const path of await collectFiles(join(repoRoot, 'packages', 'components', 'src'))) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name !== 'index.js') basenames.add(name);
  }
  return basenames;
}

test('no app grows a new fork of a shared component module', async () => {
  const shadowed = await sharedModuleBasenames();
  const found = new Set();
  for (const path of await collectFiles(join(repoRoot, 'apps'))) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (shadowed.has(name)) found.add(relative(repoRoot, path));
  }

  const unexpected = [...found].filter((path) => !KNOWN_FORKS.has(path) && !GENERATED_MIRRORS.has(path)).sort();
  assert.deepEqual(unexpected, [], [
    'New app-local shadows of shared components appeared. Import the module from',
    '@neurodesk/webapp-components instead of copying it; if a fork is genuinely',
    'required, extract the shared part first or add a justified allowlist entry:',
    ...unexpected.map((path) => `- ${path}`),
  ].join('\n'));

  const extracted = [...KNOWN_FORKS].filter((path) => !found.has(path)).sort();
  assert.deepEqual(extracted, [], [
    'Forks listed in the ratchet no longer exist — congratulations; remove their',
    'entries from KNOWN_FORKS so the list only shrinks:',
    ...extracted.map((path) => `- ${path}`),
  ].join('\n'));
});

test('distribution mirrors exactly match their canonical source', async () => {
  for (const [target, source] of GENERATED_MIRRORS) {
    assert.equal(await readFile(join(repoRoot, target), 'utf8'), await readFile(join(repoRoot, source), 'utf8'), target);
  }
});
