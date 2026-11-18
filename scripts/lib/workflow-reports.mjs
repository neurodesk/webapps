import { readdir, readFile } from 'node:fs/promises';
import { reportNightlyFailure } from './nightly-failures.mjs';
import { alertNotarization } from './notarization-alert.mjs';

// One scheduled reporter for every finished workflow run attempt: a failed or
// incomplete scheduled attempt on the default branch gets a workflow issue
// (nightly-failures.mjs), and a failed non-pull-request attempt of a workflow
// that notarizes gets the Apple notarization alert (notarization-alert.mjs).
//
// A tick keeps no cursor. It lists the candidate runs created in the lookback,
// checks every attempt of each (earlier attempts only for rerun runs), and
// reports each attempt that has no report marker yet. The markers in the
// issues are the only state, so a failed, overlapping or late tick and a rerun
// lose nothing, and a repeated tick writes nothing.

export const REPORTER_WORKFLOW = 'workflow-reports.yml';
// Runs created this long before a tick are checked. Reruns in the 30 days to 18 Nov 2026 came at
// most 43 hours after their run; a longer lookback re-reads the logs of every failed macOS job
// in it on each tick (docs/development/ci-audit.md has the cost).
export const LOOKBACK_MS = 14 * 24 * 3600e3;
// The workflow_run reporters this one replaced reported every attempt that completed before
// this instant, with the same markers. It must precede the merge of workflow-reports.yml.
export const CUTOVER = '2026-11-18T13:00:00Z';

const FAILED = new Set(['failure', 'timed_out']);
// A run with one of these conclusions has no failed or cancelled job unless a job continues on error.
const QUIET = new Set(['success', 'skipped', 'neutral']);
// Scripts and workflows that notarize with the Apple Developer account. node-cli-portable.yml is reusable:
// its jobs run inside the workflows that call it.
const NOTARIZES = /notar|APPLE_ID|uses: \.\/\.github\/workflows\/node-cli-portable\.yml/i;
// A reusable workflow never has runs of its own (test/workflow-reports.test.mjs compares these with a YAML parse).
const REUSABLE = /^ {2}workflow_call:/m;
const JOB_CONTINUES_ON_ERROR = /^ {4}continue-on-error:/m;
const ATTEMPT_MARKER = /<!-- (?:nightly|notarization)-run:\d+:attempt:\d+ -->/g;
const REPORT_ISSUE = /^<!-- (?:nightly-workflow:\d+|apple-notarization-alert) -->/;
// The runs API answers at most this many runs per query.
const LISTING_LIMIT = 1000;

const time = value => Date.parse(value);
const stamp = value => new Date(value).toISOString().replace(/\.\d+Z$/, 'Z');

// What the reports need from the workflow files: the run paths (".github/workflows/x.yml") that
// notarize, the events those run on, and the paths with a job that continues on error.
export async function workflowFacts(directory) {
  const facts = { notarizing: [], notarizingEvents: new Set(), continuesOnError: [] };
  for (const file of (await readdir(directory)).sort()) {
    if (!file.endsWith('.yml') || file === REPORTER_WORKFLOW) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    if (REUSABLE.test(source)) continue;
    const path = `.github/workflows/${file}`;
    if (JOB_CONTINUES_ON_ERROR.test(source)) facts.continuesOnError.push(path);
    if (!NOTARIZES.test(source)) continue;
    facts.notarizing.push(path);
    const on = source.match(/^on:\n((?: {2}.*\n|\s*\n)*)/m)?.[1] ?? '';
    for (const [, event] of on.matchAll(/^ {2}([a-z_]+):/gm)) facts.notarizingEvents.add(event);
  }
  facts.notarizingEvents = [...facts.notarizingEvents].sort();
  return facts;
}

// The run listings a tick needs: scheduled runs on the default branch, and every event other
// than pull_request that a notarizing workflow runs on (a schedule is on the default branch).
export function runFilters(defaultBranch, notarizingEvents) {
  const events = notarizingEvents.filter(event => !['pull_request', 'schedule'].includes(event));
  return [{ event: 'schedule', branch: defaultBranch }, ...events.map(event => ({ event }))];
}

// Every run matching `filter` created in [from, to] (epoch ms), splitting a range the API would truncate.
export async function listCreated(client, filter, from, to) {
  const query = page => `/actions/runs?${new URLSearchParams({ ...filter, created: `${stamp(from)}..${stamp(to)}`, per_page: '100', page: String(page) })}`;
  const first = await client.request(query(1));
  if (first.total_count > LISTING_LIMIT && to - from >= 2000) {
    const middle = from + Math.floor((to - from) / 2000) * 1000;
    return [...await listCreated(client, filter, from, middle), ...await listCreated(client, filter, middle + 1000, to)];
  }
  const runs = [...first.workflow_runs];
  for (let page = 2; runs.length < Math.min(first.total_count, LISTING_LIMIT) && page <= LISTING_LIMIT / 100; page++) {
    const { workflow_runs: more } = await client.request(query(page));
    if (!more.length) break;
    runs.push(...more);
  }
  return runs;
}

export function isScheduledReport(run, { repository, defaultBranch }) {
  return run.event === 'schedule' && run.head_branch === defaultBranch && run.head_repository?.full_name === repository;
}

export function isNotarizationCandidate(run, { repository, notarizing }) {
  return run.event !== 'pull_request' && run.head_repository?.full_name === repository && notarizing.includes(run.path);
}

