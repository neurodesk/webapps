import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';

async function workflow(name) {
  return YAML.parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

// Every workflow whose portable job calls the shared Node packager, with its package directory.
async function portableCallers() {
  const files = await readdir(new URL('../.github/workflows/', import.meta.url));
  const callers = [];
  for (const file of files.filter((name) => name.endsWith('.yml')).sort()) {
    const name = file.slice(0, -'.yml'.length);
    const flow = await workflow(name);
    if (flow.jobs?.portable?.uses === './.github/workflows/node-cli-portable.yml') callers.push([name, flow.jobs.portable.with.package]);
  }
  return callers;
}

async function packagesWithReleaseSpec() {
  const packages = [];
  for (const name of (await readdir(new URL('../packages/', import.meta.url))).sort()) {
    const spec = new URL(`../packages/${name}/release.json`, import.meta.url);
    if (await access(spec).then(() => true, () => false)) packages.push(`packages/${name}`);
  }
  return packages;
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
  const portable = (await portableCallers()).map(([name]) => name);
  for (const name of ['synthsr-native', 'synthseg-native', ...portable, 'node-cli-portable', 'greedy-native', 'sct-full-tests', 'native-nifti', 'native-publish']) {
    const flow = await workflow(name);
    for (const job of Object.values(flow.jobs)) {
      if (job.uses) assert.match(job.uses, /^\.\/\.github\/workflows\/[\w-]+\.yml$/, `${name}: ${job.uses}`);
      for (const step of job.steps || []) {
        if (!step.uses) continue;
        if (['./.github/actions/setup-wasm-opt', './.github/actions/windows-signing'].includes(step.uses)) continue;
        assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
        if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      }
    }
  }
});

