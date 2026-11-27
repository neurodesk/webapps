import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, posix as posixPath, relative, resolve } from 'node:path';
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

const GH_AW_BOILERPLATE_JOBS = new Set(['pre_activation', 'activation', 'conclusion', 'unlock']);
const SHA_64 = /^[0-9a-f]{64}$/;
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/i;
const GH_AW_SETUP_ACTION = /^github\/gh-aw-actions\/setup@[0-9a-f]{40}$/i;
const GH_AW_DOWNLOAD_ARTIFACT = /^actions\/download-artifact@[0-9a-f]{40}$/i;
// Exact compiler-emitted shell commands in gh-aw v1.2.2 boilerplate jobs (no chaining or extra commands).
const GH_AW_BOILERPLATE_ACTION_SCRIPT = /^bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/([a-z0-9_]+\.sh)"$/;
const GH_AW_BOILERPLATE_SH_SCRIPTS = Object.freeze({
  activation: new Set([
    'mask_otlp_headers.sh',
    'check_oauth_tokens.sh',
    'save_base_github_folders.sh',
    'log_runtime_features_summary.sh',
    'validate_prompt_placeholders.sh',
    'print_prompt_summary.sh',
  ]),
  conclusion: new Set(['collect_usage_artifact_files.sh']),
  pre_activation: new Set(),
  unlock: new Set(),
});
const GH_AW_VALIDATE_COPILOT_SECRET_RUN = 'bash "${RUNNER_TEMP}/gh-aw/actions/validate_multi_secret.sh" COPILOT_GITHUB_TOKEN \'GitHub Copilot CLI\' https://github.github.com/gh-aw/reference/engines/#github-copilot-default';
const GH_AW_BOILERPLATE_EXACT_RUNS = new Set([
  'sleep 10',
  'mkdir -p /tmp/gh-aw/aw-prompts\ncp -a "${RUNNER_TEMP}/gh-aw/aw-prompts/." /tmp/gh-aw/aw-prompts/',
  'if [ -f /tmp/gh-aw/runtime/aw_info.json ]; then cp /tmp/gh-aw/runtime/aw_info.json /tmp/gh-aw/aw_info.json; fi',
  'echo "::warning::Threat detection produced no security verdict. Review the detection job logs before trusting the agent outputs."',
  'mkdir -p /tmp/gh-aw/\nfind "/tmp/gh-aw/" -type f -print\nif [ -f "/tmp/gh-aw/agent_output.json" ]; then\n  echo "GH_AW_AGENT_OUTPUT=/tmp/gh-aw/agent_output.json" >> "$GITHUB_OUTPUT"\nfi',
  GH_AW_VALIDATE_COPILOT_SECRET_RUN,
]);

function hasValidTimeout(timeout) {
  return (Number.isInteger(timeout) && timeout > 0)
    || (typeof timeout === 'string' && /^\$\{\{[\s\S]+\}\}$/.test(timeout.trim()));
}

function parseMarkdownWorkflow(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) return null;
  const rawFrontmatter = lines.slice(1, endIndex).join('\n');
  const body = lines.slice(endIndex + 1).join('\n').trim();
  try {
    return {
      frontmatter: YAML.parse(rawFrontmatter),
      normalizedFrontmatter: rawFrontmatter.split('\n').map((line) => line.trimEnd()).join('\n').trim(),
      body,
    };
  } catch {
    return null;
  }
}

function computeGhAwFrontmatterHash(normalizedFrontmatter) {
  return createHash('sha256')
    .update(JSON.stringify({ 'frontmatter-text': normalizedFrontmatter }), 'utf8')
    .digest('hex');
}

