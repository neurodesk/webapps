import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const registryPath = join(repoRoot, 'registry', 'apps.yml');

const ID = /^[a-z][a-z0-9-]*$/;
const RUNTIMES = new Set(['static-esm', 'static-esm-rust', 'rust-wasm', 'react-vite']);

export async function loadAppsRegistry(path = registryPath) {
  const registry = parse(await readFile(path, 'utf8'));
  const errors = [];
  const ids = new Set();
  const paths = new Set();

  if (!registry?.site?.domain) errors.push('site.domain is required');
  if (!registry?.site?.cloudflare_project) errors.push('site.cloudflare_project is required');
  if (!Array.isArray(registry?.apps) || registry.apps.length === 0) {
    errors.push('apps must be a non-empty array');
  }

  for (const app of registry?.apps ?? []) {
    if (!ID.test(app.id ?? '')) errors.push(`invalid app id: ${app.id}`);
    if (!ID.test(app.path ?? '')) errors.push(`invalid app path for ${app.id}: ${app.path}`);
    if (ids.has(app.id)) errors.push(`duplicate app id: ${app.id}`);
    if (paths.has(app.path)) errors.push(`duplicate app path: ${app.path}`);
    if (!RUNTIMES.has(app.runtime)) errors.push(`invalid runtime for ${app.id}: ${app.runtime}`);
    if (!app.title || !app.description || !app.source || !app.license) {
      errors.push(`incomplete catalog entry: ${app.id}`);
    }
    ids.add(app.id);
    paths.add(app.path);
  }

  if (errors.length) throw new Error(`Invalid app registry:\n- ${errors.join('\n- ')}`);
  return Object.freeze({
    site: Object.freeze({ ...registry.site }),
    apps: Object.freeze(registry.apps.map((app) => Object.freeze({ ...app }))),
  });
}

export function findApp(registry, id) {
  const app = registry.apps.find((candidate) => candidate.id === id);
  if (!app) throw new Error(`Unknown app '${id}'`);
  return app;
}
