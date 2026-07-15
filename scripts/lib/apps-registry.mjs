import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const registryPath = join(repoRoot, 'registry', 'apps.yml');

const ID = /^[a-z][a-z0-9-]*$/;
const RUNTIMES = new Set([
  'static-esm',
  'static-esm-rust',
  'rust-wasm',
  'react-vite',
  'vite-wasm',
  'vite-webgpu',
]);
const SHELLS = new Set(['static-html', 'imaging-workspace', 'react']);
const SUPPORT_STATUSES = new Set(['active', 'experimental', 'maintenance', 'retired']);
const TOOLCHAINS = new Set(['node', 'rust-wasm', 'python-reference']);
const ASSET_MANIFEST_SCHEMAS = new Set(['scientific-assets-v1', 'pipeline-assets-v1']);
const PINNED_SOURCE = /^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/;

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
    if (!SHELLS.has(app.shell)) errors.push(`invalid shell for ${app.id}: ${app.shell}`);
    if (!SUPPORT_STATUSES.has(app.support_status)) {
      errors.push(`invalid support status for ${app.id}: ${app.support_status}`);
    }
    if (!Array.isArray(app.maintainers) || app.maintainers.length === 0) {
      errors.push(`maintainers are required for ${app.id}`);
    }
    if (!Array.isArray(app.ci?.toolchains) || !app.ci.toolchains.includes('node')) {
      errors.push(`ci.toolchains for ${app.id} must include node`);
    } else {
      for (const toolchain of app.ci.toolchains) {
        if (!TOOLCHAINS.has(toolchain)) errors.push(`invalid toolchain for ${app.id}: ${toolchain}`);
      }
      if (app.runtime.includes('rust') && !app.ci.toolchains.includes('rust-wasm')) {
        errors.push(`Rust runtime for ${app.id} must declare the rust-wasm toolchain`);
      }
    }
    if (typeof app.ci?.shared_runtime !== 'boolean' || typeof app.ci?.release !== 'boolean') {
      errors.push(`ci.shared_runtime and ci.release must be booleans for ${app.id}`);
    }
    if (app.model_manifest === null && app.asset_manifest_schema !== null) {
      errors.push(`asset_manifest_schema must be null when ${app.id} has no model_manifest`);
    }
    if (app.model_manifest && !ASSET_MANIFEST_SCHEMAS.has(app.asset_manifest_schema)) {
      errors.push(`invalid asset manifest schema for ${app.id}: ${app.asset_manifest_schema}`);
    }
    if (!app.title || !app.description || !app.source || !app.license) {
      errors.push(`incomplete catalog entry: ${app.id}`);
    }
    if (app.support_status === 'active' && !PINNED_SOURCE.test(app.source)) {
      errors.push(`active app source must be an immutable 40-character commit for ${app.id}`);
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
