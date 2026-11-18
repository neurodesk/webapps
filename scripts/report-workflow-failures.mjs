import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createGitHubClient } from './lib/nightly-failures.mjs';
import { CUTOVER, runTick } from './lib/workflow-reports.mjs';

// Scheduled reports of failed workflow run attempts (scripts/lib/workflow-reports.mjs).
//   node scripts/report-workflow-failures.mjs                 report every attempt without a marker
//   node scripts/report-workflow-failures.mjs --dry-run [--since <ISO>] [--until <ISO>]
// --since replaces the cutover (attempts that completed before it are not reported), --until
// ignores attempts that completed at or after it, and --dry-run reads issues but never writes,
// not even the step summary.
const USAGE = 'Usage: report-workflow-failures.mjs [--dry-run] [--since <ISO time>] [--until <ISO time>]';

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
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const dryRun = values['dry-run'];
  // Every HTTP request, a log download's redirect included.
  let requests = 0;
  const api = createGitHubClient({ token, repository, fetchImpl: (...args) => { requests++; return fetch(...args); } });
  const client = dryRun ? readOnly(api) : api;
  const defaultBranch = process.env.DEFAULT_BRANCH || (await client.request('')).default_branch;
  const until = values.until ? instant(values.until, 'until') : new Date();
  const cutover = values.since ? instant(values.since, 'since').toISOString() : CUTOVER;
  const tick = await runTick({ client, repository, defaultBranch, workflows: new URL('../.github/workflows/', import.meta.url), until, cutover, dryRun });
  const lines = [
    `Workflow failure reports${dryRun ? ' (dry run)' : ''}: ${tick.listed} runs listed, ${tick.candidates} candidate runs, ${tick.attempts} attempts, ${tick.results.length} reports checked, ${requests} HTTP requests.`,
    `Runs created from ${tick.earliest.toISOString()} to ${until.toISOString()}; from ${cutover}, ${tick.scheduled} scheduled attempts and ${tick.notarization} failed notarizing attempts completed.`,
  ];
  if (tick.marked.length) lines.push(`Already reported: ${tick.marked.join(', ')}.`);
  for (const { result, ...entry } of tick.results) {
    const { body, report, ...shown } = result ?? {};
    lines.push(JSON.stringify({ ...entry, ...(result && { result: shown }) }));
    if (result?.incomplete) console.log(`::warning title=Notarization alert::Logs of ${result.incomplete.join(', ')} in run ${entry.run} were longer than the alert reads; check them for a notarization failure.`);
  }
  const summary = `${lines.join('\n')}\n`;
  console.log(summary);
  if (!dryRun && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${summary}\`\`\`\n`);
  const failed = tick.results.filter(entry => entry.error);
  if (failed.length) throw new Error(`${failed.length} reports failed; the next tick checks their attempts again`);
} catch (error) {
  console.error(`Workflow failure reporter failed: ${error.message}`);
  process.exitCode = 1;
}
