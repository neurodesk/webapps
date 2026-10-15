#!/usr/bin/env node
// Shadow comparison of the CI app planner (issue #259). Replays the current
// planner over merged pull requests, merge base against the PR head, with the
// workspace graph and registry of that head, and checks its selection against
// an independent oracle (scripts/lib/app-plan-shadow.mjs) and the full catalog.
// With --ci-history it also lists apps that failed on main after a narrowed
// pull request skipped them.
//
//   node scripts/app-plan-shadow.mjs --last 50 --prs 240-247 \
//     --json shadow.json --markdown shadow.md --ci-history
//
// Needs `gh` (authenticated), `pnpm`, and main's history fetched locally.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { changedManifests, changedPathsFromGit, createAppPlan } from './lib/app-plan.mjs';
import { compareSelection, expectedApps, failureCandidates, parseableClosure, republishedPackages, supersededMerges, workspaceClosures } from './lib/app-plan-shadow.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { listJobs, listRuns, mapLimited, mergedPullRequests } from './lib/github-actions.mjs';
import { loadConservativeWorkspaceGraph, WorkspaceGraphConfigurationError } from './lib/workspace-graph.mjs';

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const MAIN = option('--main') || 'origin/main';

function prNumbers(spec) {
  return (spec ?? '').split(',').filter(Boolean).flatMap((part) => {
    const [from, to = from] = part.split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
  });
}

async function extract(sha, dir) {
  await mkdir(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', sha], { cwd: repoRoot });
    const tar = spawn('tar', ['-x', '-C', dir]);
    archive.stdout.pipe(tar.stdin);
    archive.on('error', reject);
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`extracting ${sha} failed`))));
  });
}

// The registry the planner saw at that revision. Older registries can fail
// today's validation (description length, new fields); the planner reads only
// ids, paths and ci facts, so those are normalised the way the loader does.
async function registryAt(root) {
  const path = join(root, 'registry/apps.yml');
  try {
    return await loadAppsRegistry(path);
  } catch {
    const registry = parse(await readFile(path, 'utf8'));
    return {
      site: registry.site,
      apps: registry.apps.map((app) => ({ ...app, ci: { browser_test: false, hardware_gpu: false, ...app.ci }, app_scoped_runtime_families: app.app_scoped_runtime_families ?? [] })),
    };
  }
}

async function workspaceManifests(root) {
  const manifests = new Map();
  for (const top of ['apps', 'packages', 'exes']) {
    const dirs = await readdir(join(root, top), { withFileTypes: true }).catch(() => []);
    for (const dir of dirs.filter((entry) => entry.isDirectory())) {
      const text = await readFile(join(root, top, dir.name, 'package.json'), 'utf8').catch(() => null);
      if (text !== null) manifests.set(`${top}/${dir.name}`, JSON.parse(text));
    }
  }
  return manifests;
}

// What pnpm lists for each app from the lockfile alone.
async function lockClosures(root, appIds) {
  const closures = new Map();
  await mapLimited(appIds, 8, async (id) => {
    const dir = join(root, 'apps', id);
    const exists = await readFile(join(dir, 'package.json'), 'utf8').then(() => true, () => false);
    if (!exists) return;
    const { stdout } = await execFileAsync('pnpm', ['list', '--filter', `./apps/${id}`, '--lockfile-only', '--depth', 'Infinity', '--parseable'], {
      cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COREPACK_ENABLE_STRICT: '0' },
    });
    closures.set(id, parseableClosure(stdout));
  });
  return closures;
}

