import { execFileSync } from 'node:child_process';

// Push runs on main supersede each other, so a merge whose own run was
// cancelled is tested by no later run that diffs only from its own `before`.
// The base for a push is instead the newest commit a `ci` run on the branch
// finished green: the diff from there covers every merge not yet tested,
// however many runs in a row were cancelled.
export const TESTED_BASE = 'last-success';

// Pull request runs test a head against an older main, and a fork's pull
// request can come from a branch named main; neither tested the branch itself.
// A dispatch can test part of the plan (its gpu or site scope), so it does not
// count either.
const BRANCH_EVENTS = new Set(['push', 'schedule']);

// Of `runs` (GitHub workflow runs), the head of the green branch run nearest
// to `head`, or why there is none. `git.isAncestor(a, b)` and
// `git.distance(a, b)` (commits in a..b) answer for the checked-out history.
// With `atHead`, a green run of `head` itself answers with `head`: nothing is
// left to test. `events` narrows which runs count as having tested the branch.
// With `conclusions`, a run that finished another way (a failed run, for
// carriedApps) can be the base too.
export function testedBase({ runs, head, branch, git, workflow = 'ci', atHead = false, events = BRANCH_EVENTS, conclusions = ['success'] }) {
  const candidates = new Map();
  for (const run of runs) {
    if (!conclusions.includes(run.conclusion) || run.head_branch !== branch || !events.has(run.event)) continue;
    if (run.head_sha === head) {
      if (atHead) return { base: head, reason: `${workflow} run ${run.id} (${run.event}) already finished green at ${head}` };
      continue;
    }
    if (candidates.has(run.head_sha)) continue;
    if (!git.isAncestor(run.head_sha, head)) continue;
    candidates.set(run.head_sha, run);
  }
  if (!candidates.size) {
    return { base: null, reason: `no successful ${workflow} run on ${branch} has a head that is an ancestor of ${head}` };
  }
  const [base, run] = [...candidates].reduce((best, entry) => (git.distance(entry[0], head) < git.distance(best[0], head) ? entry : best));
  const outcome = run.conclusion === 'success' ? 'successful' : run.conclusion;
  return { base, run, reason: `base ${base} is the head of the last ${outcome} ${workflow} run on ${branch} (${run.event} run ${run.id})` };
}

// A run that failed tested every app it selected; only those whose jobs did
// not pass are untested at its head. `jobs` ({ name, conclusion }) are its
// latest attempt's. Jobs every push runs again, whatever its plan, need no
// carrying; any other failed job (the plan itself) cannot be tied to an app.
const APP_JOB = /^(?:app-tests|browser-e2e|browser-e2e-gpu) \(([^,)]+)[,)]/;
const RERUN_JOBS = new Set(['workspace-contracts', 'composite-site', 'homepage-easter-egg', 'example-cache-retention', 'agent-interactions', 'full-plan', 'full-plan-withheld']);
const UNFINISHED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);
export function carriedApps(jobs) {
  const carried = new Map();
  const unattributed = [];
  for (const job of jobs) {
    if (!UNFINISHED.has(job.conclusion)) continue;
    const app = job.name.match(APP_JOB)?.[1];
    if (app) carried.set(app, [...(carried.get(app) ?? []), job.name]);
    else if (!RERUN_JOBS.has(job.name.replace(/ \(.*$/, ''))) unattributed.push(job.name);
  }
  return { carried, unattributed };
}

// The jobs of a run's latest attempt, from the Actions API.
async function runJobs({ repository, runId, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=50&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`the Actions API answered ${response.status} for the jobs of run ${runId}`);
    const batch = (await response.json()).jobs ?? [];
    jobs.push(...batch.map(({ name, conclusion }) => ({ name, conclusion })));
    if (batch.length < 50) return jobs;
  }
}

// The base `ci` on main diffs from, and the apps it carries: the head of the
// nearest finished push or nightly run, green or failed. After a failed run
// only the apps whose jobs failed are untested at its head, so they are
// selected again instead of every app since the last green run. When a failed
// job cannot be tied to an app, the base is the last green run as before.
export async function resolveCiBase({ head, branch = 'main', cwd, env = process.env, fetchImpl }) {
  const git = gitAncestry(cwd);
  const sha = git.resolve(head);
  if (!sha) return { base: null, carried: new Map(), reason: `${head} is not a commit in this checkout` };
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  let runs;
  let finished;
  try {
    runs = await successfulRuns({ repository, workflow: 'ci.yml', branch, token, apiUrl: env.GITHUB_API_URL, fetchImpl, status: 'completed' });
    finished = testedBase({ runs, head: sha, branch, git, conclusions: ['success', 'failure'] });
    if (finished.run?.conclusion !== 'failure') return { ...finished, carried: new Map() };
    const { carried, unattributed } = carriedApps(await runJobs({ repository, runId: finished.run.id, token, apiUrl: env.GITHUB_API_URL, fetchImpl }));
    if (!unattributed.length) {
      const apps = [...carried.keys()];
      return { ...finished, carried, reason: `${finished.reason}; it failed for ${apps.length ? apps.join(', ') : 'jobs every push runs again'}, which ${apps.length === 1 ? 'is' : 'are'} selected again` };
    }
    const green = testedBase({ runs, head: sha, branch, git });
    return { ...green, carried: new Map(), reason: `${green.reason}; the nearest finished run failed in ${unattributed.slice(0, 3).join(', ')}, which no app owns` };
  } catch (error) {
    return { base: null, carried: new Map(), reason: `the last finished ci run on ${branch} is unknown: ${error.message}` };
  }
}

export function gitAncestry(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return {
    resolve(revision) {
      try {
        return git(['rev-parse', '--verify', `${revision}^{commit}`]);
      } catch {
        return null;
      }
    },
    isAncestor(ancestor, descendant) {
      try {
        git(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },
    distance(ancestor, descendant) {
      return Number(git(['rev-list', '--count', `${ancestor}..${descendant}`]));
    },
  };
}

// The newest successful runs of `workflow` on `branch`, from the Actions API.
// `status: 'completed'` lists failed runs too.
export async function successfulRuns({ repository, workflow, branch, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, status = 'success' }) {
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to find the last successful run');
  const url = `${apiUrl}/repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&status=${status}&per_page=100`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`the Actions API answered ${response.status} for ${workflow} runs on ${branch}`);
  return (await response.json()).workflow_runs ?? [];
}

// The base a push run on `branch` diffs from, or null and why: the caller
// then selects the whole catalog.
export async function resolveTestedBase({ head, branch = 'main', workflow = 'ci.yml', cwd, env = process.env, fetchImpl, atHead = false, events }) {
  const git = gitAncestry(cwd);
  const sha = git.resolve(head);
  if (!sha) return { base: null, reason: `${head} is not a commit in this checkout` };
  let runs;
  try {
    runs = await successfulRuns({ repository: env.GITHUB_REPOSITORY, workflow, branch, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, fetchImpl });
  } catch (error) {
    return { base: null, reason: `the last successful ${workflow.replace(/\.yml$/, '')} run on ${branch} is unknown: ${error.message}` };
  }
  return testedBase({ runs, head: sha, branch, git, workflow: workflow.replace(/\.yml$/, ''), atHead, events });
}
