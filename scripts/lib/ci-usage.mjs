// What one day of workflow runs cost, and whether it stayed inside the budget.
//
// Each budget names one way the catalogue has wasted runner time before:
//   - a ready pull request pushed to again and again, each push testing every
//     app (keep iterative work in draft, AGENTS.md "CI scope"),
//   - many pull requests selecting every app, which points at a file the
//     planner ties to the whole catalogue.
// The report also lists how many workflows each push to main ran. That has no
// budget: a release changes most packages and rightly runs their workflows,
// and test/workflow-gate.test.mjs keeps shared paths out of `push` filters.
// The report reads run lists and the job count of long `ci` runs only, so it
// stays far below the hourly API limit of the workflow token.

export const BUDGETS = Object.freeze({
  // Whole-catalogue `ci` runs one pull request may start in the window.
  largeRunsPerPullRequest: 2,
  // Whole-catalogue pull request `ci` runs over all pull requests.
  largeRuns: 8,
});

// A `ci` run with this many jobs tested most of the catalogue.
export const LARGE_RUN_JOBS = 100;
// A run shorter than this did no work beyond its plan or gate job.
export const WORKED_SECONDS = 180;
const PER_PUSH_EXEMPT = new Set(['ci', 'deploy-github-pages']);

// A run that has not finished has used its runners up to `until`, the end of
// the reported window. Leaving it out would lose it: the next report starts
// after it was created.
export function wallSeconds(run, until) {
  const end = run.status && run.status !== 'completed' ? Date.parse(until) : Date.parse(run.updated_at);
  const seconds = (end - Date.parse(run.run_started_at ?? run.created_at)) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export const worked = (run, until) => run.conclusion !== 'skipped' && wallSeconds(run, until) >= WORKED_SECONDS;

// The `ci` runs whose job count is worth asking for.
export function largeRunCandidates(runs, until) {
  return runs.filter((run) => run.name === 'ci' && run.event === 'pull_request' && worked(run, until));
}

// What names a run's pull request. A fork's run lists no pull request, and
// forks share branch names, so its repository is part of the name.
export function pullRequestOf(run) {
  if (run.pull_requests?.length) return `#${run.pull_requests[0]}`;
  return run.head_repository ? `${run.head_repository}:${run.head_branch}` : run.head_branch;
}

// `jobCounts` maps a run id to its number of jobs.
export function summarizeUsage(runs, jobCounts = new Map(), until = undefined) {
  const byWorkflow = new Map();
  for (const run of runs) {
    const key = `${run.name}\u0000${run.event}`;
    const row = byWorkflow.get(key) ?? { workflow: run.name, event: run.event, runs: 0, worked: 0, cancelled: 0, wallMinutes: 0 };
    row.runs += 1;
    if (worked(run, until)) row.worked += 1;
    if (run.conclusion === 'cancelled') row.cancelled += 1;
    row.wallMinutes += wallSeconds(run, until) / 60;
    byWorkflow.set(key, row);
  }

  const largeByPullRequest = new Map();
  for (const run of largeRunCandidates(runs, until)) {
    if ((jobCounts.get(run.id) ?? 0) < LARGE_RUN_JOBS) continue;
    const list = largeByPullRequest.get(pullRequestOf(run)) ?? [];
    list.push({ id: run.id, sha: run.head_sha.slice(0, 9), conclusion: run.conclusion ?? run.status, jobs: jobCounts.get(run.id), wallMinutes: Math.round(wallSeconds(run, until) / 60) });
    largeByPullRequest.set(pullRequestOf(run), list);
  }

  const byPush = new Map();
  for (const run of runs) {
    if (run.event !== 'push' || run.head_branch !== 'main' || PER_PUSH_EXEMPT.has(run.name) || !worked(run, until)) continue;
    const workflows = byPush.get(run.head_sha) ?? new Set();
    workflows.add(run.name);
    byPush.set(run.head_sha, workflows);
  }

  return {
    runs: runs.length,
    byWorkflow: [...byWorkflow.values()].map((row) => ({ ...row, wallMinutes: Math.round(row.wallMinutes) })).sort((a, b) => b.wallMinutes - a.wallMinutes),
    largeRuns: [...largeByPullRequest].map(([pullRequest, list]) => ({ pullRequest, runs: list })).sort((a, b) => b.runs.length - a.runs.length),
    pushes: [...byPush].map(([sha, workflows]) => ({ sha: sha.slice(0, 9), workflows: [...workflows].sort() })).sort((a, b) => b.workflows.length - a.workflows.length),
  };
}

// One sentence per exceeded budget; empty when the day stayed inside all of them.
export function budgetFindings(usage, budgets = BUDGETS) {
  const findings = [];
  for (const { pullRequest, runs } of usage.largeRuns) {
    if (runs.length > budgets.largeRunsPerPullRequest) {
      findings.push(`${pullRequest} started ${runs.length} whole-catalogue ci runs (budget ${budgets.largeRunsPerPullRequest}): convert a ready pull request to draft before pushing fixes.`);
    }
  }
  const total = usage.largeRuns.reduce((sum, { runs }) => sum + runs.length, 0);
  if (total > budgets.largeRuns) {
    findings.push(`${total} whole-catalogue pull request ci runs (budget ${budgets.largeRuns}): read each run's app-plan summary for the file that selects every app.`);
  }
  return findings;
}

export function usageMarkdown(usage, findings, { since, until }) {
  const lines = [`## CI usage, ${since} to ${until}`, '', `${usage.runs} workflow runs. Minutes are run wall time, not runner minutes: a run with parallel jobs uses more.`, ''];
  lines.push(findings.length ? '### Over budget' : '### Inside every budget', '', ...findings.map((finding) => `- ${finding}`), '');
  lines.push('### Whole-catalogue pull request ci runs', '');
  if (!usage.largeRuns.length) lines.push('None.');
  for (const { pullRequest, runs } of usage.largeRuns) {
    lines.push(`- ${pullRequest}: ${runs.map((run) => `${run.sha} (${run.jobs} jobs, ${run.wallMinutes} min, ${run.conclusion})`).join(', ')}`);
  }
  lines.push('', '### Workflows per push to main (besides ci and the deploy)', '');
  if (!usage.pushes.length) lines.push('None.');
  for (const { sha, workflows } of usage.pushes.slice(0, 10)) lines.push(`- ${sha}: ${workflows.length} (${workflows.slice(0, 6).join(', ')}${workflows.length > 6 ? ', ...' : ''})`);
  lines.push('', '### Workflows by wall time', '', '| Workflow | Event | Runs | Did work | Cancelled | Wall minutes |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of usage.byWorkflow.slice(0, 25)) lines.push(`| ${row.workflow} | ${row.event} | ${row.runs} | ${row.worked} | ${row.cancelled} | ${row.wallMinutes} |`);
  return `${lines.join('\n')}\n`;
}