async function shadow(pr, scratch) {
  const merge = pr.mergeCommit?.oid;
  const row = { pr: pr.number, title: pr.title, mergedAt: pr.mergedAt, merge };
  try {
    git('merge-base', '--is-ancestor', merge, MAIN);
  } catch {
    return { ...row, skipped: `merge commit ${merge?.slice(0, 8)} is not on ${MAIN}` };
  }
  const parents = git('rev-list', '--parents', '-n', '1', merge).split(' ').slice(1);
  const [base, head] = parents.length === 2 ? parents : [parents[0], merge];
  const mergeBase = git('merge-base', base, head);
  const changedPaths = changedPathsFromGit({ base, head, cwd: repoRoot });
  const dir = join(scratch, String(pr.number));
  await extract(head, join(dir, 'head'));
  await extract(mergeBase, join(dir, 'base'));
  try {
    const registry = await registryAt(join(dir, 'head'));
    let graph = null;
    let configuration = null;
    try {
      graph = await loadConservativeWorkspaceGraph(join(dir, 'head'));
    } catch (error) {
      if (!(error instanceof WorkspaceGraphConfigurationError)) throw error;
      configuration = error.message;
    }
    const manifests = changedManifests({ base, head, cwd: repoRoot, changedPaths });
    const planned = createAppPlan(registry, configuration ? [] : changedPaths, graph, manifests);
    const plan = configuration ? { ...planned, reasons: { ...planned.reasons, fallback: configuration } } : planned;

    const [workspaceBefore, workspaceAfter] = await Promise.all([workspaceManifests(join(dir, 'base')), workspaceManifests(join(dir, 'head'))]);
    const ids = registry.apps.map((app) => app.id);
    const lockfile = manifests.get('pnpm-lock.yaml');
    const closures = lockfile && {
      before: await lockClosures(join(dir, 'base'), ids),
      after: await lockClosures(join(dir, 'head'), ids),
      republished: republishedPackages(lockfile.before, lockfile.after),
    };
    const oracle = expectedApps({
      apps: registry.apps,
      changedPaths,
      workspace: { before: workspaceClosures(workspaceBefore), after: workspaceClosures(workspaceAfter) },
      lockClosures: closures ?? null,
      registry: manifests.get('registry/apps.yml') ?? null,
      offlineLock: manifests.get('registry/offline-assets.lock.json') ?? null,
    });
    const comparison = compareSelection({ catalog: registry, plan, oracle });
    return {
      ...row,
      base,
      head,
      changed: changedPaths.length,
      ...comparison,
      site: plan.site,
      expected: Object.fromEntries(oracle.expected),
      reasons: plan.reasons,
      exempt: oracle.exempt,
      unattributed: oracle.unattributed,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const APP_JOB = /^(app-tests|browser-e2e|browser-e2e-gpu) \(([^,)]+)/;

// Main's CI in order, with each app's outcome over its per-app jobs.
async function mainHistory(since) {
  const runs = (await listRuns({ since, branch: 'main' }))
    .filter((run) => ['push', 'schedule', 'workflow_dispatch'].includes(run.event))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return mapLimited(runs, 6, async (run) => {
    const apps = new Map();
    for (const job of await listJobs(run.id)) {
      const app = job.name.match(APP_JOB)?.[2];
      if (!app || !['success', 'failure'].includes(job.conclusion)) continue;
      if (apps.get(app) !== 'failure') apps.set(app, job.conclusion);
    }
    return { id: run.id, sha: run.head_sha, event: run.event, conclusion: run.conclusion, createdAt: run.created_at, apps };
  });
}

function markdown(rows, candidates, superseded) {
  const done = rows.filter((row) => !row.skipped);
  const narrowed = done.filter((row) => !row.fallback);
  const total = (key, kind, list = done) => list.reduce((sum, row) => sum + row.jobs[kind][key], 0);
  const lines = [
    `Replayed ${done.length} merged pull requests (${rows.length - done.length} skipped). Narrowed: ${narrowed.length}; full catalog: ${done.length - narrowed.length}.`,
    '',
    `Per-app jobs selected versus full catalog: app-tests ${total('app', 'planned')}/${total('app', 'full')}, browser-e2e ${total('browser', 'planned')}/${total('browser', 'full')}, macOS GPU ${total('gpu', 'planned')}/${total('gpu', 'full')}.`,
    '',
    `Oracle misses: ${done.reduce((sum, row) => sum + row.misses.length, 0)}.`,
    '',
    '| PR | Selected | Full | Misses | Fallback or reasons |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => (row.skipped
      ? `| #${row.pr} | - | - | - | skipped: ${row.skipped} |`
      : `| #${row.pr} | ${row.fallback ? 'all' : row.selected.length ? row.selected.join(', ') : 'none'} | ${row.full} | ${row.misses.map((miss) => `**${miss.app}**: ${miss.reasons.join('; ')}`).join('<br>') || '0'} | ${(row.fallback ?? (row.site ? `site build: ${row.reasons.site[0] ?? 'selected apps'}` : 'no site build')).replaceAll('|', '\\|').slice(0, 160)} |`)),
  ];
  if (candidates) {
    lines.push('', `Apps that failed on main after a narrowed PR skipped them: ${candidates.length}.`, '');
    for (const candidate of candidates) {
      lines.push(`- ${candidate.app}: failed in run ${candidate.run} (${candidate.failedAt.slice(0, 8)}), last passed at ${candidate.lastPass.slice(0, 8)}; skipped by #${candidate.skippedBy.join(', #')}`);
    }
  }
  if (superseded) {
    lines.push('', `Merges whose own push run on main was cancelled by a later push: ${superseded.length}.`, '');
    for (const entry of superseded) lines.push(`- #${entry.pr} (run ${entry.run}): ${entry.apps === 'all' ? 'full catalog' : entry.apps.join(', ') || 'no apps'}`);
  }
  return `${lines.join('\n')}\n`;
}

// --rows reuses the replay of an earlier --json report, so the CI history can
// be refreshed without replaying every pull request again.
let rows;
if (option('--rows')) {
  rows = JSON.parse(await readFile(option('--rows'), 'utf8')).rows;
} else {
  const numbers = prNumbers(option('--prs'));
  const last = Number(option('--last') ?? (numbers.length ? 0 : 50));
  const pulls = [
    ...(last ? await mergedPullRequests({ limit: last }) : []),
    ...(numbers.length ? await mergedPullRequests({ numbers }) : []),
  ].filter((pr, index, all) => all.findIndex((other) => other.number === pr.number) === index)
    .sort((a, b) => b.number - a.number);

  const scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'app-plan-shadow-'));
  rows = [];
  try {
    for (const pr of pulls) {
      const row = await shadow(pr, scratch);
      rows.push(row);
      const summary = row.skipped ?? (row.fallback ? `full catalog: ${row.fallback}` : `${row.selected.length}/${row.full} apps`);
      console.error(`#${pr.number} ${summary.slice(0, 140)}${row.misses?.length ? ` MISSES ${row.misses.map((miss) => miss.app).join(', ')}` : ''}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  // Kept even if the CI history below fails; --rows picks it up again.
  if (option('--json')) await writeFile(option('--json'), `${JSON.stringify({ rows }, null, 2)}\n`);
}

let history = null;
let candidates = null;
let superseded = null;
if (argv.includes('--ci-history')) {
  const earliest = rows.filter((row) => row.mergedAt).map((row) => row.mergedAt).sort()[0];
  const since = new Date(Date.parse(earliest) - 3 * 86400e3).toISOString().slice(0, 10);
  history = await mainHistory(since);
  const selections = new Map(rows.filter((row) => !row.skipped).map((row) => [row.merge, row]));
  candidates = failureCandidates({
    history,
    selections,
    mergesBetween: (from, to) => {
      try {
        return git('rev-list', '--first-parent', '--merges', `${from}..${to}`).split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  });
  superseded = supersededMerges({ history, selections });
}

const report = {
  generatedAt: new Date().toISOString(),
  main: git('rev-parse', MAIN),
  rows,
  failureCandidates: candidates,
  supersededMerges: superseded,
  mainRuns: history?.map((run) => ({ ...run, apps: Object.fromEntries(run.apps) })) ?? null,
};
if (option('--json')) await writeFile(option('--json'), `${JSON.stringify(report, null, 2)}\n`);
const text = markdown(rows, candidates, superseded);
if (option('--markdown')) await writeFile(option('--markdown'), text);
else process.stdout.write(text);
