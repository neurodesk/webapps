// Import independently versioned native releases; never guess URLs from web versions.
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../../registry/standalone.json', import.meta.url);
const catalog = JSON.parse(await readFile(path));
const releases = { greedy: '0.2.20260914', synthsr: '0.3.20260910', synthseg: '0.2.20260910' };
for (const [id, version] of Object.entries(releases)) {
  const response = await fetch(`https://api.github.com/repos/neurodesk/webapps/releases/tags/${id}-v${version}`);
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft) throw new Error(`${id}: native release is still a draft`);
  catalog.apps[id].downloads = release.assets.flatMap(asset => {
    const match = asset.name.match(/-(macos-arm64|linux-x64|windows-x64)\.(?:pkg|tar\.gz|zip)$/);
    if (!match) return [];
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error(`${asset.name}: GitHub has no asset digest`);
    return [{ kind: 'cli', platform: match[1], version, url: asset.browser_download_url, sha256: asset.digest.slice(7), bytes: asset.size,
      validationUrl: release.assets.find(item => item.name === `${asset.name}.validation.txt`)?.browser_download_url,
      modelsIncluded: id !== 'greedy',
    }];
  });
  console.log(`${id}: ${catalog.apps[id].downloads.length} released native downloads`);
}
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
