import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

// The ci.yml jobs the CI policy in AGENTS.md needs: the plan, the contract and
// package tests, the per-app jobs, the composite site and the jobs that consume
// it, and the homepage easter egg. The app-plan job runs this file (`pnpm
// check:integration`) before any other job starts, so a change that deletes
// one of them fails its own run, even when the deleted job is the one that
// would have run the contract tests.
const REQUIRED_JOBS = ['app-plan', 'workspace-contracts', 'app-tests', 'browser-e2e', 'browser-e2e-gpu', 'composite-site', 'example-cache-retention', 'agent-interactions', 'homepage-easter-egg'];

function missingJobs(ci) {
  return REQUIRED_JOBS.filter((id) => !Array.isArray(ci?.jobs?.[id]?.steps) || ci.jobs[id].steps.length === 0);
}

test('ci.yml keeps every job the CI policy needs', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(missingJobs(ci), [], 'ci.yml lost a job the CI policy needs; restore it or change the policy in AGENTS.md and here');
  const withoutContracts = structuredClone(ci);
  delete withoutContracts.jobs['workspace-contracts'];
  assert.deepEqual(missingJobs(withoutContracts), ['workspace-contracts']);
  // The check runs in app-plan, before the plan and every job that needs it.
  const integration = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts['check:integration'];
  assert.match(integration, /(?:^| )test\/ci-required-jobs\.test\.mjs(?: |$)/);
  const steps = ci.jobs['app-plan'].steps;
  const check = steps.findIndex((step) => step.run === 'pnpm check:integration');
  assert.ok(check >= 0 && steps[check].if === undefined, 'app-plan runs pnpm check:integration on every run');
  assert.ok(check < steps.findIndex((step) => step.id === 'plan'), 'before it writes the plan');
});
