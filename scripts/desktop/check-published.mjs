import { readFile } from 'node:fs/promises';
import { loadStandalone } from '../lib/standalone.mjs';
import { loadAppsRegistry } from '../lib/apps-registry.mjs';

const registry = await loadAppsRegistry();
const catalog = await loadStandalone(registry);
const suite = catalog.suite;
if (!suite?.downloads?.length || !Array.isArray(suite.apps)) throw new Error('Publish the tested offline suite and import standalone-catalog.json before deploying');
for (const app of registry.apps) {
  const version = JSON.parse(await readFile(`apps/${app.id}/package.json`)).version;
  if (!suite.apps.some(item => item.id === app.id && item.version === version)) throw new Error(`${app.id} ${version} has no matching released offline application`);
}
for (const platform of ['macos-arm64', 'windows-x64', 'linux-x64', 'linux-x64-apptainer']) {
  const download = suite.downloads.find(item => item.platform === platform);
  if (!download?.modelsIncluded) throw new Error(`Missing model-inclusive ${platform} release`);
  for (const file of download.parts || [download]) {
    const response = await fetch(file.url, { method: 'HEAD' });
    if (!response.ok) throw new Error(`Published binary is unavailable: ${file.url} (${response.status})`);
  }
}
console.log(`Every app has a published offline distribution in suite ${suite.version}`);
