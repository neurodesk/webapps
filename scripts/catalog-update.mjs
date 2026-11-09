// Compute the Standalone catalog changes for released native archives, without writing the catalog.
// Usage: node scripts/catalog-update.mjs --out update.json (app@VERSION ... | --tag APP-vVERSION | --missing)
// webapps@VERSION (tag webapps-vVERSION) is the nightly desktop suite.
// --tag serves the release "released" event: a release without native archives yet is skipped, because
// its native workflow announces it again once the archives are attached.
// --missing serves the schedule: each app's newest release whose archives the catalog does not link yet. One
// that is not complete yet is skipped with a warning; its own native workflow still announces it.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { nativeReleases, portableSpecs, portableSpecsAt } from './lib/native-releases.mjs';
import { SUITE_ID, catalogUpdate, parseReleases, releaseFromTag, releaseSources, unlistedReleases } from './lib/standalone-import.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, tag: { type: 'string' }, missing: { type: 'boolean' } } });
if (!values.out) throw new Error('--out is required');
const catalog = JSON.parse(await readFile(new URL('../registry/standalone.json', import.meta.url), 'utf8'));
const headers = { accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

async function fetchRelease(tag) {
  const response = await fetch(`https://api.github.com/repos/neurodesk/webapps/releases/tags/${tag}`, { headers });
  if (!response.ok) throw new Error(`${tag}: HTTP ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

const nativeAt = (tag) => nativeReleases(portableSpecsAt(`refs/tags/${tag}`));
let releases = parseReleases(positionals);
if (values.tag && releaseFromTag(values.tag)?.id === SUITE_ID) {
  releases = [releaseFromTag(values.tag)];
} else if (values.tag) {
  const release = releaseFromTag(values.tag);
  const sources = (release && nativeAt(values.tag).get(release.id)) ?? [];
  const built = sources.length ? releaseSources(sources, await fetchRelease(values.tag)) : [];
  if (!built.length) {
    console.log(`${values.tag}: no native archives attached; nothing to publish`);
    releases = [];
  } else {
    releases = [release];
  }
}
async function allReleases() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/neurodesk/webapps/releases?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`releases page ${page}: HTTP ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

let update;
if (values.missing) {
  update = [];
  for (const release of unlistedReleases(catalog, await allReleases(), nativeReleases(await portableSpecs()))) {
    try {
      update.push(...await catalogUpdate(catalog, [release], { fetchRelease, fetchText, nativeAt }));
    } catch (error) {
      console.log(`::warning::${release.id}@${release.version} not published: ${error.message}`);
    }
  }
} else {
  update = await catalogUpdate(catalog, releases, { fetchRelease, fetchText, nativeAt });
}
for (const { id, version, downloads, suite } of update) console.log(`${id}@${version}: ${(downloads ?? suite.downloads).length} verified downloads`);
await writeFile(values.out, `${JSON.stringify(update, null, 2)}\n`);
