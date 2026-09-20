import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScalar, parse, parseDocument, visit } from 'yaml';

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const registryPath = join(repoRoot, 'registry', 'apps.yml');

const ID = /^[a-z][a-z0-9-]*$/;
export const RUNTIMES = new Set([
  'static-esm',
  'static-esm-rust',
  'rust-wasm',
  'react-vite',
  'vite-wasm',
  'vite-webgpu',
]);
export const SHELLS = new Set(['static-html', 'imaging-workspace', 'react']);
export const SUPPORT_STATUSES = new Set(['active', 'experimental', 'maintenance', 'retired']);
const TOOLCHAINS = new Set(['node', 'rust-wasm', 'python-reference']);
const ASSET_MANIFEST_SCHEMAS = new Set(['scientific-assets-v1', 'pipeline-assets-v1']);
const PINNED_SOURCE = /^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/;
const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]+$/;
const PACKAGE_SCRIPT = /^[a-z][a-z0-9:-]*$/;

export async function loadAppsRegistry(path = registryPath) {
  const registry = parse(await readFile(path, 'utf8'));
  const errors = [];
  const ids = new Set();
  const paths = new Set();
  const categoryIds = new Set();

  if (!registry?.site?.domain) errors.push('site.domain is required');
  if (!GA4_MEASUREMENT_ID.test(registry?.site?.analytics?.measurement_id ?? '')) {
    errors.push('site.analytics.measurement_id must be a GA4 measurement id');
  }
  if (!Number.isInteger(registry?.site?.analytics?.period_days)
      || registry.site.analytics.period_days < 1
      || registry.site.analytics.period_days > 366) {
    errors.push('site.analytics.period_days must be an integer from 1 to 366');
  }
  if (!Array.isArray(registry?.site?.categories) || registry.site.categories.length === 0) {
    errors.push('site.categories must be a non-empty array');
  }
  for (const category of registry?.site?.categories ?? []) {
    if (!ID.test(category.id ?? '')) errors.push(`invalid category id: ${category.id}`);
    if (categoryIds.has(category.id)) errors.push(`duplicate category id: ${category.id}`);
    if (!category.title || !category.description) {
      errors.push(`incomplete category entry: ${category.id}`);
    }
    categoryIds.add(category.id);
  }
  if (!Array.isArray(registry?.apps) || registry.apps.length === 0) {
    errors.push('apps must be a non-empty array');
  }

  for (const app of registry?.apps ?? []) {
    if (!ID.test(app.id ?? '')) errors.push(`invalid app id: ${app.id}`);
    if (!ID.test(app.path ?? '')) errors.push(`invalid app path for ${app.id}: ${app.path}`);
    if (ids.has(app.id)) errors.push(`duplicate app id: ${app.id}`);
    if (paths.has(app.path)) errors.push(`duplicate app path: ${app.path}`);
    if (!Array.isArray(app.categories) || app.categories.length === 0
        || app.categories.some((category) => !categoryIds.has(category))
        || new Set(app.categories).size !== app.categories.length) {
      errors.push(`categories must be a non-empty array of unique declared category ids for ${app.id}`);
    }
    if (Object.hasOwn(app, 'category')) errors.push(`use categories instead of category for ${app.id}`);
    if (!Array.isArray(app.keywords) || app.keywords.length === 0
      || app.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim())) {
      errors.push(`keywords must be a non-empty string array for ${app.id}`);
    }
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
    if (app.ci?.browser_test !== undefined && typeof app.ci.browser_test !== 'boolean') {
      errors.push(`ci.browser_test must be a boolean for ${app.id}`);
    }
    if (app.ci?.release_test !== undefined && !PACKAGE_SCRIPT.test(app.ci.release_test)) {
      errors.push(`invalid ci.release_test for ${app.id}: ${app.ci.release_test}`);
    }
    if (app.model_manifest === null && app.asset_manifest_schema !== null) {
      errors.push(`asset_manifest_schema must be null when ${app.id} has no model_manifest`);
    }
    if (app.model_manifest && !ASSET_MANIFEST_SCHEMAS.has(app.asset_manifest_schema)) {
      errors.push(`invalid asset manifest schema for ${app.id}: ${app.asset_manifest_schema}`);
    }
    if (app.artifact_budget_bytes !== undefined &&
        (!Number.isInteger(app.artifact_budget_bytes) || app.artifact_budget_bytes <= 0)) {
      errors.push(`artifact_budget_bytes must be a positive integer for ${app.id}`);
    }
    if (app.app_scoped_runtime_families !== undefined && (
      !Array.isArray(app.app_scoped_runtime_families)
      || app.app_scoped_runtime_families.some((family) => !ID.test(family))
      || new Set(app.app_scoped_runtime_families).size !== app.app_scoped_runtime_families.length
    )) {
      errors.push(`app_scoped_runtime_families must contain unique runtime family ids for ${app.id}`);
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
    site: Object.freeze({
      ...registry.site,
      analytics: Object.freeze({ ...registry.site.analytics }),
      categories: Object.freeze(registry.site.categories.map((category) => Object.freeze({ ...category }))),
    }),
    apps: Object.freeze(registry.apps.map((app) => Object.freeze({
      ...app,
      ci: Object.freeze({ browser_test: false, ...app.ci }),
      keywords: Object.freeze([...app.keywords]),
      categories: Object.freeze([...app.categories]),
      app_scoped_runtime_families: Object.freeze([...(app.app_scoped_runtime_families ?? [])]),
    }))),
  });
}

export function findApp(registry, id) {
  const app = registry.apps.find((candidate) => candidate.id === id);
  if (!app) throw new Error(`Unknown app '${id}'`);
  return app;
}

// Return the registry text with `app` appended to `apps`, preserving the
// existing comments, blank lines, key order, and inline `[a, b]` sequences.
// The result is not validated; callers must run loadAppsRegistry on it.
export function addAppToRegistryText(text, app) {
  const doc = parseDocument(text);
  if (doc.errors.length) {
    throw new Error(`Invalid app registry YAML:\n- ${doc.errors.map((e) => e.message).join('\n- ')}`);
  }
  const apps = doc.get('apps');
  if (!apps || typeof apps.add !== 'function') throw new Error('apps must be a sequence');
  const node = doc.createNode(app);
  visit(node, {
    Seq(_, seq) {
      if (seq.items.every((item) => isScalar(item))) seq.flow = true;
    },
  });
  apps.add(node);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
