import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyWindowsArchive, windowsSigningConfig } from '../scripts/desktop/windows-signing.mjs';
import { prepareReleaseFiles } from '../scripts/desktop/release-files.mjs';
import { loadAppsRegistry, primaryCatalog } from '../scripts/lib/apps-registry.mjs';

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
  assert.match(signer, /\$toSign = @\(\$files \| Where-Object/);
  assert.match(signer, /-Files \(\$toSign -join ','\)/);
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
  // target.executables is the launcher, the private Node runtime and any native tools the package ships.
  assert.match(node, /verify_zip\(archive, target\.executables\)/);
  assert.match(node, /return \(self\.executable, self\.private_node, \*self\.native_executables\)/);
  const greedy = await read('scripts/package-greedy.py');
  assert.ok(greedy.indexOf('windows_signing.sign_tree(stage') < greedy.indexOf("archive = dist / f'{name}.zip'"));
  const receipt = await read('scripts/check-native-receipts.mjs');
  assert.match(receipt, /windows_signing\.py', 'verify'/);
  const synthsr = await workflow('synthsr-native');
  const checks = synthsr.jobs.release.steps;
  assert.ok(checks.findIndex(step => step.name === 'Enforce Windows signature policy') < checks.findIndex(step => step.name === 'Attach verified release assets'));
  const publish = await read('scripts/desktop/publish.mjs');
  assert.match(publish, /windowsSigning\.archiveSha256 !== archiveHash/);
  assert.match(publish, /verifyWindowsArchive\(archive, desktop\.executable\)/);
});

test('Electron signing is disabled by default and runs after resource editing before archival', () => {
  const previous = process.env.WINDOWS_SIGNING_ENABLED;
  try {
    delete process.env.WINDOWS_SIGNING_ENABLED;
    assert.deepEqual(windowsSigningConfig('neurodesk-webapps', 'win32'), {});
    process.env.WINDOWS_SIGNING_ENABLED = 'false';
    assert.deepEqual(windowsSigningConfig('neurodesk-webapps', 'win32'), {});
    assert.deepEqual(windowsSigningConfig('neurodesk-webapps', 'linux'), {});
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
    const config = windowsSigningConfig('neurodesk-webapps', 'win32');
    assert.equal(config.win.signExecutable, false);
    assert.equal(typeof config.afterSign, 'function');
    delete process.env.AZURE_ARTIFACT_SIGNING_PROFILE;
    assert.throws(() => windowsSigningConfig('neurodesk-webapps', 'win32'));
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
  const suites = [
    'python scripts/lib/test_windows_signing.py',
    'python exes/node-cli/scripts/test_portable_release.py',
    'python exes/synthsr/scripts/test_portable_release.py',
  ];
  for (const command of suites) {
    const steps = flow.jobs.policy.steps.filter(step => step.run === command);
    assert.equal(steps.length, 1, `${command} must have its own native exit-code gate`);
    assert.equal(steps[0]['continue-on-error'], undefined);
    assert.equal(steps[0].if, undefined);
  }
  assert.doesNotMatch(JSON.stringify(flow), /Azure\/login|id-token|secrets\./);
  const vendorSignatures = flow.jobs.policy.steps.find(step => step.name === 'Test vendor signature preservation without an account');
  assert.equal(vendorSignatures.if, "runner.os == 'Windows'");
  assert.equal(vendorSignatures.run, './scripts/test-windows-signing.ps1');
  for (const event of ['pull_request', 'push']) {
    assert.ok(flow.on[event].paths.includes('scripts/test-windows-signing.ps1'));
  }
});

// A Windows ZIP laid out as electron-builder writes it, with the mock signer's
// evidence (scripts/lib/test_windows_signing.py): synthetic PE certificates, not signatures.
function mockSignedArchive(path, executable) {
  execFileSync('python3', ['-I', '-c', `
import json, sys, zipfile
sys.path.insert(0, sys.argv[1])
import windows_signing as signing
from test_windows_signing import pe
archive, executable = sys.argv[2], sys.argv[3]
files = {executable: pe(), 'ffmpeg.dll': pe()}
evidence = {'schema': 1, 'files': {name: {'sha256': __import__('hashlib').sha256(data).hexdigest(), 'verified': 'signtool /pa /all /tw', 'timestamp': 'mock fixture timestamp'} for name, data in files.items()}}
with zipfile.ZipFile(archive, 'w') as bundle:
    for name, data in files.items():
        bundle.writestr(name, data)
    bundle.writestr(signing.EVIDENCE, json.dumps(evidence))
    bundle.writestr('resources/offline/bundle.json', '{}')
`, new URL('../scripts/lib/', import.meta.url).pathname, path, executable]);
}

test('every catalogue suite signs and verifies its own Windows executable', async () => {
  const registry = await loadAppsRegistry();
  const primary = primaryCatalog(registry).desktop.executable;
  const names = ['WINDOWS_SIGNING_ENABLED', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_ARTIFACT_SIGNING_ENDPOINT', 'AZURE_ARTIFACT_SIGNING_ACCOUNT', 'AZURE_ARTIFACT_SIGNING_PROFILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const root = await mkdtemp(join(tmpdir(), 'suite-signing-'));
  try {
    for (const name of names) process.env[name] = 'fixture';
    process.env.WINDOWS_SIGNING_ENABLED = 'true';
    process.env.AZURE_ARTIFACT_SIGNING_ENDPOINT = 'https://eus.codesigning.azure.net/';
    assert.ok(registry.site.catalogs.length > 1);
    for (const { id, desktop } of registry.site.catalogs) {
      const archive = join(root, `${desktop.release}-0.1.20260915-win-x64.zip`);
      mockSignedArchive(archive, `${desktop.executable}.exe`);
      const result = await prepareReleaseFiles(archive, join(root, id), { desktop, version: '0.1.20260915', platform: 'windows-x64' });
      assert.equal(result.windowsSigning.verified, true, id);
      verifyWindowsArchive(archive, desktop.executable);
      // Negative control: the policy rejects a suite archive checked for another suite's executable.
      if (desktop.executable !== primary) assert.throws(() => verifyWindowsArchive(archive, primary), id);
    }
    // No signing helper falls back to a default executable.
    assert.throws(() => verifyWindowsArchive(join(root, 'absent.zip')), /suite executable/);
    assert.throws(() => windowsSigningConfig(undefined, 'linux'), /suite executable/);
    assert.throws(() => windowsSigningConfig('../neurodesk-webapps', 'win32'), /suite executable/);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('desktop packaging and publication pass the catalogue executable to Windows signing', async () => {
  assert.match(await read('scripts/desktop/pack.mjs'), /windowsSigningConfig\(desktop\.executable\)/);
  assert.match(await read('scripts/desktop/release-files.mjs'), /verifyWindowsArchive\(archive, desktop\.executable\)/);
  const publish = await read('scripts/desktop/publish.mjs');
  assert.equal(publish.match(/verifyWindowsArchive\([^)]*, desktop\.executable\)/g).length, 2);
});
