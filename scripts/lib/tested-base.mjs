import { execFileSync } from 'node:child_process';

// Push runs on main supersede each other, so a merge whose own run was
// cancelled is tested by no later run that diffs only from its own `before`.
// The base for a push is instead the newest commit a `ci` run on the branch
// finished on (resolveCiBase; the workflow gate's sweep asks for green runs):
// the diff from there covers every merge not yet tested, however many runs in
// a row were cancelled.
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
    const outcome = conclusions.length === 1 && conclusions[0] === 'success' ? 'successful' : 'finished';
    return { base: null, reason: `no ${outcome} ${workflow} run on ${branch} has a head that is an ancestor of ${head}` };
  }
  const [base, run] = [...candidates].reduce((best, entry) => (git.distance(entry[0], head) < git.distance(best[0], head) ? entry : best));
  const outcome = run.conclusion === 'success' ? 'successful' : 'failed';
  return { base, run, reason: `base ${base} is the head of the last ${outcome} ${workflow} run on ${branch} (${run.event} run ${run.id})` };
}

// A run that failed tested every app it selected; only those whose jobs did
// not pass are untested at its head. `jobs` ({ name, conclusion }) are the
// listed attempt's, and `appIds` the registry's. The per-app jobs are named by
// their matrix, whose first value is the app id (matrixEntry). Jobs every push
// runs again whatever its plan, and jobs only the nightly runs (which tests
// every app), need no carrying; the jobs the plan narrows (PLANNED_JOBS) are
// carried by carriedPlannedJobs. Any other failed job (the plan itself), an
// unfinished per-app job, or an app id the registry does not know cannot be
// tied to an app. test/app-plan.test.mjs holds ci.yml to these job lists.
export const APP_JOBS = ['app-tests', 'browser-e2e', 'browser-e2e-gpu'];
export const RERUN_JOBS = ['workspace-contracts', 'composite-site', 'example-cache-retention', 'full-plan', 'full-plan-withheld'];
// Jobs that run only where the plan's change reaches.
export const PLANNED_JOBS = ['homepage-easter-egg'];
export const NIGHTLY_JOBS = ['agent-interactions'];
const PLAN_JOB = 'app-plan';
const APP_JOB = new RegExp(`^(?:${APP_JOBS.join('|')}) \\(([^,)]+)[,)]`);
const UNPASSED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);
const PASSED = new Set(['success', 'skipped', 'neutral']);
export function carriedApps(jobs, appIds) {
  const carried = new Map();
  const unattributed = [];
  for (const job of jobs) {
    if (PASSED.has(job.conclusion)) continue;
    const app = job.name.match(APP_JOB)?.[1];
    const base = job.name.replace(/ \(.*$/, '');
    if (PLANNED_JOBS.includes(base)) continue;
    if (!UNPASSED.has(job.conclusion)) unattributed.push(`${job.name} (not finished)`);
    else if (app && (!appIds || appIds.has(app))) carried.set(app, [...(carried.get(app) ?? []), job.name]);
    else if (app || ![...RERUN_JOBS, ...NIGHTLY_JOBS].includes(base)) unattributed.push(job.name);
  }
  return { carried, unattributed };
}

// How a planned job ended in one run: passed (`success`), not due (`skipped`
// in a run whose plan succeeded and left it out), or why it did not pass:
// failed, cancelled, timed out, unfinished, skipped behind a plan that did not
// succeed, or missing from the run's jobs.
export const NOT_DUE = 'not due';
export function plannedJobState(jobs, name) {
  const job = jobs.find((each) => each.name === name);
  if (!job) return `${name} is missing from its jobs`;
  if (job.conclusion === 'success') return 'passed';
  if (job.conclusion === 'skipped') return jobs.find((each) => each.name === PLAN_JOB)?.conclusion === 'success' ? NOT_DUE : `${name} was skipped because ${PLAN_JOB} did not succeed`;
  return `${name} ${job.conclusion ? `concluded ${job.conclusion}` : `is ${job.status ?? 'unfinished'}`}`;
}

// The planned jobs a push on `branch` runs again in full, and why: for each,
// the most recent ci run whose head lies from `base` up to (not at) `head`,
// cancelled and unfinished runs included, in which it was due; carried when
// it did not pass there, or when that run's jobs cannot be read. A run at the
// head itself is this push's own or a re-run of it.
export async function carriedPlannedJobs({ runs, base, head, branch, git, readJobs }) {
  const carried = new Map();
  if (!base) return carried;
  const recent = runs
    .filter((run) => run.head_branch === branch && run.event !== 'pull_request' && run.head_sha !== head && git.isAncestor(base, run.head_sha) && git.isAncestor(run.head_sha, head))
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.id - a.id);
  for (const name of PLANNED_JOBS) {
    for (const run of recent) {
      let jobs;
      try {
        jobs = await readJobs(run);
      } catch (error) {
        carried.set(name, [`the jobs of ci run ${run.id} could not be read (${error.message})`]);
        break;
      }
      const state = plannedJobState(jobs, name);
      if (state === NOT_DUE) continue;
      if (state !== 'passed') carried.set(name, [`${state} in ci run ${run.id}`]);
      break;
    }
  }
  return carried;
}

