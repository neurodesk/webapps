#!/usr/bin/env node
import { stageDicompareRoutes } from './lib/dicompare-routes.mjs';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { loadAppInformation } from './lib/app-information.mjs';
import {
  HUB_SITE,
  SITES_DIR,
  hostedThemeOptions,
  projectCatalogSite,
  projectHubSite,
  workerConfig,
  workerSites,
} from './lib/catalog-sites.mjs';
import { injectCompositeTheme } from './lib/composite-theme.mjs';
import { renderLandingPage } from './lib/landing-page.mjs';
import { loadNotFoundTemplate, renderNotFoundPage } from './lib/not-found-page.mjs';
import { assembleRuntimeAssetStore } from './lib/runtime-assets.mjs';
import { headersFile } from './lib/vite-app-config.mjs';
import { loadStandalone, stageStandaloneAssets } from './lib/standalone.mjs';

const registry = await loadAppsRegistry();
const information = await loadAppInformation(registry);
const standalone = await loadStandalone(registry);
// dist/ is the all-app assembly the desktop suite reads; each catalogue's
// deployable site is projected from it into dist-sites/<catalog id>.
const siteDist = join(repoRoot, 'dist');
const sitesDir = join(repoRoot, SITES_DIR);
const notFoundTemplate = await loadNotFoundTemplate(repoRoot);

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
  ['sciget-logo.svg', join(repoRoot, 'site', 'sciget-logo.svg')],
  ['fonts', join(repoRoot, 'site', 'fonts')],
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
  await writeFile(indexPath, injectCompositeTheme(indexHtml, hostedThemeOptions({
    registry, information, app, version: appPackage.version,
  })));
  await rm(join(destination, 'standalone.json'), { force: true });
  await rm(join(destination, 'shell-adapters/components'), { recursive: true, force: true });
}

await cp(join(repoRoot, 'site/easter-eggs/vessel-surfer/dist'), join(siteDist, 'surf'), { recursive: true });

await assembleRuntimeAssetStore({ repoRoot, siteDist, registry });

await writeFile(join(siteDist, 'index.html'), renderLandingPage(registry, standalone));
await cp(join(repoRoot, 'site', 'landing.css'), join(siteDist, 'landing.css'));
await cp(join(repoRoot, 'site', 'landing.js'), join(siteDist, 'landing.js'));
for (const [name, sharedSource] of sharedSiteAssets) {
  await cp(sharedSource, join(siteDist, name), { recursive: true });
}
await cp(join(repoRoot, 'site', 'analytics.json'), join(siteDist, 'analytics.json'));
await stageStandaloneAssets(siteDist);
await stageDicompareRoutes({ repoRoot, siteDist });
await writeFile(join(siteDist, '404.html'), renderNotFoundPage(notFoundTemplate, { registry }));
await writeFile(join(siteDist, '.nojekyll'), '');
await writeFile(join(siteDist, '_headers'), headersFile);
console.log(`Assembled ${registry.apps.length} apps at ${siteDist}`);

await rm(sitesDir, { recursive: true, force: true });
for (const catalog of registry.site.catalogs) {
  const destination = join(sitesDir, catalog.id);
  const site = await projectCatalogSite({
    repoRoot, siteDist, destination, registry, catalog, information, standalone, notFoundTemplate,
  });
  console.log(`Projected ${site.apps.length} apps and ${site.families.length} runtime families for ${catalog.host} at ${destination}`);
}
await projectHubSite({ siteDist, destination: join(sitesDir, HUB_SITE), registry });
console.log(`Wrote the ${registry.site.hub.host} hub at ${join(sitesDir, HUB_SITE)}`);
for (const { host, site } of workerSites(registry)) {
  await writeFile(join(sitesDir, `${site}.wrangler.json`), `${JSON.stringify(workerConfig(host, site), null, 2)}\n`);
}