// Every attempt of each run, the latest as listed and the earlier ones from the attempts endpoint.
export async function attemptsOf(runs, client) {
  const attempts = [];
  for (const run of runs) {
    attempts.push(run);
    for (let number = Number(run.run_attempt ?? 1) - 1; number >= 1; number--) {
      attempts.push(await client.request(`/actions/runs/${run.id}/attempts/${number}`));
    }
  }
  return attempts;
}

// The reports an attempt that completed at or after `cutover` may need, by what the run listing
// says. An attempt whose run passed is read only when its workflow has a job that continues on error.
export function reportsFor(attempt, { repository, defaultBranch, notarizing, continuesOnError, cutover = CUTOVER }) {
  if (attempt.status !== 'completed' || !(time(attempt.updated_at) >= time(cutover))) return [];
  const kinds = [];
  if (isScheduledReport(attempt, { repository, defaultBranch }) && (!QUIET.has(attempt.conclusion) || continuesOnError.includes(attempt.path))) kinds.push('scheduled');
  if (FAILED.has(attempt.conclusion) && isNotarizationCandidate(attempt, { repository, notarizing })) kinds.push('notarization');
  return kinds;
}

// The attempt markers already reported in the report issues updated since `since`. A marker in a
// comment on an issue closed before that comment is left out: the report reopens the issue after
// commenting, so the report runs again to finish (or to see that a person closed it since).
export async function reportedMarkers(client, since) {
  const markers = new Set();
  const issues = await client.list(`/issues?state=all&creator=github-actions%5Bbot%5D&since=${stamp(since)}&sort=updated&direction=desc`);
  for (const issue of issues) {
    if (issue.pull_request || issue.user?.login !== 'github-actions[bot]' || !REPORT_ISSUE.test(issue.body ?? '')) continue;
    for (const [marker] of issue.body.matchAll(ATTEMPT_MARKER)) markers.add(marker);
    for (const comment of await client.list(`/issues/${issue.number}/comments?since=${stamp(since)}`)) {
      if (comment.user?.login !== 'github-actions[bot]') continue;
      const marker = comment.body?.match(/^<!-- (?:nightly|notarization)-run:\d+:attempt:\d+ -->/)?.[0];
      const unfinished = issue.state === 'closed' && !(time(issue.closed_at) >= time(comment.created_at));
      if (marker && !unfinished) markers.add(marker);
    }
  }
  return markers;
}

const markerOf = (kind, attempt) => `<!-- ${kind === 'scheduled' ? 'nightly' : 'notarization'}-run:${attempt.id}:attempt:${attempt.run_attempt ?? 1} -->`;

// Reports each attempt, oldest first, one at a time so that reports on one issue never race, and
// lists the attempts whose marker `reported` already holds.
// A report that throws is recorded and the others still run; the caller fails the tick, and
// the next tick checks the attempt again because it still has no marker.
export async function reportWorkflowRuns({ attempts, repository, defaultBranch, notarizing, continuesOnError = [], cutover = CUTOVER, reported = new Set(), client, dryRun = false }) {
  const results = [];
  const marked = [];
  const ordered = [...attempts].sort((a, b) => time(a.updated_at) - time(b.updated_at) || a.id - b.id || a.run_attempt - b.run_attempt);
  for (const run of ordered) {
    for (const kind of reportsFor(run, { repository, defaultBranch, notarizing, continuesOnError, cutover })) {
      if (reported.has(markerOf(kind, run))) {
        marked.push(`${kind} ${run.id}:${run.run_attempt ?? 1}`);
        continue;
      }
      const entry = { kind, run: run.id, attempt: run.run_attempt ?? 1, workflow: run.name, conclusion: run.conclusion };
      try {
        const result = kind === 'scheduled'
          ? await reportNightlyFailure({ run, repository, defaultBranch, client, dryRun })
          : await alertNotarization({ run, repository, client, notarizing, dryRun });
        results.push({ ...entry, result });
      } catch (error) {
        results.push({ ...entry, error: error.message });
      }
    }
  }
  return { results, marked };
}

// One tick: list the candidate runs created in the lookback before `until`, read their attempts,
// and report each that completed in [cutover, until) and has no marker. A replay passes an earlier cutover.
export async function runTick({ client, repository, defaultBranch, workflows, until, cutover = CUTOVER, dryRun = false }) {
  const facts = await workflowFacts(workflows);
  const earliest = until.getTime() - LOOKBACK_MS;
  const listed = new Map();
  for (const filter of runFilters(defaultBranch, facts.notarizingEvents)) {
    for (const run of await listCreated(client, filter, earliest, until.getTime() - 1000)) listed.set(run.id, run);
  }
  const candidates = [...listed.values()].filter(run => isScheduledReport(run, { repository, defaultBranch }) || isNotarizationCandidate(run, { repository, notarizing: facts.notarizing }));
  const attempts = (await attemptsOf(candidates, client)).filter(attempt => time(attempt.updated_at) < until.getTime());
  const reported = await reportedMarkers(client, new Date(Math.max(earliest, time(cutover))));
  const { results, marked } = await reportWorkflowRuns({ attempts, repository, defaultBranch, notarizing: facts.notarizing, continuesOnError: facts.continuesOnError, cutover, reported, client, dryRun });
  const completed = attempts.filter(attempt => attempt.status === 'completed' && time(attempt.updated_at) >= time(cutover));
  return {
    listed: listed.size, candidates: candidates.length, attempts: attempts.length, earliest: new Date(earliest), results, marked,
    scheduled: completed.filter(attempt => isScheduledReport(attempt, { repository, defaultBranch })).length,
    notarization: completed.filter(attempt => FAILED.has(attempt.conclusion) && isNotarizationCandidate(attempt, { repository, notarizing: facts.notarizing })).length,
  };
}
