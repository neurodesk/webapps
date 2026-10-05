#!/usr/bin/env node
// Runs a TopoFit command line on the pinned OpenNeuro scan and compares it with the
// OpenRecon end-to-end reference. Preprocessing hashes and limits come from the checked-in report.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const report = JSON.parse(await readFile(new URL('./results/ds000001-end-to-end.json', import.meta.url), 'utf8'));
const models = JSON.parse(await readFile(new URL('../model.manifest.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/topofit.js', import.meta.url))];

// The OpenRecon surfaces published at the model manifest's revision are the 2026-09-11 capture
// (this report as of commit 8b7b7f5c). The report's current reference_sha256 values name an
// unpublished recapture whose files differ, at least in FreeSurfer's "created by" stamp.
const PUBLISHED_REFERENCE_SHA256 = {
  'lh.white': '019b12b21a40c525f5b2574af5f31b55725d517b68e02cd811825974f4fc126b',
  'rh.white': '4a0c230add9cece03f713a7f706251a88db176b00faea2fcac0602fa34cdd1cd',
  'lh.pial': 'ea9d56cfa4274d0e21158bc5fb0b602e322ff92c2a0cffe8fccdb3b9bbd0fd96',
  'rh.pial': 'ddb4a4c2e9a15dc122928a9557b03b641d93a73594ae7065867b46ef686bd7cc',
  'lh.registration': '2ee500bb51fe710f0da82539a732fceb2bf439fd886e09bede2d77e32795d377',
  'rh.registration': '6642526992336467480a2f786de0c2306c8e5a1c3178842ddd9d3af670070533',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinned(relative, expected) {
  const directory = join(tmpdir(), 'neurodesk-topofit-validation', models.revision);
  const path = join(directory, ...relative.split('/'));
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return path;
  const url = new URL(`validation/${relative}`, models.base_url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

function readSurface(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xff || bytes[2] !== 0xfe) throw new Error('not a FreeSurfer triangle surface');
  let offset = bytes.indexOf(0x0a, 3) + 1;
  if (bytes[offset] === 0x0a) offset += 1;
  const vertexCount = bytes.readInt32BE(offset);
  const faceCount = bytes.readInt32BE(offset + 4);
  offset += 8;
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertices.length; i += 1, offset += 4) vertices[i] = bytes.readFloatBE(offset);
  const faces = new Int32Array(faceCount * 3);
  for (let i = 0; i < faces.length; i += 1, offset += 4) faces[i] = bytes.readInt32BE(offset);
  return { vertices, faces };
}

// numpy.quantile(..., method="linear"), as compare.py computes the reference report.
function quantile(values, probability) {
  const sorted = Float64Array.from(values).sort();
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const maximum = (values) => values.reduce((largest, value) => Math.max(largest, value), -Infinity);

function compareSurface(name, actual, reference) {
  const count = reference.vertices.length / 3;
  check(actual.vertices.length === reference.vertices.length, `${name} vertices ${actual.vertices.length / 3} = ${count}`);
  const facesIdentical = actual.faces.length === reference.faces.length && actual.faces.every((value, i) => value === reference.faces[i]);
  check(facesIdentical, `${name} faces identical to OpenRecon (${reference.faces.length / 3})`);
  if (actual.vertices.length !== reference.vertices.length) return;
  const distance = new Float64Array(count);
  const angle = new Float64Array(count);
  const radiusError = new Float64Array(count);
  for (let v = 0; v < count; v += 1) {
    const [ax, ay, az] = actual.vertices.subarray(v * 3, v * 3 + 3);
    const [rx, ry, rz] = reference.vertices.subarray(v * 3, v * 3 + 3);
    distance[v] = Math.hypot(ax - rx, ay - ry, az - rz);
    const actualRadius = Math.hypot(ax, ay, az);
    const cosine = (ax * rx + ay * ry + az * rz) / (actualRadius * Math.hypot(rx, ry, rz));
    angle[v] = (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
    radiusError[v] = Math.abs(actualRadius - 100);
  }
  const limit = (value, threshold, unit, label) => check(
    Number.isFinite(value) && value >= 0 && value <= threshold,
    `${name} ${label} ${value.toPrecision(3)} ${unit} <= ${threshold}`,
  );
  const { thresholds } = report;
  if (name.endsWith('registration')) {
    limit(mean(angle), thresholds.registrationMeanDegrees, 'deg', 'mean angle');
    limit(quantile(angle, 0.95), thresholds.registrationP95Degrees, 'deg', 'p95 angle');
    limit(maximum(radiusError), thresholds.registrationRadiusMaxMm, 'mm', 'max radius error');
  } else {
    limit(mean(distance), thresholds.surfaceMeanMm, 'mm', 'mean distance');
    limit(quantile(distance, 0.95), thresholds.surfaceP95Mm, 'mm', 'p95 distance');
    limit(maximum(distance), thresholds.surfaceMaxMm, 'mm', 'max distance');
  }
}

const work = await mkdtemp(join(tmpdir(), 'topofit-cli-check-'));
try {
  check(report.release === models.release, `reference release ${report.release} matches the model manifest`);
  const input = await pinned('inputs/sub-01_T1w.nii.gz', report.input.sha256);
  const output = join(work, 'surfaces');
  const run = spawnSync(command[0], [...command.slice(1), input, output], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  const manifest = JSON.parse(await readFile(join(output, 'topofit_manifest.json'), 'utf8'));
  check(manifest.inputSha256 === report.input.sha256, `inputSha256 ${manifest.inputSha256}`);
  for (const key of ['inferenceSha256', 'alignmentInputSha256', 'modelInputSha256']) {
    check(manifest[key] === report.provenance[key], `${key} ${manifest[key]}`);
  }
  const assets = Object.fromEntries(Object.entries(manifest.runtime.assets).sort(([a], [b]) => (a < b ? -1 : 1)));
  check(sha256(JSON.stringify(assets)) === report.provenance.assetSetSha256, `assetSetSha256 ${sha256(JSON.stringify(assets))}`);
  check(manifest.runtime.executionProvider === 'cpu', `executionProvider ${manifest.runtime.executionProvider}, ${manifest.runtime.threads} threads, ONNX Runtime ${manifest.runtime.onnxruntime}`);
  for (const [name, hash] of Object.entries(manifest.outputSha256)) {
    check(sha256(await readFile(join(output, name))) === hash, `${name} matches its recorded SHA-256`);
  }
  for (const name of Object.keys(report.surfaces)) {
    const reference = readSurface(await readFile(await pinned(`openrecon/end-to-end/surf/${name}`, PUBLISHED_REFERENCE_SHA256[name])));
    compareSurface(name, readSurface(await readFile(join(output, name))), reference);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} TopoFit command-line checks` : 'PASS TopoFit command line matches the OpenRecon end-to-end reference');
process.exitCode = failures.length ? 1 : 0;
