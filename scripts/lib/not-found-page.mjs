import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { primaryCatalog } from './apps-registry.mjs';

const DEFAULT_TITLE = 'Neurodesk Webapps';
const DICOMPARE_ROUTES = '<script src="/dicompare/dicompare-routes.js"></script>';
const MOVED = /(<script type="application\/json" id="moved-apps">)[\s\S]*?(<\/script>)/;

/**
 * Where each app path this host does not serve now lives: a former path goes to
 * its app (on this host, or on the host of the app's catalogue), and an app of
 * another catalogue goes to that catalogue's host. Without a catalogue (the
 * all-app assembly) every app is present and only former paths move.
 */
export function movedAppRoutes(registry, catalog) {
  const routes = {};
  const here = (app) => !catalog || app.catalog === catalog.id;
  const home = (app) => {
    if (here(app)) return `/${app.path}`;
    const host = registry.site.catalogs.find((candidate) => candidate.id === app.catalog).host;
    return `https://${host}/${app.path}`;
  };
  for (const app of registry.apps) {
    for (const path of app.former_paths) routes[path] = home(app);
    if (!here(app)) routes[app.path] = home(app);
  }
  return routes;
}

/** The 404 page of one host, from the site/404.html template. */
export function renderNotFoundPage(template, { registry, catalog }) {
  const title = (catalog ?? primaryCatalog(registry)).title;
  const apps = catalog ? registry.apps.filter((app) => app.catalog === catalog.id) : registry.apps;
  const routes = JSON.stringify(movedAppRoutes(registry, catalog)).replaceAll('<', '\\u003c');
  let html = template
    .replace(MOVED, (_match, open, close) => `${open}${routes}${close}`)
    .replaceAll(DEFAULT_TITLE, title.replaceAll('&', '&amp;').replaceAll('<', '&lt;'));
  // dicompare's client routes are restored by its own bridge, which only its host serves.
  if (!apps.some((app) => app.id === 'dicompare')) html = html.replace(`\n  ${DICOMPARE_ROUTES}`, '');
  return html;
}

export async function loadNotFoundTemplate(repoRoot) {
  return readFile(join(repoRoot, 'site', '404.html'), 'utf8');
}
