import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import sourceParser from '@neurodesk/code-quality';
import YAML from 'yaml';

const workflow = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const ci = await workflow('ci');
const events = Object.keys(ci.on);

function evaluate(expression, event, overrides = {}) {
  if (typeof expression !== 'string') return expression;
  // GitHub permits hyphens in property names; JavaScript requires brackets.
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll('needs.app-plan.', "needs['app-plan'].").replaceAll('needs.composite-site.', "needs['composite-site'].");
  return runInNewContext(source, {
    github: { event_name: event, workflow: 'ci', ref: 'refs/heads/main', event: { pull_request: { draft: false } } },
    cancelled: () => false,
    inputs: { agentic_mode: 'interactions' },
    needs: { 'app-plan': { outputs: { has_gpu_apps: 'true', all_apps: 'false' } }, 'composite-site': { result: 'success' } },
    ...overrides,
  });
}

function group(template, event) {
  return template.replace(/\$\{\{.*?\}\}/g, (expression) => evaluate(expression, event));
}

const commands = (job) => job.steps.flatMap((step) => step.run ? [step.run] : []);
const SITE_CHECKS = ['site-runtime', 'site-audit', 'site-e2e', 'site-mobile', 'site-catalog'];

test('new pushes cannot cancel scheduled or manually requested coverage', async () => {
  const quality = await workflow('quality');
  for (const [name, flow] of [['ci', ci], ['quality mutation', quality.jobs.mutation], ['standalone-links', await workflow('standalone-links')]]) {
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
    needs: { 'app-plan': { outputs: { has_browser_apps: 'true', has_gpu_apps: 'true', all_apps: 'true', has_site: 'true' } }, 'composite-site': { result: 'success' } },
  };
  assert.equal(evaluate(ci.env.NEURODESK_E2E_SKIP_SLOW, 'workflow_dispatch', manual), '');
  for (const job of ['composite-site', 'browser-e2e', 'browser-e2e-gpu']) {
    assert.equal(evaluate(ci.jobs[job].if, 'workflow_dispatch', manual), true, job);
  }
  const interactions = ci.jobs['composite-site'].steps.find((step) => step.id === 'agent-site');
  const pipeline = ci.jobs['processing-workflows'];
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
  // A draft pull request starts neither browser job; a ready one, and every other event, does.
  const draft = { github: { event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { pull_request: { draft: true } } }, needs: { 'app-plan': { outputs: { has_browser_apps: 'true', has_gpu_apps: 'true', all_apps: 'false' } } } };
  for (const name of ['browser-e2e', 'browser-e2e-gpu']) {
    assert.equal(evaluate(ci.jobs[name].if, 'pull_request', draft), false, `${name} on a draft`);
    assert.equal(evaluate(ci.jobs[name].if, 'pull_request', { ...draft, github: { ...draft.github, event: { pull_request: { draft: false } } } }), true, `${name} when ready`);
  }
  assert.equal(evaluate(ci.jobs['app-tests'].if, 'pull_request', { ...draft, needs: { 'app-plan': { outputs: { has_apps: 'true' } } } }), true, 'a draft still runs unit and build tests');
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
  // Processing workflows make live model calls: like interactions, they start only after every check passed.
  const processing = ci.jobs['processing-workflows'];
  assert.deepEqual(processing.needs, ['composite-site', ...SITE_CHECKS]);
  assert.ok(!SITE_CHECKS.some((id) => commands(ci.jobs[id]).some((run) => run.includes('pnpm test:e2e:pipeline'))), 'no site check runs processing');
  const unpack = processing.steps.findIndex((step) => step.uses === './.github/actions/composite-site');
  const run = processing.steps.findIndex((step) => step.run?.includes('pnpm test:e2e:pipeline'));
  assert.ok(unpack >= 0 && run > unpack, 'processing tests the uploaded build');
  // At the base the cache clean-up ran after the one serial site job passed.
  assert.deepEqual(ci.jobs['example-cache-retention'].needs, SITE_CHECKS);
  for (const [id, name] of [['site-e2e', 'catalog-e2e'], ['site-audit', 'interface-audit'], ['site-catalog', 'interface-elements'], ['processing-workflows', 'catalog-pipeline']]) {
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
  'site-e2e': ['pnpm test:smoke', 'pnpm test:e2e:types', 'pnpm test:e2e:catalog'],
  'site-mobile': ['pnpm test:interface-workflows', 'pnpm test:image-uploads', 'pnpm test:mobile'],
  'site-catalog': ['pnpm --filter @neurodesk/webapp-components test:elements:browser', 'pnpm --filter @neurodesk/webapp-components test:showcase:browser', 'pnpm --filter @neurodesk/webapp-components test:handoff:browser', 'node test/automation-catalog.smoke.mjs', 'node test/webmcp.smoke.mjs', 'node test/webmcp-examination.smoke.mjs', 'node test/webmcp-interaction.smoke.mjs', 'pnpm test:app-handoff'],
};
// The checks that cover one page per app: SMOKE_APPS narrows them on pull requests and pushes.
const SCOPED = ['pnpm test:runtime-startup', 'pnpm audit:interfaces', 'pnpm test:smoke', 'pnpm test:e2e:catalog', 'pnpm test:interface-workflows', 'pnpm test:mobile', 'node test/webmcp.smoke.mjs', 'node test/webmcp-interaction.smoke.mjs'];

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
  // 283 MB per run: three days covers a late re-run of one failed check, not GitHub's 30-day re-run window.
  assert.equal(upload.with['retention-days'], 3);
  for (const id of SITE_CHECKS) {
    const job = ci.jobs[id];
    assert.equal(job.needs, 'composite-site', id);
    assert.equal(job.if, "needs.composite-site.result == 'success'", `${id} starts whenever the build job succeeded`);
    assert.equal(job.env, undefined, `${id} narrows single steps, never the whole job`);
    const unpack = job.steps.findIndex((step) => step.uses === './.github/actions/composite-site');
    const firstCheck = job.steps.findIndex((step) => SITE_COMMANDS[id].some((command) => step.run?.includes(command)));
    assert.ok(unpack >= 0 && unpack < firstCheck, `${id} unpacks the build before its first check`);
    assert.ok(!commands(job).some((run) => /\bpnpm build\b|turbo run/.test(run)), `${id} tests the uploaded build`);
    for (const step of job.steps) {
      const scoped = SCOPED.some((command) => step.run?.includes(command));
      assert.equal(step.env?.SMOKE_APPS, scoped ? '${{ needs.composite-site.outputs.smoke_apps }}' : undefined, `${id}: ${step.name ?? step.run ?? step.uses}`);
    }
  }
  assert.equal(site.outputs.smoke_apps, '${{ steps.check-apps.outputs.smoke_apps }}');
  const choose = site.steps.find((step) => step.id === 'check-apps');
  assert.equal(choose.run, 'node scripts/site-check-apps.mjs');
  assert.deepEqual(choose.env, {
    EVENT: '${{ github.event_name }}',
    SCOPE: '${{ inputs.scope }}',
    ALL_APPS: '${{ needs.app-plan.outputs.all_apps }}',
    SITE_CODE: '${{ needs.app-plan.outputs.site_code }}',
    SELECTED_IDS: '${{ needs.app-plan.outputs.selected_ids }}',
  });
  for (const output of ['all_apps', 'site_code', 'selected_ids']) {
    assert.equal(ci.jobs['app-plan'].outputs[output], `\${{ steps.plan.outputs.${output} }}`, output);
  }
});

