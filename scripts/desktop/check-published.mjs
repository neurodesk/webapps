import { readFile } from 'node:fs/promises';
import { loadStandalone } from '../lib/standalone.mjs';
import { catalogApps, loadAppsRegistry } from '../lib/apps-registry.mjs';
import { suitePlatforms } from './suite.mjs';

// Holds every published catalogue suite to the current desktop and app versions. A catalogue
// whose suite has not been published yet is skipped: its landing page shows no download.
const registry = await loadAppsRegistry();
const standalone = await loadStandalone(registry);
const desktopVersion = JSON.parse(await readFile('packages/desktop/package.json')).version;
for (const catalog of registry.site.catalogs) {
  const suite = standalone.suites?.[catalog.id];
  if (!suite) {
    console.log(`${catalog.id}: no published suite yet`);
    continue;
  }
  if (!suite.downloads?.length || !Array.isArray(suite.apps)) throw new Error(`${catalog.id}: publish the tested offline suite and import standalone-catalog.json before deploying`);
  if (suite.version !== desktopVersion) throw new Error(`${catalog.id}: publish suite ${desktopVersion} before deploying; catalog still references ${suite.version}`);
  for (const app of catalogApps(registry, catalog)) {
    const version = JSON.parse(await readFile(`apps/${app.id}/package.json`)).version;
    if (!suite.apps.some(item => item.id === app.id && item.version === version)) throw new Error(`${catalog.id}: ${app.id} ${version} has no matching released offline application`);
  }
  const downloads = suitePlatforms(registry, catalog).map(platform => {
    const download = suite.downloads.find(item => item.platform === platform);
    if (!download) throw new Error(`${catalog.id}: missing ${platform} release`);
    return download;
  });
  if (suite.models?.kind !== 'models') throw new Error(`${catalog.id}: publish the platform-independent model pack before deploying`);
  for (const download of [...downloads, suite.models]) {
    for (const file of download.parts || [download]) {
      const response = await fetch(file.url, { method: 'HEAD' });
      if (!response.ok) throw new Error(`Published binary is unavailable: ${file.url} (${response.status})`);
    }
  }
  console.log(`${catalog.id}: every app has a published offline distribution in suite ${suite.version}`);
}
