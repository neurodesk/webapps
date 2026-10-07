#!/usr/bin/env node
// Registers the web app's pinned example with an ants command line and compares its four outputs
// with the web app's own downloads, recorded in t1-mni-reference.json by
// apps/ants/e2e/reference.spec.js.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { REGISTRATION_WASM_SHA256 } from '@neurodesk/registration/node';
import { artifactName } from '../src/outputs.js';
import { EXAMPLE_SHA256, ROLES, compare, pinnedExample, readReference, summarize } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/ants.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const reference = await readReference();
check(reference.registrationWasmSha256 === REGISTRATION_WASM_SHA256, `reference was recorded with the installed kernel ${REGISTRATION_WASM_SHA256.slice(0, 12)}`);
check(JSON.stringify(reference.inputs) === JSON.stringify(EXAMPLE_SHA256), 'reference was recorded from the pinned example inputs');
check(Boolean(reference.browser?.artifacts), 'reference holds the web app\'s downloads');

if (reference.browser?.artifacts) {
  const example = await pinnedExample();
  const work = await mkdtemp(join(tmpdir(), 'ants-cli-check-'));
  try {
    const output = join(work, 'results');
    const started = performance.now();
    const run = spawnSync(command[0], [...command.slice(1), example.moving.path, example.fixed.path, output], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr.slice(-4000)}`);
    const seconds = (performance.now() - started) / 1000;
    const names = Object.fromEntries(ROLES.map((role) => [role, artifactName(example.moving.name, role)]));
    const files = await readdir(output);
    check(
      JSON.stringify(files.sort()) === JSON.stringify(Object.values(names).sort()),
      `${example.id} writes exactly the web app's downloads ${Object.values(names).join(', ')} (${seconds.toFixed(0)} s)`,
    );
    check(
      run.stdout.trim().split(/\r?\n/).join('\n') === ROLES.map((role) => join(output, names[role])).join('\n'),
      'standard output lists the written files and nothing else',
    );
    if (ROLES.every((role) => files.includes(names[role]))) {
      const outputs = Object.fromEntries(await Promise.all(ROLES.map(async (role) => [role, await readFile(join(output, names[role]))])));
      const actual = summarize(outputs, await readFile(example.fixed.path));
      for (const [passed, line] of compare('command line', actual, reference.browser.artifacts, 'browser')) check(passed, line);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
console.log(failures.length ? `FAIL ${failures.length} ANTs command-line checks` : 'PASS ANTs command line reproduces the web app\'s SyN registration of the pinned example');
process.exitCode = failures.length ? 1 : 0;
