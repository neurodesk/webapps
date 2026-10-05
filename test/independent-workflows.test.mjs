import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';

async function workflow(name) {
  return YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

test('desktop builds run on the daily schedule or by hand, and publish only on schedule unless asked', async () => {
  const flow = await workflow('standalone');
  assert.deepEqual(flow.on, {
    schedule: [{ cron: '23 3 * * *' }],
    workflow_dispatch: { inputs: { publish: { description: 'Publish the desktop release when every job passes', type: 'boolean', default: false } } },
  });
  assert.equal(flow.concurrency['cancel-in-progress'], false);
  assert.equal(flow.jobs.publish.if, "github.event_name == 'schedule' || inputs.publish");
  assert.deepEqual(flow.jobs.publish.needs, ['bundle', 'desktop', 'models-offline']);
  assert.ok(flow.jobs.bundle.steps.some(step => step.run === 'pnpm build'));
  assert.equal(flow.jobs.bundle.outputs.release_date, '${{ steps.date.outputs.release_date }}');
  for (const [name, job] of Object.entries(flow.jobs)) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with?.ref, undefined, 'use the scheduled run commit for every job');
    const stamp = job.steps.find(step => step.run === 'node scripts/desktop/daily-version.mjs');
    assert.equal(stamp.env.DESKTOP_RELEASE_DATE, name === 'bundle'
      ? '${{ steps.date.outputs.release_date }}'
      : '${{ needs.bundle.outputs.release_date }}');
  }
});

test('web releases and deployments do not wait for the desktop suite', async () => {
  for (const name of ['release', 'deploy-pages']) {
    const flow = await workflow(name);
    assert.doesNotMatch(JSON.stringify(flow), /scripts\/desktop\/|standalone\.yml/);
  }
});