test('a site check re-run after the build expired says to re-run all jobs', async () => {
  const action = YAML.parse(await readFile(new URL('../.github/actions/composite-site/action.yml', import.meta.url), 'utf8'));
  const steps = action.runs.steps;
  const download = steps.findIndex((step) => String(step.uses).startsWith('actions/download-artifact@'));
  assert.equal(steps[download].with.name, 'composite-site-${{ github.sha }}');
  assert.equal(steps[download]['continue-on-error'], true);
  const explain = steps[download + 1];
  assert.equal(explain.if, `steps.${steps[download].id}.outcome == 'failure'`);
  assert.match(explain.run, /::error::.*keeps it 3 days\. Use \\"Re-run all jobs\\" to build it again/);
  assert.match(explain.run, /\nexit 1\n?$/);
  const upload = ci.jobs['composite-site'].steps.find((step) => String(step.uses).startsWith('actions/upload-artifact@'));
  assert.match(explain.run, new RegExp(`keeps it ${upload.with['retention-days']} days`), 'the message names the retention ci.yml sets');
});

test('correctness lint runs on every CI event with no duplicate routine gate', async () => {
  const quality = await workflow('quality');
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

test('each quality job runs on exactly the events its former workflow ran on', async () => {
  const quality = await workflow('quality');
  // code-quality, unused-code and dependency-quality ran on pull requests, main pushes and dispatch;
  // mutation-quality on pull requests (smoke), its weekly schedule and dispatch (every module).
  const expected = {
    correctness: ['pull_request', 'push', 'workflow_dispatch'],
    'unused-code': ['pull_request', 'push', 'workflow_dispatch'],
    dependencies: ['pull_request', 'push', 'workflow_dispatch'],
    mutation: ['pull_request', 'schedule', 'workflow_dispatch'],
  };
  const triggers = Object.keys(quality.on).sort();
  assert.deepEqual(triggers, ['pull_request', 'push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(quality.on.pull_request.types, ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']);
  assert.deepEqual(quality.on.push, { branches: ['main'] });
  assert.deepEqual(quality.on.schedule, [{ cron: '41 4 * * 1' }]);
  assert.deepEqual(Object.keys(quality.jobs).sort(), Object.keys(expected).sort());
  for (const [name, job] of Object.entries(quality.jobs)) {
    const runs = triggers.filter(event => evaluate(job.if ?? 'true', event));
    assert.deepEqual(runs, expected[name], name);
  }
  const draft = { github: { event_name: 'pull_request', workflow: 'quality', ref: 'refs/pull/1/merge', event: { action: 'synchronize', pull_request: { draft: true } } } };
  const converted = { github: { event_name: 'pull_request', workflow: 'quality', ref: 'refs/pull/1/merge', event: { action: 'converted_to_draft', pull_request: { draft: true } } } };
  for (const name of ['correctness', 'dependencies']) {
    assert.equal(evaluate(quality.jobs[name].if, 'pull_request', draft), true, `${name} still checks drafts`);
    assert.equal(evaluate(quality.jobs[name].if, 'pull_request', converted), false, `${name} skips converted_to_draft`);
  }
  for (const name of ['unused-code', 'mutation']) {
    assert.equal(evaluate(quality.jobs[name].if, 'pull_request', draft), false, `${name} defers drafts until ready`);
    assert.equal(evaluate(quality.jobs[name].if, 'pull_request', converted), false, `${name} skips converted_to_draft`);
  }
  // Each job keeps its former workflow's concurrency: a newer run on the same ref cancels the
  // running correctness, unused-code and dependency checks, whatever the event.
  assert.equal(quality.concurrency, undefined, 'one group for the workflow would make every job wait for the previous run');
  const formerConcurrency = {
    correctness: { group: 'code-quality-${{ github.ref }}', 'cancel-in-progress': true },
    'unused-code': { group: 'unused-code-${{ github.ref }}', 'cancel-in-progress': true },
    dependencies: { group: 'dependency-quality-${{ github.ref }}', 'cancel-in-progress': true },
    mutation: { group: 'mutation-quality-${{ github.event_name }}-${{ github.ref }}', 'cancel-in-progress': "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}" },
  };
  for (const [name, concurrency] of Object.entries(formerConcurrency)) assert.deepEqual(quality.jobs[name].concurrency, concurrency, name);
  for (const name of ['correctness', 'unused-code', 'dependencies']) {
    for (const event of expected[name]) {
      assert.equal(group(quality.jobs[name].concurrency.group, event), group(quality.jobs[name].concurrency.group, 'push'), `${name}: ${event} shares the ref's group`);
    }
  }
  const mutation = quality.jobs.mutation.steps;
  const step = (command) => mutation.find(each => each.run === command);
  for (const event of expected.mutation) {
    assert.equal(evaluate(step('pnpm quality:mutations:smoke').if, event), event === 'pull_request', `smoke on ${event}`);
    assert.equal(evaluate(step('pnpm quality:mutations').if, event), event !== 'pull_request', `every module on ${event}`);
  }
  for (const name of ['code-quality', 'unused-code', 'dependency-quality', 'mutation-quality']) {
    await assert.rejects(readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url)), { code: 'ENOENT' }, `${name}.yml is folded into quality.yml`);
  }
});

