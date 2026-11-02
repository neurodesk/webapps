#!/usr/bin/env node
// Runs a samsrf command line on the web app's pinned example (apps/samsrf/examples.json): reverse
// correlation on the whole V1-V3 label in three worker shards, and the Nelder-Mead pRF fit and the
// connective-field analysis on its first 200 vertices. Every GIfTI must be byte-identical to the same
// job run in this process, in one piece, on the same files through src/node.js, and the fixed pins
// below (file names, one value per vertex, R^2 above 0.1 inside the ROI) must hold.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { analysisSpec, createJob, exportGiis, readAnalysisInputs, readGifti, runJob } from '../src/node.js';
import { MODELS } from './example-inputs.mjs';

const TOTAL_VERTICES = 134260;
const SMALL_ROI = 200;
const MAPS = {
  rc: ['pol', 'ecc', 'r^2', 'x0', 'y0', 'fwhm', 'beta', 'noise_ceiling'].map((map) => `lh_pRF_Rcp_${map}.gii`),
  prf: ['pol', 'ecc', 'nr^2', 'x0', 'y0', 'sigma', 'beta', 'baseline', 'noise_ceiling', 'r^2'].map((map) => `lh_pRF_Gaussian_${map}.gii`),
  cf: ['pol', 'ecc', 'r^2', 'x0', 'y0', 'centre', 'surround', 'beta', 'suppression', 'fwhm', 'vx', 'noise_ceiling'].map((map) => `lh_CF_Rcp_${map}.gii`),
};
// The fewest ROI vertices with R^2 > 0.1 each case must reach (the example gives several times more).
const FITTED = { rc: 2000, prf: 50, cf: 50 };

const [example] = JSON.parse(await readFile(new URL('../../../apps/samsrf/examples.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/samsrf.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

// A pinned example file, from SAMSRF_WEBAPP_EXAMPLE_DIR when it holds the same bytes, else downloaded once
// into a cache under the temporary directory.
async function pinned({ name, url, sha256: expected }) {
  const local = process.env.SAMSRF_WEBAPP_EXAMPLE_DIR && join(process.env.SAMSRF_WEBAPP_EXAMPLE_DIR, name);
  for (const path of [local, join(tmpdir(), 'neurodesk-samsrf-validation', expected, name)].filter(Boolean)) {
    const cached = await readFile(path).catch(() => null);
    if (cached && sha256(cached) === expected) return path;
  }
  const path = join(tmpdir(), 'neurodesk-samsrf-validation', expected, name);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

const work = await mkdtemp(join(tmpdir(), 'samsrf-cli-check-'));
try {
  const files = {};
  for (const file of example.files) files[file.name] = await pinned(file);
  const runs = example.files.filter(({ role }) => role === 'run').map(({ name }) => files[name]);

  // The first SMALL_ROI vertices of the V1-V3 label, in file order, as a label of their own.
  const [header, , ...rows] = (await readFile(files['lh.V123.label'], 'utf8')).split('\n');
  const smallLabel = join(work, 'lh.V123_first200.label');
  await writeFile(smallLabel, `${[header, String(SMALL_ROI), ...rows.slice(0, SMALL_ROI)].join('\n')}\n`);
  for (const [kind, model] of Object.entries(MODELS)) await writeFile(join(work, `${kind}.json`), JSON.stringify(model, null, 2));

  const apertures = files['aps_Bars.mat'];
  const cases = [
    { kind: 'rc', inputs: { roi: files['lh.V123.label'], apertures }, shards: 3 },
    { kind: 'prf', inputs: { roi: smallLabel, apertures }, shards: 1 },
    {
      kind: 'cf',
      inputs: { roi: smallLabel, seed: files['lh.V1_seed.label'], template: files['lh_benson.gii'], white: files['lh.white'], area: files['lh.area'] },
      shards: 1,
    },
  ];
  for (const { kind, inputs, shards } of cases) {
    const output = join(work, kind);
    const started = performance.now();
    const options = Object.entries(inputs).flatMap(([name, path]) => [`--${name}`, path]);
    const argv = [...command.slice(1), kind, join(work, `${kind}.json`), output, '--runs', ...runs, ...options, '--shards', String(shards)];
    const run = spawnSync(command[0], argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command.join(' ')} ${kind} exited with ${run.status}:\n${run.stderr}`);
    console.log(`INFO ${kind}: ${run.stderr.trim().split('\n').at(-1)} (${((performance.now() - started) / 1000).toFixed(1)} s)`);

    // The same job in this process, on the same files, in one piece.
    const reference = readAnalysisInputs({ runs, ...inputs });
    const job = createJob(analysisSpec(reference, kind, MODELS[kind]));
    let expected;
    try {
      expected = exportGiis(runJob(job).maps, `lh_${job.modelName}${job.outSuffix}`);
    } finally {
      job.free();
    }
    const names = (await readdir(output)).sort();
    const provenance = MAPS[kind][0].replace(/_pol\.gii$/, '_provenance.json');
    check(JSON.stringify(expected.map(({ name }) => name)) === JSON.stringify(MAPS[kind]), `${kind}: the in-process job exports ${MAPS[kind].length} maps`);
    check(JSON.stringify(names) === JSON.stringify([...MAPS[kind], provenance].sort()), `${kind}: outputs ${names.join(', ')}`);
    for (const { name, bytes } of expected) {
      const actual = await readFile(join(output, name)).catch(() => Buffer.alloc(0));
      check(sha256(actual) === sha256(bytes), `${kind}: ${name} identical to the in-process job (${sha256(actual).slice(0, 12)})`);
    }
    const map = async (name) => readGifti(await readFile(join(output, name))).arrays[0].data;
    const counts = await Promise.all(MAPS[kind].map(async (name) => (await map(name).catch(() => [])).length));
    check(counts.every((count) => count === TOTAL_VERTICES), `${kind}: every map holds ${TOTAL_VERTICES} values`);
    const r2 = await map(MAPS[kind].find((name) => name.endsWith('_r^2.gii'))).catch(() => []);
    const fitted = Array.from(reference.roi).filter((vertex) => r2[vertex] > 0.1).length;
    check(fitted >= FITTED[kind], `${kind}: ${fitted} of ${reference.roi.length} ROI vertices with R^2 > 0.1 (at least ${FITTED[kind]})`);
    const record = JSON.parse(await readFile(join(output, provenance), 'utf8').catch(() => '{}'));
    const inputCount = runs.length + Object.keys(inputs).length;
    check(record.analysedVertices === reference.roi.length && record.inputs?.length === inputCount,
      `${kind}: provenance records ${record.analysedVertices} vertices and ${record.inputs?.length} of ${inputCount} inputs`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} samsrf command-line checks` : 'PASS samsrf command line matches the in-process SamSrf port on the web app example');
process.exitCode = failures.length ? 1 : 0;