const GH_AW_BOILERPLATE_ALLOWED_ACTIONS = Object.freeze({
  activation: new Set(['github/gh-aw-actions/setup', 'actions/github-script', 'actions/upload-artifact']),
  conclusion: new Set(['github/gh-aw-actions/setup', 'actions/download-artifact', 'actions/github-script', 'actions/upload-artifact']),
  pre_activation: new Set(['github/gh-aw-actions/setup', 'actions/github-script']),
  unlock: new Set(['github/gh-aw-actions/setup', 'actions/github-script']),
});
const GH_AW_BOILERPLATE_CJS_MODULES = Object.freeze({
  activation: new Set([
    'generate_aw_info.cjs',
    'restore_aic_scan_cache.cjs',
    'check_daily_aic_workflow_guardrail.cjs',
    'check_workflow_timestamp_api.cjs',
    'check_version_updates.cjs',
    'create_prompt.cjs',
    'interpolate_prompt.cjs',
    'skill_inventory.cjs',
  ]),
  conclusion: new Set([
    'handle_noop_message.cjs',
    'missing_tool.cjs',
    'report_incomplete_handler.cjs',
    'handle_agent_failure.cjs',
    'generate_usage_artifacts.cjs',
  ]),
  pre_activation: new Set(),
  unlock: new Set(),
});
const GH_AW_SETUP_ALLOWED_WITH_KEYS = new Set(['destination', 'job-name', 'trace-id', 'parent-span-id', 'safe-output-artifact-client']);
const GH_AW_CHECKOUT_EXACT_WITH_KEYS = ['fetch-depth', 'persist-credentials', 'sparse-checkout', 'sparse-checkout-cone-mode'];
const GH_AW_SCRIPT_ALLOWED_WITH_KEYS = new Set(['script', 'github-token']);
const GH_AW_UPLOAD_ALLOWED_WITH_KEYS = new Set(['name', 'path', 'if-no-files-found', 'retention-days', 'overwrite', 'include-hidden-files']);
const GH_AW_BOILERPLATE_UPLOAD_NAMES = Object.freeze({
  activation: new Set(['aic-usage-scan-v2', 'info', 'activation']),
  conclusion: new Set(['usage']),
});
const GH_AW_RETENTION_EXPR = /^\$\{\{\s*vars\.GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS\s*\|\|\s*'\d+'\s*\}\}$/;
const GH_AW_BOILERPLATE_DOWNLOAD_SPECS = Object.freeze({
  conclusion: [
    { keys: ['name', 'path'], name: 'info', path: '/tmp/gh-aw/' },
    { keys: ['name', 'path'], name: 'detection', path: '/tmp/gh-aw/threat-detection/' },
    { keys: ['merge-multiple', 'path', 'pattern'], pattern: '{agent,agent-output-fallback}', 'merge-multiple': true, path: '/tmp/gh-aw/' },
    { keys: ['merge-multiple', 'path', 'pattern'], pattern: 'safe-outputs-items', 'merge-multiple': true, path: '/tmp/gh-aw/' },
  ],
});
const GH_AW_LITERAL_TMP_PATH = /^\/tmp\/gh-aw(?:\/[A-Za-z0-9._-]+)*\/?$/;
const GH_AW_ACTIVATION_SPARSE_CHECKOUT = '.github\n.agents\n.claude\n.codex\n.gemini\n.pi';
const GH_AW_GITHUB_SCRIPT_DISPATCH = /^const path = require\('path'\);\nconst actionsDir = path\.join\(process\.env\.RUNNER_TEMP, 'gh-aw', 'actions'\);\nconst \{ setupGlobals \} = require\(path\.join\(actionsDir, 'setup_globals\.cjs'\)\);\nsetupGlobals\(core, github, context, exec, io, getOctokit\);\nconst \{ main \} = require\(path\.join\(actionsDir, '([a-z0-9_]+\.cjs)'\)\);\nawait main\((?:core, context|core|)\);$/;
const GH_AW_GITHUB_SCRIPT_PROMPT = /^const promptEnvironment = new Set\(\[(?:"[A-Z0-9_]+",)*"[A-Z0-9_]+"\]\);\nfor \(const name of Object\.keys\(process\.env\)\) \{\n {2}if \(!promptEnvironment\.has\(name\)\) delete process\.env\[name\];\n\}\nglobal\.core = core;\nglobal\.context = context;\nconst \{ main \} = require\(process\.env\.GH_AW_ACTIONS_DIR \+ '\/((?:create_prompt|interpolate_prompt)\.cjs)'\);\nawait main\((?:core|)\);$/;

function isSafeTmpGhAwPath(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!GH_AW_LITERAL_TMP_PATH.test(trimmed) || trimmed.split('/').includes('..')) return false;
  const normalized = posixPath.normalize(trimmed);
  return normalized === '/tmp/gh-aw' || normalized.startsWith('/tmp/gh-aw/');
}

function isVerifiedBoilerplateUploadStep(id, withObj, withKeys) {
  const allowedNames = GH_AW_BOILERPLATE_UPLOAD_NAMES[id];
  if (!allowedNames || !allowedNames.has(withObj.name)) return false;
  if (!withKeys.every((key) => GH_AW_UPLOAD_ALLOWED_WITH_KEYS.has(key))) return false;
  if (withObj['if-no-files-found'] !== 'ignore') return false;
  if (withObj.overwrite !== undefined && withObj.overwrite !== true) return false;
  if (withObj['include-hidden-files'] !== undefined && withObj['include-hidden-files'] !== true) return false;
  if (typeof withObj['retention-days'] !== 'string' || !GH_AW_RETENTION_EXPR.test(withObj['retention-days'].trim())) return false;
  const rawPath = typeof withObj.path === 'string'
    ? withObj.path.replace(/\r\n/g, '\n').trim()
    : '';
  if (!rawPath) return false;
  const paths = rawPath.split('\n').map((line) => line.trim()).filter(Boolean);
  return paths.length > 0 && paths.every((p) => isSafeTmpGhAwPath(p));
}

function isVerifiedBoilerplateDownloadStep(id, withObj, withKeys) {
  const specs = GH_AW_BOILERPLATE_DOWNLOAD_SPECS[id];
  if (!specs) return false;
  const sortedKeys = withKeys.slice().sort();
  return specs.some((spec) => (
    sortedKeys.length === spec.keys.length
    && sortedKeys.every((key, i) => key === spec.keys[i] && withObj[key] === spec[key])
  ));
}

