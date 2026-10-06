// Write published native releases into registry/standalone.json.
// Usage: node scripts/desktop/import-native-releases.mjs [app@VERSION ...]
// With no arguments, every command-line entry is refreshed from the release it already names.
import { readFile, writeFile } from 'node:fs/promises';
import { portableSpecs } from '../lib/native-releases.mjs';
import { catalogReleases, importReleases, parseReleases } from '../lib/standalone-import.mjs';

const path = new URL('../../registry/standalone.json', import.meta.url);
const catalog = JSON.parse(await readFile(path, 'utf8'));
const releases = process.argv.length > 2 ? parseReleases(process.argv.slice(2)) : catalogReleases(catalog);
const headers = { accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

async function fetchRelease(tag) {
  const response = await fetch(`https://api.github.com/repos/neurodesk/webapps/releases/tags/${tag}`, { headers });
  if (!response.ok) throw new Error(`${tag}: HTTP ${response.status}`);
  return response.json();
}

await importReleases(catalog, releases, { fetchRelease, specs: await portableSpecs() });
for (const { id, version } of releases) console.log(`${id}: ${catalog.apps[id].downloads.length} downloads from ${id}-v${version}`);
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
