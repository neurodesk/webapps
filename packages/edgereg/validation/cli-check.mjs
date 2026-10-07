#!/usr/bin/env node
// Registers the web app's pinned example with an edgereg command line and compares the download
// with the web app's own, recorded in t1-mni-reference.json by apps/edgereg/e2e/reference.spec.js.
// With --native PATH it also runs native niimath on the same argv and holds it to
// NATIVE_TOLERANCES.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { registeredName } from '../src/registration.js';
import { EXAMPLE_SHA256, compareWithBrowser, compareWithNative, pinnedExample, readReference, summarize } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, native: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/edgereg.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} exited with ${result.status}:\n${result.stderr.slice(-4000)}`);
  return result;
}

const reference = await readReference();
check(JSON.stringify(reference.inputs) === JSON.stringify(EXAMPLE_SHA256), 'reference was recorded from the pinned example inputs');
check(Boolean(reference.browser?.artifact), 'reference holds the web app\'s download');

if (reference.browser?.artifact) {
  const example = await pinnedExample();
  const work = await mkdtemp(join(tmpdir(), 'edgereg-cli-check-'));
  try {
    const output = join(work, 'results');
    const started = performance.now();
    const cli = run(command[0], [...command.slice(1), example.moving.path, example.fixed.path, output]);
    const seconds = (performance.now() - started) / 1000;
    const name = registeredName(example.moving.name);
    const files = await readdir(output);
    check(JSON.stringify(files) === JSON.stringify([name]), `${example.id} writes exactly the web app's download ${name} (${seconds.toFixed(1)} s)`);
    check(cli.stdout.trim() === join(output, name), 'standard output lists the written file and nothing else');
    const provenance = JSON.parse(cli.stderr.trim().split(/\r?\n/).at(-1));
    check(provenance.robustFov === reference.robustFov, `provenance records robustFov ${provenance.robustFov}, as the reference was run`);
    if (files.includes(name)) {
      const registered = await readFile(join(output, name));
      const fixed = await readFile(example.fixed.path);
      for (const [passed, line] of compareWithBrowser('command line', summarize(registered, fixed), reference.browser.artifact)) check(passed, line);
      if (values.native) {
        // Native niimath reads the files under the names the web app stages, from its own directory.
        const native = join(work, 'native');
        await mkdir(native);
        const [input, ...rest] = provenance.argv;
        const staged = rest[rest.indexOf('-allineate') + 1];
        await copyFile(example.moving.path, join(native, input));
        await copyFile(example.fixed.path, join(native, staged));
        run(resolve(values.native), provenance.argv, { cwd: native });
        for (const [passed, line] of compareWithNative(await readFile(join(native, 'registered.nii')), registered, fixed)) check(passed, line);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
console.log(failures.length ? `FAIL ${failures.length} EdgeReg command-line checks` : 'PASS EdgeReg command line reproduces the web app\'s registration of the pinned example');
process.exitCode = failures.length ? 1 : 0;
