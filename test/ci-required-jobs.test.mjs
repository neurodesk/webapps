import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The ci.yml jobs the CI policy in AGENTS.md needs: the plan, the contract and
// package tests, the per-app jobs, the composite site and the agentic checks
// that consume it, and the homepage easter egg. example-cache-retention keeps
// a cache and may fail without failing the run, so it is not one of them.
//
// This file runs twice in every ci run: in app-plan (`pnpm check:integration`,
// before the plan) and in workspace-contracts (`pnpm test:contracts`, which
// runs every test file). Each copy checks both jobs and both steps, so a
// change that removes one guard, or the job around it, fails the other.
const REQUIRED_JOBS = ['app-plan', 'workspace-contracts', 'app-tests', 'browser-e2e', 'browser-e2e-gpu', 'composite-site', 'agent-interactions', 'homepage-easter-egg'];
const GUARDS = { 'app-plan': ['check:integration', 'pnpm check:integration'], 'workspace-contracts': ['test:contracts', 'pnpm test:contracts'] };
const GUARD_FILE = 'test/ci-required-jobs.test.mjs';
// When each required job runs. A change here can skip a check, so it changes this table too.
const JOB_CONDITIONS = {
  'app-plan': "github.event.action != 'converted_to_draft'",
  'workspace-contracts': "github.event.action != 'converted_to_draft' && inputs.scope != 'gpu' && inputs.scope != 'site'",
  'app-tests': "needs.app-plan.outputs.has_apps == 'true'",
  'browser-e2e': "needs.app-plan.outputs.has_browser_apps == 'true'",
  'browser-e2e-gpu': "needs.app-plan.outputs.has_gpu_apps == 'true' && (github.event_name != 'pull_request' || needs.app-plan.outputs.all_apps != 'true')",
  'composite-site': "(github.event_name != 'pull_request' || !github.event.pull_request.draft) && (github.event_name == 'push' || github.event_name == 'schedule' || needs.app-plan.outputs.has_site == 'true')",
  'agent-interactions': "needs.composite-site.outputs.agent_site_ready == 'true'",
  'homepage-easter-egg': "github.event.action != 'converted_to_draft' && inputs.scope != 'gpu' && needs.app-plan.outputs.easter_egg == 'true'",
};
// The run steps of required jobs that may be skipped, by job and step name, with their condition.
const STEP_CONDITIONS = {
  'workspace-contracts': { 'Check correctness on full CI runs': "${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}" },
  'app-tests': { 'Install pinned nightly toolchain': 'matrix.rust_wasm', 'Install Python reference dependencies': 'matrix.python_reference', 'Test qsmbly against its built WASM': "matrix.app == 'qsmbly'" },
  'browser-e2e': { 'Install Greedy WebAssembly toolchain': 'matrix.rust_wasm', 'Install Python reference dependencies': 'matrix.python_reference' },
  'browser-e2e-gpu': { 'Install Greedy WebAssembly toolchain': 'matrix.rust_wasm', 'Install Python reference dependencies': 'matrix.python_reference' },
  'composite-site': {
    'Package the built catalog for agent interactions': "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.agentic_mode == 'interactions')",
    'Run requested Neurodesk processing workflows': "github.event_name == 'workflow_dispatch' && inputs.agentic_mode == 'pipeline'",
  },
};

