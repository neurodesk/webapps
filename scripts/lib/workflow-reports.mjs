import { readdir, readFile } from 'node:fs/promises';
import { reportNightlyFailure } from './nightly-failures.mjs';
import { alertNotarization } from './notarization-alert.mjs';

// One scheduled reporter for every finished workflow run: a failed or
// incomplete scheduled run on the default branch gets a workflow issue
// (nightly-failures.mjs), and a failed non-pull-request run of a workflow that
// notarizes gets the Apple notarization alert (notarization-alert.mjs).
//
// A tick checks every run attempt that finished in the lookback and that no
// successful reporter run saw as its run's finished latest attempt. A failed,
// cancelled or skipped tick is therefore made up by the next successful one,
// and a rerun that replaced an attempt between two ticks still has the
// replaced attempt checked. Both reports mark the run and attempt they cover,
// so checking an attempt twice never repeats an issue or comment.

export const REPORTER_WORKFLOW = 'workflow-reports.yml';
// Runs created this long before a tick are listed: the longest runs and late reruns finish inside it.
export const LOOKBACK_MS = 7 * 24 * 3600e3;
// A reporter run lists runs within this long of its start; a rerun started later did not hide its predecessor.
export const LISTING_MARGIN_MS = 15 * 60e3;
// Without any successful reporter run (the first tick), runs that finished this long ago count as seen.
export const FIRST_TICK_MS = 24 * 3600e3;

const FAILED = new Set(['failure', 'timed_out']);
// Scripts and workflows that notarize with the Apple Developer account. node-cli-portable.yml is reusable:
// its jobs run inside the workflows that call it.
const NOTARIZES = /notar|APPLE_ID|uses: \.\/\.github\/workflows\/node-cli-portable\.yml/i;
// A reusable workflow never has runs of its own (test/workflow-reports.test.mjs compares this with a YAML parse).
const REUSABLE = /^ {2}workflow_call:/m;

const time = value => Date.parse(value);

// The workflow files whose runs notarize macOS packages, as run `path`s (".github/workflows/x.yml").
export async function notarizingWorkflowPaths(directory) {
  const paths = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!file.endsWith('.yml') || file === REPORTER_WORKFLOW) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    if (NOTARIZES.test(source) && !REUSABLE.test(source)) paths.push(`.github/workflows/${file}`);
  }
  return paths;
}

// The start times of the successful reporter runs. Before the first one, the
// tick checks the last day only (dispatch the workflow once after merging it).
export function reporterStarts(reporterRuns, { now }) {
  const starts = reporterRuns
    .filter(run => run.status === 'completed' && run.conclusion === 'success')
    .map(run => time(run.run_started_at))
    .filter(Number.isFinite);
  return starts.length ? starts : [now.getTime() - FIRST_TICK_MS];
}

// Whether a successful reporter run listed this attempt as finished and still latest:
// it started after the attempt finished, and the next attempt (if any) started after its listing.
// An attempt replaced before the oldest counted tick is history the ticks do not cover (the
// workflow_run reporters did, or the replay's --since says so): it counts as seen.
export function wasSeen(attempt, nextStartedAt, reporterStarts) {
  const finished = time(attempt.updated_at);
  const replaced = nextStartedAt === undefined ? Infinity : time(nextStartedAt);
  if (replaced < Math.min(...reporterStarts)) return true;
  return reporterStarts.some(start => start >= finished && start + LISTING_MARGIN_MS <= replaced);
}

// Every finished attempt of `runs` that finished before `until` and that no counted reporter run saw.
// Earlier attempts come from the attempts endpoint and are read only for rerun runs.
export async function unseenAttempts(runs, { client, reporterStarts, until, earliest }) {
  const attempts = [];
  for (const run of runs) {
    let next;
    let attempt = run;
    for (;;) {
      const finished = attempt.status === 'completed' && time(attempt.updated_at) < until.getTime();
      if (finished && !wasSeen(attempt, next?.run_started_at, reporterStarts)) attempts.push(attempt);
      const number = Number(attempt.run_attempt ?? 1);
      if (number <= 1 || time(attempt.run_started_at) < earliest.getTime()) break;
      next = attempt;
      attempt = await client.request(`/actions/runs/${run.id}/attempts/${number - 1}`);
    }
  }
  return attempts.sort((a, b) => time(a.updated_at) - time(b.updated_at) || a.id - b.id || a.run_attempt - b.run_attempt);
}

export function isScheduledReport(run, { repository, defaultBranch }) {
  return run.event === 'schedule' && run.head_branch === defaultBranch && run.head_repository?.full_name === repository;
}

export function isNotarizationCandidate(run, { repository, notarizing }) {
  return FAILED.has(run.conclusion) && run.event !== 'pull_request' && run.head_repository?.full_name === repository && notarizing.includes(run.path);
}

// The run listings a tick needs: every scheduled run on the default branch, and every failed run
// (pull requests are dropped afterwards; the API cannot exclude an event).
export function runFilters(defaultBranch) {
  return [{ event: 'schedule', branch: defaultBranch }, { status: 'failure' }, { status: 'timed_out' }];
}

// Reports each unseen attempt, oldest first, one at a time so that reports on one issue never race.
// A report that throws is recorded and the others still run; the caller fails the tick, so the next
// successful tick checks the attempt again.
export async function reportWorkflowRuns({ attempts, repository, defaultBranch, notarizing, client, dryRun = false }) {
  const results = [];
  for (const run of attempts) {
    const reports = [];
    if (isScheduledReport(run, { repository, defaultBranch })) reports.push(['scheduled', () => reportNightlyFailure({ run, repository, defaultBranch, client, dryRun })]);
    if (isNotarizationCandidate(run, { repository, notarizing })) reports.push(['notarization', () => alertNotarization({ run, repository, client, notarizing, dryRun })]);
    for (const [kind, report] of reports) {
      const entry = { kind, run: run.id, attempt: run.run_attempt ?? 1, workflow: run.name, conclusion: run.conclusion };
      try {
        results.push({ ...entry, result: await report() });
      } catch (error) {
        results.push({ ...entry, error: error.message });
      }
    }
  }
  return results;
}
