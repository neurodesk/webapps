#!/usr/bin/env node
// Decides which projected sites a deploy publishes and checks (scripts/lib/site-deploy.mjs).
// Run after `pnpm build`: it reads this workflow's earlier runs on main, digests
// each dist-sites/<site>, reads the digest record its host serves, writes this
// build's record into the site, and writes the decision to GITHUB_OUTPUT and a
// table of every site to the job summary.
//
//   node scripts/plan-site-deploy.mjs [--deploy-all] [--verify-all] [--sites-dir dist-sites]
//
// --deploy-all publishes every site (a dispatched run). --verify-all checks every
// live site (the daily run). A site whose live record cannot be read is published;
// every site is published when the previous deploy run was not green or the run
// history (GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_RUN_ID)
// cannot be read.
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { SITES_DIR } from './lib/catalog-sites.mjs';
import { deployOutputs, deploySummary, forcedReason, planDeploy, readDeployHistory } from './lib/site-deploy.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const history = await readDeployHistory({
  repository: process.env.GITHUB_REPOSITORY,
  workflowRef: process.env.GITHUB_WORKFLOW_REF,
  runId: process.env.GITHUB_RUN_ID,
  token: process.env.GITHUB_TOKEN,
});
const planned = await planDeploy({
  registry: await loadAppsRegistry(),
  sitesDir: option('--sites-dir') ?? join(repoRoot, SITES_DIR),
  commit: process.env.GITHUB_SHA ?? null,
  deployAll: process.argv.includes('--deploy-all'),
  verifyAll: process.argv.includes('--verify-all'),
  history,
  nonce: `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? Date.now()}`,
  write: writeFile,
});
const outputs = deployOutputs(planned);
const forced = forcedReason(history);
const summary = `${forced ? `Every site is published: ${forced}.\n\n` : ''}${deploySummary(planned)}`;
console.log(summary);
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
