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
export const MAX_DESCRIPTION_LENGTH = 60;
export const SHELLS = new Set(['static-html', 'imaging-workspace', 'react']);
export const SUPPORT_STATUSES = new Set(['active', 'experimental', 'maintenance', 'retired']);
// Landing-page facets. Labels are what the app cards show.
export const ANATOMY = new Map([
  ['brain', 'Brain'],
  ['spinal-cord', 'Spinal cord'],
  ['whole-body', 'Whole body'],
  ['prostate', 'Prostate'],
  ['neck', 'Neck'],
  ['any', 'Any anatomy'],
]);
export const MODALITIES = new Map([
  ['mri', 'MRI'],
  ['ct', 'CT'],
  ['mrs', 'MRS'],
  ['microscopy', 'Microscopy'],
  ['surface', 'Surfaces'],
]);
export const INPUT_FORMATS = new Map([
  ['dicom', 'DICOM'],
  ['nifti', 'NIfTI'],
  ['mgz', 'MGZ'],
  ['ome-zarr', 'OME-Zarr'],
  ['tiff', 'TIFF'],
  ['itk', 'NRRD/MHA/MINC'],
  ['gifti', 'GIfTI'],
  ['freesurfer', 'FreeSurfer'],
  ['mesh', 'STL/OBJ/PLY'],
  ['mrs-raw', 'Vendor MRS'],
  ['neuroflow', 'NeuroFlow workflow'],
]);
export const HARDWARE = new Map([
  ['cpu', 'No GPU needed'],
  ['webgl-required', 'Needs WebGL'],
  ['webgpu-optional', 'WebGPU optional'],
  ['webgpu-required', 'Needs WebGPU'],
]);
// What another app sends this one (packages/components/src/handoff): the converted NIfTI
// image by default, the DICOM files it came from, or nothing for an app that cannot use a
// single series (a URL-streaming viewer, a surface editor, a BIDS dataset pipeline).
export const HANDOFF_FORMS = new Set(['nifti', 'dicom', 'none']);
const TOOLCHAINS = new Set(['node', 'rust-wasm', 'python-reference']);
const ASSET_MANIFEST_SCHEMAS = new Set(['scientific-assets-v1', 'pipeline-assets-v1']);
const PINNED_SOURCE = /^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/;
const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]+$/;
const PACKAGE_SCRIPT = /^[a-z][a-z0-9:-]*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LOGO = /^[a-z0-9][a-z0-9-]*\.svg$/;
// Where a catalogue is served: the repository's one GitHub Pages site, or an
// assets-only Cloudflare Worker (.github/workflows/deploy-pages.yml).
export const HOSTINGS = new Set(['pages', 'worker']);

// A catalogue or the hub page: the host it is served from and the brand its
// pages and app shells show.
function validateSiteEntry(entry, label, errors) {
  if (!HOST.test(entry?.host ?? '')) errors.push(`${label}.host must be a host name`);
  for (const key of ['title', 'heading', 'description']) {
    if (typeof entry?.[key] !== 'string' || !entry[key].trim()) errors.push(`${label}.${key} must be a non-empty string`);
  }
  const brand = entry?.brand;
  if (typeof brand?.name !== 'string' || !brand.name.trim()) errors.push(`${label}.brand.name must be a non-empty string`);
  if (!LOGO.test(brand?.logo ?? '')) errors.push(`${label}.brand.logo must name an SVG file in site/`);
  if (!/^https:\/\/\S+\/$/.test(brand?.home ?? '')) errors.push(`${label}.brand.home must be an https URL ending in /`);
  if (typeof brand?.more_apps !== 'string' || !brand.more_apps.trim()) errors.push(`${label}.brand.more_apps must be a non-empty string`);
}

