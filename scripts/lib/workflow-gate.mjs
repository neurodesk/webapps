import { execFileSync } from 'node:child_process';
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
//
// A workflow lists its shared filters in its gate job (`shared_paths`), not in
// `on.pull_request.paths`, so that a pull request touching only shared trees
// starts one workflow run, native.yml, instead of one per workflow. native.yml
// decides for every such workflow at once and calls the ones that run
// (dispatchDecision); its nightly run is their sweep. A pull request that also
// changes one of a workflow's own paths starts the workflow itself, and the
// workflow's gate decides with both kinds of filter, as before.

const ROOT_MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const SHARED_TREE = /^(?:packages|exes|scripts|test|test-utils|registry|models)\/\*\*$/;
// Packages every app is built from. A glob into one is shared; a single file
// in one is a generated command-line import and stays the workflow's own.
// Consumer workflows' generated node-drivers files are also shared so a change
// to a driver routes through native.yml instead of firing 15+ separate runs
// (node-drivers.yml itself owns `packages/node-drivers/**`).
export const SHARED_PACKAGES = ['packages/components', 'packages/runtime-support'];
const SHARED_NODE_DRIVER = /^packages\/node-drivers\/(?:package\.json|src\/[^/*]+\.js)$/;
const LOCKFILE = 'pnpm-lock.yaml';
const WORKSPACE_MANIFEST = /^(?:packages|exes)\/[^/]+\/package\.json$/;

export function isSharedFilter(filter) {
  if (ROOT_MANIFESTS.includes(filter) || SHARED_TREE.test(filter) || SHARED_NODE_DRIVER.test(filter)) return true;
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

// The workflow native.yml (and native-2.yml, ... when sharded) is, and the gate
// job in it that decides for the workflows it calls.
export const DISPATCHER = 'native';
export const dispatcherName = (index) => (index === 0 ? DISPATCHER : `${DISPATCHER}-${index + 1}`);
export const isDispatcher = (name) => name === DISPATCHER || /^native-[2-9]\d*$/.test(name);
const DISPATCHER_GATE = 'gate / decide';

// The shared filters a workflow's gate job lists, one per line.
export function sharedPaths(flow) {
  const text = flow?.jobs?.gate?.with?.shared_paths;
  return typeof text === 'string' ? text.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

// Every pull request filter of a workflow: the paths that start it (its own)
// and the shared paths for which native.yml calls it. Undefined without a
// pull request path filter.
export function pullRequestFilters(flow) {
  const own = flow?.on?.pull_request?.paths;
  return Array.isArray(own) ? [...own, ...sharedPaths(flow)] : undefined;
}

// native.yml decides pull requests for every workflow that lists shared paths,
// and sweeps nightly those of them that a push to main also starts: a workflow
// never tested on main has nothing to keep in step there.
export function dispatched(flow) {
  return sharedPaths(flow).length > 0;
}
export function swept(flow) {
  return dispatched(flow) && Boolean(flow.on?.push);
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
  const filters = pullRequestFilters(flow);
  if (!filters) return run('the workflow has no pull request path filter');
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

// The paths a comparison changed, read NUL-delimited so that no name is
// trimmed, quoted or split: { ok: true, paths, renamed } with both sides of
// every rename or copy in `paths` and in `renamed`, or { ok: false, reason }
// when git cannot compare the two commits. An unreadable diff is never an
// empty one.
export function readChangedPaths({ base, head = 'HEAD', cwd }) {
  if (!base || /^0+$/.test(base)) return { ok: false, reason: 'no base commit to compare with' };
  let output;
  try {
    output = execFileSync('git', ['diff', '-z', '--name-status', '--find-renames', '--find-copies', `${base}...${head}`], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, reason: `git diff ${base}...${head} failed: ${String(error.stderr || error.message).trim().split('\n')[0]}` };
  }
  const fields = output.split('\0');
  const paths = new Set();
  const renamed = new Set();
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const names = /^[RC]/.test(status) ? [fields[index++], fields[index++]] : [fields[index++]];
    if (names.some((name) => name === undefined)) return { ok: false, reason: `git diff ${base}...${head} printed an incomplete entry` };
    for (const name of names) {
      paths.add(name);
      if (names.length > 1) renamed.add(name);
    }
  }
  return { ok: true, paths: [...paths], renamed };
}

// GitHub matches a pull request's path filters against at most this many changed files.
const GITHUB_DIFF_LIMIT = 3000;
// A changed path GitHub's filter matching and pathGlob certainly read alike: ASCII
// letters, digits and . _ @ + - in segments, no spaces, quotes or glob characters.
const PLAIN_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const PLAIN = '[A-Za-z0-9._@+-]';

// A test that certainly agrees with GitHub's documented path filter for this
// own filter, or null where the filter has a form this does not model: a
// literal path, a literal directory followed by `**`, or one `*` in the last
// segment. A wildcard never stands for a segment that starts with a dot.
function certainMatcher(filter) {
  if (new RegExp(`^${PLAIN}+(?:/${PLAIN}+)*$`).test(filter)) return (path) => path === filter;
  const tree = filter.match(new RegExp(`^((?:${PLAIN}+/)+)\\*\\*$`));
  if (tree) return (path) => path.startsWith(tree[1]) && !/(?:^|\/)\./.test(path.slice(tree[1].length));
  const leaf = filter.match(new RegExp(`^((?:${PLAIN}+/)*)(${PLAIN}*)\\*(${PLAIN}*)$`));
  if (leaf) {
    const [, directory, start, end] = leaf;
    return (path) => {
      if (!path.startsWith(directory)) return false;
      const name = path.slice(directory.length);
      return !name.includes('/') && !name.startsWith('.') && name.length >= start.length + end.length && name.startsWith(start) && name.endsWith(end);
    };
  }
  return null;
}

// The changed path and own filter that make it certain GitHub started a
// workflow for a pull request itself, or null when that is not certain: the
// comparison is not below GitHub's file limit, or every own match is a side
// of a rename or copy, an unusual path or a filter form certainMatcher does
// not model. `diff` is readChangedPaths's answer.
export function certainOwnStart(flow, { paths, renamed = new Set() }) {
  if (!(paths.length < GITHUB_DIFF_LIMIT)) return null;
  const filters = flow.on?.pull_request?.paths ?? [];
  // An exclusion can undo a match that comes before it.
  if (filters.some((filter) => filter.startsWith('!'))) return null;
  const matchers = filters.map((filter) => ({ filter, matches: certainMatcher(filter) })).filter(({ matches }) => matches);
  for (const path of paths) {
    if (renamed.has(path) || !PLAIN_PATH.test(path)) continue;
    const own = matchers.find(({ matches }) => matches(path));
    if (own) return { path, filter: own.filter };
  }
  return null;
}

// The skip verdict native.yml gives a workflow GitHub certainly started itself.
export const startsItself = ({ path, filter }) => `starts itself: ${path} matches its own filter ${filter}, and its own pull request run decides`;

// Whether native.yml calls a workflow for a pull request. When GitHub
// certainly started the workflow itself, its gate decides with every filter
// and native.yml skips it with that verdict. When that is not certain, native.yml decides
// too: a workflow may then run twice, never not at all. A workflow none of
// whose shared paths changed is one GitHub would not have started for them,
// and any other gets the decision its gate would give.
export function dispatchDecision({ flow, changedPaths, renamed = new Set(), ...rest }) {
  const own = certainOwnStart(flow, { paths: changedPaths, renamed });
  if (own) return { run: false, reason: startsItself(own) };
  if (!reachesSharedPaths(flow, changedPaths)) return { run: false, reason: 'none of its shared paths changed' };
  return decideWorkflow({ flow, changedPaths, ...rest });
}

// Whether a changed path may match one of a workflow's shared filters as
// GitHub matches them: `*` any character but `/`, `**` any character, a
// newline included. A path this does not model (outside PLAIN_PATH: spaces,
// control characters, non-ASCII) counts as matching every shared filter, so
// it can only send the workflow on to its decision.
export function reachesSharedPaths(flow, changedPaths) {
  const shared = sharedPaths(flow).map((filter) => new RegExp(pathGlob(filter).source, 's'));
  return changedPaths.some((path) => !PLAIN_PATH.test(path) || shared.some((glob) => glob.test(path)));
}

// native.yml's scheduled runs on main, read as runs of one workflow it
// calls, for the base its sweep and pushes diff from (testedBase). A run
// that finished green tested every workflow it called. In any other, a
// workflow's part is green when the gate decided and every job of the
// workflow passed or was skipped: a skipped call is a sweep that found
// nothing to test, as a skipped gate is in the workflow's own run. A run
// whose native.yml did not call the workflow (`calls`), or whose jobs are
// unknown, tested nothing of it.
export function dispatchedRuns(workflow, runs, { calls, jobs }) {
  const ours = (job) => job.name === workflow || job.name.startsWith(`${workflow} / `);
  return runs.filter((run) => calls(run)).map((run) => {
    let green = run.conclusion === 'success';
    const listed = green ? null : jobs(run);
    if (listed) {
      const part = listed.filter(ours);
      green = listed.some((job) => job.name === DISPATCHER_GATE && job.conclusion === 'success')
        && part.length > 0 && part.every((job) => job.conclusion === 'success' || job.conclusion === 'skipped');
    }
    return { ...run, event: 'schedule', conclusion: green ? 'success' : 'failure' };
  });
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
  const filters = pullRequestFilters(flow);
  if (!filters) return { run: true, reason: 'the workflow has no pull request path filter' };
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
  const pulls = pullRequestFilters(flow);
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