test('contract and correctness owners replace duplicate invocations without losing native parity', async () => {
  const workspace = commands(ci.jobs['workspace-contracts']);
  const packages = commands(ci.jobs['package-tests']);
  assert.equal(workspace.filter((command) => command === 'pnpm test:contracts').length, 1);
  assert.ok(packages.indexOf(packages.find((command) => command.includes('make -C exes/nii2tvx test'))) < packages.indexOf('pnpm test:packages'));
  assert.ok(workspace.includes('node scripts/lint-workspaces.mjs'));
  assert.ok(!workspace.includes('pnpm lint'));
  assert.ok(commands((await workflow('quality')).jobs.correctness).includes('pnpm lint:correctness'));
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
    for (const name of ['ci', 'quality']) {
      assert.ok(!JSON.stringify((await workflow(name)).jobs).includes(`test/${file}.test.mjs`), `${file} is owned by contracts, not repeated in ${name}`);
    }
  }
  assert.equal(composite.filter((command) => /install.*chromium/.test(command)).length, 0, 'the build job needs no browser');
  assert.equal(ci.jobs['composite-site'].steps.filter((step) => step.uses === './.github/actions/setup-playwright').length, 0, 'the build job needs no browser action');
  for (const id of SITE_CHECKS) {
    assert.equal(ci.jobs[id].steps.filter((step) => step.uses === './.github/actions/setup-playwright').length, 1, `one browser install in ${id}`);
  }
});

