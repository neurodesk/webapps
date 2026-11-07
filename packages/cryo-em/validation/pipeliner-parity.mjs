#!/usr/bin/env node
// ADR-0004's argument gate: asks real RELION, in the relion container, which
// command its GUI writes to note.txt for every case in test/gui-cases.js, and
// compares it word by word with relionCommand(). Exits non-zero on any
// difference.
//
//   node packages/cryo-em/validation/pipeliner-parity.mjs --image relion:5.1.1
//
// For each case it makes a fresh RELION project whose next job number is the
// case's, adds the job with `relion_pipeliner --addJobFromStar` (a new job,
// not a continuation, as the GUI's Run! button makes it) and `--addJobOptions`
// holding the inputs, every option through its GUI variable and the launch,
// and runs it with `--RunJobs`. RELION then writes note.txt exactly as the GUI
// does (PipeLine::runJob). The RELION programs and mpirun on PATH are stubs
// that only write the success marker, so nothing is computed. The note.txt
// lines carry no MPI launcher; RELION adds `mpirun -n N` only to the line it
// executes.
//
// It also adds each command once with no options and checks that RELION's
// defaults, read back from job.star, equal the table's `default`s.
//
// Options: --image <name> (default relion:5.1.1), --case <substring>,
// --cases <module> (check the GUI_CASES that module exports instead),
// --keep (keep the scratch directory), --notes <file> (write RELION's lines
// per case as JSON).

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RELION_DEFINITION, relionCommand, validateRelionSpec } from '../src/spec.js';
import { pathToFileURL } from 'node:url';
import { GUI_CASES as PACKAGE_CASES, shellWords } from '../test/gui-cases.js';
import { PACKAGE_ONLY_PROGRAMS, addJobOptions, guiInputPaths, guiJobOptions, guiValue, minimalJobStar, pipelineStar, readJobStar, readNoteCommands } from './relion-gui.mjs';

const { values: args } = parseArgs({
  options: {
    image: { type: 'string', default: 'relion:5.1.1' },
    case: { type: 'string' },
    keep: { type: 'boolean', default: false },
    notes: { type: 'string' },
    cases: { type: 'string' },
  },
});

const PIPELINER = '/opt/relion-5.1.1/bin/relion_pipeliner';

// The stub every relion_* program and mpirun resolve to: it writes the
// success marker where --pipeline_control points, so the pipeliner's wait
// ends, and does nothing else.
const STUB = `#!/bin/sh
previous=""
for word in "$@"; do
  if [ "$previous" = "--pipeline_control" ]; then mkdir -p "$word" && touch "$word/RELION_JOB_EXIT_SUCCESS"; fi
  previous="$word"
done
exit 0
`;

const MPIRUN_STUB = `#!/bin/sh
[ "$1" = "-n" ] && shift 2
exec "$@"
`;

// Per run directory: job-min.star, options.txt, and run.txt when the job is
// to be run. The project is <run>/project.
const DRIVER = `#!/bin/bash
set -u
mkdir -p /work/stubs
for program in /opt/relion-5.1.1/bin/relion_*; do ln -sf /work/stub "/work/stubs/$(basename "$program")"; done
ln -sf /work/mpirun-stub /work/stubs/mpirun
export PATH="/work/stubs:$PATH"
unset RELION_SCRATCH_DIR RELION_QSUB_NRMPI RELION_QSUB_NRTHREADS RELION_QUEUE_USE
for run in /work/runs/*/; do
  cd "$run/project" || exit 1
  ${PIPELINER} --addJobFromStar ../job-min.star --addJobOptions "$(cat ../options.txt)" > ../add.log 2>&1
  echo $? > ../add.status
  if [ -f ../run.txt ]; then
    timeout 120 ${PIPELINER} --RunJobs "$(cat ../run.txt)" --sec_wait_after 1 > ../run.log 2>&1
    echo $? > ../run.status
  fi
done
`;

