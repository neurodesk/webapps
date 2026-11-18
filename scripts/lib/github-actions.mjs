import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Read-only GitHub Actions queries through the authenticated `gh` CLI.

const execFileAsync = promisify(execFile);
export const REPOSITORY = process.env.GITHUB_REPOSITORY || 'neurodesk/webapps';

// One `gh` process. Aborting `signal` kills it.
async function execGh(args, { signal } = {}) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 512 * 1024 * 1024, signal, killSignal: 'SIGKILL' });
  return stdout;
}

// GitHub answers large job listings with an occasional 502; retry those.
// Each attempt is one call of `send`.
async function retried(send, args, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send(args);
    } catch (error) {
      if (attempt >= attempts || !/HTTP 5\d\d|timed out|ECONNRESET/.test(error.stderr ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

const gh = (args) => retried(execGh, args);

// Every item `jq` selects across all pages, one JSON value per line.
async function paginated(path, jq) {
  const out = await gh(['api', '--paginate', path, '--jq', jq]);
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// A time as the API's `created` filter takes it, to the second.
const stamp = (time) => new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');

// Workflow runs of `workflow` (file name), newest first, created on or after `since` (YYYY-MM-DD).
export function listRuns({ workflow = 'ci.yml', since, event, branch, limit = 1000 }) {
  const query = new URLSearchParams({ per_page: '100', created: `>=${since}` });
  if (event) query.set('event', event);
  if (branch) query.set('branch', branch);
  return paginated(`repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`, '.workflow_runs[] | @json')
    .then((runs) => runs.slice(0, limit));
}

// Completed and running runs of every workflow created in [since, until), as
// the fields a usage report reads. The API returns at most 1,000 runs per
// query, so the range is read in two-hour windows.
// A run as the usage report reads it: pull requests as numbers, the head
// repository as its full name (scripts/lib/ci-usage.mjs, pullRequestOf).
const RUN_FIELDS = '{id, name, event, status, conclusion, head_branch, head_sha, created_at, run_started_at, updated_at, pull_requests: [.pull_requests[].number], head_repository: .head_repository.full_name}';

export async function listAllRuns({ since, until, windowHours = 2 }) {
  const fields = RUN_FIELDS;
  const runs = new Map();
  for (let from = since.getTime(); from < until.getTime(); from += windowHours * 3600e3) {
    const to = Math.min(from + windowHours * 3600e3, until.getTime()) - 1000;
    const query = new URLSearchParams({ per_page: '100', created: `${stamp(from)}..${stamp(to)}` });
    for (const run of await paginated(`repos/${REPOSITORY}/actions/runs?${query}`, `.workflow_runs[] | ${fields} | @json`)) runs.set(run.id, run);
  }
  return [...runs.values()];
}

// The `ci` pull request runs of one head branch created at or after `since`,
// in the usage report's shape. Forks share branch names; pullRequestOf tells
// their runs apart.
export function listPullRequestRuns({ branch, since }) {
  const query = new URLSearchParams({ per_page: '100', event: 'pull_request', branch, created: `>=${new Date(since).toISOString().replace(/\.\d+Z$/, 'Z')}` });
  return paginated(`repos/${REPOSITORY}/actions/workflows/ci.yml/runs?${query}`, `.workflow_runs[] | ${RUN_FIELDS} | @json`);
}

// The names of a pull request's labels as they are now, not as the event that
// started the run saw them, so a re-run sees a label added since.
export async function pullRequestLabels(number) {
  return JSON.parse(await gh(['api', `repos/${REPOSITORY}/pulls/${number}`, '--jq', '[.labels[].name]']));
}

// How many jobs a run's latest attempt has, in one request.
export async function jobCount(runId) {
  return Number(await gh(['api', `repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=1&filter=latest`, '--jq', '.total_count']));
}

// The name and conclusion of each job of a run's latest attempt, in pages of 30 (see listJobs).
export function jobOutcomes(runId) {
  return paginated(jobsPath(runId), '.jobs[] | {name, conclusion} | @json');
}

// The jobs of a run's latest attempt. Pages of 100 jobs fail with a steady
// HTTP 502 for some full-catalog runs; pages of 30 do not.
const jobsPath = (runId) => `repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=30&filter=latest`;
export function listJobs(runId) {
  return paginated(jobsPath(runId), '.jobs[] | @json');
}

// A job's plain-text log, or '' once GitHub has expired it.
export async function jobLog(jobId) {
  try {
    return await gh(['api', '--allow-escape-sequences', `repos/${REPOSITORY}/actions/jobs/${jobId}/logs`]);
  } catch {
    return '';
  }
}

// Merged pull requests, newest first.
export async function mergedPullRequests({ limit, numbers }) {
  const fields = 'number,title,mergedAt,mergeCommit,baseRefName';
  if (numbers) {
    return Promise.all(numbers.map(async (number) => JSON.parse(await gh(['pr', 'view', String(number), '--repo', REPOSITORY, '--json', fields]))));
  }
  return JSON.parse(await gh(['pr', 'list', '--repo', REPOSITORY, '--state', 'merged', '--base', 'main', '--limit', String(limit), '--json', fields]));
}

// Runs `task` over `items`, at most `width` at a time, keeping order.
export async function mapLimited(items, width, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

// The search of merged pull requests, one page of 100 per request.
const MERGED_PULL_REQUESTS = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number createdAt mergedAt mergeCommit { oid } headRefName headRepository { nameWithOwner } } }
  }
}`;

// The reads of report-only measures, through one runner that charges every
// request before it sends it. Each page and each retry is one `gh` process and
// one request; listings are read a page at a time for that. Once `cap`
// requests were sent, `deadline` (a time in milliseconds) passed or a request
// failed, every further read rejects without sending, with the reason. The
// deadline also kills the `gh` processes still running. `requests()` counts
// the requests sent.
export function limitedReads({ cap, deadline, timeLimitMinutes }) {
  let sent = 0;
  let stop = null;
  const controller = new AbortController();
  setTimeout(() => {
    stop ??= `the time limit of ${timeLimitMinutes} minutes was reached`;
    controller.abort();
  }, Math.max(0, deadline - Date.now())).unref();

  async function send(args) {
    if (!stop && sent >= cap) stop = `the request cap of ${cap} was reached`;
    if (stop) throw new Error(stop);
    sent += 1;
    try {
      return await execGh(args, { signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted ? new Error(stop) : error;
    }
  }
  // A refused request is likely to be followed by more: after the first, send none.
  async function request(args) {
    try {
      return await retried(send, args);
    } catch (error) {
      stop ??= (error.stderr || error.message || String(error)).trim().split('\n')[0];
      throw error;
    }
  }

  // Every item of a listing, `map` applied, one page per request.
  async function pages(path, key, map) {
    const size = Number(new URLSearchParams(path.split('?')[1]).get('per_page'));
    const items = [];
    for (let page = 1; ; page += 1) {
      const { total, items: more } = JSON.parse(await request(['api', `${path}&page=${page}`, '--jq', `{total: .total_count, items: [.${key}[] | ${map}]} | @json`]));
      if (!Number.isSafeInteger(total) || !Array.isArray(more)) throw new Error(`the API answered ${path} without a listing`);
      items.push(...more);
      // The API lists at most 1,000 results of one query.
      if (more.length < size || items.length >= Math.min(total, 1000)) return items;
    }
  }

  return {
    requests: () => sent,
    // Runs of `workflow` (file name) created at or after `since`, in the usage report's shape.
    listRuns({ workflow, since }) {
      const query = new URLSearchParams({ per_page: '100', created: `>=${stamp(since)}` });
      return pages(`repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`, 'workflow_runs', RUN_FIELDS);
    },
    // The runs of every workflow on one head branch created in [since, until),
    // in the usage report's shape. Forks share branch names; ofPullRequest
    // tells their runs apart.
    listBranchRuns({ branch, since, until }) {
      const query = new URLSearchParams({ per_page: '100', branch, created: `${stamp(since)}..${stamp(new Date(until).getTime() - 1000)}` });
      return pages(`repos/${REPOSITORY}/actions/runs?${query}`, 'workflow_runs', RUN_FIELDS);
    },
    listJobs: (runId) => pages(jobsPath(runId), 'jobs', '{name, status, conclusion, started_at, completed_at, runner_name}'),
    // Pull requests merged into main in [since, until), as { number,
    // repository, branch, createdAt, mergedAt, mergeCommit }.
    async mergedPullRequests({ since, until }) {
      const q = `repo:${REPOSITORY} is:pr is:merged base:main merged:${stamp(since)}..${stamp(new Date(until).getTime() - 1000)}`;
      const found = [];
      for (let after = null; ;) {
        const args = ['api', 'graphql', '-f', `query=${MERGED_PULL_REQUESTS}`, '-f', `q=${q}`, '--jq', '.data.search | {next: (if .pageInfo.hasNextPage then .pageInfo.endCursor else null end), items: .nodes} | @json'];
        if (after) args.push('-f', `after=${after}`);
        const { next, items } = JSON.parse(await request(args));
        if (!Array.isArray(items)) throw new Error('the API answered the pull request search without a listing');
        found.push(...items);
        // The search finds at most 1,000 results.
        if (!next || found.length >= 1000) break;
        after = next;
      }
      return found.map((pullRequest) => ({
        number: pullRequest?.number,
        repository: pullRequest?.headRepository?.nameWithOwner ?? null,
        branch: pullRequest?.headRefName,
        createdAt: pullRequest?.createdAt,
        mergedAt: pullRequest?.mergedAt,
        mergeCommit: pullRequest?.mergeCommit?.oid,
      }));
    },
  };
}
