#!/usr/bin/env node
// Fits the web app's pinned example with a dwi2trx command line and compares every tensor map with
// the web app's own downloads, recorded in dwi-gradients-reference.json by
// apps/dwi2trx/e2e/reference.spec.js. The command line's MindGrab mask must be the recorded one,
// and a fit given that mask through --mask must write the same maps.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TENSOR_MAPS, mapFileName } from '../src/tensor.js';
import { EXAMPLE_SHA256, compare, pinnedExample, readReference, summarize, summarizeMaps } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/dwi2trx.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

function run(args) {
  const started = performance.now();
  const result = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(' ')} ${args.join(' ')} exited with ${result.status}:\n${result.stderr.slice(-4000)}`);
  const provenance = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1));
  return { stdout: result.stdout, provenance, seconds: (performance.now() - started) / 1000 };
}

const reference = await readReference();
check(JSON.stringify(reference.inputs) === JSON.stringify(EXAMPLE_SHA256), 'reference was recorded from the pinned example inputs');
check(Boolean(reference.browser?.maps && reference.mask), 'reference holds the web app\'s maps and the MindGrab mask');

if (reference.browser?.maps && reference.mask) {
  const example = await pinnedExample();
  const inputs = [example.image.path, example.bval.path, example.bvec.path];
  const name = example.image.name;
  const expected = [...TENSOR_MAPS, 'mask'].map((map) => mapFileName(name, map));
  const work = await mkdtemp(join(tmpdir(), 'dwi2trx-cli-check-'));
  try {
    const output = join(work, 'mindgrab');
    const cli = run([...inputs, output]);
    const files = await readdir(output);
    check(
      JSON.stringify([...files].sort()) === JSON.stringify([...expected].sort()),
      `${example.id} writes the ${TENSOR_MAPS.length} tensor maps and the mask, named as the web app's downloads (${cli.seconds.toFixed(0)} s)`,
    );
    check(cli.stdout.trim().split(/\r?\n/).join('\n') === expected.map((file) => join(output, file)).join('\n'), 'standard output lists the written files and nothing else');
    check(
      cli.provenance.masked === true && cli.provenance.mask?.model === 'mindgrab' && cli.provenance.mask?.version === reference.mask.provenance.version && cli.provenance.mask?.backend === 'cpu',
      `provenance records the MindGrab ${cli.provenance.mask?.version} ${cli.provenance.mask?.backend} mask (${((cli.provenance.mask?.elapsedMs ?? 0) / 1000).toFixed(0)} s)`,
    );
    const maskPath = join(output, mapFileName(name, 'mask'));
    const mask = summarize(await readFile(maskPath).catch(() => Buffer.alloc(352)));
    check(
      mask.voxelSha256 === reference.mask.voxelSha256 && JSON.stringify(mask.geometry) === JSON.stringify(reference.mask.geometry),
      `MindGrab mask voxels ${mask.voxelSha256.slice(0, 12)} (${mask.nonzero} brain voxels) identical to the recorded ${reference.mask.voxelSha256.slice(0, 12)} (${reference.mask.nonzero})`,
    );
    const actual = await summarizeMaps((file) => readFile(join(output, file)).catch(() => Buffer.alloc(352)), name);
    for (const [passed, line] of compare('command line', actual, reference.browser.maps, 'browser reference')) check(passed, line);
    check(actual.FA.minimum >= 0 && actual.FA.maximum <= 1, `FA lies in [0, 1] (${actual.FA.minimum} to ${actual.FA.maximum.toFixed(4)})`);

    const provided = join(work, 'provided');
    const given = run([...inputs, provided, '--mask', maskPath]);
    check(given.provenance.mask?.source === 'provided' && given.provenance.masked === true, 'provenance records the provided mask');
    const fromMask = await summarizeMaps((file) => readFile(join(provided, file)).catch(() => Buffer.alloc(352)), name);
    const differing = TENSOR_MAPS.filter((map) => fromMask[map].voxelSha256 !== reference.browser.maps[map].voxelSha256);
    check(differing.length === 0, `--mask with that mask writes the browser reference's voxels in every map${differing.length ? `; differs in ${differing.join(', ')}` : ''} (${given.seconds.toFixed(1)} s)`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
console.log(failures.length ? `FAIL ${failures.length} DWI2TRX command-line checks` : 'PASS DWI2TRX command line reproduces the web app\'s tensor fit of the pinned example');
process.exitCode = failures.length ? 1 : 0;
