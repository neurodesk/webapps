#!/usr/bin/env node
// Decides which projected sites a deploy publishes and checks (scripts/lib/site-deploy.mjs).
// Run after `pnpm build`: it digests each dist-sites/<site>, reads the digest
// record its host serves, looks up the site's verified marker in the Actions
// cache, writes this build's record into the site, and writes the decision to
// GITHUB_OUTPUT and a table of every site to the job summary.
//
//   node scripts/plan-site-deploy.mjs [--deploy-all] [--verify-all] [--sites-dir dist-sites]
//
// --deploy-all publishes every site (a dispatched run). --verify-all checks every
// live site (the daily run). A site is skipped only when its host serves this
// build's digest and the marker for that site, digest and check hash exists in
// the cache of GITHUB_REF (read with GITHUB_TOKEN and GITHUB_REPOSITORY). Every
// read has a deadline, so the outputs are always written.
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { SITES_DIR } from './lib/catalog-sites.mjs';
import { planSiteDeploy } from './lib/site-deploy.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const { outputs, summary } = await planSiteDeploy({
  registry: await loadAppsRegistry(),
  sitesDir: option('--sites-dir') ?? join(repoRoot, SITES_DIR),
  root: repoRoot,
  env: process.env,
  deployAll: process.argv.includes('--deploy-all'),
  verifyAll: process.argv.includes('--verify-all'),
  write: writeFile,
});
console.log(summary);
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
