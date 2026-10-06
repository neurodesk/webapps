// Compute the Standalone catalog changes for released native archives, without writing the catalog.
// Usage: node scripts/catalog-update.mjs --out update.json (app@VERSION ... | --tag APP-vVERSION)
// --tag serves the release "released" event: a release without native archives yet is skipped, because
// its native workflow announces it again once the archives are attached.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { nativeReleases, portableSpecsAt } from './lib/native-releases.mjs';
import { releasePlatform } from './lib/portable-command.mjs';
import { catalogUpdate, parseReleases, releaseFromTag } from './lib/standalone-import.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, tag: { type: 'string' } } });
if (!values.out) throw new Error('--out is required');
const catalog = JSON.parse(await readFile(new URL('../registry/standalone.json', import.meta.url), 'utf8'));
const headers = { accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

async function fetchRelease(tag) {
  const response = await fetch(`https://api.github.com/repos/neurodesk/webapps/releases/tags/${tag}`, { headers });
  if (!response.ok) throw new Error(`${tag}: HTTP ${response.status}`);
  return response.json();
}

const nativeAt = (tag) => nativeReleases(portableSpecsAt(`refs/tags/${tag}`));
let releases = parseReleases(positionals);
if (values.tag) {
  const release = releaseFromTag(values.tag);
  const native = release && nativeAt(values.tag).get(release.id);
  const assets = native ? (await fetchRelease(values.tag)).assets : [];
  if (!assets.some((asset) => releasePlatform(native.spec, asset.name))) {
    console.log(`${values.tag}: no native archives attached; nothing to publish`);
    releases = [];
  } else {
    releases = [release];
  }
}
const update = await catalogUpdate(catalog, releases, { fetchRelease, nativeAt });
for (const [id, downloads] of Object.entries(update)) console.log(`${id}: ${downloads.length} verified downloads`);
await writeFile(values.out, `${JSON.stringify(update, null, 2)}\n`);
