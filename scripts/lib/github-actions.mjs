import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Read-only GitHub Actions queries through the authenticated `gh` CLI.

const run = promisify(execFile);
export const REPOSITORY = process.env.GITHUB_REPOSITORY || 'neurodesk/webapps';

// GitHub answers large job listings with an occasional 502; retry those.
async function gh(args, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await run('gh', args, { maxBuffer: 512 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      if (attempt >= attempts || !/HTTP 5\d\d|timed out|ECONNRESET/.test(error.stderr ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

// Every item `jq` selects across all pages, one JSON value per line.
async function paginated(path, jq) {
  const out = await gh(['api', '--paginate', path, '--jq', jq]);
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// Workflow runs of `workflow` (file name), newest first, created on or after `since` (YYYY-MM-DD).
export function listRuns({ workflow = 'ci.yml', since, event, branch, limit = 1000 }) {
  const query = new URLSearchParams({ per_page: '100', created: `>=${since}` });
  if (event) query.set('event', event);
  if (branch) query.set('branch', branch);
  return paginated(`repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`, '.workflow_runs[] | @json')
    .then((runs) => runs.slice(0, limit));
}

// The jobs of a run's latest attempt. Pages of 100 jobs fail with a steady
// HTTP 502 for some full-catalog runs; pages of 30 do not.
export function listJobs(runId) {
  return paginated(`repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=30&filter=latest`, '.jobs[] | @json');
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
