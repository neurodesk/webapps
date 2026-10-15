import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

const workflow = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const ci = await workflow('ci');
const events = ['pull_request', 'push', 'schedule', 'workflow_dispatch'];

function evaluate(expression, event, overrides = {}) {
  if (typeof expression !== 'string') return expression;
  // GitHub permits hyphens in property names; JavaScript requires brackets.
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('needs.app-plan.', "needs['app-plan'].");
  return runInNewContext(source, {
    github: { event_name: event, workflow: 'ci', ref: 'refs/heads/main' },
    inputs: { agentic_mode: 'interactions' },
    needs: { 'app-plan': { outputs: { has_gpu_apps: 'true', all_apps: 'false' } } },
    ...overrides,
  });
}

function group(template, event) {
  return template.replace(/\$\{\{.*?\}\}/g, (expression) => evaluate(expression, event));
}

const commands = (job) => job.steps.flatMap((step) => step.run ? [step.run] : []);

test('new pushes cannot cancel scheduled or manually requested coverage', async () => {
  for (const name of ['ci', 'mutation-quality', 'standalone-links']) {
    const flow = await workflow(name);
    assert.equal(new Set(events.map((event) => group(flow.concurrency.group, event))).size, events.length, name);
    for (const event of events) {
      assert.equal(evaluate(flow.concurrency['cancel-in-progress'], event), ['pull_request', 'push'].includes(event), `${name}: ${event}`);
    }
  }
});

test('routine events omit slow repeats while nightly, manual and release retain the full tier', async () => {
  for (const event of [...events, 'release']) {
    assert.equal(evaluate(ci.env.NEURODESK_E2E_SKIP_SLOW, event), ['pull_request', 'push'].includes(event) ? '1' : '', event);
  }
  for (const ref of ['refs/tags/v1.0.20261015', 'refs/heads/feature']) {
    assert.equal(evaluate(ci.env.NEURODESK_E2E_SKIP_SLOW, 'push', { github: { event_name: 'push', ref } }), '', ref);
  }
  const release = await workflow('release');
  assert.ok(!JSON.stringify(release).includes('NEURODESK_E2E_SKIP_SLOW'));
});

test('manual CI defaults to full deterministic coverage with agent checks opt-in', () => {
  const input = ci.on.workflow_dispatch.inputs.agentic_mode;
  assert.deepEqual(input.options, ['none', 'interactions', 'pipeline']);
  assert.equal(input.default, 'none');
  const manual = {
    inputs: { agentic_mode: input.default },
    needs: { 'app-plan': { outputs: { has_browser_apps: 'true', has_gpu_apps: 'true', all_apps: 'true', has_site: 'true' } } },
  };
  assert.equal(evaluate(ci.env.NEURODESK_E2E_SKIP_SLOW, 'workflow_dispatch', manual), '');
  for (const job of ['composite-site', 'browser-e2e', 'browser-e2e-gpu']) {
    assert.equal(evaluate(ci.jobs[job].if, 'workflow_dispatch', manual), true, job);
  }
  const steps = ci.jobs['composite-site'].steps;
  const interactions = steps.find((step) => step.run?.includes('pnpm test:e2e:agent'));
  const pipeline = steps.find((step) => step.run?.includes('pnpm test:e2e:pipeline'));
  for (const mode of input.options) {
    const context = { ...manual, inputs: { agentic_mode: mode } };
    assert.equal(evaluate(interactions.if, 'workflow_dispatch', context), mode === 'interactions', mode);
    assert.equal(evaluate(pipeline.if, 'workflow_dispatch', context), mode === 'pipeline', mode);
  }
  assert.equal(evaluate(interactions.if, 'schedule', { inputs: {} }), true);
  assert.equal(evaluate(pipeline.if, 'schedule', { inputs: {} }), false);
});

