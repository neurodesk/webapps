import { execFileSync } from 'node:child_process';
import { standaloneImpact } from './app-plan.mjs';
import { gitAncestry, successfulRuns } from './tested-base.mjs';

// Whether the scheduled `standalone` run has to build the desktop suites.
//
// Every remote asset the build reads is pinned, so a tree that did not change
// since the last suites were published can only fail from runner drift or a
// flake, and would publish the same apps under a new date. The schedule
// therefore builds when a desktop input changed on main since the head of the
// last run that published, and at least once a week whatever changed. A
// dispatch always builds. Anything the gate cannot decide builds.
//
// Every path is an input except two that nothing in the desktop build reads:
//   - another workflow's file: no build, test or packaging step of the suites
//     reads `.github/workflows/` (test/standalone-gate.test.mjs holds the
//     scripts this workflow runs to that); the files of this workflow and of
//     the workflows it calls stay inputs,
//   - a `registry/standalone.json` change to the published suites alone: this
//     workflow's own publish writes it after every build, so counting it
//     would build every night. A changed app entry or any other field is an
//     input.

export const WORKFLOW = 'standalone';
// A week of nights. The schedule fires daily at 03:23 UTC, and a run can
// start late, so the seventh night after a published build always builds.
export const FORCED_BUILD_AFTER_MS = 6.5 * 24 * 60 * 60 * 1000;
const STANDALONE = 'registry/standalone.json';
const WORKFLOW_FILE = /^\.github\/workflows\/([^/]+)\.ya?ml$/;
const PUBLISH_JOB = /^publish(?: \(|$)/;

// The local reusable workflows a workflow calls, by file name.
export function calledWorkflows(flow) {
  return Object.values(flow?.jobs ?? {})
    .map((job) => job.uses?.match(/^\.\/\.github\/workflows\/([\w-]+)\.ya?ml$/)?.[1])
    .filter(Boolean);
}

// Why `path` is not a desktop input, or null when it is one. `manifests` maps
// changed paths to their { before, after } text (changedManifests).
export function nonInput(path, { flow, manifests = new Map(), registry }) {
  const workflow = path.match(WORKFLOW_FILE)?.[1];
  if (workflow && workflow !== WORKFLOW && !calledWorkflows(flow).includes(workflow)) return 'another workflow';
  if (path === STANDALONE) {
    const manifest = manifests.get(path);
    if (!manifest?.before || !manifest?.after || !registry) return null;
    const impact = standaloneImpact(manifest, registry);
    if (!impact.shared && !impact.changed.length) return 'only the published suites changed';
  }
  return null;
}

// Whether a finished run published the suites: its build and every publish
// job passed. A night the gate skipped, a dispatch without `publish` and a
// source approval run finish green without publishing.
export function published(jobs) {
  const publish = jobs.filter((job) => PUBLISH_JOB.test(job.name));
  return publish.length > 0
    && publish.every((job) => job.conclusion === 'success')
    && jobs.some((job) => job.name === 'bundle' && job.conclusion === 'success');
}

// Of `runs` (successful runs of this workflow, newest first), the published
// run on `branch` nearest to `head`, or why there is none. `jobsOf(run)`
// resolves to the jobs of the run's listed attempt.
export async function publishedBase({ runs, head, branch = 'main', git, jobsOf }) {
  const candidates = runs
    .filter((run) => run.conclusion === 'success' && run.head_branch === branch && ['schedule', 'workflow_dispatch'].includes(run.event))
    .filter((run) => run.head_sha === head || git.isAncestor(run.head_sha, head))
    .map((run) => ({ run, distance: run.head_sha === head ? 0 : git.distance(run.head_sha, head) }))
    .sort((a, b) => a.distance - b.distance);
  for (const { run } of candidates) {
    if (published(await jobsOf(run))) {
      return { base: run.head_sha, run, reason: `base ${run.head_sha} is the head of the last run that published the suites (${run.event} run ${run.id})` };
    }
  }
  return { base: null, reason: `no successful ${WORKFLOW} run on ${branch} that published the suites has a head that is an ancestor of ${head}` };
}

// The decision for one event. `base` is publishedBase's answer; `changedPaths`
// the paths that differ between its head and `head` (null when unknown).
export function decideStandalone({ event, base, head, changedPaths, flow, manifests = new Map(), registry, now = Date.now() }) {
  if (event !== 'schedule') return { run: true, reason: `a ${event} run always builds` };
  if (!base?.base) return { run: true, reason: base?.reason ?? 'the last published run is unknown' };
  const started = Date.parse(base.run.run_started_at ?? base.run.created_at);
  if (!Number.isFinite(started)) return { run: true, reason: `run ${base.run.id} has no start time` };
  if (now - started >= FORCED_BUILD_AFTER_MS) {
    return { run: true, reason: `the weekly build: the suites were last published by run ${base.run.id}, started ${new Date(started).toISOString()}` };
  }
  if (!Array.isArray(changedPaths)) return { run: true, reason: `the paths changed since ${base.base} are unknown` };
  if (!changedPaths.length && base.base !== head) return { run: true, reason: `git lists no changed path between ${base.base} and ${head}` };
  const inputs = changedPaths.filter((path) => !nonInput(path, { flow, manifests, registry }));
  if (inputs.length) {
    const more = inputs.length > 1 ? `, and ${inputs.length - 1} more` : '';
    return { run: true, reason: `${inputs[0]} changed since ${base.base}${more}` };
  }
  const aside = changedPaths.length ? ` (${changedPaths.length} non-input ${changedPaths.length === 1 ? 'path' : 'paths'} aside)` : '';
  return { run: false, reason: `no desktop input changed since ${base.base}${aside}; ${base.reason}` };
}

// The paths that differ between two commits. Unlike changedPathsFromGit, an
// unreadable diff throws instead of answering with no paths.
export function changedPaths({ base, head, cwd }) {
  return execFileSync('git', ['diff', '--name-only', base, head], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((path) => path.trim()).filter(Boolean);
}

// The jobs of one attempt of a run, from the Actions API.
async function runJobs({ repository, run, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`the Actions API answered ${response.status} for the jobs of run ${run.id}`);
    const batch = (await response.json()).jobs ?? [];
    jobs.push(...batch.map(({ name, conclusion }) => ({ name, conclusion })));
    if (batch.length < 100) return jobs;
  }
}

// The base for a scheduled run on `branch`, from the Actions API, with `head`
// resolved to a commit. An API error answers with no base, so the run builds.
export async function resolvePublishedBase({ head, branch = 'main', cwd, env = process.env, fetchImpl }) {
  const git = gitAncestry(cwd);
  const sha = git.resolve(head);
  if (!sha) return { base: null, reason: `${head} is not a commit in this checkout` };
  const api = { repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, fetchImpl };
  try {
    const runs = await successfulRuns({ ...api, workflow: `${WORKFLOW}.yml`, branch });
    return { ...await publishedBase({ runs, head: sha, branch, git, jobsOf: (run) => runJobs({ ...api, run }) }), head: sha };
  } catch (error) {
    return { base: null, head: sha, reason: `the last published ${WORKFLOW} run on ${branch} is unknown: ${error.message}` };
  }
}
