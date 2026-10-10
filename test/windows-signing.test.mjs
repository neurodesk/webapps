import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { windowsSigningConfig } from '../scripts/desktop/windows-signing.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const workflow = async name => YAML.parse(await read(`.github/workflows/${name}.yml`));
const login = 'Azure/login@935127ca5bb3c4b02c9c2c10060028383878f33f';

test('Azure signing requires complete opt-in configuration before OIDC and uses pinned official tooling', async () => {
  const action = YAML.parse(await read('.github/actions/windows-signing/action.yml'));
  const steps = action.runs.steps;
  assert.match(steps[0].run, /check-config/);
  const oidc = steps.findIndex(step => step.uses === login);
  assert.ok(oidc > 0);
  assert.equal(steps[oidc].if, "inputs.enabled == 'true'");
  assert.equal(steps[oidc].with['client-id'], '${{ inputs.client-id }}');
  assert.equal(steps.at(-1).if, "inputs.enabled == 'true'");
  assert.match(steps.at(-1).run, /ArtifactSigning -RequiredVersion 0\.1\.8/);
  assert.doesNotMatch(JSON.stringify(action), /client-secret|secrets\./);
  const signer = await read('scripts/windows-signing.ps1');
  assert.match(signer, /-TimestampRfc3161 'http:\/\/timestamp\.acs\.microsoft\.com' -TimestampDigest SHA256/);
  assert.match(signer, /verify \/pa \/all \/tw/);
  assert.match(signer, /TimeStamperCertificate/);
  assert.match(signer, /\$LASTEXITCODE -ne 0/);
  assert.match(signer, /10\.0\.26100\.4188/);
});

test('Windows producers get OIDC permission and suppress activation in pull requests', async () => {
  for (const [name, jobName] of [['node-cli-portable', 'portable'], ['synthsr-native', 'portable'], ['greedy-native', 'native'], ['standalone', 'desktop']]) {
    const flow = await workflow(name);
    const job = flow.jobs[jobName];
    assert.equal(job.permissions['id-token'], 'write', name);
    const setup = job.steps.find(step => step.uses === './.github/actions/windows-signing');
    assert.equal(setup.if, "runner.os == 'Windows'", name);
    assert.equal(setup.with.enabled, "${{ github.event_name != 'pull_request' && vars.WINDOWS_SIGNING_ENABLED || 'false' }}");
    assert.equal(flow.env.WINDOWS_SIGNING_ENABLED, setup.with.enabled);
    for (const producer of Object.values(flow.jobs)) {
      assert.doesNotMatch(JSON.stringify(producer), /AZURE_CLIENT_SECRET/);
    }
  }
  for (const name of await readdir(new URL('.github/workflows/', root))) {
    if (!name.endsWith('.yml')) continue;
    const flow = await workflow(name.slice(0, -4));
    for (const job of Object.values(flow.jobs || {})) {
      if (job.uses === './.github/workflows/node-cli-portable.yml') assert.equal(job.permissions['id-token'], 'write', name);
    }
  }
});

test('portable and native release gates verify Windows archives before publishing', async () => {
  const node = await read('exes/node-cli/scripts/portable_release.py');
  assert.ok(node.indexOf('windows_signing.sign_tree(stage') < node.indexOf('manifest = create_manifest(stage'));
  assert.match(node, /verify_zip\(archive, \(target\.executable, target\.private_node\)\)/);
  const greedy = await read('scripts/package-greedy.py');
  assert.ok(greedy.indexOf('windows_signing.sign_tree(stage') < greedy.indexOf("archive = dist / f'{name}.zip'"));
  const receipt = await read('scripts/check-native-receipts.mjs');
  assert.match(receipt, /windows_signing\.py', 'verify'/);
  const synthsr = await workflow('synthsr-native');
  const checks = synthsr.jobs.release.steps;
  assert.ok(checks.findIndex(step => step.name === 'Enforce Windows signature policy') < checks.findIndex(step => step.name === 'Attach verified release assets'));
  const publish = await read('scripts/desktop/publish.mjs');
  assert.match(publish, /windowsSigning\.archiveSha256 !== archiveHash/);
  assert.match(publish, /verifyWindowsArchive\(archive\)/);
});

test('Electron signing is disabled by default and runs after resource editing before archival', () => {
  const previous = process.env.WINDOWS_SIGNING_ENABLED;
  try {
    delete process.env.WINDOWS_SIGNING_ENABLED;
    assert.deepEqual(windowsSigningConfig('win32'), {});
    process.env.WINDOWS_SIGNING_ENABLED = 'false';
    assert.deepEqual(windowsSigningConfig('win32'), {});
    assert.deepEqual(windowsSigningConfig('linux'), {});
  } finally {
    if (previous === undefined) delete process.env.WINDOWS_SIGNING_ENABLED;
    else process.env.WINDOWS_SIGNING_ENABLED = previous;
  }
});

test('configured Electron packaging owns signing and fails closed when configuration is incomplete', () => {
  const names = ['WINDOWS_SIGNING_ENABLED', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_ARTIFACT_SIGNING_ENDPOINT', 'AZURE_ARTIFACT_SIGNING_ACCOUNT', 'AZURE_ARTIFACT_SIGNING_PROFILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'fixture';
    process.env.WINDOWS_SIGNING_ENABLED = 'true';
    process.env.AZURE_ARTIFACT_SIGNING_ENDPOINT = 'https://eus.codesigning.azure.net/';
    const config = windowsSigningConfig('win32');
    assert.equal(config.win.signExecutable, false);
    assert.equal(typeof config.afterSign, 'function');
    delete process.env.AZURE_ARTIFACT_SIGNING_PROFILE;
    assert.throws(() => windowsSigningConfig('win32'));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('mock policy runs on Windows and Linux without Azure permissions or credentials', async () => {
  const flow = await workflow('windows-signing-policy');
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.deepEqual(flow.jobs.policy.strategy.matrix.os, ['ubuntu-24.04', 'windows-latest']);
  assert.match(JSON.stringify(flow.jobs.policy.steps), /test_windows_signing\.py/);
  assert.doesNotMatch(JSON.stringify(flow), /Azure\/login|id-token|secrets\./);
});
