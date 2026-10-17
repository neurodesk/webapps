import { execFileSync } from 'node:child_process';

// Push runs on main supersede each other, so a merge whose own run was
// cancelled is tested by no later run that diffs only from its own `before`.
// The base for a push is instead the newest commit a `ci` run on the branch
// finished green: the diff from there covers every merge not yet tested,
// however many runs in a row were cancelled.
export const TESTED_BASE = 'last-success';

// Pull request runs test a head against an older main, and a fork's pull
// request can come from a branch named main; neither tested the branch itself.
const BRANCH_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);

// Of `runs` (GitHub workflow runs), the head of the green branch run nearest
// to `head`, or why there is none. `git.isAncestor(a, b)` and
// `git.distance(a, b)` (commits in a..b) answer for the checked-out history.
export function testedBase({ runs, head, branch, git }) {
  const candidates = new Map();
  for (const run of runs) {
    if (run.conclusion !== 'success' || run.head_branch !== branch || !BRANCH_EVENTS.has(run.event)) continue;
    if (run.head_sha === head || candidates.has(run.head_sha)) continue;
    if (!git.isAncestor(run.head_sha, head)) continue;
    candidates.set(run.head_sha, run);
  }
  if (!candidates.size) {
    return { base: null, reason: `no successful ci run on ${branch} has a head that is an ancestor of ${head}` };
  }
  const [base, run] = [...candidates].reduce((best, entry) => (git.distance(entry[0], head) < git.distance(best[0], head) ? entry : best));
  return { base, reason: `base ${base} is the head of the last successful ci run on ${branch} (${run.event} run ${run.id})` };
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
export async function successfulRuns({ repository, workflow, branch, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to find the last successful run');
  const url = `${apiUrl}/repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=100`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`the Actions API answered ${response.status} for ${workflow} runs on ${branch}`);
  return (await response.json()).workflow_runs ?? [];
}

// The base a push run on `branch` diffs from, or null and why: the caller
// then selects the whole catalog.
export async function resolveTestedBase({ head, branch = 'main', workflow = 'ci.yml', cwd, env = process.env, fetchImpl }) {
  const git = gitAncestry(cwd);
  const sha = git.resolve(head);
  if (!sha) return { base: null, reason: `${head} is not a commit in this checkout` };
  let runs;
  try {
    runs = await successfulRuns({ repository: env.GITHUB_REPOSITORY, workflow, branch, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, fetchImpl });
  } catch (error) {
    return { base: null, reason: `the last successful ci run on ${branch} is unknown: ${error.message}` };
  }
  return testedBase({ runs, head: sha, branch, git });
}
