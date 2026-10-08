#!/usr/bin/env node
// Runs a brain2print command line on every case in browser-reference.json and holds its files to
// what the web app's pipeline wrote in Chromium: the browser ran MindGrab's published wrapper on
// its CPU backend and niimath in its WebAssembly worker; the command line runs the Node drivers.
// The files are measured with this directory's own parsers (measure.mjs).
//
//   node validation/cli-check.mjs [--executable PATH] [--only CASE,...]
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REFERENCE_URL, caseInput } from './cases.mjs';
import { compareOutputs, measureOutputs } from './measure.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' }, only: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/brain2print.js', import.meta.url))];
const only = values.only ? new Set(values.only.split(',')) : null;
const reference = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const flags = (settings) => [
  '--model', settings.model,
  '--simplify', String(settings.simplify),
  '--smooth', String(settings.smooth),
  settings.largestOnly ? '--largest-only' : '--no-largest-only',
  settings.fillBubbles ? '--fill-bubbles' : '--no-fill-bubbles',
];

async function files(directory) {
  const map = new Map();
  for (const name of (await readdir(directory)).sort()) map.set(name, new Uint8Array(await readFile(join(directory, name))));
  return map;
}

// The release check runs with an empty home that must stay empty, so everything goes under the temporary directory.
const work = await mkdtemp(join(tmpdir(), 'brain2print-cli-check-'));
try {
  for (const [id, expected] of Object.entries(reference.cases)) {
    if (only && !only.has(id)) continue;
    const { name, bytes } = await caseInput(expected.input);
    const input = join(work, `${id}-${name}`);
    await writeFile(input, bytes);
    const output = join(work, id);
    const started = Date.now();
    const run = spawnSync(command[0], [...command.slice(1), input, output, ...flags(expected.settings)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      check(false, `${id}: ${command.join(' ')} exited with ${run.status}: ${run.stderr.trim()}`);
      continue;
    }
    const report = JSON.parse(run.stdout);
    console.log(`INFO ${id}: ${((Date.now() - started) / 1000).toFixed(1)} s, browser ${expected.seconds} s, ${JSON.stringify(report.provenance)}`);
    check(JSON.stringify(report.provenance.settings) === JSON.stringify(expected.settings), `${id}: provenance records the settings ${JSON.stringify(report.provenance.settings)}`);
    check(report.provenance.segmentation.version === reference.mindgrab && report.provenance.segmentation.backend === 'cpu', `${id}: MindGrab ${report.provenance.segmentation.version} on ${report.provenance.segmentation.backend}, browser ${reference.mindgrab} on ${reference.backend}`);
    check(report.provenance.niimath === reference.niimath, `${id}: niimath ${report.provenance.niimath}, browser ${reference.niimath}`);
    check(JSON.stringify(report.provenance.meshing) === JSON.stringify(expected.report.meshing), `${id}: niimath mesh options ${JSON.stringify(report.provenance.meshing.options)}`);
    check(JSON.stringify(report.measurements) === JSON.stringify(expected.report.measurements), `${id}: reported mesh checks ${JSON.stringify(report.measurements)} equal the browser's`);
    for (const [passed, line] of compareOutputs(measureOutputs(await files(output)), expected)) check(passed, `${id}: ${line}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} brain2print command-line checks` : 'PASS brain2print command line matches the web app');
process.exitCode = failures.length ? 1 : 0;
