// Fails when a release in a computed catalog update no longer serves the archives it verified. The
// publish job runs it before each commit attempt. Uses no packages, so it runs beside the write token.
// With PARTIAL_OK=1 and BASE_CATALOG set on a multi-entry update, entries that fail reverification
// are dropped with a warning and the surviving verified entries are re-applied cleanly.
// Usage: GH_TOKEN=... node scripts/verify-catalog-update.mjs update.json
import { readFile, writeFile } from 'node:fs/promises';
import { applyCatalogUpdate, checkUpdateAssets, filterVerifiedUpdate } from './lib/standalone-import.mjs';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: verify-catalog-update.mjs update.json');
const repository = process.env.GITHUB_REPOSITORY || 'neurodesk/webapps';
const headers = { accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

async function fetchRelease(tag) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, { headers });
  if (!response.ok) throw new Error(`${tag}: HTTP ${response.status}`);
  return response.json();
}

const update = JSON.parse(await readFile(file, 'utf8'));
if (process.env.PARTIAL_OK === '1' && update.length > 1 && process.env.BASE_CATALOG) {
  const { verified, dropped } = await filterVerifiedUpdate(update, fetchRelease, {
    onDrop: (entry, error) => console.log(`::warning::${entry.id}@${entry.version} dropped at commit verification: ${error.message}`),
  });
  if (dropped.length) {
    const catalogPath = new URL('../registry/standalone.json', import.meta.url);
    const base = JSON.parse(await readFile(process.env.BASE_CATALOG, 'utf8'));
    applyCatalogUpdate(base, verified);
    await writeFile(catalogPath, `${JSON.stringify(base, null, 2)}\n`);
    await writeFile(file, `${JSON.stringify(verified, null, 2)}\n`);
  }
} else {
  await checkUpdateAssets(update, fetchRelease);
}
console.log('every archive in the update is still the released one');