function isVerifiedBoilerplateActionStep(id, step, allowedActions) {
  if (!PINNED_ACTION.test(step.uses)) return false;
  const actionRepo = step.uses.slice(0, step.uses.lastIndexOf('@'));
  const withObj = step.with && typeof step.with === 'object' ? step.with : {};
  const withKeys = Object.keys(withObj);

  if (actionRepo === 'github/gh-aw-actions/setup') {
    return step.name === 'Setup Scripts'
      && withObj.destination === '${{ runner.temp }}/gh-aw/actions'
      && withKeys.every((key) => GH_AW_SETUP_ALLOWED_WITH_KEYS.has(key));
  }
  if (actionRepo === 'actions/checkout') {
    const sparse = typeof withObj['sparse-checkout'] === 'string'
      ? withObj['sparse-checkout'].replace(/\r\n/g, '\n').trim()
      : '';
    return id === 'activation'
      && step.name === 'Checkout .github and .agents folders'
      && withKeys.length === GH_AW_CHECKOUT_EXACT_WITH_KEYS.length
      && withKeys.slice().sort().every((key, i) => key === GH_AW_CHECKOUT_EXACT_WITH_KEYS[i])
      && withObj['persist-credentials'] === false
      && withObj['sparse-checkout-cone-mode'] === true
      && withObj['fetch-depth'] === 1
      && sparse === GH_AW_ACTIVATION_SPARSE_CHECKOUT;
  }
  if (!allowedActions.has(actionRepo)) return false;
  if (actionRepo === 'actions/github-script') {
    if (!withKeys.every((key) => GH_AW_SCRIPT_ALLOWED_WITH_KEYS.has(key))) return false;
    const script = typeof withObj.script === 'string'
      ? withObj.script.replace(/\r\n/g, '\n').trim()
      : '';
    const match = script.match(GH_AW_GITHUB_SCRIPT_DISPATCH) || script.match(GH_AW_GITHUB_SCRIPT_PROMPT);
    if (!match) return false;
    return GH_AW_BOILERPLATE_CJS_MODULES[id]?.has(match[1]) === true;
  }
  if (actionRepo === 'actions/upload-artifact') {
    return isVerifiedBoilerplateUploadStep(id, withObj, withKeys);
  }
  if (actionRepo === 'actions/download-artifact') {
    return isVerifiedBoilerplateDownloadStep(id, withObj, withKeys);
  }
  return false;
}

