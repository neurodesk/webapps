import { readdir, readFile } from 'node:fs/promises';
import { reportNightlyFailure } from './nightly-failures.mjs';
import { alertNotarization } from './notarization-alert.mjs';

// One scheduled reporter for every finished workflow run attempt: a failed or
// incomplete scheduled attempt on the default branch gets a workflow issue
// (nightly-failures.mjs), and a failed non-pull-request attempt of a workflow
// that notarizes gets the Apple notarization alert (notarization-alert.mjs).
//
// A tick keeps no cursor. It lists the candidate runs created in the lookback
// (scheduled runs on the default branch and every run of each notarizing
// workflow), checks every attempt of each (earlier attempts only for rerun runs), and
// reports each attempt that has no report marker yet. The markers in the
// issues are the only state, so a failed, overlapping or late tick and a rerun
// lose nothing, and a repeated tick writes nothing.

export const REPORTER_WORKFLOW = 'workflow-reports.yml';
// Runs created this long before a tick are checked. Reruns in the 30 days to 18 Nov 2026 came at
// most 43 hours after their run; a longer lookback re-reads the logs of every failed macOS job
// in it on each tick (docs/development/ci-audit.md has the cost).
export const LOOKBACK_MS = 14 * 24 * 3600e3;
// Attempts that completed before this instant belong to the workflow_run reporters this one
// replaced (docs/development/ci-audit.md, "Handoff from the workflow_run reporters").
export const CUTOVER = '2026-11-15T05:40:00Z';

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
const SECOND = 1000;

const time = value => Date.parse(value);
const stamp = value => new Date(value).toISOString().replace(/\.\d+Z$/, 'Z');

// The workflow a run record belongs to. The API can qualify a run's path with the ref it ran
// from (".github/workflows/x.yml@v1"); every comparison uses the path without it.
export const workflowPath = path => path.replace(/@.*$/, '');
const runRecord = run => ({ ...run, path: workflowPath(run.path) });

// What the reports need from the workflow files: the run paths (".github/workflows/x.yml") that
// notarize and the paths with a job that continues on error.
export async function workflowFacts(directory) {
  const facts = { notarizing: [], continuesOnError: [] };
  for (const file of (await readdir(directory)).sort()) {
    if (!/\.ya?ml$/.test(file) || file === REPORTER_WORKFLOW) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    if (REUSABLE.test(source)) continue;
    const path = `.github/workflows/${file}`;
    if (JOB_CONTINUES_ON_ERROR.test(source)) facts.continuesOnError.push(path);
    if (NOTARIZES.test(source)) facts.notarizing.push(path);
  }
  return facts;
}