// The jobs of one attempt of a run, from the Actions API: the attempt the run
// listing reported, so a re-run started since cannot answer with its own
// unfinished jobs.
async function runJobs({ repository, runId, attempt, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=50&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`the Actions API answered ${response.status} for the jobs of run ${runId}`);
    const batch = (await response.json()).jobs ?? [];
    jobs.push(...batch.map(({ name, conclusion }) => ({ name, conclusion })));
    if (batch.length < 50) return jobs;
  }
}

// The base `ci` on main diffs from, and the apps and planned jobs it carries:
// the head of the nearest finished push or nightly run, green or failed.
// After a failed run only the apps whose jobs failed are untested at its head,
// so they are selected again instead of every app since the last green run.
// When a failed job cannot be tied to an app, the base is the last green run
// as before. Planned jobs are carried from every run between that base and the
// head (carriedPlannedJobs), whichever base it is.
export async function resolveCiBase({ head, branch = 'main', cwd, env = process.env, fetchImpl, appIds }) {
  const git = gitAncestry(cwd);
  const sha = git.resolve(head);
  const none = { carried: new Map(), checks: new Map() };
  if (!sha) return { base: null, ...none, reason: `${head} is not a commit in this checkout` };
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const jobLists = new Map();
  const readJobs = (run) => {
    if (!jobLists.has(run.id)) jobLists.set(run.id, runJobs({ repository, runId: run.id, attempt: run.run_attempt ?? 1, token, apiUrl: env.GITHUB_API_URL, fetchImpl }));
    return jobLists.get(run.id);
  };
  try {
    // Every run, unfinished ones too: a planned job a running nightly has not passed yet is carried.
    const runs = await successfulRuns({ repository, workflow: 'ci.yml', branch, token, apiUrl: env.GITHUB_API_URL, fetchImpl, status: null });
    const finished = testedBase({ runs, head: sha, branch, git, conclusions: ['success', 'failure'] });
    let result;
    if (finished.run?.conclusion !== 'failure') result = { ...finished, carried: new Map() };
    else {
      const { carried, unattributed } = carriedApps(await readJobs(finished.run), appIds);
      if (!unattributed.length) {
        const apps = [...carried.keys()];
        const why = apps.length
          ? `it failed for ${apps.join(', ')}, which ${apps.length === 1 ? 'is' : 'are'} selected again (without @slow tests on a push)`
          : 'it failed only in jobs every push runs again, planned jobs or jobs only the nightly runs';
        result = { ...finished, carried, reason: `${finished.reason}; ${why}` };
      } else {
        const green = testedBase({ runs, head: sha, branch, git });
        result = { ...green, carried: new Map(), reason: `${green.reason}; the nearest finished run failed in ${unattributed.slice(0, 3).join(', ')}, which no app owns` };
      }
    }
    const checks = await carriedPlannedJobs({ runs, base: result.base, head: sha, branch, git, readJobs });
    const rerun = [...checks].map(([name, reasons]) => `; ${name} runs again in full: ${reasons.join(', ')}`).join('');
    return { ...result, checks, reason: `${result.reason}${rerun}` };
  } catch (error) {
    return { base: null, ...none, reason: `the last finished ci run on ${branch} is unknown: ${error.message}` };
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
// `status: 'completed'` lists failed runs too, and `status: null` every run.
export async function successfulRuns({ repository, workflow, branch, token, apiUrl = 'https://api.github.com', fetchImpl = fetch, status = 'success' }) {
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to find the last successful run');
  const url = `${apiUrl}/repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}${status ? `&status=${status}` : ''}&per_page=100`;
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
