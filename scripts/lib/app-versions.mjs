// Changesets owns dependency propagation and changelogs. Apps and their linked
// packages replace the planned semver patch with the UTC release date.
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import getReleasePlan from '@changesets/get-release-plan';
import applyReleasePlan from '@changesets/apply-release-plan';
import { read as readConfig } from '@changesets/config';
import { getPackages } from '@manypkg/get-packages';
import { repoRoot } from './apps-registry.mjs';
import { stringLiterals } from './string-literals.mjs';

export const DATE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(\d{8})$/;
export const LINKED_PACKAGES = Object.freeze({
  '@neurodesk/ants': 'ants',
  '@neurodesk/bison': 'bison',
  '@neurodesk/brain-extraction': 'brain-extraction',
  '@neurodesk/brain2print': 'brain2print',
  '@neurodesk/browserqc': 'browserqc',
  '@neurodesk/brainqcnet': 'brainqcnet',
  '@neurodesk/calmar': 'calmar',
  '@neurodesk/carotid-flow': 'carotid-flow',
  '@neurodesk/deface': 'deface',
  '@neurodesk/degibbs': 'degibbs',
  '@neurodesk/dicompare': 'dicompare',
  '@neurodesk/nii2tvx': 'disconnectome',
  '@neurodesk/mri2vid': 'mri2vid',
  '@neurodesk/dwi2trx': 'dwi2trx',
  '@neurodesk/dwidenoise': 'dwidenoise',
  '@neurodesk/easy-mp2rage': 'easy-mp2rage',
  '@neurodesk/edgereg': 'edgereg',
  '@neurodesk/elastix': 'elastix',
  '@neurodesk/fireants': 'fireants',
  '@neurodesk/greedy': 'greedy',
  '@neurodesk/hmc': 'hmc',
  '@neurodesk/lcmodel': 'lcmodel',
  '@neurodesk/musclemap': 'musclemap',
  '@neurodesk/n4': 'n4',
  '@neurodesk/niimath': 'niimath',
  '@neurodesk/omezarr-convert': 'omezarr-convert',
  '@neurodesk/samsrf': 'samsrf',
  '@neurodesk/sdc': 'sdc',
  '@neurodesk/noddi': 'noddi',
  '@neurodesk/seedseg': 'seedseg',
  '@neurodesk/spinalcordtoolbox': 'spinalcordtoolbox',
  '@neurodesk/synthseg': 'synthseg',
  '@neurodesk/synthsr': 'synthsr',
  '@neurodesk/nesvor': 'nesvor',
  '@neurodesk/qsmbly': 'qsmbly',
  '@neurodesk/syncro': 'syncro',
  '@neurodesk/topofit': 'topofit',
  '@neurodesk/vesselboost': 'vesselboost',
  '@neurodesk/white-matter-lesions': 'white-matter-lesions',
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

/** Workspace package name → directory, for apps, packages and site workspaces. */
export async function workspacePackages(root = repoRoot) {
  const packages = new Map();
  for (const group of ['apps', 'packages', 'site/easter-eggs']) {
    const entries = await readdir(join(root, group), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
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
  const desktopName = '@neurodesk/desktop';
  for (const release of plan.releases) {
    if (release.type === 'none') continue;
    const pkg = packages.get(release.name);
    const datedSite = pkg?.group === 'site/easter-eggs' && DATE_VERSION.test(pkg.manifest.version);
    if (!pkg || (pkg.group !== 'apps' && !Object.hasOwn(LINKED_PACKAGES, release.name) && release.name !== desktopName && !datedSite)) continue;
    const app = packages.get(LINKED_PACKAGES[release.name]);
    const series = app?.manifest.releaseSeries ?? pkg.manifest.releaseSeries;
    if (series !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(series)) {
      throw new Error(`${release.name}: releaseSeries must be MAJOR.MINOR, got ${series}`);
    }
    release.newVersion = nextVersion(release.oldVersion, series === undefined ? release.type : 'patch', date);
    if (series !== undefined) release.newVersion = `${series}.${date}`;
    // GitHub suite artifacts are immutable, including explicit same-day desktop changes.
    if (release.name === desktopName && release.newVersion === release.oldVersion) {
      release.newVersion = nextVersion(release.oldVersion, 'minor', date);
    }
    if (release.newVersion === release.oldVersion && !sameDay) {
      throw new Error(`${release.name} is already at ${release.oldVersion}; release again tomorrow or pass --same-day to update this version`);
    }
  }
  const embeddedUpdates = [];
  for (const release of plan.releases) {
    const pkg = packages.get(release.name);
    if (release.type !== 'none' && pkg?.group === 'apps') {
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
      const merged = mergeSameVersionSections(text, release.newVersion);
      if (merged !== text) await writeFile(path, merged);
    }
  }
  return written;
}

const CHANGE_TYPES = ['Major Changes', 'Minor Changes', 'Patch Changes'];

/** Merge the section Changesets prepends for a same-day release into the existing one. */
export function mergeSameVersionSections(text, version) {
  const heading = `## ${version}\n`;
  const first = text.indexOf(heading);
  const second = first === -1 ? -1 : text.indexOf(heading, first + heading.length);
  if (second === -1) return text;
  const next = text.indexOf('\n## ', second + heading.length);
  const end = next === -1 ? text.length : next + 1;
  const groups = new Map();
  for (const body of [text.slice(first + heading.length, second), text.slice(second + heading.length, end)]) {
    const parts = body.split(/^### (.+)\n/m);
    for (let index = 1; index < parts.length; index += 2) {
      const entries = parts[index + 1].trim();
      if (entries) groups.set(parts[index], [...(groups.get(parts[index]) ?? []), entries]);
    }
  }
  const rank = (title) => (CHANGE_TYPES.includes(title) ? CHANGE_TYPES.indexOf(title) : CHANGE_TYPES.length);
  const sections = [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([title, entries]) => `### ${title}\n\n${entries.join('\n')}\n`);
  const rest = text.slice(end);
  const body = sections.length ? `\n${sections.join('\n')}` : '';
  return `${text.slice(0, first)}${heading}${body}${rest ? `\n${rest}` : ''}`;
}

/**
 * Version strings that live outside package.json. Each app that embeds its
 * version registers a site here; test/app-versions.test.mjs checks they agree.
 */
export const EMBEDDED_VERSION_SITES = Object.freeze({
  'omezarr-convert': [
    { file: 'apps/omezarr-convert/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  'microscope-qc': [
    { file: 'apps/microscope-qc/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  hmc: [
    { file: 'apps/hmc/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  brain2print: [
    { file: 'apps/brain2print/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  nesvor: [
    { file: 'apps/nesvor/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  dwidenoise: [
    { file: 'apps/dwidenoise/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  degibbs: [
    { file: 'apps/degibbs/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  n4: [
    { file: 'apps/n4/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  noddi: [
    { file: 'apps/noddi/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  'calcium-imaging': [
    { file: 'apps/calcium-imaging/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  'cryo-em': [
    { file: 'apps/cryo-em/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  stitching: [
    { file: 'apps/stitching/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  histo2mri: [
    { file: 'apps/histo2mri/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  dwicorrect: [
    { file: 'apps/dwicorrect/src/config.js', pattern: /(version: ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  qsmbly: [
    { file: 'apps/qsmbly/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
    { file: 'apps/qsmbly/rust-wasm/Cargo.toml', pattern: /(name = "qsm_wasm"\nversion = ")[^"]+("\n)/, replace: '$1{version}$2' },
    { file: 'apps/qsmbly/rust-wasm/Cargo.lock', pattern: /(name = "qsm_wasm"\nversion = ")[^"]+("\n)/, replace: '$1{version}$2' },
  ],
  vesselboost: [
    { file: 'apps/vesselboost/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  seedseg: [
    { file: 'apps/seedseg/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  spinalcordtoolbox: [
    { file: 'apps/spinalcordtoolbox/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  calmar: [
    { file: 'apps/calmar/web/js/app/config.js', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  dicompare: [
    { file: 'apps/dicompare/src/version.ts', pattern: /(export const VERSION = ')[^']+(')/, replace: '$1{version}$2' },
  ],
  greedy: [
    { file: 'exes/greedy/Cargo.toml', pattern: /(^\[workspace\.package\][\s\S]*?^version = ")[^"]+(")/m, replace: '$1{version}$2' },
    { file: 'exes/greedy/Cargo.lock', pattern: /(name = "greedy-rs"\nversion = ")[^"]+(")/, replace: '$1{version}$2' },
  ],
  musclemap: [
    { file: 'apps/musclemap/model-sources/release.json', pattern: /("appVersion":\s*")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/model-sources/release.json', pattern: /("targetAppVersion":\s*")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/web/js/app/model-catalog.generated.js', pattern: /(export const APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'apps/musclemap/web/js/app/model-catalog.generated.js', pattern: /(export const TARGET_APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'packages/musclemap/src/model-catalog.generated.js', pattern: /(export const APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
    { file: 'packages/musclemap/src/model-catalog.generated.js', pattern: /(export const TARGET_APP_VERSION = ")[^"]+(")/, replace: '$1{version}$2' },
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
    { file: 'apps/synthsr/src/inference-worker.js', pattern: /(app: 'SynthSR web )[^']+(')/, replace: '$1{version}$2' },
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

// JSX is left out: its text cannot be tokenized without a parser, and app versions live in
// config .js/.ts files.
const VERSION_SOURCE = /^(?:apps|packages|site)\/.+\.(?:[cm]?[jt]s|html)$/;
const NOT_VERSION_SOURCE = /\/(?:test|tests|e2e|validation|docs|vendor|public|node_modules)\/|\.(?:test|spec)\.[^/]+$/;
const DATE_VERSION_IN_TEXT = /(?<![@\w.])v?((\d+)\.(\d+)\.20\d{6})(?![\w.])/dg;
const VERSION_KEY = /version$/i;
const PACKAGE_KEY = /[@/]/;

/**
 * App version literals in tracked sources of date-versioned app, package and site workspaces
 * that no embedded version site rewrites: a `0.0.0` assigned to a key ending in `version`
 * (`version`, `VERSION`, `APP_VERSION`, `appVersion`), and any date version in a string (`v` prefix allowed) whose MAJOR.MINOR is
 * that of the enclosing package. Pins of other packages, `name@x.y.z` specifiers, values under a
 * package-name key (`"@scope/name": "…"`), comments and URLs pass. A date version in HTML
 * outside `<script>` is not checked, nor one whose MAJOR.MINOR is stale.
 */
export async function unsyncedVersionLiterals(root = repoRoot) {
  const { stdout } = await promisify(execFile)('git', ['-C', root, 'ls-files', '-z', 'apps', 'packages', 'site'], { maxBuffer: 64 * 1024 * 1024 });
  const files = stdout.split('\0').filter(Boolean);
  const seriesByDir = new Map();
  for (const file of files.filter((item) => /(?:^|\/)package\.json$/.test(item))) {
    const { version } = JSON.parse(await readFile(join(root, file), 'utf8').catch(() => '{}'));
    const series = DATE_VERSION.exec(version ?? '');
    seriesByDir.set(file.slice(0, -'/package.json'.length), series && `${series[1]}.${series[2]}`);
  }
  const seriesOf = (file) => {
    for (let dir = file; dir.includes('/');) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      // A nested package.json without a date version (easy-mp2rage's web/) defers to its owner.
      if (seriesByDir.get(dir)) return seriesByDir.get(dir);
    }
    return null;
  };
  const sites = Object.values(EMBEDDED_VERSION_SITES).flat();
  const unsynced = [];
  for (const file of files) {
    const series = seriesOf(file);
    if (!series || !VERSION_SOURCE.test(file) || NOT_VERSION_SOURCE.test(file)) continue;
    let text = await readFile(join(root, file), 'utf8').catch(() => '');
    if (file.endsWith('.html')) text = scriptsOnly(text);
    const synced = new Set();
    for (const site of sites.filter((item) => item.file === file)) {
      const match = site.pattern.exec(text);
      if (match) synced.add(match.index + match[1].length);
    }
    for (const { value, start, key } of stringLiterals(text)) {
      if (value.includes('://') || PACKAGE_KEY.test(key ?? '')) continue;
      const found = VERSION_KEY.test(key ?? '') && value === '0.0.0'
        ? [{ version: value, at: start }]
        : [...value.matchAll(DATE_VERSION_IN_TEXT)]
          .filter((match) => `${match[2]}.${match[3]}` === series)
          .map((match) => ({ version: match[1], at: start + match.indices[1][0] }));
      for (const { version, at } of found) {
        if (synced.has(at)) continue;
        const line = text.slice(0, at).split('\n').length;
        unsynced.push(`${file}:${line}: ${version}: read it from package.json (preferred; a dependency's version from that dependency's package.json), or register it in EMBEDDED_VERSION_SITES`);
      }
    }
  }
  return unsynced;
}

// The HTML with everything outside `<script>` elements blanked, keeping offsets and lines.
function scriptsOnly(html) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  let out = '';
  let last = 0;
  for (const match of html.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const body = match.index + match[1].length;
    out += blank(html.slice(last, body)) + match[2];
    last = body + match[2].length;
  }
  return out + blank(html.slice(last));
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