function validateCatalogs(registry, errors) {
  const catalogs = registry?.site?.catalogs;
  if (!Array.isArray(catalogs) || catalogs.length === 0) {
    errors.push('site.catalogs must be a non-empty array');
    return;
  }
  validateSiteEntry(registry.site.hub, 'site.hub', errors);
  const ids = new Set();
  const hosts = new Set([registry.site.hub?.host]);
  for (const catalog of catalogs) {
    if (!ID.test(catalog?.id ?? '')) errors.push(`invalid catalog id: ${catalog?.id}`);
    // dist-sites/hub holds the hub page.
    if (catalog?.id === 'hub') errors.push('catalog id hub is reserved for the hub page');
    if (ids.has(catalog?.id)) errors.push(`duplicate catalog id: ${catalog.id}`);
    if (hosts.has(catalog?.host)) errors.push(`duplicate catalog host: ${catalog.host}`);
    if (!HOSTINGS.has(catalog?.hosting)) errors.push(`hosting for catalog ${catalog?.id} must be one of: ${[...HOSTINGS].join(', ')}`);
    validateSiteEntry(catalog, `catalog ${catalog?.id}`, errors);
    ids.add(catalog?.id);
    hosts.add(catalog?.host);
  }
  // A repository has one GitHub Pages site; it serves the primary domain.
  const pages = catalogs.filter((catalog) => catalog?.hosting === 'pages');
  if (pages.length !== 1 || pages[0].host !== registry.site.domain) {
    errors.push('exactly one catalog must use pages hosting, on site.domain');
  }
  for (const id of ids) {
    if (!registry.apps?.some((app) => app?.catalog === id)) errors.push(`catalog ${id} has no apps`);
  }
}

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
  validateCatalogs(registry, errors);
  const catalogIds = new Set((registry?.site?.catalogs ?? []).map((catalog) => catalog?.id));
  const formerPaths = new Set();

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
    // One home per app: its URL, its landing page and the handoff menu that lists it.
    if (typeof app.catalog !== 'string' || !catalogIds.has(app.catalog)) {
      errors.push(`catalog for ${app.id} must be exactly one declared catalog id`);
    }
    if (app.former_paths !== undefined && (!Array.isArray(app.former_paths)
        || app.former_paths.some((path) => !ID.test(path) || formerPaths.has(path)))) {
      errors.push(`former_paths for ${app.id} must be unique app paths`);
    }
    for (const path of app.former_paths ?? []) formerPaths.add(path);
    if (!Array.isArray(app.keywords) || app.keywords.length === 0
      || app.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim())) {
      errors.push(`keywords must be a non-empty string array for ${app.id}`);
    }
    for (const [field, values] of [['anatomy', ANATOMY], ['modalities', MODALITIES], ['inputs', INPUT_FORMATS]]) {
      const list = app[field];
      if (!Array.isArray(list) || list.length === 0
          || list.some((value) => !values.has(value))
          || new Set(list).size !== list.length) {
        errors.push(`${field} for ${app.id} must be a non-empty array of unique values from: ${[...values.keys()].join(', ')}`);
      }
    }
    if (!HARDWARE.has(app.hardware)) {
      errors.push(`hardware for ${app.id} must be one of: ${[...HARDWARE.keys()].join(', ')}`);
    }
    if (app.remote_compute !== undefined && app.remote_compute !== true) {
      errors.push(`remote_compute for ${app.id} must be true or absent`);
    }
    if (!RUNTIMES.has(app.runtime)) errors.push(`invalid runtime for ${app.id}: ${app.runtime}`);
    if (!SHELLS.has(app.shell)) errors.push(`invalid shell for ${app.id}: ${app.shell}`);
    if (!SUPPORT_STATUSES.has(app.support_status)) {
      errors.push(`invalid support status for ${app.id}: ${app.support_status}`);
    }
    if (app.handoff !== undefined && !HANDOFF_FORMS.has(app.handoff)) {
      errors.push(`handoff for ${app.id} must be one of ${[...HANDOFF_FORMS].join(', ')}`);
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
    if (app.ci?.hardware_gpu !== undefined && typeof app.ci.hardware_gpu !== 'boolean') {
      errors.push(`ci.hardware_gpu must be a boolean for ${app.id}`);
    }
    if (app.ci?.hardware_gpu && app.ci.browser_test !== true) {
      errors.push(`ci.hardware_gpu needs ci.browser_test for ${app.id}`);
    }
    if (app.ci?.e2e_shards !== undefined && !(Number.isInteger(app.ci.e2e_shards) && app.ci.e2e_shards >= 2 && app.ci.e2e_shards <= 4 && app.ci.browser_test === true)) {
      errors.push(`ci.e2e_shards for ${app.id} must be an integer from 2 to 4 on a browser-tested app`);
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
    // The app bar shows the description beside the title; a longer one hides at 1440 px.
    if (app.description?.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters for ${app.id}`);
    }
    if (app.support_status === 'active' && !PINNED_SOURCE.test(app.source)) {
      errors.push(`active app source must be an immutable 40-character commit for ${app.id}`);
    }
    ids.add(app.id);
    paths.add(app.path);
  }

  for (const path of formerPaths) {
    if (paths.has(path)) errors.push(`former path ${path} is a current app path`);
  }

  if (errors.length) throw new Error(`Invalid app registry:\n- ${errors.join('\n- ')}`);
  const siteEntry = (entry) => Object.freeze({ ...entry, brand: Object.freeze({ ...entry.brand }) });
  return Object.freeze({
    site: Object.freeze({
      ...registry.site,
      analytics: Object.freeze({ ...registry.site.analytics }),
      categories: Object.freeze(registry.site.categories.map((category) => Object.freeze({ ...category }))),
      hub: siteEntry(registry.site.hub),
      catalogs: Object.freeze(registry.site.catalogs.map(siteEntry)),
    }),
    apps: Object.freeze(registry.apps.map((app) => Object.freeze({
      ...app,
      ci: Object.freeze({ browser_test: false, hardware_gpu: false, ...app.ci }),
      keywords: Object.freeze([...app.keywords]),
      categories: Object.freeze([...app.categories]),
      anatomy: Object.freeze([...app.anatomy]),
      modalities: Object.freeze([...app.modalities]),
      inputs: Object.freeze([...app.inputs]),
      remote_compute: app.remote_compute === true,
      app_scoped_runtime_families: Object.freeze([...(app.app_scoped_runtime_families ?? [])]),
      former_paths: Object.freeze([...(app.former_paths ?? [])]),
    }))),
  });
}

export function findCatalog(registry, id) {
  const catalog = registry.site.catalogs.find((candidate) => candidate.id === id);
  if (!catalog) throw new Error(`Unknown catalog '${id}'`);
  return catalog;
}

/** The catalogue served from site.domain, which also hosts the analytics report. */
export function primaryCatalog(registry) {
  return registry.site.catalogs.find((catalog) => catalog.host === registry.site.domain);
}

export function catalogApps(registry, catalog) {
  return registry.apps.filter((app) => app.catalog === catalog.id);
}

/** The deployed URL of an app, on its catalogue's host. */
export function appUrl(registry, app) {
  return `https://${findCatalog(registry, app.catalog).host}/${app.path}/`;
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
