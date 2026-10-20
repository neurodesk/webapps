#!/usr/bin/env node
// Runs a noddi command line on every case of reference.mjs and compares each output with the web
// app's download, recorded in browser-reference.json by apps/noddi/e2e/reference.spec.js. On the
// pinned example the command line's MindGrab mask must be the recorded one, and a fit given that
// mask through --mask must write the same maps.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CASES, caseInputs, compareOutputs, inputChecksums, readReference, sharedProvenance, summarize } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/noddi.js', import.meta.url))];

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

// The written files, by the artifact role the web app gives each name.
async function outputs(directory, roles) {
  const byName = Object.fromEntries(Object.entries(roles).map(([role, summary]) => [summary.name, role]));
  const found = {};
  for (const name of await readdir(directory)) found[byName[name] ?? name] = summarize(name, await readFile(join(directory, name)));
  return found;
}

const reference = await readReference();
const inputs = await caseInputs();
check(JSON.stringify(reference.inputs) === JSON.stringify(inputChecksums(inputs)), 'reference was recorded from the pinned example and the phantom');

const self = spawnSync(command[0], [...command.slice(1), 'self-check'], { encoding: 'utf8' });
check(self.status === 0, `self-check passes: ${(self.stdout || self.stderr).trim().slice(0, 300)}`);

const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'noddi-cli-check-'));
try {
  for (const testCase of CASES) {
    const was = reference.browser.cases[testCase.id];
    const { files } = inputs[testCase.input];
    const positional = [files.image.path, files.bval.path, files.bvec.path];
    const output = join(work, testCase.id);
    const cli = run([...positional, output, ...testCase.options]);
    const written = await outputs(output, was.outputs);
    const expected = Object.values(was.outputs).map((file) => join(output, file.name));
    check(
      cli.stdout.trim().split(/\r?\n/).sort().join('\n') === expected.sort().join('\n'),
      `${testCase.id}: standard output lists the ${expected.length} written files and nothing else (${cli.seconds.toFixed(1)} s)`,
    );
    check(
      JSON.stringify(sharedProvenance(cli.provenance)) === JSON.stringify(sharedProvenance(was.provenance)),
      `${testCase.id}: ${cli.provenance.method}, ${cli.provenance.tensorFit}, ${cli.provenance.maskVoxels} voxels, as the web app fitted`,
    );
    for (const [passed, line] of compareOutputs(`${testCase.id}`, written, was.outputs)) check(passed, line);

    if (testCase.mask !== 'mindgrab') {
      check(cli.provenance.mask === 'none', `${testCase.id}: provenance records the unmasked fit`);
      continue;
    }
    check(
      cli.provenance.mask === `mindgrab-${reference.mask.provenance.version}-cpu`,
      `${testCase.id}: provenance records the MindGrab ${reference.mask.provenance.version} CPU mask (${cli.provenance.mask})`,
    );
    const maskPath = join(output, was.outputs.mask.name);
    check(
      written.mask?.decompressedSha256 === reference.mask.decompressedSha256,
      `${testCase.id}: MindGrab mask ${written.mask?.decompressedSha256.slice(0, 12)} (${written.mask?.nonzero} brain voxels) identical to the recorded ${reference.mask.decompressedSha256.slice(0, 12)} (${reference.mask.nonzero})`,
    );
    const provided = join(work, `${testCase.id}-provided`);
    const given = run([...positional, provided, ...testCase.options, '--mask', maskPath]);
    check(given.provenance.mask === 'supplied', `${testCase.id}: provenance records the supplied mask`);
    const fromMask = await outputs(provided, was.outputs);
    const differing = compareOutputs(`${testCase.id} --mask`, fromMask, was.outputs).filter(([passed]) => !passed);
    check(differing.length === 0, `${testCase.id}: --mask with that mask writes the web app's files${differing.length ? `; ${differing.map(([, line]) => line).join('; ')}` : ''} (${given.seconds.toFixed(1)} s)`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length
  ? `FAIL ${failures.length} noddi command-line checks`
  : `PASS noddi command line reproduces the web app's downloads on ${CASES.length} cases`);
process.exitCode = failures.length ? 1 : 0;
