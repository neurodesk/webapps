import { join } from 'node:path';
import { catalogApps, findCatalog, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { SITES_DIR } from '../scripts/lib/catalog-sites.mjs';

/**
 * The apps a site check covers and the directory it serves locally. With
 * SITE_CATALOG=<catalog id> a check runs against that catalogue's site
 * (dist-sites/<id>, or its host through BASE_URL); without it, against the
 * all-app assembly in dist/.
 */
export async function siteUnderTest() {
  const registry = await loadAppsRegistry();
  const id = process.env.SITE_CATALOG;
  if (!id) return { registry, apps: registry.apps, siteDir: join(repoRoot, 'dist') };
  const catalog = findCatalog(registry, id);
  return { registry, catalog, apps: catalogApps(registry, catalog), siteDir: join(repoRoot, SITES_DIR, catalog.id) };
}
