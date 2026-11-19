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
// runs again whatever its plan, and the agentic jobs only the nightly (which
// tests every app) or a dispatch runs, need no carrying. Any other failed job (the plan itself), a job
// that has not finished, or an app id the registry does not know cannot be
// tied to an app. The site jobs check only the apps their run selected and the
// canaries (scripts/lib/smoke-apps.mjs) and name no app, so a failure there is
// tied to none either. test/app-plan.test.mjs holds ci.yml to these job lists.
export const APP_JOBS = ['app-tests', 'browser-e2e', 'browser-e2e-gpu'];
export const RERUN_JOBS = ['workspace-contracts', 'homepage-easter-egg', 'example-cache-retention', 'full-plan', 'full-plan-withheld'];
export const SITE_JOBS = ['composite-site', 'site-runtime', 'site-audit', 'site-e2e', 'site-mobile', 'site-catalog'];
export const NIGHTLY_JOBS = ['agent-interactions', 'processing-workflows'];
// The required check of pull requests and merge queue runs. It fails only when
// another job of its run did not pass, and that job is listed itself.
export const AGGREGATE_JOBS = ['ci-required'];
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
    if (!UNPASSED.has(job.conclusion)) unattributed.push(`${job.name} (not finished)`);
    else if (app && (!appIds || appIds.has(app))) carried.set(app, [...(carried.get(app) ?? []), job.name]);
    else if (app || ![...RERUN_JOBS, ...NIGHTLY_JOBS, ...AGGREGATE_JOBS].includes(base)) unattributed.push(job.name);
  }
  return { carried, unattributed };
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

// The base `ci` on main diffs from, and the apps it carries: the head of the
// nearest finished push or nightly run, green or failed. After a failed run
// only the apps whose jobs failed are untested at its head, so they are
// selected again instead of every app since the last green run. When a failed
// job cannot be tied to an app, the base is the last green run as before.
export async function resolveCiBase({ head, branch = 'main', cwd, env = process.env, fetchImpl, appIds }) {
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
    const jobs = await runJobs({ repository, runId: finished.run.id, attempt: finished.run.run_attempt ?? 1, token, apiUrl: env.GITHUB_API_URL, fetchImpl });
    const { carried, unattributed } = carriedApps(jobs, appIds);
    if (!unattributed.length) {
      const apps = [...carried.keys()];
      const why = apps.length
        ? `it failed for ${apps.join(', ')}, which ${apps.length === 1 ? 'is' : 'are'} selected again (without @slow tests on a push)`
        : 'it failed only in jobs every push runs again or only the nightly runs';
      return { ...finished, carried, reason: `${finished.reason}; ${why}` };
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

// A push to main whose commits a merge queue already tested. GitHub alone
// starts `merge_group` runs, and a queue run tests the very commit that then
// lands on main, with the complete plan from the queue's base. A push is
// covered when every commit it adds since its base (resolveCiBase) has a
// completed, successful ci run of this repository with event merge_group for
// that commit's own SHA. Running is the default: no base, apps the base run
// left untested, a commit without such a run, more than QUEUE_COMMIT_LIMIT
// commits, a git or API error, a timeout and an answer of any other shape
// leave the push as it was.
export const QUEUE_EVENT = 'merge_group';
export const QUEUE_COMMIT_LIMIT = 20;
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const QUEUE_DEADLINE_MS = 60_000;

// Whether one run record of the Actions API proves that ci passed in a merge
// queue at `sha` in `repository`. Every field is checked, none is assumed.
export function queueRunProves(run, { sha, repository }) {
  return run !== null && typeof run === 'object' && !Array.isArray(run)
    && Number.isSafeInteger(run.id) && run.id > 0
    && run.event === QUEUE_EVENT
    && run.status === 'completed'
    && run.conclusion === 'success'
    && typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && run.head_sha === sha
    && typeof run.path === 'string' && run.path.replace(/@.*$/, '') === CI_WORKFLOW_PATH
    && typeof repository === 'string' && repository !== ''
    && run.repository?.full_name === repository
    && run.head_repository?.full_name === repository;
}

// The commits `head` adds to `base`, newest first, or null when git cannot say.
function addedCommits(base, head, cwd) {
  try {
    const listed = execFileSync('git', ['rev-list', `${base}..${head}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    return listed.every((sha) => /^[0-9a-f]{40}$/.test(sha)) ? listed : null;
  } catch {
    return null;
  }
}

// Whether a merge queue tested every commit of a push to main, and the runs
// that prove it. `tested` is resolveCiBase's answer for the push.
export async function queueCoverage({ tested, head, cwd, env = process.env, fetchImpl = fetch, deadlineMs = QUEUE_DEADLINE_MS }) {
  const no = (reason) => ({ covered: false, runs: [], reason });
  if (!tested?.base) return no('the push has no tested base');
  if (!(tested.carried instanceof Map) || tested.carried.size > 0) return no('the base run left apps untested');
  const commits = addedCommits(tested.base, head, cwd);
  if (!commits?.length) return no(`git cannot list the commits from ${tested.base} to ${head}`);
  if (commits.length > QUEUE_COMMIT_LIMIT) return no(`the push adds ${commits.length} commits, more than ${QUEUE_COMMIT_LIMIT}`);
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository || !token) return no('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to read merge queue runs');
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  // One deadline for every request and every body: it aborts the request and
  // ends a wait on a body that never finishes, whatever fetch does with it.
  const controller = new AbortController();
  const { signal } = controller;
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(`no answer within ${deadlineMs} ms`);
      controller.abort(reason);
      reject(reason);
    }, deadlineMs);
  });
  expired.catch(() => {});
  const inTime = (promise) => Promise.race([promise, expired]);
  const runs = [];
  try {
    for (const sha of commits) {
      const url = `${apiUrl}/repos/${repository}/actions/workflows/ci.yml/runs?event=${QUEUE_EVENT}&head_sha=${sha}&status=success&per_page=100`;
      const response = await inTime(fetchImpl(url, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
        redirect: 'error',
        signal,
      }));
      if (!response.ok) return no(`the Actions API answered ${response.status} for merge queue runs of ${sha}`);
      const body = await inTime(response.json());
      const listed = Array.isArray(body?.workflow_runs) ? body.workflow_runs : null;
      if (!listed) return no(`the Actions API listed no workflow_runs for ${sha}`);
      const proof = listed.find((run) => queueRunProves(run, { sha, repository }));
      if (!proof) return no(`no successful merge queue ci run tested ${sha}`);
      runs.push({ sha, id: proof.id, url: `${server}/${repository}/actions/runs/${proof.id}` });
    }
  } catch (error) {
    return no(`merge queue runs could not be read: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const named = runs.map((run) => `${run.sha.slice(0, 9)} in ${run.url}`).join(', ');
  return { covered: true, runs, reason: `a merge queue ci run passed at every commit since ${tested.base.slice(0, 9)}: ${named}` };
}
