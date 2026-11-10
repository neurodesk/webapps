import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { selectAffectedApps } from './app-plan.mjs';
import { LockfileAnalysisError, lockfileImpact } from './lockfile-impact.mjs';
import { moduleClosure, packageSources } from './module-closure.mjs';
import { reachableFrom } from './workspace-graph.mjs';

// Whether a path-filtered workflow has to run for a pull request.
//
// GitHub starts a workflow when any file of the whole pull request matches its
// `paths`, on every push. Filters on shared trees (`packages/components/**`,
// `pnpm-lock.yaml`, `registry/**`) therefore start a native suite for changes
// that never reach it. The gate keeps those filters as the coarse trigger and
// asks, for a pull request whose only matches are shared:
//   - does a script the workflow runs load a changed file: any script of a
//     package it owns (command line, tests, validation harnesses, browser
//     pages) or a root script one of its steps names,
//   - does the lockfile change resolve a package it owns differently,
//   - does the app planner select an app the workflow builds.
// A file under any other filter is the workflow's own and always runs it.
// Pushes to main, schedules and dispatches are not gated.
// The import closure is a lower bound: a file read through a computed path is
// not seen, and is first tested on main.

const ROOT_MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const SHARED_TREE = /^(?:packages|exes|scripts|test|test-utils|registry|models)\/\*\*$/;
// Packages every app is built from. A glob into one is shared; a single file
// in one is a generated command-line import and stays the workflow's own.
export const SHARED_PACKAGES = ['packages/components', 'packages/runtime-support'];
const LOCKFILE = 'pnpm-lock.yaml';
const WORKSPACE_MANIFEST = /^(?:packages|exes)\/[^/]+\/package\.json$/;

export function isSharedFilter(filter) {
  if (ROOT_MANIFESTS.includes(filter) || SHARED_TREE.test(filter)) return true;
  return SHARED_PACKAGES.some((directory) => filter === `${directory}/package.json`
    || (filter.startsWith(`${directory}/`) && filter.includes('*')));
}

// GitHub's `paths` glob: `**` crosses directories, `*` does not.
export function pathGlob(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${source}$`);
}

// A workflow owns the packages it filters on whole.
export function ownedPackages(filters, root) {
  return filters
    .map((filter) => filter.match(/^((?:packages|exes)\/[^/*]+)\/\*\*$/)?.[1])
    .filter((directory) => directory && !SHARED_PACKAGES.includes(directory) && existsSync(join(root, directory, 'package.json')));
}

// The registry apps a workflow builds: the ones it filters on.
export function workflowApps(filters, registry) {
  const ids = new Set(registry.apps.map((app) => app.id));
  return [...new Set(filters.map((filter) => filter.match(/^apps\/([^/*]+)\//)?.[1]).filter((id) => ids.has(id)))];
}

// Root scripts a workflow's steps name (`node scripts/desktop/smoke.mjs`).
const ROOT_SCRIPT = /(?:^|[\s'"=(])((?:scripts|test-utils|test)\/[\w./-]+\.[cm]?[jt]s)\b/gm;
export function workflowScripts(flow) {
  const commands = Object.values(flow?.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ''));
  return [...new Set(commands.flatMap((command) => [...command.matchAll(ROOT_SCRIPT)].map((match) => match[1])))];
}

// A dependency's package.json that only gained `exports` entries resolves
// every existing import as before. Anything else may not.
export function onlyAddsExports({ before, after }) {
  let old;
  let now;
  try {
    [old, now] = [JSON.parse(before), JSON.parse(after)];
  } catch {
    return false;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fields = new Set([...Object.keys(old), ...Object.keys(now)]);
  if ([...fields].some((field) => field !== 'exports' && !same(old[field], now[field]))) return false;
  const [was, is] = [old.exports, now.exports];
  if (!was || !is || typeof was !== 'object' || typeof is !== 'object') return false;
  // A pattern entry can be shadowed by a more specific addition.
  if (Object.keys(was).some((key) => key.includes('*'))) return false;
  return Object.keys(was).every((key) => same(was[key], is[key]));
}

export function decideWorkflow({ flow, changedPaths, registry, graph, manifests = new Map(), root }) {
  const run = (reason) => ({ run: true, reason });
  const filters = flow?.on?.pull_request?.paths;
  if (!Array.isArray(filters)) return run('the workflow has no pull request path filter');
  if (filters.some((filter) => filter.startsWith('!'))) return run('the workflow excludes paths, which the gate does not analyse');
  if (!changedPaths.length) return run('the changed paths are unknown');

  const patterns = filters.map((filter) => ({ filter, shared: isSharedFilter(filter), glob: pathGlob(filter) }));
  const matched = changedPaths.filter((path) => patterns.some(({ glob }) => glob.test(path)));
  if (!matched.length) return run('no changed path matches a filter, so the diff GitHub matched is not the one read here');
  for (const path of matched) {
    const own = patterns.find(({ shared, glob }) => !shared && glob.test(path));
    if (own) return run(`${path} matches ${own.filter}`);
  }

  // From here the whole diff counts: a file outside the filters can still
  // be what makes a matched shared file relevant.
  const owned = ownedPackages(filters, root);
  const starts = [
    ...owned.map((directory) => ({ from: `a script in ${directory}`, seeds: packageSources(root, directory) })),
    ...workflowScripts(flow).map((script) => ({ from: script, seeds: [script] })),
  ];
  for (const { from, seeds } of starts) {
    const closure = new Set(moduleClosure(root, seeds));
    for (const path of changedPaths) {
      if (!closure.has(path)) continue;
      const manifest = WORKSPACE_MANIFEST.test(path) && manifests.get(path);
      if (manifest && onlyAddsExports(manifest)) continue;
      return run(`${from} loads ${path}`);
    }
  }

  if (changedPaths.includes(LOCKFILE) && owned.length) {
    const lock = manifests.get(LOCKFILE);
    if (!lock) return run(`${LOCKFILE}: the base or head lockfile is unavailable`);
    let importers;
    try {
      importers = lockfileImpact(lock);
    } catch (error) {
      if (!(error instanceof LockfileAnalysisError)) throw error;
      return run(`${LOCKFILE}: ${error.message}`);
    }
    if (importers.has('.')) return run(`${LOCKFILE}: ${importers.get('.')}; the root's dependencies resolve for every workspace member`);
    for (const directory of owned) {
      const reach = graph ? reachableFrom(graph, directory) : new Set([directory]);
      const importer = [...importers.keys()].find((candidate) => reach.has(candidate));
      if (importer) return run(`${LOCKFILE}: ${importers.get(importer)} (${importer}, which ${directory} uses)`);
    }
  }

  const apps = workflowApps(filters, registry);
  if (apps.length) {
    const plan = selectAffectedApps(registry, changedPaths, graph, manifests);
    if (plan.reasons.fallback) return run(`the app planner selects every app: ${plan.reasons.fallback}`);
    const app = apps.find((id) => plan.reasons.apps[id]);
    if (app) return run(`the app planner selects ${app}: ${plan.reasons.apps[app][0]}`);
  }

  const subject = apps.length ? `scripts or app ${apps.join(', ')}` : 'scripts';
  return {
    run: false,
    reason: `only shared paths changed (${matched.slice(0, 5).join(', ')}${matched.length > 5 ? `, and ${matched.length - 5} more` : ''}), and none reaches this workflow's ${subject}`,
  };
}
