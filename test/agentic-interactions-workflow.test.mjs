import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { agenticCatalog } from '../test-utils/agentic-catalog.mjs';

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
  assert.equal(job.strategy['max-parallel'], 4, 'the model key allows four concurrent requests');
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

test('the runner only permits an empty shard when the unsharded selection proves it is empty', async t => {
  const root = await scratch(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(args));
if (args[2] === 'list') {
  fs.writeFileSync(process.env.CAPTURE_LIST, JSON.stringify(args));
  process.stdout.write(JSON.stringify({ pairs: JSON.parse(process.env.LIST_PAIRS) }));
  process.exit(Number(process.env.LIST_EXIT || 0));
}
process.exit(Number(process.env.RUN_EXIT || 0));
`, { mode: 0o755 });
  const runner = new URL('../scripts/run-agentic-tests.mjs', import.meta.url).pathname;
  const pairs = Array.from({ length: 3 }, () => ({ kind: 'test', disposition: 'run' }));
  const invoke = async (flags, environment = {}) => {
    const capture = join(root, 'args.json');
    execFileSync(process.execPath, [runner, '--mode', 'agent', '--skip-build', '--site-dir', root, '--target', 'desktop', ...flags], {
      cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CAPTURE_ARGS: capture, CAPTURE_LIST: join(root, 'list.json'), LIST_PAIRS: JSON.stringify(pairs), NEURODESK_API_KEY: 'test-fixture-only', ...environment }, stdio: 'pipe',
    });
    return JSON.parse(await readFile(capture, 'utf8'));
  };
  assert.deepEqual(await invoke(['--shard', '2/3', '--grep', 'About', '--output', 'out']), ['exec', 'e2e', 'run', '--tag', 'help,example', '--target', 'desktop', '--grep', 'About', '--shard', '2/3', '--output', 'out']);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'list.json'), 'utf8')), ['exec', 'e2e', 'list', '--tag', 'help,example', '--target', 'desktop', '--grep', 'About', '--reporter', 'json']);
  assert.deepEqual(await invoke(['--shard', '2/3', '--output', 'out'], { LIST_PAIRS: JSON.stringify(pairs.slice(0, 1)) }), ['exec', 'e2e', 'run', '--tag', 'help,example', '--target', 'desktop', '--shard', '2/3', '--pass-with-no-tests', '--output', 'out']);
  assert.ok(!(await invoke(['--shard', '1/3'], { LIST_PAIRS: JSON.stringify(pairs.slice(0, 1)) })).includes('--pass-with-no-tests'));
  await assert.rejects(invoke(['--shard', '2/3'], { LIST_PAIRS: '[]' }), /Command failed/);
  await assert.rejects(invoke(['--shard', '2/3'], { LIST_EXIT: '2' }), /Command failed/);
  for (const code of [1, 2, 3, 4]) {
    await assert.rejects(invoke(['--shard', '2/3'], { LIST_PAIRS: JSON.stringify(pairs.slice(0, 1)), RUN_EXIT: String(code) }), /Command failed/);
  }
  for (const shard of ['0/3', '4/3', '2/0', '2', '1/9007199254740992']) {
    await assert.rejects(invoke(['--shard', shard]), /Command failed/);
  }
  assert.deepEqual(await invoke(['--output', 'out']), ['exec', 'e2e', 'run', '--tag', 'help,example', '--target', 'desktop', '--output', 'out']);
  assert.deepEqual(await invoke(['--shard', '2/3', '--list']), ['exec', 'e2e', 'list', '--tag', 'help,example', '--target', 'desktop']);
});

test('the real e2e selector partitions every catalog interaction exactly once per target', async () => {
  const cli = new URL('../node_modules/e2e/dist/cli/bin.js', import.meta.url).pathname;
  const catalog = await agenticCatalog('');
  const list = async (target, shard) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'list', '--tag', 'help,example', '--target', target, '--reporter', 'json', ...(shard ? ['--shard', `${shard}/3`] : [])], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, E2E_APPS: '', E2E_TELEMETRY_DISABLED: '1' }, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout).pairs.filter(pair => pair.disposition === 'run');
  };
  for (const target of job.strategy.matrix.target) {
    const [whole, ...shards] = await Promise.all([list(target), ...job.strategy.matrix.shard.map(shard => list(target, shard))]);
    const key = pair => JSON.stringify([pair.target, pair.titlePath]);
    assert.equal(whole.length, catalog.reduce((count, app) => count + 1 + app.examples.length, 0));
    assert.deepEqual([...new Set(whole.map(pair => pair.titlePath[0]))].sort(), catalog.map(app => app.id).sort());
    const partition = shards.flat().map(key);
    assert.equal(new Set(partition).size, partition.length, `${target}: duplicate tests across shards`);
    assert.deepEqual(partition.sort(), whole.map(key).sort(), `${target}: shard coverage differs from the full catalog`);
    assert.ok(shards.every(shard => shard.length > 0));
  }
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
