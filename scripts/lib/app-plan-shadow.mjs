import { parse } from 'yaml';

// An oracle for the app planner, built without its workspace graph or its
// lockfile analysis, so a shadow run can find apps the planner should have
// selected. It knows only what an app demonstrably consumes:
// - its own directory and its model manifest,
// - the workspace packages it declares (workspace:, link: and file:
//   specifiers), transitively, at the merge base or at head,
// - the packages pnpm itself lists for it from the lockfile
//   (`pnpm list --lockfile-only --depth Infinity --parseable`),
// - its registry/apps.yml entry and its offline asset lock entries.
// Root files (scripts/, test-utils/, ci.yml, root package.json) have no
// independent owner; the oracle reports them but never expects an app for them.
// Package tests and Markdown in packages reach an app only when the app reads
// them; the planner follows such reads, the oracle reports them as exempt.

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const LOCAL_SPEC = /^(?:workspace:|link:|file:)/;
const PACKAGE_TESTS = /^packages\/[^/]+\/tests?\//;
const DOCUMENT = /^(?:packages|exes)\/.+\.md$/;

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalize(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

// Workspace directory ('apps/x', 'packages/y') -> the workspace directories it
// uses, directly or transitively, through local dependency specifiers.
// `manifests` maps each workspace directory to its parsed package.json.
export function workspaceClosures(manifests) {
  const byName = new Map([...manifests].filter(([, manifest]) => manifest?.name).map(([dir, manifest]) => [manifest.name, dir]));
  const direct = new Map();
  for (const [dir, manifest] of manifests) {
    const uses = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
        const value = String(spec);
        if (!LOCAL_SPEC.test(value)) continue;
        const target = value.startsWith('workspace:') ? byName.get(name) : normalize(`${dir}/${value.replace(LOCAL_SPEC, '')}`);
        if (target && manifests.has(target) && target !== dir) uses.add(target);
      }
    }
    direct.set(dir, uses);
  }
  const closures = new Map();
  for (const dir of direct.keys()) {
    const seen = new Set();
    const pending = [...direct.get(dir)];
    while (pending.length) {
      const next = pending.pop();
      if (seen.has(next) || next === dir) continue;
      seen.add(next);
      pending.push(...(direct.get(next) ?? []));
    }
    closures.set(dir, seen);
  }
  return closures;
}

// `pnpm list --parseable` output for one importer: the virtual-store entries
// (`.pnpm/<id>/node_modules/<name>`) it resolves. Workspace directories are
// absolute paths and are left out; workspaceClosures covers them.
export function parseableClosure(text) {
  return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('.pnpm/')));
}

// pnpm names a package's virtual-store directory after its lockfile key with
// '/' replaced by '+', so `@scope/name@1.0.0` lives under `.pnpm/@scope+name@1.0.0`
// (with `_peer...` appended when peers resolve it).
function storePrefix(key) {
  return `.pnpm/${key.replace(/\(.*$/, '').replaceAll('/', '+')}`;
}

// Virtual-store prefixes whose lockfile `packages` entry (integrity, engines,
// resolution) changed while the key stayed the same. pnpm list shows only
// keys, so these changes are invisible in its output.
export function republishedPackages(before, after) {
  const [old, now] = [parse(before)?.packages ?? {}, parse(after)?.packages ?? {}];
  return [...Object.keys(now)].filter((key) => Object.hasOwn(old, key) && !same(old[key], now[key])).map(storePrefix);
}

function storeEntryMatches(entry, prefix) {
  return entry === prefix || entry.startsWith(`${prefix}/`) || entry.startsWith(`${prefix}_`);
}

// What changed in one app's lockfile closure: entries added or removed, and
// entries whose package was republished under the same key.
export function closureChange(before, after, republished = []) {
  const added = [...after].filter((entry) => !before.has(entry));
  const removed = [...before].filter((entry) => !after.has(entry));
  const union = new Set([...before, ...after]);
  const changed = [...union].filter((entry) => republished.some((prefix) => storeEntryMatches(entry, prefix)));
  return { added, removed, changed };
}

function registryEntries(text) {
  try {
    const apps = parse(text)?.apps;
    return new Map((Array.isArray(apps) ? apps : []).map((app) => [app?.id, app]));
  } catch {
    return new Map();
  }
}

function offlineLockEntries(text) {
  try {
    const lock = JSON.parse(text);
    return { apps: lock.apps ?? {}, assets: lock.assets ?? {} };
  } catch {
    return { apps: {}, assets: {} };
  }
}

const sample = (list, count = 3) => (list.length > count ? `${list.slice(0, count).join(', ')} and ${list.length - count} more` : list.join(', '));