test('scientific CPU and hardware GPU tests keep independent builds and test-data provisioning', () => {
  for (const name of ['browser-e2e', 'browser-e2e-gpu']) {
    const job = ci.jobs[name];
    const steps = commands(job);
    assert.ok(steps.some((command) => command.includes('scripts/e2e-test-data.mjs')), name);
    assert.ok(steps.includes('pnpm --filter ${{ matrix.app }} build'), name);
    assert.ok(steps.includes('pnpm --filter ${{ matrix.app }} test:e2e'), name);
    const step = job.steps.find((entry) => entry.run === 'pnpm --filter ${{ matrix.app }} test:e2e');
    assert.equal(step.env.NEURODESK_E2E_PREBUILT, '1', name);
  }
  const gpu = ci.jobs['browser-e2e-gpu'];
  assert.equal(gpu.env.NEURODESK_HARDWARE_GPU, '1');
  assert.equal(gpu['runs-on'], 'macos-15');
  assert.equal(ci.jobs['browser-e2e'].steps.find((step) => step.name === 'Download ${{ matrix.app }} test data').env.CPU_ONLY, "${{ matrix.hardware_gpu && '--cpu' || '' }}");
  for (const event of events) {
    assert.equal(evaluate(gpu.if, event), true, `${event} retains selected GPU apps`);
    assert.equal(evaluate(gpu.if, event, { needs: { 'app-plan': { outputs: { has_gpu_apps: 'true', all_apps: 'true' } } } }), event !== 'pull_request', `${event} catalog coverage`);
  }
});

test('every deterministic interface check runs before optional agent checks', () => {
  const steps = ci.jobs['composite-site'].steps;
  const agentSteps = steps.map((step, index) => /pnpm test:e2e:(?:agent|pipeline)/.test(step.run || '') ? index : -1).filter((index) => index >= 0);
  assert.equal(agentSteps.length, 2);
  assert.equal(steps[agentSteps[0]]['timeout-minutes'], 120);
  for (const command of ['pnpm audit:interfaces', 'pnpm test:interface-workflows', 'pnpm test:image-uploads', 'pnpm test:mobile']) {
    const index = steps.findIndex((step) => step.run === command);
    assert.ok(index >= 0 && agentSteps.every((agent) => index < agent), command);
  }
  for (const name of ['catalog-e2e', 'interface-audit']) {
    const artifact = steps.find((step) => step.with?.name === name);
    assert.equal(artifact.if, 'always()');
  }
});

test('contract and correctness owners replace duplicate invocations without losing native parity', async () => {
  const workspace = commands(ci.jobs['workspace-contracts']);
  assert.equal(workspace.filter((command) => command === 'pnpm test:contracts').length, 1);
  assert.ok(workspace.indexOf(workspace.find((command) => command.includes('make -C exes/nii2tvx test'))) < workspace.indexOf('pnpm test:packages'));
  assert.ok(workspace.includes('node scripts/lint-workspaces.mjs'));
  assert.ok(!workspace.includes('pnpm lint'));
  assert.ok(commands((await workflow('code-quality')).jobs.correctness).includes('pnpm lint:correctness'));
  const composite = commands(ci.jobs['composite-site']);
  assert.ok(composite.includes('node --test test/runtime-assets.test.mjs'), 'built runtime assembly remains independently tested');
  const source = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(source);
  assert.ok(pkg.scripts['test:contracts'].includes('test/*.test.mjs'));
  for (const file of ['deployed-isolation', 'runtime-assets-rewrite', 'runtime-worker-scope', 'agentic-catalog', 'agentic-provider', 'chromium-cdp', 'playwright-discovery', 'lint-coverage', 'dependency-quality', 'unused-code', 'mutation-quality']) {
    assert.ok(!pkg.scripts['test:contracts'].includes(`/${file}.test.mjs`), `${file} is not excluded from contracts`);
    for (const name of ['ci', 'code-quality', 'dependency-quality', 'unused-code', 'mutation-quality']) {
      assert.ok(!JSON.stringify((await workflow(name)).jobs).includes(`test/${file}.test.mjs`), `${file} is owned by contracts, not repeated in ${name}`);
    }
  }
  assert.equal(composite.filter((command) => /install.*chromium/.test(command)).length, 1, 'one browser install per composite job');
});