test('routine CI uses the lightweight SCT gate and full inference runs independently', async () => {
  const ci = await workflow('ci');
  const full = await workflow('sct-full-tests');
  const release = await workflow('release');
  const registry = await loadAppsRegistry();
  const entry = createAppPlan(registry, ['apps/spinalcordtoolbox/package.json']).apps.include[0];
  const step = ci.jobs['app-tests'].steps.find(step => step.name === 'Test ${{ matrix.app }}');
  assert.equal(entry.release_test, 'test:release');
  assert.equal(step.env.TEST_SCRIPT, '${{ matrix.release_test }}');
  assert.match(step.run, /run "\$TEST_SCRIPT"/);
  assert.deepEqual(Object.keys(full.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(full.jobs['full-suite']['timeout-minutes'], 240);
  assert.equal(full.jobs['full-suite'].env.SCT_WORKER_TIMEOUT_MINUTES, '30');
  assert.equal(full.concurrency['cancel-in-progress'], false);
  for (const flow of [ci, release]) {
    assert.ok(!JSON.stringify(flow).includes('sct-full-tests'));
  }
});

test('native packages share one gated publisher while signing stays isolated', async () => {
  const flow = await workflow('synthsr-native');
  assert.deepEqual(flow.permissions, {contents: 'read'});
  assert.equal(flow.jobs.release.if, "github.event_name == 'workflow_dispatch' && inputs.sign_release");
  assert.deepEqual(flow.jobs.release.needs, ['portable', 'macos']);
  assert.deepEqual(
    flow.jobs.portable.strategy.matrix.include.map(entry => entry.platform).sort(),
    ['linux-x64', 'windows-x64'],
  );
  const linux = flow.jobs.portable.strategy.matrix.include.find(entry => entry.platform === 'linux-x64');
  assert.equal(linux.os, 'ubuntu-24.04');
  assert.ok(!JSON.stringify(flow.jobs.portable).includes('secrets.'));
  assert.ok(!JSON.stringify(flow.jobs.macos).includes('secrets.'));
  assert.match(JSON.stringify(flow.jobs.portable), /portable_release\.py package/);
  assert.match(JSON.stringify(flow.jobs.portable), /portable_release\.py verify/);
  const steps = flow.jobs.release.steps;
  const target = steps.findIndex(step => step.name === 'Check release target');
  const sign = steps.findIndex(step => step.name === 'Sign and notarize installer');
  const publish = steps.findIndex(step => step.name === 'Attach verified release assets');
  assert.ok(target >= 0 && target < sign && sign < publish);
  assert.match(steps[target].run, /isDraft or .isPrerelease/);
  assert.match(steps[target].run, /git rev-parse/);
  assert.match(steps[target].run, /GITHUB_SHA/);
  assert.ok(steps.some(step => step.uses?.startsWith('actions/download-artifact@')));
});

test('native and independent test workflows pin actions and discard checkout credentials', async () => {
  for (const name of ['synthsr-native', 'synthseg-native', 'syncro-native', 'greedy-native', 'sct-full-tests', 'native-nifti', 'native-result-publish']) {
    const flow = await workflow(name);
    for (const job of Object.values(flow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses) continue;
        if (step.uses === './.github/actions/setup-wasm-opt') continue;
        assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
        if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      }
    }
  }
});

test('native result publication runs model-free on every supported desktop platform', async () => {
  const flow = await workflow('native-result-publish');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.deepEqual(flow.jobs.filesystem.strategy.matrix.os, ['ubuntu-24.04', 'windows-latest', 'macos-latest']);
  const checks = flow.jobs.filesystem.steps.filter(step => step.run);
  assert.equal(checks.length, 4, 'each check has its own exit status on Windows too');
  for (const step of checks) assert.equal(step.run.split('\n').length, 1);
  const commands = checks.map(step => step.run).join('\n');
  assert.match(commands, /cargo test --locked --offline --manifest-path exes\/result-publish\/Cargo.toml/);
  assert.match(commands, /cargo test --locked --offline --release --manifest-path exes\/result-publish\/Cargo.toml/);
  assert.doesNotMatch(commands, /check-model|fetch_model|test-real/);
  for (const event of ['pull_request', 'push']) {
    assert.ok(flow.on[event].paths.includes('exes/result-publish/**'));
    assert.ok(flow.on[event].paths.includes('exes/synthsr/src/main.rs'));
    assert.ok(flow.on[event].paths.includes('exes/synthseg/src/main.rs'));
  }
  for (const name of ['synthsr-native', 'synthseg-native']) {
    const native = await workflow(name);
    assert.ok(native.on.pull_request.paths.includes('exes/result-publish/**'));
  }
});

test('SYNcro portable builds use target runners and one gated publisher', async () => {
  const flow=await workflow('syncro-native');
  assert.deepEqual(flow.permissions,{contents:'read'});
  assert.equal(flow.jobs.release.if,"github.event_name == 'workflow_dispatch' && inputs.publish_release");
  assert.deepEqual(flow.jobs.release.needs,['portable']);
  assert.deepEqual(
    flow.jobs.portable.strategy.matrix.include.map(entry=>entry.platform).sort(),
    ['linux-x64','windows-x64'],
  );
  assert.ok(!JSON.stringify(flow.jobs.portable).includes('secrets.'));
  assert.match(JSON.stringify(flow.jobs.portable),/portable_release\.py package/);
  assert.match(JSON.stringify(flow.jobs.portable),/portable_release\.py verify/);
  const steps=flow.jobs.release.steps;
  const target=steps.findIndex(step=>step.name==='Check release target');
  const verify=steps.findIndex(step=>step.name==='Check portable release assets');
  const publish=steps.findIndex(step=>step.name==='Attach verified release assets');
  assert.ok(target>=0&&target<verify&&verify<publish);
  assert.match(steps[target].run,/git rev-parse/);
  assert.match(steps[target].run,/GITHUB_SHA/);
  assert.equal(flow.jobs.release.permissions.contents,'write');
});


test('SynthSeg verifies native parity before its isolated signing job', async () => {
  const flow = await workflow('synthseg-native');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.equal(flow.jobs.release.if, "github.event_name == 'workflow_dispatch' && inputs.sign_release");
  assert.equal(flow.jobs.release.needs, 'verify');
  assert.ok(!JSON.stringify(flow.jobs.verify).includes('secrets.'));
  assert.equal(flow.jobs.verify.env.SYNTHSEG_REAL_DEVICES, 'cpu');
  assert.equal(flow.jobs.release.env.SYNTHSEG_REAL_DEVICES, 'cpu');
  const verifySteps = flow.jobs.verify.steps;
  assert.ok(verifySteps.some(step => /make -C exes\/synthseg fmt lint test(?:\n|$)/.test(step.run || '')));
  assert.ok(verifySteps.some(step => step.run === 'make -C exes/synthseg test-real'));
  assert.ok(verifySteps.some(step => step.run === 'make -C exes/synthseg macos-pkg-adhoc'));
  assert.ok(verifySteps.some(step => /rm -f exes\/synthseg\/validation\/report.json/.test(step.run || '')));
  const evidence = verifySteps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(evidence.if, 'always()');
  assert.match(evidence.with.path, /validation\/report.json/);
  const steps = flow.jobs.release.steps;
  const target = steps.findIndex(step => step.name === 'Check release target');
  const sign = steps.findIndex(step => step.name === 'Sign and notarize installer');
  const publish = steps.findIndex(step => step.name === 'Attach verified release assets');
  assert.ok(target >= 0 && target < sign && sign < publish);
  assert.match(steps[target].run, /isDraft or .isPrerelease/);
  assert.match(steps[target].run, /GITHUB_SHA/);
});


test('shared NIfTI changes select both native suites and the model-free cross-platform gate', async () => {
  for (const name of ['synthsr-native', 'synthseg-native', 'native-nifti']) {
    const flow = await workflow(name);
    for (const trigger of [flow.on.pull_request, flow.on.push].filter(Boolean)) {
      assert.ok(trigger.paths.includes('exes/nifti/**'), `${name} selects shared decoding changes`);
      assert.ok(trigger.paths.includes('test-utils/native-nifti/**'), `${name} selects caller characterization changes`);
    }
  }
  const flow = await workflow('native-nifti');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.deepEqual(flow.jobs.core.strategy.matrix.os, ['ubuntu-24.04', 'windows-latest', 'macos-latest']);
  const core = flow.jobs.core.steps.map(step => step.run || '').join('\n');
  for (const manifest of ['exes/nifti/Cargo.toml', 'test-utils/native-nifti/Cargo.toml']) {
    assert.ok(core.includes(`cargo test --locked --manifest-path ${manifest}`));
    assert.ok(core.includes(`cargo test --locked --release --manifest-path ${manifest}`));
    assert.ok(core.includes(`cargo fmt --manifest-path ${manifest} --check`));
  }
  assert.ok(!JSON.stringify(flow).includes('secrets.'));
  assert.doesNotMatch(core, /fetch_model|test-real/);
  const steps = flow.jobs.wasm.steps;
  const tests = steps.flatMap((step, index) => step.run === 'node --test packages/synthseg/test/nifti.test.js' ? [index] : []);
  const build = steps.findIndex(step => step.run === 'make -C packages/synthseg wasm');
  assert.equal(tests.length, 2);
  assert.ok(tests[0] < build && build < tests[1]);
  assert.ok(steps.some(step => step.with?.targets === 'wasm32-unknown-unknown'));
  assert.ok(steps.some(step => step.with?.['node-version'] === 24));
  assert.ok(steps.some(step => step.uses === './.github/actions/setup-wasm-opt'));
});
