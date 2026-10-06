#!/usr/bin/env node
// Registers the web app's pinned example with a FireANTs command line, once per preset, and
// compares each result with t1-mni-reference.json: first with the web app's own download
// (browser, recorded by apps/fireants/e2e/reference.spec.js), then with the engine called
// in-process (inProcess, recorded by --write-reference).
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { register } from '@fireants/fireants';
import enginePackage from '@fireants/fireants/package.json' with { type: 'json' };
import { finalNcc } from '../src/node.js';
import { registeredFileName } from '../src/outputs.js';
import { EXAMPLE_SHA256, THREADS, TOLERANCES, TRANSFORMS, compare, pinnedExample, readReference, recorded, summarize, writeReference } from './reference.mjs';

// Registration of the 1 mm example takes minutes; the engine's own default limit is 15.
const TIMEOUT_MS = 6 * 60 * 60 * 1000;
const ENGINE = `${enginePackage.name} ${enginePackage.version}`;

const { values } = parseArgs({
  options: {
    executable: { type: 'string' },
    'write-reference': { type: 'boolean' },
    transform: { type: 'string', multiple: true },
  },
});
const transforms = values.transform ?? TRANSFORMS;
for (const transform of transforms) {
  if (!TRANSFORMS.includes(transform)) throw new Error(`--transform must be ${TRANSFORMS.join(' or ')}, not "${transform}"`);
}
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/fireants.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const example = await pinnedExample();
const fixedBytes = await readFile(example.fixed.path);
const reference = await readReference();

async function recordInProcess(transform) {
  const started = performance.now();
  const result = await register(fixedBytes, await readFile(example.moving.path), {
    backend: 'cpu',
    transform,
    threads: THREADS,
    worker: false,
    gzip: true,
    verbose: 1,
    timeoutMs: TIMEOUT_MS,
  });
  const entry = {
    path: 'register() in-process with worker: false, otherwise as apps/fireants/src/main.js calls it',
    threads: result.threads,
    seconds: Math.round((performance.now() - started) / 1000),
    stages: result.log.split('\n').filter((line) => /\(NCC /.test(line)).map((line) => line.trim()),
    finalNcc: finalNcc(result.log),
    ...recorded(summarize(Buffer.from(result.image), fixedBytes)),
  };
  // Re-read so a browser reference recorded meanwhile is kept.
  const latest = await readReference();
  latest.example = example.id;
  latest.inputs = EXAMPLE_SHA256;
  latest.engine = ENGINE;
  latest.threads = THREADS;
  latest.cases[transform].inProcess = entry;
  await writeReference(latest);
  console.log(JSON.stringify(entry, null, 2));
}

async function checkCommandLine(transform, work) {
  const cases = reference.cases[transform];
  const output = join(work, transform);
  const started = performance.now();
  const run = spawnSync(command[0], [...command.slice(1), example.moving.path, example.fixed.path, output, '--transform', transform, '--threads', String(THREADS)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  const seconds = (performance.now() - started) / 1000;
  const name = registeredFileName(example.moving.name);
  const files = await readdir(output);
  check(files.length === 1 && files[0] === name, `${transform} ${example.id} writes only ${name} (${seconds.toFixed(0)} s on ${THREADS} threads)`);
  if (!files.includes(name)) return;
  const actual = {
    ...summarize(await readFile(join(output, name)), fixedBytes),
    finalNcc: finalNcc(run.stderr),
  };
  for (const [passed, line] of compare(`${transform} command line`, actual, cases.browser, 'browser')) check(passed, line);
  check(actual.voxelSha256 === cases.inProcess.voxelSha256, `${transform} command line voxels identical to the in-process engine reference's ${cases.inProcess.voxelSha256.slice(0, 12)}`);
  check(
    Number.isFinite(actual.finalNcc) && Math.abs(actual.finalNcc - cases.inProcess.finalNcc) <= TOLERANCES.finalNcc,
    `${transform} command line final NCC ${actual.finalNcc} vs in-process ${cases.inProcess.finalNcc}, |diff| <= ${TOLERANCES.finalNcc}`,
  );
}

if (values['write-reference']) {
  for (const transform of transforms) await recordInProcess(transform);
} else {
  check(reference.engine === ENGINE, `reference engine ${reference.engine} is the installed one`);
  for (const transform of transforms) {
    check(Boolean(reference.cases[transform]?.browser && reference.cases[transform]?.inProcess), `${transform} has browser and in-process references`);
  }
  const work = await mkdtemp(join(tmpdir(), 'fireants-cli-check-'));
  try {
    for (const transform of transforms) {
      if (reference.cases[transform]?.browser && reference.cases[transform]?.inProcess) await checkCommandLine(transform, work);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(failures.length ? `FAIL ${failures.length} FireANTs command-line checks` : `PASS FireANTs command line reproduces the web app's ${transforms.join(' and ')} registrations of the pinned example`);
  process.exitCode = failures.length ? 1 : 0;
}
