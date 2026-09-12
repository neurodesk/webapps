// Changesets owns dependency propagation and changelogs. Apps and their linked
// packages replace the planned semver patch with the UTC release date.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import getReleasePlan from '@changesets/get-release-plan';
import applyReleasePlan from '@changesets/apply-release-plan';
import { read as readConfig } from '@changesets/config';
import { getPackages } from '@manypkg/get-packages';
import { repoRoot } from './apps-registry.mjs';

export const DATE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(\d{8})$/;
export const LINKED_PACKAGES = Object.freeze({
  '@neurodesk/greedy': 'greedy',
  '@neurodesk/synthseg': 'synthseg',
  '@neurodesk/synthsr': 'synthsr',
  '@neurodesk/syncro': 'syncro',
  '@neurodesk/topofit': 'topofit',
});

export function releaseDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replaceAll('-', '');
}

export function validateReleaseDate(date) {
  if (!/^\d{8}$/.test(date)) throw new Error(`Release date must be YYYYMMDD, got ${date}`);
  const parsed = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || releaseDate(parsed) !== date) {
    throw new Error(`Invalid release date: ${date}`);
  }
}

export function nextVersion(current, bump, date) {
  validateReleaseDate(date);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(current);
  if (!match) throw new Error(`Cannot derive a date version from '${current}'`);
  let [major, minor] = [Number(match[1]), Number(match[2])];
  if (bump === 'major') {
    major += 1;
    minor = 0;
  } else if (bump === 'minor') {
    minor += 1;
  } else if (bump !== 'patch') {
    throw new Error(`Unknown bump '${bump}'`);
  }
  if (bump === 'patch' && Number(date) < Number(match[3])) {
    throw new Error(`Release date ${date} would downgrade ${current}`);
  }
  return `${major}.${minor}.${date}`;
}

/** Workspace package name → directory, for apps and packages. */
export async function workspacePackages(root = repoRoot) {
  const packages = new Map();
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, group, entry.name);
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        packages.set(manifest.name, { name: manifest.name, directory, group, manifest, id: entry.name });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return packages;
}

/** Plan all explicit and dependent releases before writing anything. */
export async function planRelease(root = repoRoot, { date = releaseDate(), sameDay = false } = {}) {
  validateReleaseDate(date);
  const workspace = await getPackages(root);
  const packages = await workspacePackages(root);
  const config = await readConfig(root, workspace);
  const linkedGroups = Object.entries(LINKED_PACKAGES)
    .filter(([linked, app]) => packages.has(linked) && packages.has(app))
    .map(([linked, app]) => [app, linked]);
  config.fixed = [...config.fixed, ...linkedGroups];
  const plan = await getReleasePlan(root, undefined, config);
  if (plan.preState) throw new Error('Date releases do not support Changesets prerelease mode.');
  for (const release of plan.releases) {
    if (release.type === 'none') continue;
    const pkg = packages.get(release.name);
    if (pkg.group !== 'apps' && !Object.hasOwn(LINKED_PACKAGES, release.name)) continue;
    release.newVersion = nextVersion(release.oldVersion, release.type, date);
    if (release.newVersion === release.oldVersion && !sameDay) {
      throw new Error(`${release.name} is already at ${release.oldVersion}; release again tomorrow, bump minor, or pass --same-day to update this version`);
    }
  }
  const embeddedUpdates = [];
  for (const release of plan.releases) {
    const pkg = packages.get(release.name);
    if (release.type !== 'none' && pkg.group === 'apps') {
      embeddedUpdates.push(...await embeddedVersionUpdates(pkg.id, release.newVersion, root));
    }
  }
  return { plan, workspace, config, packages, embeddedUpdates };
}

/** Apply the same plan shown by dry-run, including dependency ranges. */
export async function applyRelease({ plan, workspace, config, packages, embeddedUpdates }) {
  const written = await applyReleasePlan(plan, workspace, config, undefined, repoRoot);
  for (const { path, text } of embeddedUpdates) {
    await writeFile(path, text);
    written.push(path);
  }
  for (const release of plan.releases) {
    if (release.type === 'none') continue;
    const pkg = packages.get(release.name);
    if (release.newVersion === release.oldVersion) {
      const path = join(pkg.directory, 'CHANGELOG.md');
      const text = await readFile(path, 'utf8');
      const heading = `## ${release.newVersion}\n`;
      const first = text.indexOf(heading);
      const duplicate = text.indexOf(heading, first + heading.length);
      if (duplicate !== -1) {
        await writeFile(path, text.slice(0, duplicate) + text.slice(duplicate + heading.length));
      }
    }
  }
  return written;
}

