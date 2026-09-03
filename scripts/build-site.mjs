#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { injectCompositeTheme } from './lib/composite-theme.mjs';
import { renderLandingPage } from './lib/landing-page.mjs';
import { assembleRuntimeAssetStore } from './lib/runtime-assets.mjs';
import { headersFile } from './lib/vite-app-config.mjs';

const registry = await loadAppsRegistry();
const siteDist = join(repoRoot, 'dist');
const siteOrigin = `https://${registry.site.domain}`;

// Standalone builds bake these files into app dist. Turbo can restore an app
// build created before a shared file changed, so composite assembly refreshes
// every baked copy from its source.
const sharedSiteAssets = [
  ['app-theme.css', join(repoRoot, 'site', 'app-theme.css')],
  ['theme.js', join(repoRoot, 'site', 'theme.js')],
  ['app-shell.js', join(repoRoot, 'site', 'app-shell.js')],
  ['shell-adapters', join(repoRoot, 'site', 'shell-adapters')],
  ['analytics.js', join(repoRoot, 'packages', 'analytics', 'src', 'index.js')],
  ['neurodesk-logo.svg', join(repoRoot, 'site', 'neurodesk-logo.svg')],
];
await rm(siteDist, { recursive: true, force: true });
await mkdir(siteDist, { recursive: true });

for (const app of registry.apps) {
  const source = join(repoRoot, 'apps', app.id, 'dist');
  const destination = join(siteDist, app.path);
  await cp(source, destination, { recursive: true });

  for (const [name, sharedSource] of sharedSiteAssets) {
    const baked = join(destination, name);
    if (existsSync(baked)) await cp(sharedSource, baked, { recursive: true });
  }

  const indexPath = join(destination, 'index.html');
  const indexHtml = await readFile(indexPath, 'utf8');
  const appPackage = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
  await writeFile(indexPath, injectCompositeTheme(indexHtml, {
    appId: app.id,
    shell: app.shell,
    title: app.title,
    description: app.description,
    version: appPackage.version,
    measurementId: registry.site.analytics.measurement_id,
    url: `${siteOrigin}/${app.path}/`,
  }));
}

await assembleRuntimeAssetStore({ repoRoot, siteDist, registry });

await writeFile(join(siteDist, 'index.html'), renderLandingPage(registry));
await cp(join(repoRoot, 'site', 'landing.css'), join(siteDist, 'landing.css'));
await cp(join(repoRoot, 'site', 'landing.js'), join(siteDist, 'landing.js'));
for (const [name, sharedSource] of sharedSiteAssets) {
  await cp(sharedSource, join(siteDist, name), { recursive: true });
}
await cp(join(repoRoot, 'site', 'analytics.json'), join(siteDist, 'analytics.json'));
await writeFile(join(siteDist, '.nojekyll'), '');
await writeFile(join(siteDist, '_headers'), headersFile);
console.log(`Assembled ${registry.apps.length} apps at ${siteDist}`);
