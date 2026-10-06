// Import independently versioned native releases; never guess URLs from web versions.
// Usage: node scripts/desktop/import-native-releases.mjs [app@VERSION ...]
// Each argument adds or replaces one pinned release; its GitHub tag must already carry archives.
import { readFile, writeFile } from 'node:fs/promises';
import { portableCommand, releasePlatform } from '../lib/portable-command.mjs';

const path = new URL('../../registry/standalone.json', import.meta.url);
const catalog = JSON.parse(await readFile(path));
const releases = { greedy: '0.2.20260914', synthsr: '0.3.20260910', synthseg: '0.2.20260910' };
for (const argument of process.argv.slice(2)) {
  const [id, version] = argument.split('@');
  if (!catalog.apps[id] || !/^\d+\.\d+\.\d{8}$/.test(version || '')) throw new Error(`Expected app@MAJOR.MINOR.YYYYMMDD, got ${argument}`);
  releases[id] = version;
}

// Apps packaged by exes/node-cli bundle their models and describe how to run them in release.json.
async function portableSpec(id) {
  try {
    return JSON.parse(await readFile(new URL(`../../packages/${id}/release.json`, import.meta.url)));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

for (const [id, version] of Object.entries(releases)) {
  const response = await fetch(`https://api.github.com/repos/neurodesk/webapps/releases/tags/${id}-v${version}`);
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft) throw new Error(`${id}: native release is still a draft`);
  const spec = await portableSpec(id);
  const downloads = release.assets.flatMap(asset => {
    const platform = releasePlatform(spec, asset.name);
    if (!platform) return [];
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error(`${asset.name}: GitHub has no asset digest`);
    return [{ kind: 'cli', platform, version, url: asset.browser_download_url, sha256: asset.digest.slice(7), bytes: asset.size,
      validationUrl: release.assets.find(item => item.name === `${asset.name}.validation.txt`)?.browser_download_url,
      ...(spec ? { modelsIncluded: true, command: portableCommand(spec, platform, asset.name) } : {}),
    }];
  });
  if (!downloads.length) throw new Error(`${id}: release ${id}-v${version} has no native archives`);
  catalog.apps[id].downloads = downloads;
  console.log(`${id}: ${downloads.length} released native downloads`);
}
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
