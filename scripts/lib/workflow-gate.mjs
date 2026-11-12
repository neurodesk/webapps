import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { selectAffectedApps } from './app-plan.mjs';
import { LockfileAnalysisError, lockfileImpact } from './lockfile-impact.mjs';
import { moduleClosure, onlyAddsExports, packageSources } from './module-closure.mjs';
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
// The import closure is a lower bound: a file read through a computed path is
// not seen. A push to main starts a workflow only for its own paths, so the
// nightly sweep (sweepWorkflow) is what first tests such a file, and what
// builds every target for a shared change the gate did let through.

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

// Root scripts the steps of a workflow, and of the local reusable workflows it
// calls, name (`node scripts/desktop/smoke.mjs`).
const ROOT_SCRIPT = /(?:^|[\s'"=(])((?:scripts|test-utils|test)\/[\w./-]+\.[cm]?[jt]s)\b/gm;
export function workflowScripts(flow, calledFlows = []) {
  const commands = [flow, ...calledFlows].flatMap((each) => Object.values(each?.jobs ?? {})).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ''));
  return [...new Set(commands.flatMap((command) => [...command.matchAll(ROOT_SCRIPT)].map((match) => match[1])))];
}

// The local reusable workflows a workflow calls, by file name. The gate itself runs nothing of the caller's.
export function calledWorkflows(flow) {
  return [...new Set(Object.values(flow?.jobs ?? {})
    .map((job) => job.uses?.match(/^\.\/\.github\/workflows\/([\w-]+)\.yml$/)?.[1])
    .filter((name) => name && name !== 'pr-gate'))];
}

// Root code the import closure cannot follow: Python, shell and PowerShell.
const UNFOLLOWED_SCRIPT = /^(?:scripts|test-utils|test)\/.*\.(?:py|sh|ps1)$/;
// The shared packager reads every package's release specification.
const PACKAGER = 'node-cli-portable';
const RELEASE_SPEC = /^packages\/[^/]+\/release\.json$/;

export function decideWorkflow({ flow, calledFlows = [], changedPaths, registry, graph, manifests = new Map(), root }) {
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

  const unfollowed = matched.find((path) => UNFOLLOWED_SCRIPT.test(path));
  if (unfollowed) return run(`${unfollowed} is a script the gate cannot follow`);
  if (calledWorkflows(flow).includes(PACKAGER)) {
    const spec = matched.find((path) => RELEASE_SPEC.test(path));
    if (spec) return run(`${spec}: the shared packager reads every release specification`);
  }

  // From here the whole diff counts: a file outside the filters can still
  // be what makes a matched shared file relevant.
  const owned = ownedPackages(filters, root);
  const starts = [
    ...owned.map((directory) => ({ from: `a script in ${directory}`, seeds: packageSources(root, directory) })),
    ...workflowScripts(flow, calledFlows).map((script) => ({ from: script, seeds: [script] })),
  ];
  for (const { from, seeds } of starts) {
    // A deleted file is still what the module naming it loads.
    const closure = new Set(moduleClosure(root, seeds, { missing: true }));
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

// The nightly sweep: a workflow runs when a path under one of its shared
// filters changed on main since the last sweep. Reach is deliberately not
// asked here, because the sweep covers what the reach analysis cannot see.
export function sweepWorkflow({ flow, changedPaths }) {
  const filters = flow?.on?.pull_request?.paths;
  if (!Array.isArray(filters)) return { run: true, reason: 'the workflow has no pull request path filter' };
  const shared = filters.filter(isSharedFilter).map((filter) => ({ filter, glob: pathGlob(filter) }));
  for (const path of changedPaths) {
    const hit = shared.find(({ glob }) => glob.test(path));
    if (hit) return { run: true, reason: `${path} changed on main and matches ${hit.filter}, which no push starts this workflow for` };
  }
  return { run: false, reason: 'no path under a shared filter changed on main since the last sweep' };
}
