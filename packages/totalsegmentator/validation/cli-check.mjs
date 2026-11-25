#!/usr/bin/env node
// Verifies a totalsegmentator command line on both pinned CT (RAS) and MRI (LPS) examples.
// Runs offline against bundled models when invoked by portable_release.py verify (with an
// isolated empty HOME that must remain untouched).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fetchBytesWithRetry } from '@neurodesk/webapp-components/fetch';
import { readVolume } from '@neurodesk/synthsr';
import { modelById } from '../src/models.js';

const examples = JSON.parse(await readFile(new URL('../../../apps/totalsegmentator/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/totalsegmentator.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinnedExample(exampleId) {
  const example = examples.find((item) => item.id === exampleId);
  if (!example) throw new Error(`Missing example ${exampleId} in apps/totalsegmentator/examples.json`);
  const [file] = example.files;
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(tmpdir(), 'neurodesk-totalsegmentator-validation', pin.sha256, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === pin.sha256) return path;
  const bytes = Buffer.from(await fetchBytesWithRetry(file.url, { signal: AbortSignal.timeout(600_000) }, { retryTransient: true, retries: 3 }));
  if (sha256(bytes) !== pin.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

function affineMatches(actual, expected) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(actual[r][c] - expected[r][c]) > 1e-4) return false;
    }
  }
  return true;
}

async function runCase({ label, input, output, task, resolution, expectedModelId, expectedFiles, minStructures, meanColumn }) {
  const run = spawnSync(
    command[0],
    [...command.slice(1), input, output, '--task', task, '--resolution', resolution],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  console.log(`INFO ${label} (--task ${task} --resolution ${resolution})`);
  check(
    report.provenance.executionProvider === 'cpu',
    `${label}: executionProvider ${report.provenance.executionProvider}, ${report.provenance.threads} threads, ONNX Runtime ${report.provenance.onnxruntime}, ${report.provenance.seconds} s`,
  );
  const expectedModel = modelById(expectedModelId);
  check(
    report.provenance.models.length === 1 && report.provenance.models[0].sha256 === expectedModel.sha256,
    `${label}: model ${report.provenance.models.map(({ file }) => file).join(', ')} matches pin`,
  );
  const outFiles = (await readdir(output)).sort();
  check(JSON.stringify(outFiles) === JSON.stringify([...expectedFiles].sort()), `${label}: outputs ${outFiles.join(', ')}`);

  const inputVol = readVolume(arrayBuffer(await readFile(input)));
  const segRaw = gunzipSync(await readFile(join(output, expectedFiles[0])));
  check(segRaw.readInt16LE(70) === 2, `${label}: segmentation NIfTI datatype is uint8 (2)`);
  const segVol = readVolume(arrayBuffer(segRaw));
  check(JSON.stringify(segVol.dims) === JSON.stringify(inputVol.dims), `${label}: dims ${segVol.dims.join('x')} match input`);
  check(affineMatches(segVol.affine, inputVol.affine), `${label}: affine matches input geometry`);

  const uniqueLabels = new Set(segRaw.subarray(352));
  const detected = uniqueLabels.size - (uniqueLabels.has(0) ? 1 : 0);
  check(detected >= minStructures, `${label}: detected ${detected} structures >= ${minStructures}`);

  const tsv = await readFile(join(output, expectedFiles[1]), 'utf8');
  const rows = tsv.trim().split('\n').map((line) => line.split('\t'));
  const headers = rows[0] || [];
  const volumeIdx = headers.indexOf('volume_ml');
  check(headers.includes(meanColumn) && volumeIdx >= 0, `${label}: TSV includes ${meanColumn} and volume_ml columns`);
  const liverRow = rows.find((cols) => cols[1] === 'liver');
  const liverMl = liverRow && volumeIdx >= 0 ? Number(liverRow[volumeIdx]) : 0;
  check(Number.isFinite(liverMl) && liverMl > 400 && liverMl < 4000, `${label}: liver detected (${liverMl.toFixed(1)} mL, expected 400-4000 mL)`);
}

const work = await mkdtemp(join(tmpdir(), 'totalseg-cli-check-'));
try {
  const ctInput = await pinnedExample('ct-abdomen');
  await runCase({
    label: 'CT fast 3mm',
    input: ctInput,
    output: join(work, 'ct'),
    task: 'total',
    resolution: 'fast',
    expectedModelId: 'total-ct-3mm',
    expectedFiles: ['example_ct_sm_totalseg_total.nii.gz', 'example_ct_sm_totalseg_total_stats.tsv'],
    minStructures: 35,
    meanColumn: 'mean_hu',
  });

  const mrInput = await pinnedExample('mr-abdomen');
  await runCase({
    label: 'MRI fast 3mm (LPS)',
    input: mrInput,
    output: join(work, 'mr'),
    task: 'total_mr',
    resolution: 'fast',
    expectedModelId: 'total-mr-3mm',
    expectedFiles: ['example_mr_sm_totalseg_total_mr.nii.gz', 'example_mr_sm_totalseg_total_mr_stats.tsv'],
    minStructures: 20,
    meanColumn: 'mean_intensity',
  });
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} TotalSegmentator command-line checks` : 'PASS TotalSegmentator command line verified on CT and MRI');
process.exitCode = failures.length ? 1 : 0;
