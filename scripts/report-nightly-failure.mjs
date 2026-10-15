import { readFile, appendFile } from 'node:fs/promises';
import { createGitHubClient, reportNightlyFailure } from './lib/nightly-failures.mjs';

try {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const client = createGitHubClient({ token, repository });
  const args = process.argv.slice(2);
  const dryRun = args.length > 0;
  let run;
  let defaultBranch;
  if (dryRun) {
    if (args.length !== 3 || args[0] !== '--run-id' || !/^\d+$/.test(args[1]) || args[2] !== '--dry-run') {
      throw new Error('Usage: report-nightly-failure.mjs --run-id <numeric> --dry-run');
    }
    run = await client.request(`/actions/runs/${args[1]}`);
    defaultBranch = process.env.DEFAULT_BRANCH || (await client.request('')).default_branch;
  } else {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    run = event.workflow_run;
    defaultBranch = event.repository.default_branch;
  }
  const result = await reportNightlyFailure({
    run,
    repository,
    defaultBranch,
    client,
    dryRun,
  });
  if (dryRun && result.body) console.log(`${result.title}\n\n${result.body}`);
  const summary = `Scheduled workflow reporter: ${JSON.stringify(result.body ? { dryRun: true, title: result.title } : result)}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
} catch (error) {
  console.error(`Nightly failure reporter failed: ${error.message}`);
  process.exitCode = 1;
}
