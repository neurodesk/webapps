import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

const ci = YAML.parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const site = ci.jobs['composite-site'];
const job = ci.jobs['agent-interactions'];
const packageSite = site.steps.find(step => step.id === 'agent-site');
const verifySite = job.steps.find(step => step.name === 'Verify and unpack the tested composite site');
const interact = job.steps.find(step => step.run?.includes('pnpm test:e2e:agent'));

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const shell = (script, cwd, environment) => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
  cwd, env: { ...process.env, ...environment }, stdio: 'pipe',
});

test('both full-catalog agent targets run in three shards on isolated runners and retain the existing time and worker bounds', async () => {
  assert.deepEqual(job.strategy.matrix.target, ['desktop', 'phone']);
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3]);
  assert.equal(interact.env.AGENTIC_SHARD, `\${{ matrix.shard }}/${job.strategy.matrix.shard.length}`);
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'catalog-agent-${{ matrix.target }}-${{ matrix.shard }}');
  assert.equal(upload.with.path, '.e2e/agent-${{ matrix.target }}-${{ matrix.shard }}/');
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.needs, 'composite-site');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(interact['timeout-minutes'], 120);
  assert.ok(!site.steps.some(step => step.run?.includes('pnpm test:e2e:agent')), 'the serial two-target call must not remain in composite-site');
  assert.match(await readFile(new URL('../e2e.config.ts', import.meta.url), 'utf8'), /workers: 1,/);
  for (const [event, mode, expected] of [['schedule', '', true], ['workflow_dispatch', 'interactions', true], ['workflow_dispatch', 'pipeline', false], ['push', '', false], ['pull_request', '', false]]) {
    assert.equal(runInNewContext(packageSite.if, { github: { event_name: event }, inputs: { agentic_mode: mode } }), expected);
  }
  for (const ready of ['true', 'false', '']) {
    assert.equal(runInNewContext(job.if.replace('needs.composite-site', 'needs["composite-site"]'), { needs: { 'composite-site': { outputs: { agent_site_ready: ready } } } }), ready === 'true');
  }
  const packaged = site.steps.find(step => step.with?.name === 'agent-catalog-site-${{ github.sha }}');
  const download = job.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, packaged.with.name);
  assert.equal(packaged.with['if-no-files-found'], 'error');
  assert.equal(site.outputs.agent_site_ready, '${{ steps.agent-site.outputs.ready }}');
  const processing = site.steps.find(step => step.run?.includes('pnpm test:e2e:pipeline'));
  assert.match(processing.if, /agentic_mode == 'pipeline'/);
  assert.match(processing.run, /--target desktop --no-cache/);
});

test('the actual agent command runs each target shard without dropping cases and preserves optional app selection', async t => {
  const root = await scratch(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const { target: targets, shard: shards } = job.strategy.matrix;
  for (const target of targets) for (const shard of shards) for (const selection of ['', 'niimath,hmc']) {
    const capture = join(root, 'args.json');
    shell(interact.run, root, { PATH: `${bin}${delimiter}${process.env.PATH}`, CAPTURE_ARGS: capture, AGENTIC_TARGET: target, AGENTIC_SHARD: `${shard}/${shards.length}`, AGENTIC_APPS: selection });
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), [
      'test:e2e:agent', '--skip-build', '--site-dir', 'dist', '--target', target, '--shard', `${shard}/${shards.length}`, '--output', `.e2e/agent-${target}-${shard}`,
      ...(selection ? ['--app', selection] : []),
    ]);
  }
});

test('the runner hands the shard to e2e and lets a narrowed selection leave a shard empty', async t => {
  const root = await scratch(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pnpm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const runner = new URL('../scripts/run-agentic-tests.mjs', import.meta.url).pathname;
  const invoke = async (...flags) => {
    const capture = join(root, 'args.json');
    execFileSync(process.execPath, [runner, '--mode', 'agent', '--skip-build', '--site-dir', root, '--target', 'desktop', ...flags], {
      cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CAPTURE_ARGS: capture, NEURODESK_API_KEY: 'test-fixture-only' }, stdio: 'pipe',
    });
    return JSON.parse(await readFile(capture, 'utf8'));
  };
  assert.deepEqual(await invoke('--shard', '2/3', '--output', 'out'), ['exec', 'e2e', 'run', '--tag', 'help,example', '--target', 'desktop', '--shard', '2/3', '--pass-with-no-tests', '--output', 'out']);
  assert.deepEqual(await invoke('--output', 'out'), ['exec', 'e2e', 'run', '--tag', 'help,example', '--target', 'desktop', '--output', 'out']);
  assert.deepEqual(await invoke('--shard', '2/3', '--list'), ['exec', 'e2e', 'list', '--tag', 'help,example', '--target', 'desktop']);
});

test('the transferred composite is checksum-verified before use, and missing credentials do not create a partial artifact', async t => {
  const root = await scratch(t);
  const temporary = join(root, 'temporary');
  const destination = join(root, 'destination');
  await mkdir(temporary);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.html'), 'the exact tested catalog bytes');
  const output = join(root, 'outputs');
  const environment = { RUNNER_TEMP: temporary, GITHUB_WORKSPACE: destination, GITHUB_OUTPUT: output, NEURODESK_API_KEY: '' };
  shell(packageSite.run, root, environment);
  await assert.rejects(readFile(output), /ENOENT/);
  shell(packageSite.run, root, { ...environment, NEURODESK_API_KEY: 'test-fixture-only' });
  assert.equal(await readFile(output, 'utf8'), 'ready=true\n');
  const transferred = join(temporary, 'agent-catalog-site');
  await mkdir(transferred);
  for (const name of ['agent-catalog-site.tar.gz', 'agent-catalog-site.tar.gz.sha256']) await writeFile(join(transferred, name), await readFile(join(temporary, name)));
  shell(verifySite.run, root, environment);
  assert.equal(await readFile(join(destination, 'dist', 'index.html'), 'utf8'), 'the exact tested catalog bytes');
  await rm(destination, { recursive: true });
  await writeFile(join(transferred, 'agent-catalog-site.tar.gz'), 'corrupt transfer');
  assert.throws(() => shell(verifySite.run, root, environment), /Command failed/);
  await assert.rejects(readFile(join(destination, 'dist', 'index.html')), /ENOENT/);
});
