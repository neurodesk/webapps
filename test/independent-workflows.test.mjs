import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { commandLineClosure } from '../scripts/lib/module-closure.mjs';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

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
    // A release.json with a tag is an external release, built by another repository.
    if (await readFile(spec, 'utf8').then((text) => !JSON.parse(text).tag, () => false)) packages.push(`packages/${name}`);
  }
  return packages;
}

test('desktop builds run on the daily schedule or by hand, and publish only on schedule unless asked', async () => {
  const flow = await workflow('standalone');
  assert.deepEqual(flow.on, {
    schedule: [{ cron: '23 3 * * *' }],
    workflow_dispatch: { inputs: {
      publish: { description: 'Publish the desktop release when every job passes', type: 'boolean', default: false },
      source_approval_only: { description: 'Run only the native Windows source approval tests', type: 'boolean', default: false },
    } },
  });
  assert.equal(flow.concurrency['cancel-in-progress'], false);
  assert.equal(flow.jobs.publish.if, "!inputs.source_approval_only && (github.event_name == 'schedule' || inputs.publish)");
  assert.deepEqual(flow.jobs.publish.needs, ['bundle', 'desktop', 'models-offline']);
  assert.ok(flow.jobs.bundle.steps.some(step => step.run === 'pnpm build'));
  assert.equal(flow.jobs.bundle.outputs.release_date, '${{ steps.date.outputs.release_date }}');
  for (const [name, job] of Object.entries(flow.jobs)) {
    if (job.uses) continue;
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

test('Standalone link checks run nightly and on main, never as a pull request gate', async () => {
  const flow = await workflow('standalone-links');
  assert.deepEqual(Object.keys(flow.on).sort(), ['push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(flow.on.push.branches, ['main']);
  assert.ok(flow.on.push.paths.includes('registry/standalone.json'));
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.ok(flow.jobs.links.steps.some(step => /node scripts\/check-standalone-links\.mjs/.test(step.run || '')));
  const ci = await workflow('ci');
  assert.doesNotMatch(JSON.stringify(ci), /check-standalone-links/);
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
  assert.match(steps[target].run, /gh release view "\$tag" >\/dev\/null/);
  assert.doesNotMatch(steps[target].run, /isDraft|isPrerelease/);
  assert.match(steps[target].run, /git rev-parse/);
  assert.match(steps[target].run, /GITHUB_SHA/);
  assert.ok(steps.some(step => step.uses?.startsWith('actions/download-artifact@')));
});

test('native and independent test workflows pin actions and discard checkout credentials', async () => {
  const portable = (await portableCallers()).map(([name]) => name);
  for (const name of ['synthsr-native', 'synthseg-native', ...portable, 'node-cli-portable', 'node-cli', 'greedy-native', 'sct-full-tests', 'native-nifti', 'native-publish', 'standalone-links', 'hmc-registration', 'n4-wasm-source', 'desktop-source-approval']) {
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

test('desktop source approval runs on Windows without an offline bundle or dependency install', async () => {
  const flow = await workflow('desktop-source-approval');
  for (const event of ['pull_request', 'push']) {
    for (const path of ['packages/desktop/src/**', 'packages/desktop/test/source-approval.test.js', '.github/workflows/desktop-source-approval.yml']) {
      assert.ok(flow.on[event].paths.includes(path), `${event}: ${path}`);
    }
  }
  assert.ok(Object.hasOwn(flow.on, 'workflow_dispatch'));
  assert.ok(Object.hasOwn(flow.on, 'workflow_call'));
  const job = flow.jobs['windows-paths'];
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job.needs, undefined);
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], 24);
  assert.deepEqual(job.steps.filter(step => step.run).map(step => step.run), ['node --test packages/desktop/test/source-approval.test.js']);
  const standalone = await workflow('standalone');
  assert.equal(standalone.jobs['source-approval'].uses, './.github/workflows/desktop-source-approval.yml');
  assert.equal(standalone.jobs['source-approval'].needs, undefined);
  for (const event of ['schedule', 'workflow_dispatch']) {
    for (const only of [false, true]) {
      for (const publish of [false, true]) {
        const context = { github: { event_name: event }, inputs: { source_approval_only: only, publish } };
        assert.equal(runInNewContext(standalone.jobs['source-approval'].if, context), event === 'workflow_dispatch' && only);
        assert.equal(runInNewContext(standalone.jobs.bundle.if, context), event !== 'workflow_dispatch' || !only);
        assert.equal(runInNewContext(standalone.jobs.publish.if, context), !only && (event === 'schedule' || publish));
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
    assert.deepEqual(Object.keys(flow.on.workflow_dispatch.inputs),[publishInput,...(name==='dwi2trx-native'?['tracking_only']:[])],name);
    assert.equal(flow.jobs.portable.with.publish_release,`\${{ github.event_name == 'workflow_dispatch' && inputs.${publishInput} }}`,name);
    assert.equal(flow.jobs.portable.with.sign_release,installer?"${{ github.event_name == 'workflow_dispatch' && inputs.sign_release }}":undefined,name);
    assert.equal(Object.keys(flow.jobs.portable.secrets||{}).length,installer?7:0,name);
    const targets=JSON.parse(flow.jobs.portable.with.targets);
    assert.deepEqual(targets.map(entry=>entry.platform).sort(),Object.keys(release.targets).sort(),`${name} builds every release target`);
    for(const entry of targets)assert.equal(entry.os,runners[entry.platform],`${name} ${entry.platform}`);
    for(const path of [`.github/workflows/${name}.yml`,`${packageDir}/**`])assert.ok(flow.on.pull_request.paths.includes(path),`${name} pull requests select ${path}`);
    for(const path of ['exes/node-cli/**','.github/workflows/node-cli-portable.yml',`${packageDir}/**`])assert.ok(flow.on.push.paths.includes(path),`${name} pushes select ${path}`);
    for(const path of ['exes/node-cli/**','.github/workflows/node-cli-portable.yml'])assert.ok(!flow.on.pull_request.paths.includes(path),`${name}: node-cli.yml gates ${path} on pull requests`);
    assert.equal(flow.jobs.portable.with.all_platforms_on_pull_request,undefined,`${name} builds linux-x64 only on pull requests`);
  }
});

test('manual DWI2TRX tracking diagnostics isolate Metal from reference and publication jobs', async () => {
  const flow = await workflow('dwi2trx-native');
  assert.equal(flow.on.workflow_dispatch.inputs.tracking_only.default, false);
  const tracking = flow.jobs.tracking;
  assert.equal(tracking['runs-on'], 'macos-15');
  assert.equal(tracking.needs, undefined);
  assert.equal(tracking.env.NEURODESK_HARDWARE_GPU, '1');
  assert.equal(tracking.env.NEURODESK_HARDWARE_GPU_VENDOR, 'apple');
  assert.ok(tracking.steps.some(step => /e2e\/real-data\.spec\.js.*--trace=on/.test(step.run ?? '')));
  assert.ok(tracking.steps.some(step => step.if === 'always()' && step.with?.name === 'dwi2trx-tracking-diagnostic'));
  for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
    for (const only of [false, true]) {
      const context = { github: { event_name: event }, inputs: { tracking_only: only, sign_release: true } };
      assert.equal(runInNewContext(tracking.if, context), event === 'workflow_dispatch' && only);
      for (const name of ['web-app-reference', 'portable']) {
        assert.equal(runInNewContext(flow.jobs[name].if, context), event !== 'workflow_dispatch' || !only);
      }
    }
  }
});

test('pull requests build the portable packager on linux-x64, except the packager gate', async () => {
  const shared=await workflow('node-cli-portable');
  const select=shared.jobs.runners.steps.find(step=>step.id==='select');
  assert.equal(select.env.LINUX_ONLY,"${{ github.event_name == 'pull_request' && !inputs.all_platforms_on_pull_request }}");
  assert.match(select.run,/select\(\.platform == "linux-x64"\)/);
  assert.deepEqual(shared.jobs.portable.needs,['runners']);
  assert.equal(shared.jobs.portable.strategy.matrix.include,'${{ fromJSON(needs.runners.outputs.targets) }}');
  const gate=await workflow('node-cli');
  assert.deepEqual(Object.keys(gate.on),['pull_request']);
  for(const path of ['exes/node-cli/**','.github/workflows/node-cli-portable.yml'])assert.ok(gate.on.pull_request.paths.includes(path));
  assert.equal(gate.jobs.packager.uses,'./.github/workflows/node-cli-portable.yml');
  assert.equal(gate.jobs.packager.with.all_platforms_on_pull_request,true);
  assert.deepEqual(JSON.parse(gate.jobs.packager.with.targets).map(entry=>entry.platform).sort(),['linux-x64','macos-arm64','windows-x64']);
});

test('the N4 module rebuild runs weekly or by hand and compares both committed files', async () => {
  const flow = await workflow('n4-wasm-source');
  assert.deepEqual(Object.keys(flow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(flow.on.schedule.length, 1);
  assert.match(flow.on.schedule[0].cron, /^\d+ \d+ \* \* \d$/, 'once a week');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.equal(flow.concurrency['cancel-in-progress'], false);
  assert.ok(!JSON.stringify(flow).includes('secrets.'));
  const steps = flow.jobs.rebuild.steps;
  assert.ok(steps.some(step => step.run === 'bash packages/n4/scripts/build.sh --check "$RUNNER_TEMP/n4-build"'));
  const script = await readFile(new URL('../packages/n4/scripts/build.sh', import.meta.url), 'utf8');
  for (const file of ['n4-bias.wasm', 'n4-bias.mjs']) assert.match(script, new RegExp(`for file in .*${file.replace('.', '\\.')}`));
  assert.match(script, /SOURCE_DATE_EPOCH="\$source_date_epoch"/, 'ANTsVersion.cxx compiles in __DATE__ and __TIME__');
});

test('a push to main never cancels the nightly full-catalog CI run', async () => {
  const ci = await workflow('ci');
  const group = (event, ref) => ci.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => runInNewContext(expression, {
    github: { workflow: 'ci', event_name: event, ref },
  }));
  assert.notEqual(group('schedule', 'refs/heads/main'), group('push', 'refs/heads/main'));
  assert.notEqual(group('pull_request', 'refs/pull/1/merge'), group('pull_request', 'refs/pull/2/merge'));
});

test('a push to main plans from the last green main run, so superseded merges are still tested', async () => {
  const ci = await workflow('ci');
  const job = ci.jobs['app-plan'];
  const step = job.steps.find((candidate) => candidate.id === 'plan');
  const evaluate = (value, github) => value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => runInNewContext(expression, { github }));
  const push = { event_name: 'push', event: { before: 'previous' }, sha: 'head' };
  const pullRequest = { event_name: 'pull_request', event: { pull_request: { base: { sha: 'base' }, head: { sha: 'head' } } } };
  assert.equal(evaluate(step.env.BASE_SHA, push), 'last-success');
  assert.equal(evaluate(step.env.BASE_SHA, pullRequest), 'base');
  for (const event_name of ['schedule', 'workflow_dispatch']) assert.equal(evaluate(step.env.BASE_SHA, { event_name, event: {} }), '');
  assert.match(step.run, /--base "\$BASE_SHA"/);
  assert.equal(step.env.GITHUB_TOKEN, '${{ github.token }}');
  assert.equal(job.permissions.actions, 'read');
  assert.equal(job.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout'))?.with?.['fetch-depth'], 0);
});

test('no pull request trigger depends on contract tests or release-only signing scripts', async () => {
  const files=(await readdir(new URL('../.github/workflows/',import.meta.url))).filter(name=>name.endsWith('.yml'));
  for(const file of files) {
    const flow=await workflow(file.slice(0,-'.yml'.length));
    const paths=flow.on?.pull_request?.paths??[];
    for(const path of ['test/independent-workflows.test.mjs','exes/synthsr/scripts/ci_macos_release.sh','exes/synthsr/scripts/notarize_macos.sh']) {
      assert.ok(!paths.includes(path),`${file} starts on ${path}`);
    }
    if(flow.on?.pull_request&&flow.concurrency)assert.notEqual(flow.concurrency['cancel-in-progress'],false,`${file} cancels superseded pull request runs`);
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
  assert.match(steps[target].run, /gh release view "\$tag" >\/dev\/null/);
  assert.doesNotMatch(steps[target].run, /isDraft|isPrerelease/);
  assert.match(steps[target].run, /GITHUB_SHA/);
  // A backfill builds a published tag's own source with main's workflow, never another ref's.
  assert.equal(flow.on.workflow_dispatch.inputs.release_tag.type, 'string');
  for (const job of [flow.jobs.verify, flow.jobs.release]) {
    assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ inputs.release_tag }}');
  }
  assert.equal(steps[target].env.BACKFILL_TAG, '${{ inputs.release_tag }}');
  assert.match(steps[target].run, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(steps[target].run, /test "\$BACKFILL_TAG" = "\$tag"/);
  assert.match(steps[target].run, /test "\$\(git rev-parse "\$tag\^\{commit\}"\)" = "\$\(git rev-parse HEAD\)"/);
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

test('live browser release checks are opt-in and provision a production app separately', async () => {
  const shared = await workflow('node-cli-portable');
  assert.equal(shared.on.workflow_call.inputs.validation_app.default, '');
  for (const [name, packageDir] of await portableCallers()) {
    const caller = await workflow(name);
    const spec = JSON.parse(await readFile(new URL(`../${packageDir}/release.json`, import.meta.url), 'utf8'));
    assert.equal(caller.jobs.portable.with.validation_app, spec.validationApp);
  }
  for (const name of ['Configure browser reference cache', 'Install browser reference Chromium', 'Build production browser reference app', 'Provision browser reference comparison']) {
    const build = shared.jobs.portable.steps.find(step => step.name === name);
    const release = shared.jobs.release.steps.find(step => step.name === name);
    assert.equal(build.if, "inputs.validation_app != ''");
    assert.equal(release.if, "inputs.sign_release && inputs.validation_app != ''");
  }
});

test('CPU Node driver parity skips optional CUDA installation', async () => {
  const flow = await workflow('node-drivers');
  assert.equal(flow.env.ONNXRUNTIME_NODE_INSTALL, 'skip');
  assert.ok(flow.jobs.node.steps.some(step => step.run === 'pnpm install --frozen-lockfile'));
});

test('Brain2Print browser CPU parity skips optional CUDA installation', async () => {
  const flow = await workflow('brain2print-native');
  const job = flow.jobs['browser-reference'];
  const install = job.steps.find(step => step.run === 'pnpm install --frozen-lockfile');
  assert.equal(install.env.ONNXRUNTIME_NODE_INSTALL, 'skip');
  assert.ok(job.steps.some(step => step.run === 'node packages/brain2print/validation/browser-reference.mjs --check'));
});

// GitHub's `paths` glob: `**` crosses directories, `*` does not.
const pathGlob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replaceAll('\u0000', '.*')}$`);

test('a native or CLI workflow runs when a file its command line imports changes', async () => {
  const files = (await readdir(new URL('../.github/workflows/', import.meta.url))).filter((name) => name.endsWith('.yml')).sort();
  const gaps = [];
  for (const file of files) {
    const flow = await workflow(file.slice(0, -'.yml'.length));
    for (const event of ['pull_request', 'push']) {
      const filters = flow.on?.[event]?.paths;
      if (!Array.isArray(filters)) continue;
      const patterns = filters.filter((filter) => !filter.startsWith('!')).map(pathGlob);
      // A workflow owns the packages it filters on whole.
      const owned = filters.map((filter) => filter.match(/^((?:packages|exes)\/[^/*]+)\/\*\*$/)?.[1]).filter(Boolean);
      for (const directory of owned) {
        if (!await access(new URL(`../${directory}/package.json`, import.meta.url)).then(() => true, () => false)) continue;
        for (const path of commandLineClosure(repoRoot, directory)) {
          if (!patterns.some((pattern) => pattern.test(path))) gaps.push(`${file} ${event}: ${directory} imports ${path}`);
        }
      }
    }
  }
  assert.deepEqual(gaps, []);
});

test('the command-line closure follows workspace exports and relative imports', () => {
  const syncro = commandLineClosure(repoRoot, 'packages/syncro');
  for (const path of ['packages/registration/src/node.js', 'packages/synthstrip/src/index.js', 'packages/synthsr/src/pipeline.js']) assert.ok(syncro.includes(path), path);
  assert.ok(syncro.every((path) => !path.startsWith('packages/syncro/')));
  const lcmodel = commandLineClosure(repoRoot, 'packages/lcmodel');
  assert.ok(lcmodel.includes('packages/node-drivers/src/dcm2niix.js'));
  // A worker loaded through new URL(..., import.meta.url).
  assert.ok(lcmodel.includes('packages/node-drivers/src/mindgrab-worker.js'));
  // An asset named without ./ is relative to the module too.
  assert.ok(commandLineClosure(repoRoot, 'packages/deface').includes('packages/runtime-support/src/niimath/niimath.wasm'));
});
