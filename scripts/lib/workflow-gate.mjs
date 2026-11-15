import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAppPlan, selectAffectedApps, standaloneImpact } from './app-plan.mjs';
import { LockfileAnalysisError, lockfileImpact } from './lockfile-impact.mjs';
import { moduleClosure, onlyAddsExports, packageSources } from './module-closure.mjs';
import { releaseBookkeeping } from './release-bookkeeping.mjs';
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

export function decideWorkflow({ flow, calledFlows = [], changedPaths: allPaths, registry, graph, manifests = new Map(), root }) {
  const run = (reason) => ({ run: true, reason });
  const filters = flow?.on?.pull_request?.paths;
  if (!Array.isArray(filters)) return run('the workflow has no pull request path filter');
  if (filters.some((filter) => filter.startsWith('!'))) return run('the workflow excludes paths, which the gate does not analyse');
  if (!allPaths.length) return run('the changed paths are unknown');

  const patterns = filters.map((filter) => ({ filter, shared: isSharedFilter(filter), glob: pathGlob(filter) }));
  if (!allPaths.some((path) => patterns.some(({ glob }) => glob.test(path)))) {
    return run('no changed path matches a filter, so the diff GitHub matched is not the one read here');
  }
  // A release's changelogs and version bumps change nothing a workflow tests.
  const changedPaths = allPaths.filter((path) => !releaseBookkeeping(path, manifests));
  const matched = changedPaths.filter((path) => patterns.some(({ glob }) => glob.test(path)));
  if (!matched.length) return { run: false, reason: 'only release bookkeeping (changelogs and version bumps) matches its filters' };
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

const STANDALONE = 'registry/standalone.json';

// What a release leaves on main without changing what a workflow builds:
// changelogs and version bumps (release-bookkeeping.mjs), and the download
// catalog's entries for other apps. Returns why the path is inert, or null.
function bookkeepingFor(path, { manifests, registry, apps }) {
  const reason = releaseBookkeeping(path, manifests);
  if (reason) return reason;
  const manifest = manifests.get(path);
  if (path === STANDALONE && manifest && registry && apps.length) {
    const impact = standaloneImpact(manifest, registry);
    if (!impact.shared && !impact.changed.some((id) => apps.includes(id))) return `no entry of ${apps.join(', ')} changed`;
  }
  return null;
}

// The nightly sweep: a workflow runs when a path under one of its shared
// filters changed on main since the last sweep. Reach is deliberately not
// asked here, because the sweep covers what the reach analysis cannot see.
// Release bookkeeping is the exception: every release writes it into the
// shared packages, and it would otherwise run every workflow the night after.
export function sweepWorkflow({ flow, changedPaths, manifests = new Map(), registry }) {
  const filters = flow?.on?.pull_request?.paths;
  if (!Array.isArray(filters)) return { run: true, reason: 'the workflow has no pull request path filter' };
  const shared = filters.filter(isSharedFilter).map((filter) => ({ filter, glob: pathGlob(filter) }));
  const apps = registry ? workflowApps(filters, registry) : [];
  let inert = 0;
  for (const path of changedPaths) {
    const hit = shared.find(({ glob }) => glob.test(path));
    if (!hit) continue;
    if (bookkeepingFor(path, { manifests, registry, apps })) {
      inert += 1;
      continue;
    }
    return { run: true, reason: `${path} changed on main and matches ${hit.filter}, which no push starts this workflow for` };
  }
  const bookkeeping = inert ? ` (${inert} release bookkeeping ${inert === 1 ? 'file' : 'files'} aside)` : '';
  return { run: false, reason: `no path under a shared filter changed on main since the last sweep${bookkeeping}` };
}

// The workflow's own paths on main: whether a path under its `push` filter
// changed beyond release bookkeeping. `known: false` when that cannot tell:
// no push filter, or no changed path under it.
export function pushWorkflow({ flow, changedPaths, manifests = new Map(), registry }) {
  const filters = flow?.on?.push?.paths;
  if (!Array.isArray(filters)) return { run: true, known: false, reason: 'the workflow has no push path filter' };
  if (filters.some((filter) => filter.startsWith('!'))) return { run: true, known: true, reason: 'the workflow excludes paths, which the gate does not analyse' };
  const globs = filters.map((filter) => ({ filter, glob: pathGlob(filter) }));
  const apps = registry ? workflowApps(filters, registry) : [];
  const matched = changedPaths.filter((path) => globs.some(({ glob }) => glob.test(path)));
  if (!matched.length) return { run: true, known: false, reason: 'no changed path matches a push filter' };
  for (const path of matched) {
    if (bookkeepingFor(path, { manifests, registry, apps })) continue;
    const { filter } = globs.find(({ glob }) => glob.test(path));
    return { run: true, known: true, reason: `${path} matches ${filter}` };
  }
  return { run: false, known: true, reason: `only release bookkeeping changed under its push filters (${matched.slice(0, 5).join(', ')}${matched.length > 5 ? `, and ${matched.length - 5} more` : ''})` };
}

// A push to main or the nightly sweep. Both read `changedPaths`, what main
// gained since the workflow last finished green there by a push or a sweep.
// Either can skip and still finish green, which moves that base for the
// other, so each asks both questions: did one of its own paths change beyond
// release bookkeeping (what a push starts it for, and what a failed or
// cancelled push left untested), or did a path under a shared pull request
// filter change (what the sweep is for)? A push whose range matches none of
// its push filters is not one the reading explains, so it runs.
// A workflow gated only so that release bookkeeping does not start it has no
// shared pull request filter: its schedule is a plain nightly run, not a sweep.
export function mainWorkflow({ flow, changedPaths, manifests = new Map(), registry, event }) {
  const pulls = flow?.on?.pull_request?.paths;
  if (event === 'schedule' && Array.isArray(pulls) && !pulls.some(isSharedFilter)) {
    return { run: true, reason: 'its schedule is a nightly run of everything, not a sweep: it has no shared pull request filter' };
  }
  const own = pushWorkflow({ flow, changedPaths, manifests, registry });
  if (own.run && (own.known || event === 'push')) return { run: true, reason: own.reason };
  const shared = sweepWorkflow({ flow, changedPaths, manifests, registry });
  if (shared.run) return shared;
  return { run: false, reason: own.known ? `${own.reason}; ${shared.reason}` : shared.reason };
}

// A ready pull request over its full-plan budget gets what a draft gets, but
// only where its `ci` run withholds the full plan too, which is where the
// draft plan tests fewer apps. The answer is `withheld`: the gate then fails,
// as ci's `full-plan-withheld` does, so a skipped suite never reads as green
// and re-running the workflow after adding `full-ci` runs it. `budget()`
// answers like fullPlanBudget (full-plan-budget.mjs); a check that fails runs
// the workflow.
export async function budgetedDecision(decision, { registry, graph, changedPaths, manifests = new Map(), budget, log = console.error }) {
  if (!decision.run) return decision;
  const full = createAppPlan(registry, changedPaths, graph, manifests);
  const draft = createAppPlan(registry, changedPaths, graph, manifests, { draft: true });
  if (draft.selected.length >= full.selected.length) return decision;
  try {
    const verdict = await budget();
    if (!verdict.withheld) return decision;
    return { run: false, withheld: true, reason: `${verdict.reason}, and its ci run withholds the full plan too; add the full-ci label, then re-run all jobs of ci and of this workflow` };
  } catch (error) {
    log(`running because the budget check failed: ${error.message}`);
    return decision;
  }
}
