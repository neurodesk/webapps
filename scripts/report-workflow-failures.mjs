import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { listAllRuns, listRuns, mapLimited } from './lib/github-actions.mjs';
import { createGitHubClient } from './lib/nightly-failures.mjs';
import {
  LOOKBACK_MS, REPORTER_WORKFLOW, notarizingWorkflowPaths, reportWorkflowRuns, reporterStarts, runFilters, unseenAttempts,
} from './lib/workflow-reports.mjs';

// Scheduled reports of failed workflow runs (scripts/lib/workflow-reports.mjs).
//   node scripts/report-workflow-failures.mjs                 report what no successful tick has seen
//   node scripts/report-workflow-failures.mjs --dry-run --since <ISO> [--until <ISO>]
// --since counts runs that finished before it as seen instead of reading this workflow's history,
// --until ignores runs that finished at or after it, and --dry-run reads issues but never writes.
const USAGE = 'Usage: report-workflow-failures.mjs [--dry-run] [--since <ISO time> [--until <ISO time>]]';
const RUN_FIELDS = '{id, name, path, workflow_id, run_attempt, event, status, conclusion, head_branch, head_sha, created_at, run_started_at, updated_at, head_repository: {full_name: .head_repository.full_name}}';

function instant(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--${name} must be an ISO time. ${USAGE}`);
  return date;
}

// A dry run must not write even if a report forgets its dryRun flag.
function readOnly(client) {
  return {
    list: client.list,
    request: (path, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') throw new Error(`Dry run refused ${options.method} ${path}`);
      return client.request(path, options);
    },
  };
}

try {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, since: { type: 'string' }, until: { type: 'string' } } });
  if (values.until && !values.since) throw new Error(USAGE);
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const dryRun = values['dry-run'];
  const api = createGitHubClient({ token, repository });
  const client = dryRun ? readOnly(api) : api;
  const defaultBranch = process.env.DEFAULT_BRANCH || (await client.request('')).default_branch;
  const until = values.until ? instant(values.until, 'until') : new Date();
  const earliest = new Date(until.getTime() - LOOKBACK_MS);
  const starts = values.since
    ? [instant(values.since, 'since').getTime()]
    : reporterStarts(await listRuns({ workflow: REPORTER_WORKFLOW, since: earliest.toISOString().slice(0, 10), branch: defaultBranch, status: 'success' }), { now: until });
  const listings = await mapLimited(runFilters(defaultBranch), 3, filter => listAllRuns({ since: earliest, until, windowHours: 24, filter, fields: RUN_FIELDS }));
  const runs = [...new Map(listings.flat().map(run => [run.id, run])).values()];
  const attempts = await unseenAttempts(runs, { client, reporterStarts: starts, until, earliest });
  const notarizing = await notarizingWorkflowPaths(new URL('../.github/workflows/', import.meta.url));
  const results = await reportWorkflowRuns({ attempts, repository, defaultBranch, notarizing, client, dryRun });
  const lines = [
    `Workflow failure reports${dryRun ? ' (dry run)' : ''}: ${runs.length} runs listed, ${attempts.length} unseen attempts, ${results.length} reports checked.`,
    `Seen up to ${new Date(Math.max(...starts)).toISOString()}; lookback from ${earliest.toISOString()} to ${until.toISOString()}.`,
  ];
  for (const { result, ...entry } of results) {
    const { body, report, ...shown } = result ?? {};
    lines.push(JSON.stringify({ ...entry, ...(result && { result: shown }) }));
    if (result?.incomplete) console.log(`::warning title=Notarization alert::Logs of ${result.incomplete.join(', ')} in run ${entry.run} were longer than the alert reads; check them for a notarization failure.`);
  }
  const summary = `${lines.join('\n')}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${summary}\`\`\`\n`);
  const failed = results.filter(entry => entry.error);
  if (failed.length) throw new Error(`${failed.length} reports failed; the next tick checks their runs again`);
} catch (error) {
  console.error(`Workflow failure reporter failed: ${error.message}`);
  process.exitCode = 1;
}