function runContainer(work) {
  const user = `${process.getuid()}:${process.getgid()}`;
  const result = spawnSync('docker', ['run', '--rm', '-u', user, '-e', 'HOME=/tmp', '-v', `${work}:/work`, '-w', '/work', args.image, 'bash', '-lc', 'bash /work/driver.sh'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`docker run exited with ${result.status}`);
}

async function prepareRun(work, id, { command, jobNumber, options, inputFiles, runJob }) {
  const run = join(work, 'runs', id);
  const project = join(run, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'default_pipeline.star'), pipelineStar(jobNumber));
  await writeFile(join(run, 'job-min.star'), minimalJobStar(command));
  await writeFile(join(run, 'options.txt'), options);
  if (runJob !== undefined) await writeFile(join(run, 'run.txt'), runJob);
  // runScheduledJobs waits for every input node to exist.
  for (const file of inputFiles) {
    await mkdir(join(project, dirname(file)), { recursive: true });
    await writeFile(join(project, file), '');
  }
  return run;
}

async function runLog(run) {
  const parts = [];
  for (const name of ['add.log', 'run.log']) {
    if (existsSync(join(run, name))) parts.push(`${name}:\n${await readFile(join(run, name), 'utf8')}`);
  }
  return parts.join('\n');
}

// Words of each step: the package's command, or RELION's lines.
function packageWords(result) {
  return [[result.program, ...result.args], ...result.then.map(step => [step.program, ...step.args])];
}

