import { appendFile, readFile } from 'node:fs/promises';
import { createGitHubClient } from './lib/nightly-failures.mjs';
import { alertNotarization } from './lib/notarization-alert.mjs';

try {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
  const repository = process.env.GITHUB_REPOSITORY;
  const client = createGitHubClient({ token, repository });
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await alertNotarization({ run: event.workflow_run, repository, client });
  const summary = `Notarization alert: ${JSON.stringify(result)}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
} catch (error) {
  console.error(`Notarization alert failed: ${error.message}`);
  process.exitCode = 1;
}
