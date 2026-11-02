#!/usr/bin/env node
// Runs an sdc command line on every case in browser-reference.json and holds its files to what the
// SyN-SDC pipeline wrote in Chromium on the web app's browser runtimes (browser-reference.mjs).
// Both run the same WebAssembly kernels single-threaded with a fixed seed, so every output must be
// the same byte for byte; .nii.gz outputs are compared decompressed, because Node's zlib and the
// browser's CompressionStream may compress the same image differently.
//
//   node validation/cli-check.mjs [--executable PATH]
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CASES, REFERENCE_URL, compareOutputs, measureOutputs, writeCaseInputs } from './cases.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/sdc.js', import.meta.url))];
const reference = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

// The release check runs with an empty home that must stay empty, so everything goes under the temporary directory.
const work = await mkdtemp(join(tmpdir(), 'sdc-cli-check-'));
try {
  for (const item of CASES) {
    const expected = reference.cases[item.id];
    if (!expected) throw new Error(`browser-reference.json has no ${item.id} case.`);
    const { dwi, t1w } = await writeCaseInputs(work);
    const output = join(work, item.id);
    const started = Date.now();
    const run = spawnSync(command[0], [...command.slice(1), dwi, output, '--t1w', t1w, ...(item.prior ? [] : ['--no-prior'])], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      check(false, `${item.id}: ${command.join(' ')} exited with ${run.status}: ${run.stderr.trim()}`);
      continue;
    }
    const report = JSON.parse(run.stdout);
    console.log(`INFO ${item.id}: ${((Date.now() - started) / 1000).toFixed(1)} s, browser ${expected.seconds} s`);
    check(report.provenance.DwiMask.startsWith('MindGrab') && report.provenance.T1wMask.startsWith('MindGrab'), `${item.id}: both masks from MindGrab`);
    const files = new Map();
    for (const name of await readdir(output)) files.set(name, new Uint8Array(await readFile(join(output, name))));
    for (const [passed, line] of compareOutputs(measureOutputs(files), expected.sha256)) check(passed, `${item.id}: ${line}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} sdc command-line checks` : 'PASS sdc command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
