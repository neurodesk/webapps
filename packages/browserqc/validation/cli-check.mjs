#!/usr/bin/env node
// Runs a browserqc command line on the web app's pinned example with each reference model and
// compares its downloads with the web app's own, recorded in reference.json by
// apps/browserqc/e2e/reference.spec.js.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ARTIFACTS, CASES, EXAMPLE_SHA256, compare, pinnedExample, readReference, summarize, withoutSidecar } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/browserqc.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const reference = await readReference();
check(reference.mindgrab === packageJson.dependencies['@brainchop/mindgrab'], `reference was recorded with the pinned MindGrab ${reference.mindgrab}`);
check(reference.niimath === packageJson.dependencies['@niivue/niimath'], `reference was recorded with the pinned niimath ${reference.niimath}`);
check(JSON.stringify(reference.inputs) === JSON.stringify(EXAMPLE_SHA256), 'reference was recorded from the pinned example inputs');
check(CASES.every((model) => reference.browser?.cases?.[model]?.artifacts), `reference holds the web app's downloads for ${CASES.join(', ')}`);

const example = await pinnedExample();
const sidecar = JSON.parse(await readFile(example.sidecar.path, 'utf8'));
const work = await mkdtemp(join(tmpdir(), 'browserqc-cli-check-'));
try {
  // Every model on the example as the app receives it, then the plain .nii path without a sidecar.
  const plainInput = join(work, 't1_crop.nii');
  await writeFile(plainInput, gunzipSync(await readFile(example.image.path)));
  const runs = [
    ...CASES.map((model) => ({ id: model, model, input: example.image.path, sidecar })),
    { id: '16chan18cls-plain', model: '16chan18cls', input: plainInput, sidecar: undefined },
  ];
  for (const { id, model, input, sidecar: given } of runs) {
    const recorded = reference.browser?.cases?.[model]?.artifacts;
    if (!recorded) continue;
    const expected = given ? recorded : withoutSidecar(recorded);
    const output = join(work, id);
    const started = performance.now();
    const args = [...command.slice(1), input, output, '--model', model, ...(given ? ['--bids', example.sidecar.path] : [])];
    const run = spawnSync(command[0], args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command[0]} ${args.join(' ')} exited with ${run.status}:\n${run.stderr.slice(-4000)}`);
    const seconds = (performance.now() - started) / 1000;
    const names = ARTIFACTS[model];
    const files = await readdir(output);
    check(
      JSON.stringify(files.sort()) === JSON.stringify([...names].sort()),
      `${id} writes exactly the web app's downloads ${names.join(', ')} (${seconds.toFixed(0)} s)`,
    );
    check(
      JSON.stringify(run.stdout.trim().split(/\r?\n/).sort()) === JSON.stringify(names.map((name) => join(output, name)).sort()),
      `${id} standard output lists the written files and nothing else`,
    );
    const written = Object.fromEntries(await Promise.all(files.filter((name) => names.includes(name)).map(async (name) => [name, await readFile(join(output, name))])));
    const actual = summarize(written, await readFile(input));
    for (const [passed, line] of compare(`command line ${id}`, actual, expected, 'browser', given)) check(passed, line);
    await rm(output, { recursive: true, force: true });
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} BrowserQC command-line checks` : 'PASS BrowserQC command line reproduces the web app\'s quality control of the pinned example');
process.exitCode = failures.length ? 1 : 0;
