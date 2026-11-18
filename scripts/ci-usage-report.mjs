#!/usr/bin/env node
// Reports what one UTC day of workflow runs cost and exits 1 when a budget in
// scripts/lib/ci-usage.mjs is exceeded, so the scheduled run fails and
// nightly-failures.yml opens an issue. The measures of scripts/lib/ci-measures.mjs
// follow the budgets; they are report-only.
//
//   node scripts/ci-usage-report.mjs [--hours 24] [--until 2026-11-11T00:00:00Z] [--max-requests 600]
//
// Without --until the window ends at the last UTC midnight. Consecutive daily
// reports then share a boundary whenever they start, so no run falls between
// two reports or into both, and every run in the window has had hours to show
// how many jobs it has. Needs an authenticated `gh`.
//
// The budgets come first and alone decide the exit code. They read one
// listing per two hours of the window and per 100 runs, and one job count per
// long `ci` pull request run. The measures then read, under --max-requests:
// the deploy runs, the merged pull requests, their runs outside the window and
// the jobs of every run that was not skipped (one request per 30 jobs). A
// failed request or the cap makes the measures that need the missing data
// unavailable; it never fails the report.
import { appendFile } from 'node:fs/promises';
import { DEPLOY_WORKFLOW, measuresMarkdown, summarizeMeasures } from './lib/ci-measures.mjs';
import { budgetFindings, largeRunCandidates, ofPullRequest, summarizeUsage, usageMarkdown } from './lib/ci-usage.mjs';
import { jobCount, listAllRuns, listBranchRuns, listJobs, listRuns, mapLimited, pullRequestsMergedBetween } from './lib/github-actions.mjs';

// Well below the 1,000 requests an hour a workflow token may make, which the
// budgets and other workflows share.
const MEASURE_REQUEST_CAP = 600;

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const hours = Number(option('--hours', 24));
const cap = Number(option('--max-requests', MEASURE_REQUEST_CAP));
const now = new Date();
const until = new Date(option('--until', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()));
if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(cap) || cap < 0 || Number.isNaN(until.getTime())) throw new Error('Usage: ci-usage-report.mjs [--hours <n>] [--until <ISO time>] [--max-requests <n>]');
const since = new Date(until.getTime() - hours * 3600e3);
const nowIso = now.toISOString();
const pages = (count, size) => Math.max(1, Math.ceil(count / size));
const report = async (text) => {
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
};

// The budgets.
const runs = await listAllRuns({ since, until });
// A run still going has used its runners up to now, not up to the window's end.
const candidates = largeRunCandidates(runs, nowIso);
const counts = await mapLimited(candidates, 6, (run) => jobCount(run.id));
const usage = summarizeUsage(runs, new Map(candidates.map((run, index) => [run.id, counts[index]])), nowIso);
const findings = budgetFindings(usage);
const budgetRequests = Math.ceil(hours / 2) + Math.floor(runs.length / 100) + candidates.length;
await report(usageMarkdown(usage, findings, { since: since.toISOString(), until: until.toISOString() }));
for (const finding of findings) console.log(`::error::${finding}`);
process.exitCode = findings.length ? 1 : 0;

// The measures. Each source either completes or names why it did not.
let requests = 0;
const unavailable = {};
let stop = null;
const spend = (count) => {
  requests += count;
};
// Throws instead of starting a request once the cap is reached or a request failed.
function take() {
  if (requests >= cap) stop ??= `the request cap of ${cap} was reached`;
  if (stop) throw new Error(stop);
}
async function collect(source, task) {
  try {
    await task();
  } catch (error) {
    const reason = stop ?? (error.stderr || error.message || String(error)).trim().split('\n')[0];
    stop ??= reason;
    unavailable[source] = reason;
  }
}

const jobs = new Map();
async function readJobs(list) {
  const started = list.filter((run) => run.conclusion !== 'skipped' && !jobs.has(run.id));
  const listed = await mapLimited(started, 6, (run) => {
    take();
    return listJobs(run.id).then((each) => {
      spend(pages(each.length, 30));
      return each;
    });
  });
  started.forEach((run, index) => {
    jobs.set(run.id, listed[index].map(({ name, status, conclusion, started_at, completed_at, runner_name }) => ({ name, status, conclusion, started_at, completed_at, runner_name })));
  });
}

// A push late in the window can go live after it ends.
let deploys = [];
await collect('deploys', async () => {
  take();
  deploys = await listRuns({ workflow: DEPLOY_WORKFLOW.file, since: since.toISOString() });
  spend(pages(deploys.length, 100));
});

let pullRequests = [];
const earlierRuns = [];
const lateRuns = [];
await collect('pullRequests', async () => {
  take();
  pullRequests = await pullRequestsMergedBetween({ since, until });
  spend(1);
  // A pull request opened before the window ran there too.
  for (const pullRequest of pullRequests.filter((each) => Date.parse(each.createdAt) < since.getTime())) {
    take();
    const listed = await listBranchRuns({ branch: pullRequest.branch, since: pullRequest.createdAt, until: since });
    spend(pages(listed.length, 100));
    earlierRuns.push(...listed.filter((run) => ofPullRequest(run, pullRequest)));
  }
  // The merge commit of a pull request merged just before the window ends
  // starts push runs after it, which the next report leaves out with the pull request.
  const mergeCommits = new Set(pullRequests.map((each) => each.mergeCommit));
  if (mergeCommits.size && until < now) {
    take();
    const listed = await listBranchRuns({ branch: 'main', since: until, until: now });
    spend(pages(listed.length, 100));
    lateRuns.push(...listed.filter((run) => run.event === 'push' && mergeCommits.has(run.head_sha)));
  }
});

await collect('jobs', () => readJobs(runs));
if (!unavailable.pullRequests) await collect('pullRequests', () => readJobs([...earlierRuns, ...lateRuns]));

let text;
try {
  text = measuresMarkdown(summarizeMeasures({ runs, earlierRuns, lateRuns, jobs, pullRequests, deploys, now: nowIso, unavailable }));
} catch (error) {
  text = `### Measures\n\nUnavailable: ${error.message}\n`;
}
await report(`\n${text}\nAbout ${budgetRequests} API requests for the budgets and ${requests} for the measures (cap ${cap}).\n`);
