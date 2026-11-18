#!/usr/bin/env node
// Decides which projected sites a deploy publishes (scripts/lib/site-deploy.mjs).
// Run after `pnpm build` and the build's checks of the projected sites: it
// digests each dist-sites/<site>, reads the digest record its host serves,
// writes this build's record into the site, and writes the decision to
// GITHUB_OUTPUT and a table of every site to the job summary.
//
//   node scripts/plan-site-deploy.mjs [--deploy-all] [--sites-dir dist-sites]
//
// --deploy-all publishes every site (a dispatched run). Each read of a live
// record has a 30 s deadline, so the outputs are always written.
import { randomUUID } from 'node:crypto';
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
  nonce: randomUUID(),
  fetch: globalThis.fetch,
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
