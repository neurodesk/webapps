import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'vendor', 'public', 'rust-wasm', 'niivue', 'dcm2niix', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (/\.(?:js|ts)$/.test(entry.name)) result.push(path);
  }
  return result;
}

test('literal About dialog headings use the canonical catalog title', async () => {
  const mismatches = [];
  for (const app of (await loadAppsRegistry()).apps) {
    for (const path of await sources(join(repoRoot, 'apps', app.id))) {
      const text = await readFile(path, 'utf8');
      for (const [, title] of text.matchAll(/\.open\(['"]About ([^'"]+)['"]/g)) {
        if (title !== app.title) mismatches.push(`${app.id}: About ${title}; expected About ${app.title}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
});
