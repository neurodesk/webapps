import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agenticCatalog } from '../test-utils/agentic-catalog.mjs';
import { repoRoot } from './lib/apps-registry.mjs';

const { values } = parseArgs({ options: {
  app: { type: 'string' },
  mode: { type: 'string', default: 'workspace' },
  target: { type: 'string', default: 'desktop,phone' },
  output: { type: 'string', default: '.e2e' },
  grep: { type: 'string' },
  shard: { type: 'string' },
  'skip-build': { type: 'boolean', default: false },
  'site-dir': { type: 'string' },
  list: { type: 'boolean', default: false },
  'no-cache': { type: 'boolean', default: false },
} });

const modes = new Map([
  ['workspace', 'workspace'],
  ['agent', 'help,example'],
  ['pipeline', 'pipeline'],
]);
if (!modes.has(values.mode)) throw new Error('Use --mode workspace, agent, or pipeline');
if (!values.list && values.mode !== 'workspace' && !process.env.NEURODESK_API_KEY) {
  throw new Error('Set NEURODESK_API_KEY for llm.neurodesk.org before running agent steps. Workspace checks and --list need no key.');
}
const catalog = await agenticCatalog(values.app);
const env = {
  ...process.env,
  E2E_APPS: catalog.map(app => app.id).join(','),
  E2E_TELEMETRY_DISABLED: '1',
  E2E_OUTPUT: values.output,
};

function run(args, { capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('pnpm', args, { cwd: repoRoot, env, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
    }
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`pnpm ${args[0]} failed (${signal ?? code})`));
    });
  });
}

let staging;
try {
  if (!values.list && !process.env.E2E_BASE_URL) {
    if (!values['skip-build']) {
      if (values.app) {
        for (const app of catalog) await run(['--filter', app.id, 'build']);
      } else {
        await run(['build']);
      }
    }
    if (values['site-dir']) {
      env.E2E_SITE_DIR = resolve(values['site-dir']);
    } else if (values.app) {
      staging = await mkdtemp(join(tmpdir(), 'agentic-site-'));
      await writeFile(join(staging, 'index.html'), '<!doctype html>\n<title>Catalog test builds</title>\n');
      for (const app of catalog) {
        await symlink(join(repoRoot, 'apps', app.id, 'dist'), join(staging, app.path));
      }
      env.E2E_SITE_DIR = staging;
    } else {
      env.E2E_SITE_DIR = join(repoRoot, 'dist');
    }
  }
  const args = ['exec', 'e2e', values.list ? 'list' : 'run', '--tag', modes.get(values.mode), '--target', values.target];
  if (values.grep) args.push('--grep', values.grep);
  if (values.shard && !values.list) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(values.shard);
    const index = Number(match?.[1]);
    const total = Number(match?.[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
      throw new Error('Use --shard index/total with the index from 1 through the total');
    }
    const listing = [...args];
    listing[2] = 'list';
    const { pairs } = JSON.parse(await run([...listing, '--reporter', 'json'], { capture: true }));
    const count = pairs.filter(pair => pair.kind === 'test' && pair.disposition === 'run').length;
    if (count === 0) throw new Error('No runnable tests before sharding');
    args.push('--shard', values.shard);
    // Only trailing shards of a nonempty selection smaller than the shard count may be empty.
    if (count < total && index > count) args.push('--pass-with-no-tests');
  }
  if (values['no-cache'] && !values.list) args.push('--no-cache');
  if (!values.list) args.push('--output', values.output);
  await run(args);
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
