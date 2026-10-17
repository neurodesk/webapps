import { posix } from 'node:path';
import { parse } from 'yaml';

// Which pnpm workspace importers a pnpm-lock.yaml change affects, from the
// lockfile text before and after. An importer is affected when its own
// dependency entries changed or when any package in its resolved closure,
// before or after the change, was added, removed or resolved differently.
// A non-root importer is also affected through the workspace importers it
// links. The root importer's links are not followed: its direct dependencies
// are hoisted for every workspace member, but a linked package's own
// dependencies stay in that package's node_modules.
// Anything this cannot classify throws LockfileAnalysisError, and the caller
// falls back to the full catalog.

export class LockfileAnalysisError extends Error {}

const SUPPORTED_VERSION = '9.0';
// The only top-level sections analysed entry by entry. A change to any other
// (settings, overrides, patchedDependencies, packageExtensionsChecksum,
// catalogs, lockfileVersion, ...) can alter every resolution.
const RESOLUTION_SECTIONS = new Set(['importers', 'packages', 'snapshots']);
const IMPORTER_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SNAPSHOT_FIELDS = ['dependencies', 'optionalDependencies'];
const LINK = 'link:';
const REPORTED_PACKAGES = 5;

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseLockfile(text, side) {
  let lock;
  try {
    lock = parse(text);
  } catch (error) {
    throw new LockfileAnalysisError(`the ${side} pnpm-lock.yaml does not parse (${error.message})`);
  }
  if (lock?.lockfileVersion !== SUPPORTED_VERSION) {
    throw new LockfileAnalysisError(`the ${side} pnpm-lock.yaml has lockfileVersion ${lock?.lockfileVersion}, not ${SUPPORTED_VERSION}`);
  }
  return { importers: {}, packages: {}, snapshots: {}, ...lock };
}

// `foo@1.2.3(peer@1)` is described by packages['foo@1.2.3'].
function packageKey(snapshot) {
  return snapshot.replace(/\(.*$/, '');
}

// A dependency resolves to `name@version`, or, for an npm: alias, to the version itself.
function snapshotOf(lock, name, version, owner) {
  for (const key of [`${name}@${version}`, String(version)]) {
    if (Object.hasOwn(lock.snapshots, key)) return key;
  }
  throw new LockfileAnalysisError(`pnpm-lock.yaml resolves ${name} for ${owner} to ${version}, which has no snapshot`);
}

function closure(lock, path) {
  const seen = new Set();
  const pending = [];
  const visit = (dependencies, owner) => {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      if (String(version).startsWith(LINK)) continue;
      const key = snapshotOf(lock, name, version, owner);
      if (!seen.has(key)) {
        seen.add(key);
        pending.push(key);
      }
    }
  };
  const importer = lock.importers[path];
  for (const field of IMPORTER_FIELDS) {
    visit(Object.fromEntries(Object.entries(importer?.[field] ?? {}).map(([name, entry]) => [name, entry?.version])), path);
  }
  while (pending.length) {
    const key = pending.pop();
    for (const field of SNAPSHOT_FIELDS) visit(lock.snapshots[key]?.[field], key);
  }
  return seen;
}

function linkedImporters(lock, path) {
  const importer = lock.importers[path];
  const targets = [];
  for (const field of IMPORTER_FIELDS) {
    for (const entry of Object.values(importer?.[field] ?? {})) {
      const version = String(entry?.version ?? '');
      if (version.startsWith(LINK)) targets.push(posix.normalize(posix.join(path, version.slice(LINK.length))));
    }
  }
  return targets;
}

// Map of affected importer path ('.', 'apps/x', 'packages/y', ...) to why.
export function lockfileImpact({ before, after }, { independentRootDevDependencies = [] } = {}) {
  const base = parseLockfile(before, 'base');
  const head = parseLockfile(after, 'head');
  for (const section of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (!RESOLUTION_SECTIONS.has(section) && !same(base[section], head[section])) {
      throw new LockfileAnalysisError(`pnpm-lock.yaml changed its ${section} section, which can alter every resolution`);
    }
  }
  if (independentRootDevDependencies.length) {
    for (const lock of [base, head]) {
      // Validate tool resolutions too, before removing their independent roots.
      closure(lock, '.');
      const importer = lock.importers['.'];
      if (!importer?.devDependencies) continue;
      const remaining = Object.fromEntries(Object.entries(importer.devDependencies).filter(([name]) => !independentRootDevDependencies.includes(name)));
      if (Object.keys(remaining).length) importer.devDependencies = remaining;
      else delete importer.devDependencies;
    }
  }
  const changed = (key) => !same(base.snapshots[key], head.snapshots[key])
    || !same(base.packages[packageKey(key)], head.packages[packageKey(key)]);

  const importers = [...new Set([...Object.keys(base.importers), ...Object.keys(head.importers)])].sort();
  const affected = new Map();
  for (const path of importers) {
    // Resolved even when the entries changed, so an incomplete lockfile always falls back.
    const packages = [...new Set([...closure(base, path), ...closure(head, path)])].filter(changed).sort();
    if (!same(base.importers[path], head.importers[path])) {
      const state = !base.importers[path] ? 'was added' : !head.importers[path] ? 'was removed' : 'changed its dependency entries';
      affected.set(path, `importer ${path} ${state}`);
    } else if (packages.length) {
      const shown = packages.slice(0, REPORTED_PACKAGES).join(', ');
      const more = packages.length > REPORTED_PACKAGES ? ` and ${packages.length - REPORTED_PACKAGES} more` : '';
      affected.set(path, `importer ${path} resolves changed packages ${shown}${more}`);
    }
  }

  const links = new Map(importers.map((path) => [path, new Set([...linkedImporters(base, path), ...linkedImporters(head, path)])]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const path of importers) {
      if (path === '.' || affected.has(path)) continue;
      const target = [...links.get(path)].find((linked) => affected.has(linked));
      if (target) {
        affected.set(path, `importer ${path} links affected importer ${target}`);
        grew = true;
      }
    }
  }
  return affected;
}
