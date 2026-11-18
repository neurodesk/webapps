#!/usr/bin/env node
// Reports what one UTC day of workflow runs cost and exits 1 when a budget in
// scripts/lib/ci-usage.mjs is exceeded, so the scheduled run fails and
// nightly-failures.yml opens an issue. The measures of scripts/lib/ci-measures.mjs
// follow the budgets; they are report-only.
//
//   node scripts/ci-usage-report.mjs [--hours 24] [--until 2026-11-11T00:00:00Z]
//
// Without --until the window ends at the last UTC midnight. Consecutive daily
// reports then share a boundary whenever they start, so no run falls between
// two reports or into both, and every run in the window has had hours to show
// how many jobs it has. Needs an authenticated `gh`.
//
// API requests: one listing per two hours of the window and per 100 runs, one
// per 30 jobs of each run that was not skipped, one search for the merged pull
// requests, one deploy listing, and for each merged pull request opened before
// the window one listing of its earlier runs and their jobs. The report prints
// the count it made.
import { appendFile } from 'node:fs/promises';
import { DEPLOY_WORKFLOW, measuresMarkdown, summarizeMeasures } from './lib/ci-measures.mjs';
import { budgetFindings, largeRunCandidates, ofPullRequest, summarizeUsage, usageMarkdown } from './lib/ci-usage.mjs';
import { listAllRuns, listBranchRuns, listJobs, listRuns, mapLimited, pullRequestsMergedBetween } from './lib/github-actions.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const hours = Number(option('--hours', 24));
const now = new Date();
const until = new Date(option('--until', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()));
if (!Number.isFinite(hours) || hours <= 0 || Number.isNaN(until.getTime())) throw new Error('Usage: ci-usage-report.mjs [--hours <n>] [--until <ISO time>]');
const since = new Date(until.getTime() - hours * 3600e3);
const pages = (count, size) => Math.max(1, Math.ceil(count / size));
let requests = 0;

const runs = await listAllRuns({ since, until });
requests += Math.ceil(hours / 2) + runs.length / 100;

// The jobs of every run that was not skipped, as the measures and the
// whole-catalogue count read them.
const jobs = new Map();
async function readJobs(list) {
  const started = list.filter((run) => run.conclusion !== 'skipped' && !jobs.has(run.id));
  const listed = await mapLimited(started, 6, (run) => listJobs(run.id));
  started.forEach((run, index) => {
    jobs.set(run.id, listed[index].map(({ name, status, conclusion, started_at, completed_at }) => ({ name, status, conclusion, started_at, completed_at })));
    requests += pages(listed[index].length, 30);
  });
}
await readJobs(runs);

const pullRequests = await pullRequestsMergedBetween({ since, until });
requests += 1;
// A pull request opened before the window ran there too.
const earlierRuns = [];
for (const pullRequest of pullRequests.filter((each) => Date.parse(each.createdAt) < since.getTime())) {
  const listed = (await listBranchRuns({ branch: pullRequest.branch, since: pullRequest.createdAt, until: since })).filter((run) => ofPullRequest(run, pullRequest));
  requests += pages(listed.length, 100);
  earlierRuns.push(...listed);
}
await readJobs(earlierRuns);

// A push late in the window can go live after it ends.
const deploys = await listRuns({ workflow: DEPLOY_WORKFLOW.file, since: since.toISOString() });
requests += pages(deploys.length, 100);

const nowIso = now.toISOString();
const counts = new Map(largeRunCandidates(runs, nowIso).map((run) => [run.id, jobs.get(run.id)?.length ?? 0]));
const usage = summarizeUsage(runs, counts, nowIso);
const findings = budgetFindings(usage);
const measures = summarizeMeasures({ runs, earlierRuns, jobs, pullRequests, deploys, until: until.toISOString(), now: nowIso });
const text = `${usageMarkdown(usage, findings, { since: since.toISOString(), until: until.toISOString() })}\n${measuresMarkdown(measures)}\nAbout ${Math.ceil(requests)} API requests.\n`;

process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
for (const finding of findings) console.log(`::error::${finding}`);
process.exitCode = findings.length ? 1 : 0;