// The apps a change affects by the oracle's rules, with reasons, and the
// changed paths it could not attribute to any app.
// - apps: [{ id }] at head (plus any removed at head, if the caller passes them)
// - workspace: { before, after } maps from workspaceClosures
// - lockClosures: null when the lockfile did not change, else
//   { before: Map(id -> Set), after: Map(id -> Set), republished: [...] }
// - registry, offlineLock: { before, after } texts when they changed
export function expectedApps({ apps, changedPaths, workspace, lockClosures = null, registry = null, offlineLock = null }) {
  const expected = new Map();
  const exempt = [];
  const add = (id, reason) => expected.set(id, [...(expected.get(id) ?? []), reason]);
  const owned = new Set();
  for (const app of apps) {
    const dir = `apps/${app.id}`;
    const used = new Set([...(workspace.before.get(dir) ?? []), ...(workspace.after.get(dir) ?? [])]);
    for (const path of changedPaths) {
      if (path.startsWith(`${dir}/`) || path === `models/${app.id}.manifest.json`) {
        add(app.id, path);
        owned.add(path);
        continue;
      }
      const user = [...used].find((pkg) => path.startsWith(`${pkg}/`));
      if (!user) continue;
      owned.add(path);
      if (PACKAGE_TESTS.test(path) || DOCUMENT.test(path)) exempt.push({ app: app.id, path });
      else add(app.id, `${path} (declared dependency ${user})`);
    }
    if (lockClosures) {
      const change = closureChange(lockClosures.before.get(app.id) ?? new Set(), lockClosures.after.get(app.id) ?? new Set(), lockClosures.republished);
      const parts = [
        change.added.length && `adds ${sample(change.added)}`,
        change.removed.length && `drops ${sample(change.removed)}`,
        change.changed.length && `republishes ${sample(change.changed)}`,
      ].filter(Boolean);
      if (parts.length) add(app.id, `pnpm-lock.yaml: pnpm lists a changed closure (${parts.join('; ')})`);
    }
  }
  if (registry) {
    owned.add('registry/apps.yml');
    const [old, now] = [registryEntries(registry.before), registryEntries(registry.after)];
    for (const app of apps) {
      if (!same(old.get(app.id), now.get(app.id))) add(app.id, 'registry/apps.yml: its entry changed');
    }
  }
  if (offlineLock) {
    owned.add('registry/offline-assets.lock.json');
    const [old, now] = [offlineLockEntries(offlineLock.before), offlineLockEntries(offlineLock.after)];
    for (const app of apps) {
      const urls = [...new Set([...(old.apps[app.id] ?? []), ...(now.apps[app.id] ?? [])])];
      if (!same(old.apps[app.id], now.apps[app.id]) || urls.some((url) => !same(old.assets[url], now.assets[url]))) {
        add(app.id, 'registry/offline-assets.lock.json: its locked assets changed');
      }
    }
  }
  if (lockClosures) owned.add('pnpm-lock.yaml');
  return { expected, exempt, unattributed: changedPaths.filter((path) => !owned.has(path)) };
}

// Planner selection versus the oracle and the full catalog.
export function compareSelection({ catalog, plan, oracle }) {
  const selected = new Set(plan.selected.map((app) => app.id));
  const misses = [...oracle.expected].filter(([id]) => !selected.has(id)).map(([id, reasons]) => ({ app: id, reasons }));
  const unexplained = [...selected].filter((id) => !oracle.expected.has(id));
  const browserJobs = (apps) => apps.filter((app) => app.ci.browser_test).reduce((total, app) => total + (app.ci.e2e_shards ?? 1), 0);
  const gpuJobs = (apps) => apps.filter((app) => app.ci.hardware_gpu).length;
  return {
    fallback: plan.reasons.fallback,
    selected: [...selected],
    full: catalog.apps.length,
    jobs: {
      planned: { app: plan.selected.length, browser: browserJobs(plan.selected), gpu: gpuJobs(plan.selected) },
      full: { app: catalog.apps.length, browser: browserJobs(catalog.apps), gpu: gpuJobs(catalog.apps) },
    },
    misses,
    // Selected by rules the oracle does not model (text references, root files,
    // the QSMbly rule): wider than strictly needed, or covered only by the planner.
    beyondOracle: unexplained,
  };
}

// Apps that failed on main after a narrowed pull request skipped them.
// `history` is main's CI in order: [{ sha, apps: Map(id -> 'success'|'failure') }],
// apps missing from a run did not run there. `mergesBetween(fromSha, toSha)`
// lists merge commits on main's first-parent line after `fromSha` up to `toSha`.
// `selections` maps a merge commit to its shadow row ({ pr, fallback, selected }).
export function failureCandidates({ history, mergesBetween, selections }) {
  const candidates = [];
  const lastPass = new Map();
  for (const run of history) {
    for (const [app, conclusion] of run.apps) {
      if (conclusion === 'success') {
        lastPass.set(app, run.sha);
        continue;
      }
      if (conclusion !== 'failure' || !lastPass.has(app)) continue;
      const skippedBy = mergesBetween(lastPass.get(app), run.sha)
        .map((sha) => selections.get(sha))
        .filter((row) => row && !row.fallback && !row.selected.includes(app))
        .map((row) => row.pr);
      if (skippedBy.length) candidates.push({ app, failedAt: run.sha, run: run.id, lastPass: lastPass.get(app), skippedBy });
      lastPass.delete(app);
    }
  }
  return candidates;
}

// Merges whose own push run on main was cancelled (a later push in the same
// concurrency group superseded it). The next push run diffs only from its own
// `before`, so the apps such a merge selected are not tested on main until a
// full run finishes. `history` entries carry { id, sha, event, conclusion }.
export function supersededMerges({ history, selections }) {
  const pushRuns = new Map(history.filter((run) => run.event === 'push').map((run) => [run.sha, run]));
  return [...selections.values()]
    .filter((row) => pushRuns.get(row.merge)?.conclusion === 'cancelled')
    .map((row) => ({ pr: row.pr, run: pushRuns.get(row.merge).id, apps: row.fallback ? 'all' : row.selected }));
}
