#!/usr/bin/env node
// Decides which projected sites a deploy publishes (scripts/lib/site-deploy.mjs).
// Run after `pnpm build`: it digests each dist-sites/<site>, reads the digest
// record its host serves, writes this build's record into the site, and writes
// the decision to GITHUB_OUTPUT and a table of every site to the job summary.
//
//   node scripts/plan-site-deploy.mjs [--deploy-all] [--sites-dir dist-sites]
//
// --deploy-all publishes every site (a manual run). A site whose live record
// cannot be read is published.
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { SITES_DIR } from './lib/catalog-sites.mjs';
import { deployOutputs, deploySummary, planDeploy } from './lib/site-deploy.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const planned = await planDeploy({
  registry: await loadAppsRegistry(),
  sitesDir: option('--sites-dir') ?? join(repoRoot, SITES_DIR),
  commit: process.env.GITHUB_SHA ?? null,
  deployAll: process.argv.includes('--deploy-all'),
  nonce: `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? Date.now()}`,
  write: writeFile,
});
const outputs = deployOutputs(planned);
const summary = deploySummary(planned);
console.log(summary);
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