// Every run of `listing` created in [from, to] (epoch ms, whole seconds as the API compares them),
// splitting a range the API would truncate. `listing` is { workflow } for every run of one workflow
// file, or a filter of the repository's runs such as { event, branch }.
export async function listCreated(client, { workflow, ...filter }, from, to) {
  const start = Math.floor(from / SECOND) * SECOND;
  const end = Math.floor(to / SECOND) * SECOND;
  const base = workflow ? `/actions/workflows/${encodeURIComponent(workflow)}/runs` : '/actions/runs';
  const query = page => `${base}?${new URLSearchParams({ ...filter, created: `${stamp(start)}..${stamp(end)}`, per_page: '100', page: String(page) })}`;
  const first = await client.request(query(1));
  if (first.total_count > LISTING_LIMIT) {
    if (end === start) throw new Error(`More than ${LISTING_LIMIT} runs of ${base} ${JSON.stringify(filter)} were created at ${stamp(start)}; the API lists only ${LISTING_LIMIT}`);
    const middle = start + Math.floor((end - start) / 2 / SECOND) * SECOND;
    return [...await listCreated(client, { workflow, ...filter }, start, middle), ...await listCreated(client, { workflow, ...filter }, middle + SECOND, end)];
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

// Any run of a notarizing workflow but a pull request's, whatever its event.
const notarizingRun = (run, repository) => run.event !== 'pull_request' && run.head_repository?.full_name === repository;

// `notarizingRuns` holds the ids of the runs a notarizing workflow's listing returned, whatever path they carry.
export function isNotarizationCandidate(run, { repository, notarizingRuns }) {
  return notarizingRun(run, repository) && notarizingRuns.has(run.id);
}

// When an attempt completed: its updated_at, in the run listing and in the attempts endpoint alike.
export const completedAt = attempt => time(attempt.updated_at);

// Every attempt of each run as a run record, the latest as listed and the earlier ones from the
// attempts endpoint.
export async function attemptsOf(runs, client) {
  const attempts = [];
  for (const run of runs) {
    attempts.push(runRecord(run));
    for (let number = Number(run.run_attempt ?? 1) - 1; number >= 1; number--) {
      attempts.push(runRecord(await client.request(`/actions/runs/${run.id}/attempts/${number}`)));
    }
  }
  return attempts;
}

// The reports an attempt that completed at or after `cutover` may need, by what the run listing
// says. An attempt whose run passed is read only when its workflow has a job that continues on error.
export function reportsFor(attempt, { repository, defaultBranch, notarizingRuns, continuesOnError, cutover = CUTOVER }) {
  if (attempt.status !== 'completed' || !(completedAt(attempt) >= time(cutover))) return [];
  const kinds = [];
  if (isScheduledReport(attempt, { repository, defaultBranch }) && (!QUIET.has(attempt.conclusion) || continuesOnError.includes(attempt.path))) kinds.push('scheduled');
  if (FAILED.has(attempt.conclusion) && isNotarizationCandidate(attempt, { repository, notarizingRuns })) kinds.push('notarization');
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
export async function reportWorkflowRuns({ attempts, repository, defaultBranch, notarizingRuns = new Set(), continuesOnError = [], cutover = CUTOVER, reported = new Set(), client, dryRun = false }) {
  const results = [];
  const marked = [];
  const ordered = [...attempts].sort((a, b) => completedAt(a) - completedAt(b) || a.id - b.id || a.run_attempt - b.run_attempt);
  for (const run of ordered) {
    for (const kind of reportsFor(run, { repository, defaultBranch, notarizingRuns, continuesOnError, cutover })) {
      if (reported.has(markerOf(kind, run))) {
        marked.push(`${kind} ${run.id}:${run.run_attempt ?? 1}`);
        continue;
      }
      const entry = { kind, run: run.id, attempt: run.run_attempt ?? 1, workflow: run.name, conclusion: run.conclusion };
      try {
        const result = kind === 'scheduled'
          ? await reportNightlyFailure({ run, repository, defaultBranch, client, dryRun })
          : await alertNotarization({ run, repository, client, dryRun });
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
  const last = until.getTime() - SECOND;
  const listed = new Map();
  const candidates = new Map();
  const notarizingRuns = new Set();
  for (const run of await listCreated(client, { event: 'schedule', branch: defaultBranch }, earliest, last)) {
    listed.set(run.id, run);
    if (isScheduledReport(run, { repository, defaultBranch })) candidates.set(run.id, run);
  }
  for (const path of facts.notarizing) {
    for (const run of await listCreated(client, { workflow: path.split('/').pop() }, earliest, last)) {
      listed.set(run.id, run);
      if (!notarizingRun(run, repository)) continue;
      candidates.set(run.id, run);
      notarizingRuns.add(run.id);
    }
  }
  const attempts = (await attemptsOf(candidates.values(), client)).filter(attempt => completedAt(attempt) < until.getTime());
  const reported = await reportedMarkers(client, new Date(Math.max(earliest, time(cutover))));
  const { results, marked } = await reportWorkflowRuns({ attempts, repository, defaultBranch, notarizingRuns, continuesOnError: facts.continuesOnError, cutover, reported, client, dryRun });
  const completed = attempts.filter(attempt => attempt.status === 'completed' && completedAt(attempt) >= time(cutover));
  return {
    listed: listed.size, candidates: candidates.size, attempts: attempts.length, earliest: new Date(earliest), results, marked,
    scheduled: completed.filter(attempt => isScheduledReport(attempt, { repository, defaultBranch })).length,
    notarization: completed.filter(attempt => FAILED.has(attempt.conclusion) && isNotarizationCandidate(attempt, { repository, notarizingRuns })).length,
  };
}