test('every non-reusable workflow job declares an explicit timeout-minutes', async () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const missing = [];
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.yml')).sort()) {
    const flow = YAML.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [id, job] of Object.entries(flow.jobs ?? {})) {
      if (job.uses) continue;
      const timeout = job['timeout-minutes'];
      const validNumber = Number.isInteger(timeout) && timeout > 0;
      const validExpr = typeof timeout === 'string' && /^\$\{\{[\s\S]+\}\}$/.test(timeout.trim());
      if (!validNumber && !validExpr) {
        missing.push(`${file}: ${id}`);
      }
    }
  }
  assert.deepEqual(missing, [], `jobs missing explicit timeout-minutes: ${missing.join(', ')}`);
});

function moduleSpecifiers(source, filePath) {
  const ast = sourceParser.parse(source, { filePath, sourceType: 'module' });
  const specifiers = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && typeof node.source?.value === 'string'
    ) {
      specifiers.push(node.source.value);
    } else if (node.type === 'ImportExpression' && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
      specifiers.push(node.source.value);
    } else if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'require'
      && node.arguments?.[0]?.type === 'Literal'
      && typeof node.arguments[0].value === 'string'
    ) {
      specifiers.push(node.arguments[0].value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  return specifiers;
}

test('workflow scripts executed before pnpm install import only Node built-ins', async () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const dir = new URL('../.github/workflows/', import.meta.url);
  const preInstallScripts = new Map();
  for (const file of (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const flow = YAML.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [jobId, job] of Object.entries(flow.jobs ?? {})) {
      let installed = false;
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        for (const line of step.run.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          if (/\b(?:pnpm\s+install|npm\s+(?:ci|install))\b/.test(trimmed)) {
            installed = true;
            continue;
          }
          if (installed) continue;
          for (const match of trimmed.matchAll(/\bnode\s+(?:--[\w=-]+\s+)*(scripts\/[\w./-]+\.[cm]?js)\b/g)) {
            const callers = preInstallScripts.get(match[1]) ?? [];
            callers.push(`${file}:${jobId}`);
            preInstallScripts.set(match[1], callers);
          }
        }
      }
    }
  }
  assert.ok(preInstallScripts.has('scripts/ci-usage-report.mjs'), 'ci-usage-report.mjs runs without pnpm install and must be checked');

  const violations = [];
  for (const [entry, callers] of [...preInstallScripts].sort()) {
    const visited = new Set();
    const pending = [resolve(repoRoot, entry)];
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, 'utf8');
      for (const specifier of moduleSpecifiers(source, file)) {
        if (isBuiltin(specifier)) continue;
        if (specifier.startsWith('.')) {
          pending.push(resolve(dirname(file), specifier));
          continue;
        }
        const from = relative(repoRoot, file).replaceAll('\\', '/');
        violations.push(`${entry} (${callers.join(', ')}): ${from} imports non-builtin "${specifier}"`);
      }
    }
  }
  assert.deepEqual(violations, [], `scripts run before pnpm install must not import packages:\n${violations.join('\n')}`);
});
