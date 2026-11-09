import { readFile } from 'node:fs/promises';
import { desktopSuites, loadStandalone, suiteRecord } from '../lib/standalone.mjs';
import { loadAppsRegistry } from '../lib/apps-registry.mjs';

const registry = await loadAppsRegistry();
const catalog = await loadStandalone(registry);
const desktopVersion = JSON.parse(await readFile('packages/desktop/package.json')).version;
for (const suite of desktopSuites(registry)) {
  const record = suiteRecord(catalog, suite);
  if (!suite.primary && !record) {
    console.log(`${suite.title} has no published suite yet; its catalogue links the full suite`);
    continue;
  }
  if (!record?.downloads?.length || !Array.isArray(record.apps)) throw new Error(`Publish the tested ${suite.title} suite and import standalone-catalog.json before deploying`);
  if (record.version !== desktopVersion) throw new Error(`Publish ${suite.title} ${desktopVersion} before deploying; catalog still references ${record.version}`);
  for (const app of suite.apps) {
    const version = JSON.parse(await readFile(`apps/${app.id}/package.json`)).version;
    if (!record.apps.some(item => item.id === app.id && item.version === version)) throw new Error(`${app.id} ${version} has no matching released offline application in ${suite.title}`);
  }
  const platforms = ['macos-arm64', 'windows-x64', 'linux-x64', ...(suite.primary ? ['linux-x64-apptainer'] : [])];
  const downloads = platforms.map(platform => {
    const download = record.downloads.find(item => item.platform === platform);
    if (!download) throw new Error(`Missing ${suite.title} ${platform} release`);
    return download;
  });
  if (record.models?.kind !== 'models') throw new Error(`Publish the ${suite.title} model pack before deploying`);
  for (const download of [...downloads, record.models]) {
    for (const file of download.parts || [download]) {
      const response = await fetch(file.url, { method: 'HEAD' });
      if (!response.ok) throw new Error(`Published binary is unavailable: ${file.url} (${response.status})`);
    }
  }
  console.log(`Every app has a published offline distribution in ${suite.title} ${record.version}`);
}
