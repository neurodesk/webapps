#!/usr/bin/env node
// Actual MATLAB Runtime references: README.md explains the precision control and gates.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as samsrf from '../../src/node.js';

const [directory, output] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node compare.mjs REFERENCE_DIRECTORY [REPORT.json]');
const read = file => readFileSync(join(directory, file));
const json = file => JSON.parse(read(file));
const f64 = file => {
  const bytes = read(file);
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const manifest = json('manifest.json');
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(read(file)).digest('hex');
  if (actual !== expected) throw new Error(`Reference checksum mismatch: ${file}`);
}
const info = json('matlab-input.json');
const vertices = Uint32Array.from(info.vertices);
const aperture = samsrf.readAperturesFile(join(directory, 'aps_Bars.mat'));
const apertures = aperture.serialize();
aperture.free();
const typed = { Float64Array, Float32Array, Uint32Array, Int32Array, Uint8Array };
const cf = JSON.parse(read('cf-input.json'), (key, value) => {
  if (!value?.file || !value.type) return value;
  const bytes = read(value.file);
  const Constructor = typed[value.type];
  if (!Constructor || bytes.byteLength !== value.length * Constructor.BYTES_PER_ELEMENT) throw new Error(`Invalid typed reference ${value.file}`);
  return new Constructor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
});
const report = { image: manifest.image, runtime: manifest.runtime, reportedVersion: manifest.reportedVersion, gates: [], defaultPrecisionDifferences: [] };
const exactMaps = {
  prf_coarse: ['x0', 'y0', 'sigma', 'ecc', 'noise_ceiling'],
  prf_fine: ['noise_ceiling'],
  rc_hull: ['x0', 'y0', 'fwhm', 'ecc', 'noise_ceiling'],
  cf_hull: ['x0', 'y0', 'centre', 'surround', 'vx', 'ecc', 'noise_ceiling'],
};

function compare(actual, expected, indices) {
  if (actual.length !== expected.length) throw new Error('Reference and output map dimensions differ');
  let maxAbs = 0;
  let different = 0;
  let nonfiniteMismatch = 0;
  let worstVertex = null;
  for (const v of indices) {
    const a = actual[v];
    const e = expected[v];
    if (!Number.isFinite(a) || !Number.isFinite(e)) {
      if (!(a === e || Number.isNaN(a) && Number.isNaN(e))) nonfiniteMismatch += 1;
      continue;
    }
    const difference = Math.abs(a - e);
    if (difference > 0) different += 1;
    if (difference > maxAbs) { maxAbs = difference; worstVertex = v; }
  }
  return { maxAbs, different, nonfiniteMismatch, worstVertex };
}

function gate(name, difference, tolerance) {
  const pass = difference.nonfiniteMismatch === 0 && difference.maxAbs <= tolerance;
  report.gates.push({ name, ...difference, tolerance, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: max |difference| ${difference.maxAbs}`);
}

for (const name of ['prf_coarse', 'prf_fine', 'rc_hull', 'cf_hull']) {
  const model = json(`runs/${name}/model.json`);
  const spec = name === 'cf_hull' ? cf : {
    kind: name === 'rc_hull' ? 'rc' : 'prf', model: JSON.stringify(model), apertures,
    data: { vertices, volumes: info.volumes, courses: f64('matlab-courses.f64') },
    roi: vertices, noiseCeiling: f64('matlab-ceiling.f64'), totalVertices: 134260,
  };
  const job = samsrf.createJob(spec);
  let maps;
  try { ({ maps } = samsrf.runJob(job)); } finally { job.free(); }
  const prefix = `lh_${name}`;
  const exported = new Map(samsrf.exportGiis(maps, prefix, null, 'samsrfx-10.003').map(file => [file.name, samsrf.readGifti(file.bytes).arrays[0].data]));
  const references = new Map(readdirSync(join(directory, 'runs', name)).filter(file => file.endsWith('.gii')).map(file => [file, samsrf.readGifti(read(`runs/${name}/${file}`)).arrays[0].data]));
  for (const map of exactMaps[name]) {
    const file = `${prefix}_${map}.gii`;
    if (!references.has(file)) throw new Error(`Missing required MATLAB reference ${file}`);
  }
  for (const [file, expected] of references) {
    const actual = exported.get(file);
    if (!actual) throw new Error(`Missing output ${file}`);
    const difference = compare(actual, expected, vertices);
    report.defaultPrecisionDifferences.push({ analysis: name, map: file, ...difference });
    console.log(`DIFF ${file}: ${difference.maxAbs} (${difference.different}/${vertices.length} vertices; nonfinite mismatches ${difference.nonfiniteMismatch})`);
    if (exactMaps[name].some(map => file === `${prefix}_${map}.gii`)) gate(`default MATLAB: ${file}`, difference, 0);
  }
  // Isolate the export convention from differences in the fitted coordinates.
  const referenceMaps = {
    values: ['R^2', 'x0', 'y0'], vertices: maps.vertices,
    data: Float64Array.from(['r^2', 'x0', 'y0'].flatMap(key => Array.from(references.get(`${prefix}_${key}.gii`)))),
  };
  const derived = samsrf.polarAndEccentricity(referenceMaps, 'samsrfx-10.003');
  gate(`${name}: legacy eccentricity from identical coordinates`, compare(derived.eccentricity, references.get(`${prefix}_ecc.gii`), vertices), 0);
  // MATLAB's single atan2 and WASM libm differ by an ULP on some coordinates.
  gate(`${name}: legacy polar angle from identical coordinates`, compare(derived.polar, references.get(`${prefix}_pol.gii`), vertices), 2 ** -15);
  if (name === 'prf_fine') {
    const expected = json('fits-double.json');
    for (const [column, label] of ['x0', 'y0', 'Sigma'].entries()) {
      const actual = Float64Array.from(vertices, v => maps.data[(column + 1) * maps.vertices + v]);
      gate(`matched float64 MATLAB fit: ${label}`, compare(actual, expected.map(row => row[column]), actual.keys()), 1e-9);
    }
    for (const [column, label] of ['R^2', 'Beta', 'Baseline'].entries()) {
      const row = maps.values.indexOf(label);
      const actual = Float64Array.from(vertices, v => maps.data[row * maps.vertices + v]);
      gate(`matched float64 MATLAB fit: ${label}`, compare(actual, expected.map(values => values[column + 3]), actual.keys()), 1e-9);
    }
    const single = json('fits-single.json');
    for (const [column, label] of ['x0', 'y0', 'sigma', 'r^2', 'beta', 'baseline'].entries()) {
      const expectedMap = references.get(`${prefix}_${label}.gii`);
      const expected = Float64Array.from(vertices, v => expectedMap[v]);
      gate(`single-precision probe reproduces GUI: ${label}`, compare(single.map(row => Math.fround(row[column])), expected, expected.keys()), 0);
    }
  }
}
if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log('Default-single vs web-double differences above are diagnostics, not a claim of exact parity.');
if (report.gates.some(result => !result.pass) || report.defaultPrecisionDifferences.some(result => result.nonfiniteMismatch)) process.exitCode = 1;
