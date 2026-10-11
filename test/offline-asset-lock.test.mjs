import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { canonicalUrl } from '../packages/desktop/src/bundle.js';

// scripts/desktop/assets.mjs refuses a lock whose per-app list differs from the
// sources, but it only runs in the nightly standalone build because it downloads
// every asset. This checks the same lists without the network, on every pull request.
const sources = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.sources.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(repoRoot, 'registry/offline-assets.lock.json'), 'utf8'));

test('each app\'s locked asset list matches its offline sources', () => {
  const drift = [];
  for (const id of new Set([...Object.keys(sources.apps), ...Object.keys(lock.apps)])) {
    const wanted = new Set((sources.apps[id] ?? []).map(source => canonicalUrl(source.url)));
    const locked = new Set(lock.apps[id] ?? []);
    const onlyLocked = [...locked].filter(url => !wanted.has(url));
    const onlySources = [...wanted].filter(url => !locked.has(url));
    if (onlyLocked.length || onlySources.length) drift.push({ app: id, onlyLocked, onlySources });
  }
  assert.deepEqual(drift, [], 'Update registry/offline-assets.lock.json apps lists to match the sources');
});

test('every locked URL a bundle needs has a lock entry, except ones built from the checkout', () => {
  const built = new Set(Object.values(sources.apps).flat().filter(source => source.path).map(source => canonicalUrl(source.url)));
  const missing = [];
  for (const [id, urls] of Object.entries(lock.apps)) {
    for (const url of urls) if (!built.has(url) && !lock.assets[url]) missing.push(`${id}: ${url}`);
  }
  for (const [url, asset] of Object.entries(lock.assets)) {
    for (const dependency of asset.dependencies ?? []) if (!lock.assets[dependency]) missing.push(`${url} -> ${dependency}`);
  }
  assert.deepEqual(missing, []);
});