// A word diff by longest common subsequence: ' word', '-word' (package),
// '+word' (RELION), with two words of context around each change.
function wordDiff(ours, theirs) {
  const table = Array.from({ length: ours.length + 1 }, () => new Array(theirs.length + 1).fill(0));
  for (let i = ours.length - 1; i >= 0; i -= 1) {
    for (let j = theirs.length - 1; j >= 0; j -= 1) {
      table[i][j] = ours[i] === theirs[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < ours.length || j < theirs.length) {
    if (i < ours.length && j < theirs.length && ours[i] === theirs[j]) {
      lines.push([' ', ours[i]]);
      i += 1;
      j += 1;
    } else if (j < theirs.length && (i === ours.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push(['+', theirs[j]]);
      j += 1;
    } else {
      lines.push(['-', ours[i]]);
      i += 1;
    }
  }
  const keep = lines.map((line, index) => lines.slice(Math.max(0, index - 2), index + 3).some(near => near[0] !== ' '));
  const out = [];
  lines.forEach((line, index) => {
    if (keep[index]) out.push(`      ${line[0]}${JSON.stringify(line[1])}`);
    else if (keep[index - 1]) out.push('       ...');
  });
  return out.join('\n');
}

function sameNumber(a, b) {
  return a !== undefined && b !== undefined && Number(a) === Number(b) && a.trim() !== '' && b.trim() !== '';
}

async function main() {
  const GUI_CASES = args.cases === undefined ? PACKAGE_CASES : (await import(pathToFileURL(resolve(args.cases)).href)).GUI_CASES;
  const cases = GUI_CASES
    .map((testCase, index) => ({ ...testCase, id: String(index + 1).padStart(2, '0') }))
    .filter(testCase => !(testCase.spec.command === 'select' && testCase.spec.options?.mode === 'classes'))
    .filter(testCase => args.case === undefined || testCase.name.includes(args.case));
  if (cases.length === 0) throw new Error('no case matches');

  const work = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'cryo-em-parity-'));
  await writeFile(join(work, 'stub'), STUB, { mode: 0o755 });
  await writeFile(join(work, 'mpirun-stub'), MPIRUN_STUB, { mode: 0o755 });
  await writeFile(join(work, 'driver.sh'), DRIVER, { mode: 0o755 });

  // Pass 1: each command once with only its inputs and fixed settings, so
  // RELION writes its defaults and the job type's variables to job.star.
  const firstOfCommand = new Map();
  for (const testCase of cases) {
    if (!firstOfCommand.has(testCase.spec.command)) firstOfCommand.set(testCase.spec.command, testCase);
  }
  const prepared = new Map();
  for (const [command, testCase] of firstOfCommand) {
    const validated = validateRelionSpec(testCase.spec, { parts: testCase.parts ?? [], profile: testCase.profile });
    const jobNumber = Number(testCase.directory.split('/job')[1]);
    const options = addJobOptions(guiJobOptions(validated, { directory: testCase.directory, withOptions: false }));
    const run = await prepareRun(work, `defaults-${command}`, { command, jobNumber, options, inputFiles: [] });
    prepared.set(command, { run, directory: testCase.directory });
  }
  console.log(`RELION defaults: ${firstOfCommand.size} job types in ${args.image}`);
  runContainer(work);

  let failures = 0;
  const labels = new Map();
  for (const [command, { run, directory }] of prepared) {
    const jobStar = join(run, 'project', directory, 'job.star');
    if (!existsSync(jobStar)) {
      failures += 1;
      console.log(`FAIL defaults ${command}: RELION wrote no job.star\n${await runLog(run)}`);
      continue;
    }
    const values = readJobStar(await readFile(jobStar, 'utf8'));
    labels.set(command, new Set(values.keys()));
    const problems = [];
    for (const [name, option] of Object.entries(RELION_DEFINITION.commands[command].options)) {
      if (option.gui === undefined || option.required) continue;
      const theirs = values.get(option.gui);
      const ours = guiValue(command, name, option.default);
      if (theirs === undefined) problems.push(`${name}: RELION has no variable ${option.gui}`);
      else if (theirs !== ours && !((option.type === 'number' || option.type === 'int') && sameNumber(theirs, ours))) problems.push(`${name} (${option.gui}): package ${JSON.stringify(ours)}, RELION ${JSON.stringify(theirs)}`);
    }
    if (problems.length > 0) {
      failures += 1;
      console.log(`FAIL defaults ${command}\n${problems.map(line => `      ${line}`).join('\n')}`);
    } else {
      console.log(`ok   defaults ${command}`);
    }
  }
  await rm(join(work, 'runs'), { recursive: true, force: true });

  // Pass 2: every case, run, and its note.txt.
  const expected = new Map();
  for (const testCase of cases) {
    const { command } = testCase.spec;
    const validated = validateRelionSpec(testCase.spec, { parts: testCase.parts ?? [], profile: testCase.profile });
    const result = relionCommand(validated, { directory: testCase.directory, profile: testCase.profile });
    const jobNumber = Number(testCase.directory.split('/job')[1]);
    const options = addJobOptions(guiJobOptions(validated, { directory: testCase.directory, profile: testCase.profile, labels: labels.get(command) }));
    const inputFiles = Object.values(guiInputPaths(validated, testCase.directory)).filter(path => !path.includes('*') && !path.startsWith('/'));
    const run = await prepareRun(work, testCase.id, { command, jobNumber, options, inputFiles, runJob: `${testCase.directory}/` });
    expected.set(testCase.id, { testCase, result, run });
  }
  console.log(`\nRELION note.txt: ${cases.length} cases`);
  runContainer(work);

  const notes = {};
  for (const { testCase, result, run } of expected.values()) {
    const notePath = join(run, 'project', testCase.directory, 'note.txt');
    const lines = existsSync(notePath) ? readNoteCommands(await readFile(notePath, 'utf8')) : null;
    if (lines === null) {
      failures += 1;
      console.log(`FAIL ${testCase.name}: RELION wrote no command to note.txt\n${await runLog(run)}`);
      continue;
    }
    // Steps RELION's GUI does not write are left out on both sides.
    const packageOnly = new Set(PACKAGE_ONLY_PROGRAMS[testCase.spec.command] ?? []);
    notes[testCase.name] = lines;
    const theirs = lines.map(shellWords);
    const ours = packageWords(result).filter(words => !packageOnly.has(words[0]));
    const problems = [];
    const steps = Math.max(ours.length, theirs.length);
    for (let index = 0; index < steps; index += 1) {
      const a = ours[index] ?? [];
      const b = theirs[index] ?? [];
      if (a.length !== b.length || a.some((word, at) => word !== b[at])) problems.push(`    step ${index + 1}:\n${wordDiff(a, b)}`);
    }
    const handLines = testCase.gui.filter(line => !packageOnly.has(shellWords(line)[0]));
    const textMatches = handLines.length === lines.length && handLines.every((line, index) => line === lines[index]);
    if (problems.length > 0) {
      failures += 1;
      console.log(`FAIL ${testCase.name}\n${problems.join('\n')}\n    RELION:\n${lines.map(line => `      ${line}`).join('\n')}`);
    } else if (!textMatches) {
      failures += 1;
      console.log(`FAIL ${testCase.name}: same words, but test/gui-cases.js does not hold RELION's text\n    RELION:\n${lines.map(line => `      ${line}`).join('\n')}`);
    } else {
      console.log(`ok   ${testCase.name}`);
    }
  }

  if (args.notes) await writeFile(args.notes, `${JSON.stringify(notes, null, 2)}\n`);
  if (args.keep) console.log(`\nScratch kept in ${work}`);
  else await rm(work, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL: ${failures} difference(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