// What keeps the guard from holding: a missing or soft required job, a run step
// that can be skipped other than as listed, or a guard step that is missing,
// conditional, soft or no longer runs this file.
function guardProblems(ci, scripts, contractFiles) {
  const problems = [];
  for (const id of REQUIRED_JOBS) {
    const job = ci?.jobs?.[id];
    if (!Array.isArray(job?.steps) || job.steps.length === 0) {
      problems.push(`ci.yml has no ${id} job with steps`);
      continue;
    }
    if (job['continue-on-error'] !== undefined && job['continue-on-error'] !== false) problems.push(`${id} may fail without failing the run (continue-on-error)`);
    if (job.if !== JOB_CONDITIONS[id]) problems.push(`${id} runs when ${JSON.stringify(job.if)}, not as the policy says`);
    for (const step of job.steps) {
      if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false) problems.push(`a step of ${id} may fail without failing it (continue-on-error)`);
      if (step.run && step.if !== undefined && STEP_CONDITIONS[id]?.[step.name] !== step.if) problems.push(`${id} step ${step.name ?? step.run} can be skipped (if: ${step.if})`);
    }
  }
  for (const [id, [script, command]] of Object.entries(GUARDS)) {
    const step = ci?.jobs?.[id]?.steps?.find((each) => each.run === command);
    if (!step) problems.push(`${id} does not run ${command}, which runs this guard`);
    else if (step.if !== undefined || (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false)) problems.push(`${id} can skip or ignore ${command}`);
    if (!scripts?.[script]) problems.push(`package.json has no ${script} script`);
  }
  if (!/(?:^| )test\/ci-required-jobs\.test\.mjs(?: |$)/.test(scripts?.['check:integration'] ?? '')) problems.push(`check:integration does not run ${GUARD_FILE}`);
  if (!contractFiles.includes(GUARD_FILE)) problems.push(`test:contracts does not run ${GUARD_FILE}`);
  return problems;
}

// The files `pnpm test:contracts` passes to node --test: its listing, run without the final runner.
function contractFiles(script, cwd) {
  const listing = script.match(/^(.*)\|\s*xargs node --test$/)?.[1];
  if (!listing) return [];
  return execFileSync('bash', ['-o', 'pipefail', '-c', listing], { cwd, encoding: 'utf8' }).split(/\s+/).filter(Boolean);
}

test('ci.yml keeps every job the CI policy needs, unskippable, with the guard in two places', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  const files = contractFiles(scripts['test:contracts'], root);
  assert.ok(files.includes(GUARD_FILE), 'test:contracts runs this file');
  assert.deepEqual(guardProblems(ci, scripts, files), [], 'restore what the CI policy needs, or change the policy in AGENTS.md and here');
  // The guard catches its own removal from either place, and a softened job or step.
  const edited = (edit) => {
    const copy = structuredClone(ci);
    const scriptsCopy = structuredClone(scripts);
    edit(copy, scriptsCopy);
    return guardProblems(copy, scriptsCopy, contractFiles(scriptsCopy['test:contracts'], root));
  };
  const cases = {
    'workspace-contracts deleted': (copy) => { delete copy.jobs['workspace-contracts']; },
    'app-plan guard step removed': (copy) => { copy.jobs['app-plan'].steps = copy.jobs['app-plan'].steps.filter((step) => step.run !== 'pnpm check:integration'); },
    'workspace-contracts guard step removed': (copy) => { copy.jobs['workspace-contracts'].steps = copy.jobs['workspace-contracts'].steps.filter((step) => step.run !== 'pnpm test:contracts'); },
    'guard step made soft': (copy) => { copy.jobs['app-plan'].steps.find((step) => step.run === 'pnpm check:integration')['continue-on-error'] = true; },
    'guard step made conditional': (copy) => { copy.jobs['workspace-contracts'].steps.find((step) => step.run === 'pnpm test:contracts').if = "github.event_name == 'schedule'"; },
    'required job made soft': (copy) => { copy.jobs['app-tests']['continue-on-error'] = true; },
    'required job condition changed': (copy) => { copy.jobs['composite-site'].if = "github.event_name == 'schedule'"; },
    'check step made skippable': (copy) => { copy.jobs['app-tests'].steps.find((step) => step.run).if = 'false'; },
    'guard left out of check:integration': (copy, scriptsCopy) => { scriptsCopy['check:integration'] = scriptsCopy['check:integration'].replace(`${GUARD_FILE} `, ''); },
    'guard left out of test:contracts': (copy, scriptsCopy) => { scriptsCopy['test:contracts'] = scriptsCopy['test:contracts'].replace('-e /easter-egg.test.mjs', '-e /easter-egg.test.mjs -e /ci-required-jobs.test.mjs'); },
  };
  for (const [label, edit] of Object.entries(cases)) assert.ok(edited(edit).length > 0, label);
});