test('portable Node command lines build on target runners and publish through one gated job', async () => {
  const shared=await workflow('node-cli-portable');
  assert.deepEqual(Object.keys(shared.on),['workflow_call']);
  assert.deepEqual(shared.permissions,{contents:'read'});
  assert.deepEqual(shared.jobs.portable.permissions,{contents:'read', 'id-token':'write'});
  assert.equal(shared.jobs.release.if,'inputs.publish_release');
  assert.deepEqual(shared.jobs.release.needs,['portable']);
  assert.equal(shared.jobs.release.permissions.contents,'write');
  assert.equal(shared.jobs.release['runs-on'],"${{ inputs.sign_release && 'macos-15' || 'ubuntu-latest' }}");
  const signing=['APPLEID','APPLEIDPASS','APPLE_TEAM_ID','CSC_LINK','CSC_KEY_PASSWORD','CSC_INSTALLER_LINK','CSC_INSTALLER_KEY_PASSWORD'];
  assert.deepEqual(Object.keys(shared.on.workflow_call.secrets),signing);
  assert.ok(!JSON.stringify(shared.jobs.portable).includes('secrets.'));
  const sign=shared.jobs.release.steps.find(step=>step.name==='Sign and notarize installer');
  assert.equal(sign.if,'inputs.sign_release');
  assert.match(sign.run,/^exes\/synthsr\/scripts\/ci_macos_release\.sh exes\/node-cli$/m);
  for(const name of signing)assert.equal(sign.env[name],`\${{ secrets.${name} }}`);
  const unsigned=shared.jobs.release.steps.filter(step=>step!==sign);
  assert.ok(!JSON.stringify(unsigned).includes('secrets.'),'signing secrets reach only the signing step');
  const upload=shared.jobs.portable.steps.find(step=>step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name,"${{ runner.os == 'macOS' && 'test-installer' || 'portable' }}-${{ matrix.platform }}");
  const build=JSON.stringify(shared.jobs.portable);
  for(const command of ['portable_release\\.py package','portable_release\\.py verify','test_portable_release\\.py','cargo test --manifest-path exes/node-cli/Cargo\\.toml','cargo clippy --manifest-path exes/node-cli/Cargo\\.toml --locked -- -D warnings','cargo fmt --manifest-path exes/node-cli/Cargo\\.toml --check']) {
    assert.match(build,new RegExp(command));
  }
  const steps=shared.jobs.release.steps;
  const target=steps.findIndex(step=>step.name==='Check release target');
  const signStep=steps.indexOf(sign);
  const verify=steps.findIndex(step=>step.name==='Check portable release assets');
  const publish=steps.findIndex(step=>step.name==='Attach verified release assets');
  assert.ok(target>=0&&target<signStep&&signStep<verify&&verify<publish);
  assert.match(steps[target].run,/tagPrefix/);
  assert.match(steps[target].run,/git rev-parse/);
  assert.match(steps[target].run,/GITHUB_SHA/);
  const runners={'linux-x64':'ubuntu-22.04','windows-x64':'windows-latest','macos-arm64':'macos-15'};
  const registry=await loadAppsRegistry();
  const callers=await portableCallers();
  assert.deepEqual(callers.map(([,packageDir])=>packageDir).sort(),await packagesWithReleaseSpec(),'every package with release.json has exactly one portable workflow');
  for(const [name,packageDir] of callers) {
    const flow=await workflow(name);
    assert.deepEqual(flow.permissions,{contents:'read'},name);
    assert.equal(flow.jobs.portable.uses,'./.github/workflows/node-cli-portable.yml',name);
    assert.equal(flow.jobs.portable.with.package,packageDir,name);
    const release=JSON.parse(await readFile(new URL(`../${packageDir}/release.json`,import.meta.url),'utf8'));
    // The archives attach to the app's own release, which exists only for apps the release plan includes.
    assert.equal(registry.apps.find(app=>app.id===release.app)?.ci.release,true,`${name}: ${release.app} is released, so ${release.app}-vVERSION exists`);
    const installer=Object.values(release.targets).some(target=>target.archive==='pkg');
    // A release with a macOS installer is published only by signing it.
    const publishInput=installer?'sign_release':'publish_release';
    assert.deepEqual(Object.keys(flow.on.workflow_dispatch.inputs),[publishInput],name);
    assert.equal(flow.jobs.portable.with.publish_release,`\${{ github.event_name == 'workflow_dispatch' && inputs.${publishInput} }}`,name);
    assert.equal(flow.jobs.portable.with.sign_release,installer?"${{ github.event_name == 'workflow_dispatch' && inputs.sign_release }}":undefined,name);
    assert.equal(Object.keys(flow.jobs.portable.secrets||{}).length,installer?7:0,name);
    const targets=JSON.parse(flow.jobs.portable.with.targets);
    assert.deepEqual(targets.map(entry=>entry.platform).sort(),Object.keys(release.targets).sort(),`${name} builds every release target`);
    for(const entry of targets)assert.equal(entry.os,runners[entry.platform],`${name} ${entry.platform}`);
    for(const trigger of [flow.on.pull_request,flow.on.push]) {
      for(const path of ['exes/node-cli/**','.github/workflows/node-cli-portable.yml',`${packageDir}/**`])assert.ok(trigger.paths.includes(path),`${name} selects ${path}`);
    }
  }
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

test('shared publication changes select both callers and independently test the dependency', async () => {
  for (const name of ['synthsr-native', 'synthseg-native', 'native-publish']) {
    const flow = await workflow(name);
    assert.ok(flow.on.pull_request, `${name} runs on pull requests`);
    for (const trigger of [flow.on.pull_request, flow.on.push].filter(Boolean)) {
      assert.ok(trigger.paths.includes('exes/native-publish/**'), `${name} selects shared publication changes`);
    }
  }
  const flow = await workflow('native-publish');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.deepEqual(flow.jobs.core.strategy.matrix.os, ['ubuntu-24.04', 'windows-latest', 'macos-latest']);
  const steps = flow.jobs.core.steps;
  const commands = steps.map(step => step.run || '').join('\n');
  const manifest = 'exes/native-publish/Cargo.toml';
  for (const command of [
    `cargo test --locked --manifest-path ${manifest}`,
    `cargo test --locked --release --manifest-path ${manifest}`,
    `cargo fmt --manifest-path ${manifest} --check`,
    `cargo clippy --locked --manifest-path ${manifest} --all-targets -- -D warnings`,
  ]) {
    assert.ok(commands.split('\n').includes(command), `isolated dependency gate runs ${command}`);
  }
  assert.ok(steps.some(step => step.with?.components === 'rustfmt, clippy'));
  assert.doesNotMatch(JSON.stringify(flow), /fetch_model|test-real|ort|setup-node|pnpm|secrets\./);
});
