import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

const workflow = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const ci = await workflow('ci');
const events = Object.keys(ci.on);

function evaluate(expression, event, overrides = {}) {
  if (typeof expression !== 'string') return expression;
  // GitHub permits hyphens in property names; JavaScript requires brackets.
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('needs.app-plan.', "needs['app-plan'].");
  return runInNewContext(source, {
    github: { event_name: event, workflow: 'ci', ref: 'refs/heads/main' },
    cancelled: () => false,
    inputs: { agentic_mode: 'interactions' },
    needs: { 'app-plan': { outputs: { has_gpu_apps: 'true', all_apps: 'false' } } },
    ...overrides,
  });
}

function group(template, event) {
  return template.replace(/\$\{\{.*?\}\}/g, (expression) => evaluate(expression, event));
}

const commands = (job) => job.steps.flatMap((step) => step.run ? [step.run] : []);
const SITE_CHECKS = ['site-runtime', 'site-audit', 'site-e2e', 'site-mobile', 'site-catalog'];

test('new pushes cannot cancel scheduled or manually requested coverage', async () => {
  for (const name of ['ci', 'mutation-quality', 'standalone-links']) {
    const flow = await workflow(name);
    assert.equal(new Set(events.map((event) => group(flow.concurrency.group, event))).size, events.length, name);
    for (const event of events) {
      const cancels = event === 'pull_request' || (name !== 'ci' && event === 'push');
      assert.equal(evaluate(flow.concurrency['cancel-in-progress'], event), cancels, `${name}: ${event}`);
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
  const interactions = ci.jobs['composite-site'].steps.find((step) => step.id === 'agent-site');
  const pipeline = ci.jobs['site-e2e'].steps.find((step) => step.run?.includes('pnpm test:e2e:pipeline'));
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
    const data = steps.findIndex((command) => command.includes('scripts/e2e-test-data.mjs'));
    const build = steps.indexOf('pnpm --filter ${{ matrix.app }} build');
    const run = steps.indexOf('pnpm --filter ${{ matrix.app }} test:e2e');
    assert.ok(data >= 0 && build > data && run > build, `${name} downloads data before building, then tests the build`);
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
  // Interactions consume the site only after every site check passed; processing remains local.
  const interactions = ci.jobs['agent-interactions'];
  assert.deepEqual(interactions.needs, ['composite-site', ...SITE_CHECKS]);
  assert.equal(interactions.if, "needs.composite-site.outputs.agent_site_ready == 'true'");
  assert.equal(ci.jobs['composite-site'].outputs.agent_site_ready, '${{ steps.agent-site.outputs.ready }}');
  assert.deepEqual(interactions.strategy.matrix.target, ['desktop', 'phone']);
  assert.deepEqual(interactions.strategy.matrix.shard, [1, 2, 3]);
  assert.equal(interactions.steps.find((step) => step.run?.includes('pnpm test:e2e:agent'))['timeout-minutes'], 120);
  for (const command of ['pnpm audit:interfaces', 'pnpm test:interface-workflows', 'pnpm test:image-uploads', 'pnpm test:mobile']) {
    assert.equal(SITE_CHECKS.filter((id) => commands(ci.jobs[id]).includes(command)).length, 1, command);
  }
  const e2e = ci.jobs['site-e2e'].steps;
  const pipeline = e2e.findIndex((step) => step.run?.includes('pnpm test:e2e:pipeline'));
  assert.ok(pipeline > e2e.findIndex((step) => step.run?.includes('pnpm test:e2e:catalog')), 'processing runs after the workspace checks');
  for (const [id, name] of [['site-e2e', 'catalog-e2e'], ['site-audit', 'interface-audit'], ['site-catalog', 'interface-elements']]) {
    const artifact = ci.jobs[id].steps.find((step) => step.with?.name === name);
    assert.equal(artifact.if, 'always()', name);
  }
});

// The old composite-site job ran every one of these in sequence over the whole
// catalogue. Each must keep running, once, in a job that tests the one build.
const SITE_COMMANDS = {
  'composite-site': ['pnpm build', 'pnpm audit:artifacts', 'node --test test/runtime-assets.test.mjs', 'node --test test/catalog-sites.test.mjs'],
  'site-runtime': ['pnpm test:resource-cache', 'pnpm test:runtime-startup'],
  'site-audit': ['node scripts/fetch-example-cache.mjs "$EXAMPLE_ASSET_CACHE" --prune', 'node test/external-requests.smoke.mjs', 'pnpm audit:interfaces'],
  'site-e2e': ['pnpm test:smoke', 'pnpm test:e2e:types', 'pnpm test:e2e:catalog', 'pnpm test:e2e:pipeline'],
  'site-mobile': ['pnpm test:interface-workflows', 'pnpm test:image-uploads', 'pnpm test:mobile'],
  'site-catalog': ['pnpm --filter @neurodesk/webapp-components test:elements:browser', 'pnpm --filter @neurodesk/webapp-components test:showcase:browser', 'pnpm --filter @neurodesk/webapp-components test:handoff:browser', 'node test/automation-catalog.smoke.mjs', 'pnpm test:app-handoff'],
};

test('the site is built once and every site check runs in one job that tests that build', () => {
  const site = ci.jobs['composite-site'];
  assert.deepEqual(Object.keys(SITE_COMMANDS), ['composite-site', ...SITE_CHECKS]);
  const every = Object.keys(SITE_COMMANDS).flatMap((id) => commands(ci.jobs[id]));
  for (const [id, expected] of Object.entries(SITE_COMMANDS)) {
    for (const command of expected) {
      assert.equal(every.filter((run) => run.includes(command)).length, 1, `${command} runs once`);
      assert.ok(commands(ci.jobs[id]).some((run) => run.includes(command)), `${id} runs ${command}`);
    }
  }
  const upload = site.steps.find((step) => String(step.uses).startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'composite-site-${{ github.sha }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const id of SITE_CHECKS) {
    const job = ci.jobs[id];
    assert.equal(job.needs, 'composite-site', id);
    assert.equal(job.if, undefined, `${id} starts whenever the build job succeeded`);
    const unpack = job.steps.findIndex((step) => step.uses === './.github/actions/composite-site');
    const firstCheck = job.steps.findIndex((step) => SITE_COMMANDS[id].some((command) => step.run?.includes(command)));
    assert.ok(unpack >= 0 && unpack < firstCheck, `${id} unpacks the build before its first check`);
    assert.ok(!commands(job).some((run) => /\bpnpm build\b|turbo run/.test(run)), `${id} tests the uploaded build`);
  }
});

test('correctness lint runs on every CI event with no duplicate routine gate', async () => {
  const quality = await workflow('code-quality');
  for (const event of ['pull_request', 'push']) {
    assert.ok(Object.hasOwn(quality.on, event), event);
    assert.deepEqual(quality.on[event]?.branches, ci.on[event]?.branches, `${event} correctness has the same branch coverage`);
    assert.equal(quality.on[event]?.paths, undefined);
    assert.equal(quality.on[event]?.['paths-ignore'], undefined);
  }
  // CI also reacts to draft transitions; lint already checks the same commit
  // on opening, reopening and every push, regardless of draft state.
  const defaultPrTypes = ['opened', 'synchronize', 'reopened'];
  const lintTypes = quality.on.pull_request?.types ?? defaultPrTypes;
  for (const type of defaultPrTypes) {
    assert.ok(lintTypes.includes(type), `correctness covers ${type}`);
    assert.ok(ci.on.pull_request.types.includes(type), `CI covers ${type}`);
  }
  const standalone = quality.jobs.correctness.steps.find((step) => step.run === 'pnpm lint:correctness');
  assert.ok(standalone);
  assert.equal(standalone.if, undefined);
  const full = ci.jobs['workspace-contracts'].steps.find((step) => step.run === 'pnpm lint:correctness');
  assert.ok(full);
  // A status function overrides GitHub's implicit success() guard after a package failure.
  assert.match(full.if, /!cancelled\(\)/);
  for (const event of events) {
    assert.equal(evaluate(full.if, event, { cancelled: () => true }), false, `${event} respects cancellation`);
    assert.equal(evaluate(full.if, event), !['pull_request', 'push'].includes(event), event);
  }
  const workspace = ci.jobs['workspace-contracts'].steps.find((step) => step.run === 'node scripts/lint-workspaces.mjs');
  assert.ok(workspace);
  assert.equal(workspace.if, undefined);
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
  assert.equal(pkg.scripts.lint, 'pnpm lint:correctness && node scripts/lint-workspaces.mjs');
  assert.ok(pkg.scripts['test:contracts'].includes('test/*.test.mjs'));
  for (const name of ['test:lint', 'test:dependencies']) {
    assert.match(pkg.scripts[name], /^node --test(?: test\/[\w-]+\.test\.mjs)+$/);
    for (const file of pkg.scripts[name].slice('node --test '.length).split(' ')) {
      await readFile(new URL(`../${file}`, import.meta.url));
      assert.ok(!pkg.scripts['test:contracts'].includes(`/${file.slice('test/'.length)}`), `${name}: ${file} is covered by contracts`);
    }
  }
  const packageTest = pkg.scripts['test:packages'].split(' && ')[0];
  assert.match(packageTest, /^pnpm (?:--filter '[^']+' )+run test$/);
  const filters = [...packageTest.matchAll(/--filter '([^']+)'/g)].flatMap((match) => ['--filter', match[1]]);
  const selected = JSON.parse(execFileSync('pnpm', [...filters, 'list', '--depth', '-1', '--json'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  }));
  assert.ok(selected.some((entry) => entry.name === '@neurodesk/nii2tvx'), 'shared package tests include native/WASM parity');
  for (const file of ['deployed-isolation', 'runtime-assets-rewrite', 'runtime-worker-scope', 'agentic-catalog', 'agentic-provider', 'chromium-cdp', 'playwright-discovery', 'lint-coverage', 'dependency-quality', 'unused-code', 'mutation-quality']) {
    assert.ok(!pkg.scripts['test:contracts'].includes(`/${file}.test.mjs`), `${file} is not excluded from contracts`);
    for (const name of ['ci', 'code-quality', 'dependency-quality', 'unused-code', 'mutation-quality']) {
      assert.ok(!JSON.stringify((await workflow(name)).jobs).includes(`test/${file}.test.mjs`), `${file} is owned by contracts, not repeated in ${name}`);
    }
  }
  assert.equal(composite.filter((command) => /install.*chromium/.test(command)).length, 0, 'the build job needs no browser');
  for (const id of SITE_CHECKS) {
    assert.equal(commands(ci.jobs[id]).filter((command) => /install.*chromium/.test(command)).length, 1, `one browser install in ${id}`);
  }
});
