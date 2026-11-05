// Run the web app's example through the command line, with the qsmxt command the app exports for
// it, and hold the χ map to the browser's (browser-reference.json) within the recorded tolerance.
//   node packages/qsmbly/validation/cli-check.mjs [--executable PATH] [--output DIR]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { pinnedExample, stageBids } from './example.mjs';
import { compare, measure, violations } from './measure.mjs';
import { ensureNativeModelDirectory, nativeModelAssets } from '../src/node.js';

const { values } = parseArgs({ options: { executable: { type: 'string' }, output: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, resolve('packages/qsmbly/bin/qsmbly.js')];
const reference = JSON.parse(await readFile(new URL('./browser-reference.json', import.meta.url), 'utf8'));
assert.ok(reference.tolerance, 'browser-reference.json records no tolerance');

/** Split the exported command into arguments: whitespace-separated, with '…' and "…" quoting. */
function splitCommand(text) {
  const line = text.split('\n').filter((entry) => !entry.startsWith('#')).join(' ');
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

const exported = splitCommand(reference.command);
assert.deepEqual(exported.slice(0, 3), ['qsmxt', 'run', '<bids_dir>'], reference.command);

const work = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'qsmbly-cli-check-'));
await mkdir(work, { recursive: true });
try {
  const emptyCache = join(work, 'empty-cache');
  const offlineEnvironment = { ...process.env, XDG_CACHE_HOME: emptyCache, NEURODESK_QSMBLY_MODEL_DIR: emptyCache, NEURODESK_OFFLINE: '1' };
  for (const [args, expected] of [
    [['qsmart', '--help'], /qsmart-inversion/],
    [['tui', '--help'], /interactive TUI/],
    [['slurm', '--help'], /SLURM/],
    [['example', '--list'], /prisma-bridge-run1/],
  ]) {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', env: offlineEnvironment });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, expected);
  }
  for (const [args, expected] of [
    [['qsmart', 'field.nii', '--mask', 'mask.nii', '--output', 'out.nii', '--field-strength', '3', '--echo-time', '0.02', '--qsmart-inversion', 'xqsm'], /bfrnet.onnx.*download-models/],
    [['run', '--qsm-algorithm', 'xqsm', '--', '--dry', 'out'], /bfrnet.onnx.*download-models/],
    [['example', '--', '--list'], /Offline QSMbly/],
    [['tui'], /native SLURM generation or the TUI/],
    [['slurm', '--submit'], /native SLURM generation or the TUI/],
  ]) {
    const result = spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', env: offlineEnvironment });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
  }
  const modelCache = join(tmpdir(), 'qsmbly-validation-models-v0.38.0');
  // Provision outside the packager's isolated HOME, then run the archive offline. Native QSMxT
  // has no offline flag, so even a classical run gets its complete verified hosted registry.
  const modelDir = await ensureNativeModelDirectory(nativeModelAssets(), { cacheDir: modelCache, offline: false, onProgress: (message) => console.log(message) });
  const bids = join(work, 'bids');
  const output = join(work, 'out');
  await rm(bids, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  const { subject, session } = await stageBids(await pinnedExample(), bids);
  const config = join(work, 'browser-export.toml');
  await writeFile(config, reference.configToml);
  const args = ['run', bids, output, '--config', config, ...exported.slice(3)];
  console.log(`qsmbly ${args.join(' ')}`);
  const started = Date.now();
  // Every hosted native weight is verified locally before this process starts.
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NEURODESK_QSMBLY_MODEL_DIR: modelDir, QSMBLY_OFFLINE: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const seconds = Math.round((Date.now() - started) / 1000);
  const derivatives = join(output, 'derivatives', 'qsmxt');
  const find = async (directory, suffix) => {
    const names = await readdir(directory);
    const matches = names.filter((name) => name.endsWith(suffix));
    assert.equal(matches.length, 1, `one ${suffix} in ${directory}: ${names.join(', ')}`);
    return readNifti(await readFile(join(directory, matches[0])), Float64Array);
  };
  const anat = join(derivatives, subject, session, 'anat');
  const chi = await find(anat, '_Chimap.nii');
  const mask = await find(anat, '_run-1_mask.nii');
  const support = await find(join(derivatives, 'workflow', subject, session, 'run-1', 'bgremove'), '_bgmask.nii');
  const measurement = measure({ dims: chi.dims, chi: chi.data, mask: mask.data, support: support.data });
  const metrics = compare(reference.measurement, measurement);
  console.log(JSON.stringify({ seconds, metrics }, null, 2));
  const failures = violations(metrics, reference.tolerance);
  assert.deepEqual(failures, [], `CLI χ map differs from the browser's ${reference.app} run`);
  console.log(`PASS QSMbly CLI χ map agrees with the browser reference (${reference.app}, ${reference.browser}) in ${seconds} s`);
} finally {
  if (!values.output) await rm(work, { recursive: true, force: true });
}