/**
 * Version strings that live outside package.json. Each app that embeds its
 * version registers a site here; test/app-versions.test.mjs checks they agree.
 */
export const EMBEDDED_VERSION_SITES = Object.freeze({
  greedy: [
    { file: 'exes/greedy/Cargo.toml', pattern: /(^\[workspace\.package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/greedy/Cargo.lock', pattern: /(name = "greedy-rs"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'exes/greedy/Cargo.lock', pattern: /(name = "greedy-rs-core"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'exes/greedy/Cargo.lock', pattern: /(name = "greedy-rs-wasm"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  musclemap: [
    { file: 'apps/musclemap/model-sources/release.json', pattern: /("appVersion":\s*")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/model-sources/release.json', pattern: /("targetAppVersion":\s*")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/web/js/app/model-catalog.generated.js', pattern: /(export const APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/web/js/app/model-catalog.generated.js', pattern: /(export const TARGET_APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  zarro: [
    { file: 'apps/zarro/src/config.js', pattern: /(version: ')[^']+(')/, replace: '$1{version}$2' },
  ],
  synthseg: [
    { file: 'exes/synthseg/Cargo.toml', pattern: /(^\[package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/synthseg/Cargo.lock', pattern: /(name = "synthseg"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'packages/synthseg/src/pipeline.js', pattern: /(const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
    { file: 'apps/synthseg/src/inference-worker.js', pattern: /(app: 'SynthSeg web )[^']+(')/, replace: '$1{version}$2' },
  ],
  synthsr: [
    { file: 'exes/synthsr/Cargo.toml', pattern: /(^\[package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/synthsr/Cargo.lock', pattern: /(name = "synthsr"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  topofit: [
    { file: 'apps/topofit/src/config.js', pattern: /(version: ')[^']+(')/, replace: '$1{version}$2' },
    { file: 'apps/topofit/src/inference-worker.js', pattern: /(app: 'TopoFit web )[^']+(')/, replace: '$1{version}$2' },
  ],
});

async function embeddedVersionUpdates(appId, version, root) {
  const updates = new Map();
  for (const site of EMBEDDED_VERSION_SITES[appId] ?? []) {
    const path = join(root, site.file);
    const text = updates.get(path) ?? await readFile(path, 'utf8');
    if (!site.pattern.test(text)) throw new Error(`${site.file}: version site not found for ${appId}`);
    const next = text.replace(site.pattern, site.replace.replace('{version}', version));
    if (next !== text) updates.set(path, next);
  }
  return [...updates].map(([path, text]) => ({ path, text }));
}

export async function syncEmbeddedVersions(appId, version, root = repoRoot) {
  const updates = await embeddedVersionUpdates(appId, version, root);
  for (const { path, text } of updates) await writeFile(path, text);
  return updates.map(({ path }) => path);
}

/** Every embedded version string that disagrees with its app's package.json. */
export async function embeddedVersionMismatches(packages, root = repoRoot) {
  const mismatches = [];
  for (const [appId, sites] of Object.entries(EMBEDDED_VERSION_SITES)) {
    const pkg = [...packages.values()].find((item) => item.group === 'apps' && item.id === appId);
    if (!pkg) continue;
    for (const site of sites) {
      const text = await readFile(join(root, site.file), 'utf8').catch(() => null);
      if (text === null) continue;
      const match = site.pattern.exec(text);
      const found = match ? text.slice(match.index + match[1].length, match.index + match[0].length - match[2].length) : null;
      if (found !== pkg.manifest.version) mismatches.push(`${site.file}: ${found ?? 'missing'} ≠ ${appId} ${pkg.manifest.version}`);
    }
  }
  for (const [linked, appId] of Object.entries(LINKED_PACKAGES)) {
    const pkg = packages.get(linked);
    const app = [...packages.values()].find((item) => item.group === 'apps' && item.id === appId);
    if (pkg && app && pkg.manifest.version !== app.manifest.version) mismatches.push(`${linked} ${pkg.manifest.version} ≠ ${appId} ${app.manifest.version}`);
  }
  return mismatches;
}
