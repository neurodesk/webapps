#!/usr/bin/env node
// Reports what one UTC day of workflow runs cost and exits 1 when a budget in
// scripts/lib/ci-usage.mjs is exceeded, so the scheduled run fails and
// nightly-failures.yml opens an issue. The measures of scripts/lib/ci-measures.mjs
// follow the budgets; they are report-only.
//
//   node scripts/ci-usage-report.mjs [--hours 24] [--until 2026-11-11T00:00:00Z] [--max-requests 600] [--time-limit 10]
//
// Without --until the window ends at the last UTC midnight. Consecutive daily
// reports then share a boundary whenever they start, so no run falls between
// two reports or into both, and every run in the window has had hours to show
// how many jobs it has. Needs an authenticated `gh`.
//
// The budgets come first and alone decide the exit code. They read one
// listing per two hours of the window and per 100 runs, and one job count per
// long `ci` pull request run. The measures then read the deploy runs, the
// merged pull requests, their runs outside the window and the jobs of every
// run that was not skipped, through one runner (limitedReads) that sends at
// most --max-requests requests and kills every request at --time-limit
// minutes after the report started. Whatever the measures meet (a refused or
// stalled request, the cap, a record without the fields they read, a step
// summary that cannot be written), they show `unavailable:` with the reason
// and the report exits with the budgets' code.
import { constants } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { checkRecords, DEPLOY_WORKFLOW, measuresMarkdown, summarizeMeasures } from './lib/ci-measures.mjs';
import { budgetFindings, largeRunCandidates, ofPullRequest, summarizeUsage, usageMarkdown } from './lib/ci-usage.mjs';
import { jobCount, limitedReads, listAllRuns, mapLimited } from './lib/github-actions.mjs';

// Well below the 1,000 requests an hour a workflow token may make, which the
// budgets and other workflows share.
const MEASURE_REQUEST_CAP = 600;
// Minutes from the report's start; well below the job's timeout-minutes of 15
// in .github/workflows/ci-usage.yml, so the job ends with the budgets' code.
const MEASURE_TIME_LIMIT = 10;
// After the time limit kills the requests, how long the measures may take to
// print before the report exits without them.
const GRACE_MS = 5000;
const started = Date.now();

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const hours = Number(option('--hours', 24));
const cap = Number(option('--max-requests', MEASURE_REQUEST_CAP));
const timeLimit = Number(option('--time-limit', MEASURE_TIME_LIMIT));
const now = new Date();
const until = new Date(option('--until', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()));
if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(cap) || cap < 0 || !Number.isFinite(timeLimit) || timeLimit < 0 || Number.isNaN(until.getTime())) throw new Error('Usage: ci-usage-report.mjs [--hours <n>] [--until <ISO time>] [--max-requests <n>] [--time-limit <minutes>]');
const since = new Date(until.getTime() - hours * 3600e3);
const nowIso = now.toISOString();

// The budgets.
const runs = await listAllRuns({ since, until });
// A run still going has used its runners up to now, not up to the window's end.
const candidates = largeRunCandidates(runs, nowIso);
const counts = await mapLimited(candidates, 6, (run) => jobCount(run.id));
const usage = summarizeUsage(runs, new Map(candidates.map((run, index) => [run.id, counts[index]])), nowIso);
const findings = budgetFindings(usage);
const budgetRequests = Math.ceil(hours / 2) + Math.floor(runs.length / 100) + candidates.length;
const text = usageMarkdown(usage, findings, { since: since.toISOString(), until: until.toISOString() });

// As before the measures: a summary that cannot be written fails the report here.
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
for (const finding of findings) console.log(`::error::${finding}`);
// The one exit code; nothing after this line changes it.
const exitCode = findings.length ? 1 : 0;
process.exitCode = exitCode;

// The measures. Every read goes through `reads`; each source either completes
// or names why it did not.
const deadline = started + timeLimit * 60e3;
let printed = false;

async function measures() {
  const reads = limitedReads({ cap, deadline, timeLimitMinutes: timeLimit });
  const unavailable = {};
  async function collect(source, task) {
    try {
      await task();
    } catch (error) {
      unavailable[source] ??= (error.stderr || error.message || String(error)).trim().split('\n')[0];
    }
  }

  await collect('runs', async () => checkRecords('run', runs));

  const jobs = new Map();
  async function readJobs(list) {
    const started = list.filter((run) => run.conclusion !== 'skipped' && !jobs.has(run.id));
    // Every listing settles before the first failure is thrown, so no request outlives the report.
    const listed = await mapLimited(started, 6, (run) => reads.listJobs(run.id).then((each) => checkRecords('job', each)).catch((error) => ({ error })));
    const failed = listed.find((each) => each.error);
    if (failed) throw failed.error;
    started.forEach((run, index) => jobs.set(run.id, listed[index]));
  }

  // A push late in the window can go live after it ends.
  let deploys = [];
  await collect('deploys', async () => {
    deploys = checkRecords('run', await reads.listRuns({ workflow: DEPLOY_WORKFLOW.file, since }));
  });

  let pullRequests = [];
  const earlierRuns = [];
  const lateRuns = [];
  await collect('pullRequests', async () => {
    pullRequests = checkRecords('pull request', await reads.mergedPullRequests({ since, until }));
    // A pull request opened before the window ran there too.
    for (const pullRequest of pullRequests.filter((each) => Date.parse(each.createdAt) < since.getTime())) {
      const listed = checkRecords('run', await reads.listBranchRuns({ branch: pullRequest.branch, since: pullRequest.createdAt, until: since }));
      earlierRuns.push(...listed.filter((run) => ofPullRequest(run, pullRequest)));
    }
    // The merge commit of a pull request merged just before the window ends
    // starts push runs after it, which the next report leaves out with the pull request.
    const mergeCommits = new Set(pullRequests.map((each) => each.mergeCommit));
    if (mergeCommits.size && until < now) {
      const listed = checkRecords('run', await reads.listBranchRuns({ branch: 'main', since: until, until: now }));
      lateRuns.push(...listed.filter((run) => run.event === 'push' && mergeCommits.has(run.head_sha)));
    }
  });

  if (!unavailable.runs) await collect('jobs', () => readJobs(runs));
  if (!unavailable.pullRequests) await collect('pullRequests', () => readJobs([...earlierRuns, ...lateRuns]));

  const measured = `\n${measuresMarkdown(summarizeMeasures({ runs, earlierRuns, lateRuns, jobs, pullRequests, deploys, now: nowIso, unavailable }))}\nAbout ${budgetRequests} API requests for the budgets and ${reads.requests()} for the measures (cap ${cap}).\n`;
  process.stdout.write(measured);
  printed = true;
  // Non-blocking: a summary path no one reads (a FIFO) fails at once, where a
  // blocking open would hold a libuv thread that even process.exit waits for.
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, measured, { flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK });
}

// The measures settle, or the time limit passes and the report leaves them.
let timer;
const failure = await Promise.race([
  measures().then(() => null, (error) => error),
  new Promise((resolve) => {
    timer = setTimeout(() => resolve(new Error(`the time limit of ${timeLimit} minutes was reached`)), Math.max(0, deadline - Date.now()) + GRACE_MS);
  }),
]);
clearTimeout(timer);
if (failure) {
  const reason = (failure.message || String(failure)).trim().split('\n')[0];
  try {
    process.stdout.write(printed ? `\nThe measures did not complete: ${reason}\n` : `\n### Measures\n\nUnavailable: ${reason}\n`);
  } catch {
    // stdout is gone; the exit code still stands.
  }
}
// A `gh` process or socket that outlives the measures cannot hold the job open.
process.exit(exitCode);