function parseVerifiedGhAwLock(file, text, sourceMarkdown) {
  if (!file.endsWith('.lock.yml') || typeof sourceMarkdown !== 'string') return null;
  const lines = text.split(/\r?\n/);
  const metaMatch = lines[0]?.match(/^# gh-aw-metadata:\s*(\{.*\})$/);
  const manifestMatch = lines[1]?.match(/^# gh-aw-manifest:\s*(\{.*\})$/);
  if (!metaMatch || !manifestMatch) return null;

  let meta;
  let manifest;
  try {
    meta = JSON.parse(metaMatch[1]);
    manifest = JSON.parse(manifestMatch[1]);
  } catch {
    return null;
  }
  if (
    meta?.strict !== true
    || typeof meta?.compiler_version !== 'string'
    || !/^v\d+\.\d+\.\d+/.test(meta.compiler_version)
    || !SHA_64.test(meta?.frontmatter_hash ?? '')
    || !SHA_64.test(meta?.body_hash ?? '')
    || manifest?.version !== 1
    || !Array.isArray(manifest?.actions)
  ) {
    return null;
  }

  const parsedMd = parseMarkdownWorkflow(sourceMarkdown);
  if (!parsedMd || !parsedMd.frontmatter || typeof parsedMd.frontmatter !== 'object') return null;
  const computedBodyHash = createHash('sha256').update(parsedMd.body).digest('hex');
  if (computedBodyHash !== meta.body_hash) return null;
  // Require exact frontmatter_hash verification; reject workflows using imports or body env/vars
  // expressions from this exemption rather than skipping the frontmatter hash check.
  if (parsedMd.frontmatter.imports !== undefined || /\$\{\{\s*(?:env|vars)\./.test(parsedMd.body)) {
    return null;
  }
  const computedFrontmatterHash = computeGhAwFrontmatterHash(parsedMd.normalizedFrontmatter);
  if (computedFrontmatterHash !== meta.frontmatter_hash) return null;

  return { meta, manifest, frontmatter: parsedMd.frontmatter };
}

const GH_AW_ALLOWED_WORKFLOW_KEYS = new Set(['name', 'on', 'permissions', 'concurrency', 'run-name', 'env', 'jobs']);
const GH_AW_BOILERPLATE_ALLOWED_JOB_KEYS = new Set(['name', 'needs', 'if', 'runs-on', 'permissions', 'concurrency', 'env', 'outputs', 'steps']);
const GH_AW_SAFE_OUTPUT_ALLOWED_JOB_KEYS = new Set(['name', 'needs', 'if', 'runs-on', 'permissions', 'env', 'outputs', 'steps']);
const GH_AW_ALLOWED_BOILERPLATE_RUNNERS = new Set(['ubuntu-slim', 'ubuntu-latest']);
const GH_AW_BOILERPLATE_RUN_STEP_KEYS = new Set(['id', 'name', 'if', 'env', 'continue-on-error', 'run']);
const GH_AW_BOILERPLATE_USES_STEP_KEYS = new Set(['id', 'name', 'if', 'env', 'continue-on-error', 'uses', 'with']);
const GH_AW_SAFE_DOWNLOAD_STEP_KEYS = new Set(['name', 'uses', 'with', 'continue-on-error']);
const GH_AW_BOILERPLATE_ENV_KEY = /^(?:GH_AW_|OTEL_)[A-Z0-9_]+$/;

function hasOnlyAllowedKeys(obj, allowedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.keys(obj).every((key) => allowedKeys.has(key));
}

function hasSafeBoilerplateEnv(env, { allowCopilotTokenSecret = false } = {}) {
  if (env === undefined) return true;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  for (const [key, value] of Object.entries(env)) {
    if (allowCopilotTokenSecret && key === 'COPILOT_GITHUB_TOKEN' && value === '${{ secrets.COPILOT_GITHUB_TOKEN }}') {
      continue;
    }
    if (!GH_AW_BOILERPLATE_ENV_KEY.test(key)) return false;
    if (key === 'GH_AW_ACTIONS_DIR' && value !== '${{ runner.temp }}/gh-aw/actions') return false;
  }
  return true;
}

function isVerifiedBoilerplateJob(id, job, frontmatter) {
  if (!GH_AW_BOILERPLATE_JOBS.has(id)) return false;
  if (Object.hasOwn(frontmatter?.jobs ?? {}, id)) return false;
  if (!hasOnlyAllowedKeys(job, GH_AW_BOILERPLATE_ALLOWED_JOB_KEYS)) return false;
  if (!GH_AW_ALLOWED_BOILERPLATE_RUNNERS.has(job['runs-on'])) return false;
  if (!hasSafeBoilerplateEnv(job.env)) return false;
  if (job.concurrency !== undefined) {
    if (id !== 'conclusion' || !job.concurrency || typeof job.concurrency !== 'object' || Array.isArray(job.concurrency)) {
      return false;
    }
    const cKeys = Object.keys(job.concurrency);
    if (!cKeys.every((key) => key === 'group' || key === 'cancel-in-progress' || key === 'queue')) return false;
    if (typeof job.concurrency.group !== 'string' || !job.concurrency.group.startsWith('gh-aw-conclusion-')) return false;
    if (job.concurrency['cancel-in-progress'] !== undefined && job.concurrency['cancel-in-progress'] !== false) return false;
    if (job.concurrency.queue !== undefined && job.concurrency.queue !== 'max') return false;
  }
  const allowedActions = GH_AW_BOILERPLATE_ALLOWED_ACTIONS[id];
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (steps.length === 0) return false;
  const setupStep = steps[0];
  if (setupStep?.name !== 'Setup Scripts' || !GH_AW_SETUP_ACTION.test(setupStep?.uses ?? '')) {
    return false;
  }
  return steps.every((step) => {
    const normalizedRun = typeof step?.run === 'string' ? step.run.replace(/\r\n/g, '\n').trim() : '';
    const allowCopilotTokenSecret = id === 'activation'
      && (normalizedRun === GH_AW_VALIDATE_COPILOT_SECRET_RUN
        || normalizedRun === 'bash "${RUNNER_TEMP}/gh-aw/actions/check_oauth_tokens.sh"');
    if (!hasSafeBoilerplateEnv(step?.env, { allowCopilotTokenSecret })) return false;
    if (typeof step?.uses === 'string') {
      return hasOnlyAllowedKeys(step, GH_AW_BOILERPLATE_USES_STEP_KEYS)
        && isVerifiedBoilerplateActionStep(id, step, allowedActions);
    }
    if (typeof step?.run !== 'string') return false;
    if (!hasOnlyAllowedKeys(step, GH_AW_BOILERPLATE_RUN_STEP_KEYS)) return false;
    const scriptMatch = normalizedRun.match(GH_AW_BOILERPLATE_ACTION_SCRIPT);
    if (scriptMatch) return GH_AW_BOILERPLATE_SH_SCRIPTS[id]?.has(scriptMatch[1]) === true;
    return GH_AW_BOILERPLATE_EXACT_RUNS.has(normalizedRun);
  });
}

function isCompilerSafeJobDownloadStep(step) {
  if (!hasOnlyAllowedKeys(step, GH_AW_SAFE_DOWNLOAD_STEP_KEYS)) return false;
  if (step?.name !== 'Download agent output artifact' || !GH_AW_DOWNLOAD_ARTIFACT.test(step?.uses ?? '')) {
    return false;
  }
  const withObj = step.with && typeof step.with === 'object' ? step.with : {};
  const keys = Object.keys(withObj).sort();
  return keys.length === 3
    && keys[0] === 'merge-multiple'
    && keys[1] === 'path'
    && keys[2] === 'pattern'
    && withObj['merge-multiple'] === true
    && withObj.pattern === '{agent,agent-output-fallback}'
    && withObj.path === '${{ runner.temp }}/gh-aw/safe-jobs/';
}

function isStepBoundedSafeOutputJob(id, job, frontmatter) {
  const safeOutputsTimeoutOk = hasValidTimeout(frontmatter?.['safe-outputs']?.['timeout-minutes']);
  const safeOutputJobsById = new Map(
    Object.entries(frontmatter?.['safe-outputs']?.jobs ?? {}).map(([name, cfg]) => [name.replaceAll('-', '_'), cfg]),
  );
  if (!safeOutputsTimeoutOk || !safeOutputJobsById.has(id)) return false;
  if (!hasOnlyAllowedKeys(job, GH_AW_SAFE_OUTPUT_ALLOWED_JOB_KEYS)) return false;
  if (!hasSafeBoilerplateEnv(job.env)) return false;
  const expectedRunner = safeOutputJobsById.get(id)?.['runs-on'] ?? 'ubuntu-latest';
  if (job['runs-on'] !== expectedRunner) return false;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (steps.length < 2) return false;
  const [firstStep, ...authoredSteps] = steps;
  // gh-aw v1.2.2 prepends the compiler-managed "Download agent output artifact" step without a
  // timeout; verify its exact compiler inputs and require explicit timeout-minutes on every authored step.
  const stepsToCheck = isCompilerSafeJobDownloadStep(firstStep) ? authoredSteps : steps;
  return stepsToCheck.length > 0 && stepsToCheck.every((step) => hasValidTimeout(step?.['timeout-minutes']));
}

function findJobsMissingTimeout(entries) {
  const missing = [];
  for (const { file, text, sourceMarkdown } of entries) {
    const flow = YAML.parse(text);
    const ghAw = parseVerifiedGhAwLock(file, text, sourceMarkdown);
    const workflowInheritsSafe = Boolean(ghAw)
      && hasOnlyAllowedKeys(flow, GH_AW_ALLOWED_WORKFLOW_KEYS)
      && hasSafeBoilerplateEnv(flow?.env);

    for (const [id, job] of Object.entries(flow?.jobs ?? {})) {
      if (job?.uses) continue;
      if (hasValidTimeout(job?.['timeout-minutes'])) continue;

      if (workflowInheritsSafe) {
        if (isVerifiedBoilerplateJob(id, job, ghAw.frontmatter)) continue;
        if (isStepBoundedSafeOutputJob(id, job, ghAw.frontmatter)) continue;
      }

      missing.push(`${file}: ${id}`);
    }
  }
  return missing;
}

test('every non-reusable workflow job declares an explicit timeout-minutes', async () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const files = await readdir(dir);
  const fileSet = new Set(files);
  const entries = [];
  for (const file of files.filter((name) => name.endsWith('.yml')).sort()) {
    const text = await readFile(new URL(file, dir), 'utf8');
    let sourceMarkdown = null;
    if (file.endsWith('.lock.yml')) {
      const mdName = `${file.slice(0, -'.lock.yml'.length)}.md`;
      if (fileSet.has(mdName)) {
        sourceMarkdown = await readFile(new URL(mdName, dir), 'utf8');
      }
    }
    entries.push({ file, text, sourceMarkdown });
  }
  const missing = findJobsMissingTimeout(entries);
  assert.deepEqual(missing, [], `jobs missing explicit timeout-minutes: ${missing.join(', ')}`);
});

test('gh-aw timeout exemption requires verified frontmatter/body hashes, exact compiler boilerplate steps, and timeouts on every authored safe-output step', () => {
  const body = 'Inspect unused code candidates.';
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const setupSha = '53d0749e19424a918acd82b4d140264ce48f2f14';
  const downloadSha = '9000827ccba6bdab643e8b6fd33ac0654aef8333';
  const checkoutSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
  const frontmatterText = [
    'name: demo',
    'max-turns: 25',
    'safe-outputs:',
    '  timeout-minutes: 10',
    '  jobs:',
    '    record-finding:',
    '      runs-on: ubuntu-latest',
  ].join('\n');
  const frontmatterHash = computeGhAwFrontmatterHash(frontmatterText);
  const validMd = ['---', frontmatterText, '---', body].join('\n');
  const validHeader = [
    `# gh-aw-metadata: ${JSON.stringify({ schema_version: 'v4', frontmatter_hash: frontmatterHash, body_hash: bodyHash, compiler_version: 'v1.2.2', strict: true })}`,
    `# gh-aw-manifest: ${JSON.stringify({ version: 1, actions: [] })}`,
  ].join('\n');
  const validLock = [
    validHeader,
    'jobs:',
    '  activation:',
    '    runs-on: ubuntu-slim',
    '    steps:',
    '      - name: Setup Scripts',
    `        uses: github/gh-aw-actions/setup@${setupSha}`,
    '        with:',
    '          destination: ${{ runner.temp }}/gh-aw/actions',
    '      - name: Checkout .github and .agents folders',
    `        uses: actions/checkout@${checkoutSha}`,
    '        with:',
    '          persist-credentials: false',
    '          sparse-checkout: |',
    '            .github',
    '            .agents',
    '            .claude',
    '            .codex',
    '            .gemini',
    '            .pi',
    '          sparse-checkout-cone-mode: true',
    '          fetch-depth: 1',
    '      - run: bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh"',
    '  agent:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 20',
    '  detection:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '  safe_outputs:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '  record_finding:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Download agent output artifact',
    `        uses: actions/download-artifact@${downloadSha}`,
    '        with:',
    '          pattern: "{agent,agent-output-fallback}"',
    '          merge-multiple: true',
    '          path: ${{ runner.temp }}/gh-aw/safe-jobs/',
    `      - uses: actions/checkout@${checkoutSha}`,
    '        timeout-minutes: 5',
    '      - run: echo ok',
    '        timeout-minutes: 5',
    '  conclusion:',
    '    runs-on: ubuntu-slim',
    '    steps:',
    '      - name: Setup Scripts',
    `        uses: github/gh-aw-actions/setup@${setupSha}`,
    '        with:',
    '          destination: ${{ runner.temp }}/gh-aw/actions',
    '      - name: Download workflow metadata',
    `        uses: actions/download-artifact@${downloadSha}`,
    '        with:',
    '          name: info',
    '          path: /tmp/gh-aw/',
    '      - name: Process no-op messages',
    '        uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
    '        with:',
    '          script: |',
    "            const path = require('path');",
    "            const actionsDir = path.join(process.env.RUNNER_TEMP, 'gh-aw', 'actions');",
    "            const { setupGlobals } = require(path.join(actionsDir, 'setup_globals.cjs'));",
    '            setupGlobals(core, github, context, exec, io, getOctokit);',
    "            const { main } = require(path.join(actionsDir, 'handle_noop_message.cjs'));",
    '            await main();',
  ].join('\n');
  assert.deepEqual(findJobsMissingTimeout([{ file: 'demo.lock.yml', text: validLock, sourceMarkdown: validMd }]), []);

  // Normal .yml workflows get no exemption even with gh-aw headers and job IDs.
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'regular.yml', text: validLock, sourceMarkdown: validMd }]),
    ['regular.yml: activation', 'regular.yml: record_finding', 'regular.yml: conclusion'],
  );

  // Stale frontmatter (including adding imports alongside edits) or stale body rejects the exemption.
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: validLock, sourceMarkdown: validMd.replace('max-turns: 25', 'max-turns: 99') }]),
    ['demo.lock.yml: activation', 'demo.lock.yml: record_finding', 'demo.lock.yml: conclusion'],
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: validLock, sourceMarkdown: validMd.replace('max-turns: 25', 'imports: []\nmax-turns: 99') }]),
    ['demo.lock.yml: activation', 'demo.lock.yml: record_finding', 'demo.lock.yml: conclusion'],
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: validLock, sourceMarkdown: `${validMd}\nextra line` }]),
    ['demo.lock.yml: activation', 'demo.lock.yml: record_finding', 'demo.lock.yml: conclusion'],
  );

  // Appending arbitrary shell commands or unexpected pinned action steps to boilerplate jobs rejects the exemption.
  const appendedBoilerplate = validLock.replace(
    'bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh"',
    'bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh" && pnpm test',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: appendedBoilerplate, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation'],
  );
  const injectedConclusionCheckout = `${validLock}\n      - uses: actions/checkout@${checkoutSha}\n`;
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: injectedConclusionCheckout, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  // Appending a pinned actions/github-script step with custom inline JS (e.g. a 60s wait) to conclusion rejects the exemption.
  const injectedCustomScript = [
    validLock,
    '      - name: Wait',
    '        uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
    '        with:',
    '          script: await new Promise((r) => setTimeout(r, 60000));',
  ].join('\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: injectedCustomScript, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  // Altering activation sparse-checkout pattern or adding extra checkout inputs (e.g. lfs: true) rejects the exemption.
  const alteredSparseCheckout = validLock.replace('            .pi\n', '            apps\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: alteredSparseCheckout, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation'],
  );
  const extraCheckoutInput = validLock.replace('          fetch-depth: 1\n', '          fetch-depth: 1\n          lfs: true\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: extraCheckoutInput, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation'],
  );
  // Changing conclusion dispatcher module or escaping /tmp/gh-aw/ via `..` or changing safe-output download path rejects the exemption.
  const alteredModule = validLock.replace('handle_noop_message.cjs', 'different_module.cjs');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: alteredModule, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  const traversalDownload = validLock.replace('          path: /tmp/gh-aw/\n', '          path: /tmp/gh-aw/../review-demo/\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: traversalDownload, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  const expressionDownload = validLock.replace('          path: /tmp/gh-aw/\n', '          path: /tmp/gh-aw/${{ github.event.inputs.dir }}\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: expressionDownload, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  const alteredSelectorDownload = validLock.replace('          name: info\n', '          name: other-artifact\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: alteredSelectorDownload, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  const alteredSafeDownload = validLock.replace('          path: ${{ runner.temp }}/gh-aw/safe-jobs/\n', '          path: /tmp/review-demo/\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: alteredSafeDownload, sourceMarkdown: validMd }]),
    ['demo.lock.yml: record_finding'],
  );

  // Adding job-level execution settings (services, container, strategy) to boilerplate or safe-output jobs rejects the exemption.
  const conclusionWithServices = validLock.replace(
    '  conclusion:\n    runs-on: ubuntu-slim\n',
    '  conclusion:\n    runs-on: ubuntu-slim\n    services:\n      redis:\n        image: redis:7\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: conclusionWithServices, sourceMarkdown: validMd }]),
    ['demo.lock.yml: conclusion'],
  );
  const activationWithContainer = validLock.replace(
    '  activation:\n    runs-on: ubuntu-slim\n',
    '  activation:\n    runs-on: ubuntu-slim\n    container: node:22\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: activationWithContainer, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation'],
  );
  const safeJobWithServices = validLock.replace(
    '  record_finding:\n    runs-on: ubuntu-latest\n',
    '  record_finding:\n    runs-on: ubuntu-latest\n    services:\n      redis:\n        image: redis:7\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: safeJobWithServices, sourceMarkdown: validMd }]),
    ['demo.lock.yml: record_finding'],
  );

  // Adding custom step execution settings (shell, working-directory, or non-GH_AW env vars like BASH_ENV) rejects the exemption.
  const activationWithCustomShell = validLock.replace(
    '      - run: bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh"\n',
    '      - shell: python3 {0}\n        run: bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh"\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: activationWithCustomShell, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation'],
  );
  const activationWithBashEnv = validLock.replace(
    '      - run: bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh"\n',
    '      - env:\n          BASH_ENV: /tmp/evil.sh\n        run: bash "${RUNNER_TEMP}/gh-aw/actions/mask_otlp_headers.sh"\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: activationWithBashEnv, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation'],
  );
  const safeDownloadWithEnv = validLock.replace(
    '      - name: Download agent output artifact\n',
    '      - name: Download agent output artifact\n        env:\n          NODE_OPTIONS: --require=/tmp/evil.js\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: safeDownloadWithEnv, sourceMarkdown: validMd }]),
    ['demo.lock.yml: record_finding'],
  );

  // Inherited workflow-level defaults.run / env or safe-output job-level env also rejects the exemption.
  const workflowWithDefaults = validLock.replace(
    'jobs:\n',
    'defaults:\n  run:\n    shell: python3 {0}\njobs:\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: workflowWithDefaults, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation', 'demo.lock.yml: record_finding', 'demo.lock.yml: conclusion'],
  );
  const workflowWithEnv = validLock.replace(
    'jobs:\n',
    'env:\n  BASH_ENV: /tmp/evil.sh\njobs:\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: workflowWithEnv, sourceMarkdown: validMd }]),
    ['demo.lock.yml: activation', 'demo.lock.yml: record_finding', 'demo.lock.yml: conclusion'],
  );
  const safeJobWithEnv = validLock.replace(
    '  record_finding:\n    runs-on: ubuntu-latest\n',
    '  record_finding:\n    runs-on: ubuntu-latest\n    env:\n      NODE_OPTIONS: --require=/tmp/evil.js\n',
  );
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: safeJobWithEnv, sourceMarkdown: validMd }]),
    ['demo.lock.yml: record_finding'],
  );

  // Untimed `uses:` action step inside a safe-output job STILL fails.
  const untimedActionStep = validLock.replace(`      - uses: actions/checkout@${checkoutSha}\n        timeout-minutes: 5\n`, `      - uses: actions/checkout@${checkoutSha}\n`);
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: untimedActionStep, sourceMarkdown: validMd }]),
    ['demo.lock.yml: record_finding'],
  );

  // Core gh-aw jobs (agent, detection, safe_outputs) and custom non-safe-output jobs still require job-level timeout-minutes.
  const missingCore = [
    validHeader,
    'jobs:',
    '  agent:',
    '    runs-on: ubuntu-latest',
    '  detection:',
    '    runs-on: ubuntu-latest',
    '  safe_outputs:',
    '    runs-on: ubuntu-latest',
    '  custom_extra:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.deepEqual(
    findJobsMissingTimeout([{ file: 'demo.lock.yml', text: missingCore, sourceMarkdown: validMd }]),
    ['demo.lock.yml: agent', 'demo.lock.yml: detection', 'demo.lock.yml: safe_outputs', 'demo.lock.yml: custom_extra'],
  );
});

function staticStringValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function moduleSpecifiers(source, filePath) {
  const ast = sourceParser.parse(source, { filePath, sourceType: 'module' });
  const specifiers = [];
  const requireBindings = new Set(['require']);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (
      node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && node.init?.type === 'CallExpression'
      && (
        (node.init.callee?.type === 'Identifier' && node.init.callee.name === 'createRequire')
        || (node.init.callee?.type === 'MemberExpression' && node.init.callee.property?.type === 'Identifier' && node.init.callee.property.name === 'createRequire')
      )
    ) {
      requireBindings.add(node.id.name);
    }
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && typeof node.source?.value === 'string'
    ) {
      specifiers.push(node.source.value);
    } else if (node.type === 'ImportExpression') {
      const value = staticStringValue(node.source);
      if (value !== null) specifiers.push(value);
    } else if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && requireBindings.has(node.callee.name)
    ) {
      const value = staticStringValue(node.arguments?.[0]);
      if (value !== null) specifiers.push(value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  return specifiers;
}

function isFile(filePath) {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function resolveLocalModule(fromFile, specifier, repoRoot) {
  const cleaned = specifier.split(/[?#]/, 1)[0];
  let base;
  if (cleaned.startsWith('file:')) {
    base = fileURLToPath(cleaned);
    if (!base.startsWith(repoRoot)) return null;
  } else {
    base = resolve(dirname(fromFile), cleaned);
  }
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    resolve(base, 'index.js'),
    resolve(base, 'index.mjs'),
    resolve(base, 'index.cjs'),
  ];
  return candidates.find(isFile) ?? null;
}

const NODE_VALUE_FLAGS = new Set([
  '-r', '-C', '--require', '--import', '--loader', '--experimental-loader', '--conditions',
  '--env-file', '--env-file-if-exists', '--test-name-pattern', '--test-skip-pattern',
  '--test-reporter', '--test-reporter-destination', '--test-shard', '--input-type',
]);
const REPO_ENTRY = /^(?:\.\/)?((?:scripts|packages|exes|test|test-utils)\/[\w./-]+\.[cm]?js)$/;

function preInstallNodeEntries(runText) {
  const entries = [];
  let installed = false;
  const normalized = runText.replace(/\\\r?\n/g, ' ');
  for (const rawLine of normalized.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    for (const segment of trimmed.split(/\s*(?:&&|\|\||;)\s*/)) {
      if (!segment) continue;
      if (/\b(?:pnpm\s+install|npm\s+(?:ci|install))\b/.test(segment) && !/--lockfile-only\b/.test(segment)) {
        installed = true;
        continue;
      }
      if (installed) continue;
      const tokens = [...segment.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i] !== 'node') continue;
        let j = i + 1;
        let evalMode = false;
        while (j < tokens.length && tokens[j].startsWith('-')) {
          const flag = tokens[j];
          if (flag === '-e' || flag === '--eval' || flag === '-p' || flag === '--print') {
            evalMode = true;
            break;
          }
          j += NODE_VALUE_FLAGS.has(flag) ? 2 : 1;
        }
        if (evalMode) continue;
        while (j < tokens.length && !tokens[j].startsWith('-')) {
          const match = tokens[j].match(REPO_ENTRY);
          if (match) entries.push(match[1]);
          j += 1;
        }
      }
    }
  }
  return { entries, installed };
}

test('workflow scripts executed before pnpm install import only Node built-ins', async () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const dir = new URL('../.github/workflows/', import.meta.url);
  const actionStepsCache = new Map();
  const expandSteps = async (steps) => {
    const expanded = [];
    for (const step of steps ?? []) {
      if (typeof step.uses === 'string' && step.uses.startsWith('./.github/actions/')) {
        if (!actionStepsCache.has(step.uses)) {
          const actionFile = resolve(repoRoot, step.uses, 'action.yml');
          const action = isFile(actionFile) ? YAML.parse(await readFile(actionFile, 'utf8')) : null;
          actionStepsCache.set(step.uses, action?.runs?.steps ?? []);
        }
        expanded.push(...actionStepsCache.get(step.uses));
      } else {
        expanded.push(step);
      }
    }
    return expanded;
  };

  const preInstallScripts = new Map();
  for (const file of (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const flow = YAML.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [jobId, job] of Object.entries(flow.jobs ?? {})) {
      let installed = false;
      for (const step of await expandSteps(job.steps)) {
        if (typeof step.run !== 'string' || installed) continue;
        const result = preInstallNodeEntries(step.run);
        for (const entry of result.entries) {
          if (!isFile(resolve(repoRoot, entry))) continue;
          const callers = preInstallScripts.get(entry) ?? [];
          if (!callers.includes(`${file}:${jobId}`)) callers.push(`${file}:${jobId}`);
          preInstallScripts.set(entry, callers);
        }
        if (result.installed) installed = true;
      }
    }
  }
  assert.ok(preInstallScripts.has('scripts/ci-usage-report.mjs'), 'ci-usage-report.mjs runs without pnpm install and must be checked');
  assert.ok(preInstallScripts.has('packages/desktop/test/source-approval.test.js'), 'desktop source-approval test runs without pnpm install and must be checked');

  const violations = [];
  for (const [entry, callers] of [...preInstallScripts].sort()) {
    const visited = new Set();
    const pending = [resolve(repoRoot, entry)];
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, 'utf8');
      const from = relative(repoRoot, file).replaceAll('\\', '/');
      for (const specifier of moduleSpecifiers(source, file)) {
        if (isBuiltin(specifier)) continue;
        if (specifier.startsWith('.') || specifier.startsWith('file:')) {
          const target = resolveLocalModule(file, specifier, repoRoot);
          if (!target) {
            violations.push(`${entry} (${callers.join(', ')}): ${from} has unresolved local import "${specifier}"`);
            continue;
          }
          if (/\.[cm]?js$/.test(target)) pending.push(target);
          continue;
        }
        violations.push(`${entry} (${callers.join(', ')}): ${from} imports non-builtin "${specifier}"`);
      }
    }
  }
  assert.deepEqual(violations, [], `scripts run before pnpm install must not import packages:\n${violations.join('\n')}`);
});
