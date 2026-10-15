#!/usr/bin/env node
// Runner minutes and queue latency of `ci` runs, split by what the app planner
// selected (issue #259). The planner's choice comes from its own summary line
// in the app-plan job log; runs older than the log retention, or older than the
// planner, are `unknown`.
//
//   node scripts/ci-minutes-report.mjs --since 2026-10-13 --event pull_request \
//     --json minutes.json --markdown minutes.md
//
// Needs an authenticated `gh`. Rerunning over the same window gives the same
// numbers, except for runs still in progress, which are left out.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { aggregate, aggregateJobs, classifyRun, summarizeRun } from './lib/ci-minutes.mjs';
import { repoRoot } from './lib/apps-registry.mjs';
import { jobLog, listJobs, listRuns, mapLimited } from './lib/github-actions.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const since = option('--since', new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10));
const until = option('--until');
const events = option('--event', 'pull_request,push,schedule').split(',');
const limit = Number(option('--limit', 1000));
// Runs before the planner printed its summary are classified by how many
// app-tests jobs they created, against the catalog on main when the run was
// created (a pull request's own head may no longer be fetchable).
const catalogSizes = new Map();
function catalogSizeAt(createdAt) {
  const commit = execFileSync('git', ['rev-list', '-1', `--before=${createdAt}`, 'origin/main'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!catalogSizes.has(commit)) {
    const registry = parse(execFileSync('git', ['show', `${commit}:registry/apps.yml`], { cwd: repoRoot, encoding: 'utf8' }));
    catalogSizes.set(commit, registry.apps.length);
  }
  return catalogSizes.get(commit);
}

// The window is filtered before the limit, which keeps the newest runs over all events.
const runs = (await Promise.all(events.map((event) => listRuns({ since, event }))))
  .flat()
  .filter((run) => run.status === 'completed' && (!until || run.created_at < until))
  .sort((a, b) => b.created_at.localeCompare(a.created_at))
  .slice(0, limit);
console.error(`Reading ${runs.length} completed ci runs since ${since}${until ? ` until ${until}` : ''}`);

const summaries = await mapLimited(runs, 6, async (run) => {
  const jobs = await listJobs(run.id);
  const planJob = jobs.find((job) => job.name === 'app-plan');
  const log = planJob ? await jobLog(planJob.id) : '';
  return { ...summarizeRun(run, jobs, classifyRun({ planJob, log, jobs, catalogSize: catalogSizeAt(run.created_at) })), event: run.event };
});

const byEvent = Object.fromEntries(events.map((event) => [event, aggregate(summaries.filter((run) => run.event === event))]));
const jobs = Object.fromEntries(events.map((event) => [event, aggregateJobs(summaries.filter((run) => run.event === event))]));

const format = (value, unit = '') => (value === null || value === undefined ? '-' : `${value}${unit}`);
const lines = [`ci runs created from ${since}${until ? ` to ${until}` : ''}, completed. Minutes are per job, rounded up as GitHub bills them.`, ''];
for (const event of events) {
  lines.push(`### ${event}`, '', '| Selection | Runs | Finished | Cancelled | Wall median / p90 (min) | Linux min/run median / p90 | macOS min/run median / p90 | Linux queue median / p90 / max (s) | macOS queue median / p90 / max (s) |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const group of byEvent[event].sort((a, b) => a.kind.localeCompare(b.kind))) {
    const minutes = (os) => `${format(group.runnerMinutesPerFinishedRun[os].median)} / ${format(group.runnerMinutesPerFinishedRun[os].p90)}`;
    const queue = (os) => `${format(group.jobQueueSeconds[os].median)} / ${format(group.jobQueueSeconds[os].p90)} / ${format(group.jobQueueSeconds[os].max)}`;
    lines.push(`| ${group.kind} | ${group.runs} | ${group.finished} | ${group.cancelled} | ${format(group.wallMinutes.median)} / ${format(group.wallMinutes.p90)} | ${minutes('Linux')} | ${minutes('macOS')} | ${queue('Linux')} | ${queue('macOS')} |`);
  }
  lines.push('', '| Job (runner) | Jobs | Run median / p90 / total (min) | Queue median / p90 / max (s) |', '| --- | --- | --- | --- |');
  for (const job of jobs[event]) {
    lines.push(`| ${job.job} | ${job.jobs} | ${format(job.runMinutes.median)} / ${format(job.runMinutes.p90)} / ${format(job.runMinutes.total)} | ${format(job.queueSeconds.median)} / ${format(job.queueSeconds.p90)} / ${format(job.queueSeconds.max)} |`);
  }
  lines.push('');
}
const text = `${lines.join('\n')}\n`;
if (option('--json')) {
  await writeFile(option('--json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), since, until: until ?? null, byEvent, jobs, runs: summaries.map(({ timings, ...run }) => run) }, null, 2)}\n`);
}
if (option('--markdown')) await writeFile(option('--markdown'), text);
else process.stdout.write(text);
