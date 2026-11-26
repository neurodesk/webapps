#!/usr/bin/env node
// Runs a VesselCharter command line on the app's pinned Lausanne TOF VesselBoost
// mask example and verifies byte-for-byte parity against the in-repository module
// that the browser app runs, plus key morphometric assertions.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { characterize } from '../src/node.js';

const examples = JSON.parse(
  await readFile(new URL('../../../apps/vesselcharter/examples.json', import.meta.url), 'utf8'),
);
const example = examples[0];
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/vesselcharter.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) {
    failures.push(line);
  }
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinned({ name, url, sha256: expected }) {
  const path = join(tmpdir(), 'neurodesk-vesselcharter-validation', expected, name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) {
    return path;
  }
  // Fallback to local upstream VesselBoost fixture if matching exact SHA-256.
  const localFixture = fileURLToPath(
    new URL(
      '../../../apps/vesselboost/test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
      import.meta.url,
    ),
  );
  const localBytes = await readFile(localFixture).catch(() => null);
  if (localBytes && sha256(localBytes) === expected) {
    return localFixture;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) {
    throw new Error(`${url}: SHA-256 differs from its pin`);
  }
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

const work = await mkdtemp(join(tmpdir(), 'vesselcharter-cli-check-'));
try {
  const maskFile = await pinned(example.files.find(({ role }) => role === 'vessels'));
  const output = join(work, 'results');
  const started = performance.now();
  const run = spawnSync(command[0], [...command.slice(1), maskFile, output], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (run.error) {
    throw run.error;
  }
  if (run.status !== 0) {
    throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  }
  console.log(
    `INFO ${run.stderr.trim().split('\n').at(-1)} (${((performance.now() - started) / 1000).toFixed(1)} s)`,
  );

  const reference = join(work, 'reference');
  const expected = await characterize({ input: maskFile, output: reference });
  const names = (await readdir(output)).sort();
  check(
    JSON.stringify(names) === JSON.stringify([...expected.files].sort()),
    `outputs ${names.join(', ')}`,
  );
  for (const name of expected.files) {
    const actual = await readFile(join(output, name)).catch(() => Buffer.alloc(0));
    const expectedBytes = await readFile(join(reference, name));
    check(
      sha256(actual) === sha256(expectedBytes),
      `${name} identical to in-repository module (${sha256(actual).slice(0, 12)})`,
    );
  }

  const summaryName = expected.files.find((name) => name.endsWith('_summary.json'));
  const summary = JSON.parse(await readFile(join(output, summaryName), 'utf8'));
  check(summary.input.inputVesselVoxels === 33894, `vessel voxels ${summary.input.inputVesselVoxels} === 33894`);
  check(summary.network.segmentCount > 80, `segment count ${summary.network.segmentCount} > 80`);
  check(summary.network.totalLengthMm > 800, `total length ${summary.network.totalLengthMm.toFixed(1)} mm > 800`);
  check(summary.network.medianDiameterMm > 0.5, `median diameter ${summary.network.medianDiameterMm.toFixed(2)} mm > 0.5`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
