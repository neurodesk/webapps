// Raw GIfTI, FreeSurfer and aperture inputs through the public Node API, against
// both hosts of the reverse-correlation recording (revcor-reference.json). Gates:
// preprocessing, the global signal and the anatomy exactly, the Benson reader at
// compare.mjs's limit, then every supported RC/CF job (CF on MATLAB's template).
// exes/samsrf/core/tests/revcor_reference.rs isolates each stage from MATLAB's
// own arrays and documents the limits used here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as samsrf from '../../src/node.js';

const [reference, inputs, reportFile] = process.argv.slice(2);
if (!reference || !inputs) throw new Error('Usage: compare-revcor.mjs REVCOR_REFERENCE_DIR MATRIX_INPUT_DIR [REPORT_JSON]');
const HOSTS = ['ubuntu-22.04', 'ubuntu-24.04'];
// The AVX-512 host reduces corr's dot product in an order the port does not follow.
const INTEL = 'ubuntu-24.04';
const UNIT = 2 ** -24;
const manifest = JSON.parse(fs.readFileSync(path.join(inputs, 'manifest.json'), 'utf8'));
const reports = [];

function readArray(root, descriptor) {
  assert.ok(descriptor?.file && descriptor.shape, 'Missing array descriptor');
  const bytes = fs.readFileSync(path.join(root, descriptor.file));
  assert.equal(bytes.byteLength, descriptor.shape.reduce((a, b) => a * b, 1) * 8, descriptor.file);
  return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const same = (a, e) => a === e || Number.isNaN(a) && Number.isNaN(e);

function ulps(a, e) {
  if (same(a, e)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(e)) return Infinity;
  const key = (value) => {
    const bits = new Int32Array(new Float32Array([value]).buffer)[0];
    return bits < 0 ? -2147483648 - bits : bits;
  };
  return Math.abs(key(a) - key(e));
}

function gate(id, name, actual, expected, accept) {
  assert.equal(actual.length, expected.length, `${id}/${name}: shape`);
  const failures = [];
  for (let i = 0; i < actual.length; i++) {
    if (!accept(actual[i], expected[i], i)) failures.push({ index: i, actual: actual[i], expected: expected[i] });
  }
  reports.push({ id, name, values: actual.length, failures });
  if (failures.length) console.log(`FAIL ${id}/${name}: ${failures.length} values, first ${JSON.stringify(failures[0])}`);
}

const exact = (a, e) => same(a, e);
const close = (a, e) => same(a, e) || Math.abs(a - e) <= 1e-12 * Math.max(1, Math.abs(e));
const castFor = (precision) => (values) => precision === 'single' ? Float64Array.from(values, Math.fround) : values;

/** A MATLAB v5 file holding one uncompressed double array named ApFrm. */
function apertureMat(dims, data) {
  const pad = (n) => Math.ceil(n / 8) * 8;
  const name = Buffer.from('ApFrm');
  const parts = [];
  const element = (type, payload) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(type, 0);
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload, Buffer.alloc(pad(payload.length) - payload.length)]);
  };
  const flags = Buffer.alloc(8);
  flags.writeUInt32LE(6, 0); // mxDOUBLE_CLASS
  parts.push(element(6, flags));
  const dimensions = Buffer.alloc(4 * dims.length);
  dims.forEach((dim, i) => dimensions.writeInt32LE(dim, 4 * i));
  parts.push(element(5, dimensions));
  parts.push(element(1, name));
  parts.push(element(9, Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
  const header = Buffer.alloc(128, ' ');
  header.write('MATLAB 5.0 MAT-file, written by compare-revcor.mjs');
  header.writeUInt16LE(0x0100, 124);
  header.write('IM', 126);
  return Buffer.concat([header, element(14, Buffer.concat(parts))]);
}

/** record_revcor_matrix.m: every fifth row and column of aps_Bars, repeated per run. */
function revcorApertures(dataset, average) {
  const full = samsrf.readAperturesFile(path.join(inputs, dataset.apertures));
  const [height, width, frames] = [full.height, full.width, full.volumes];
  const dense = full.toDense();
  full.free();
  const rows = Math.ceil(height / 5), cols = Math.ceil(width / 5);
  const repeats = average ? 1 : dataset.runs.length;
  const out = new Float64Array(rows * cols * frames * repeats);
  for (let r = 0; r < repeats; r++) {
    for (let t = 0; t < frames; t++) {
      for (let c = 0; c < cols; c++) {
        for (let y = 0; y < rows; y++) out[((r * frames + t) * cols + c) * rows + y] = dense[t * height * width + c * 5 * height + y * 5];
      }
    }
  }
  return { dims: [rows, cols, frames * repeats], data: out };
}

for (const host of HOSTS) {
  const root = path.join(reference, host);
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'revcor-matrix.json'), 'utf8')).cases;
  assert.equal(cases.length, 102, `${host}: the pinned recording must keep every case`);
  const byId = new Map(cases.map((item) => [item.id, item]));
  let pipelines = 0;
  for (const pre of cases.filter((item) => item.kind === 'preprocess')) {
    const dataset = manifest.datasets.find((item) => item.id === pre.dataset);
    const precision = pre.precision;
    const cast = castFor(precision);
    const accept = precision === 'single' ? exact : close;
    const id = `${host}/${pre.id}`;
    const data = samsrf.preprocessRuns(dataset.runs.map((run) => path.join(inputs, dataset.id, run)), {
      combine: pre.average ? 'average' : 'concatenate', noiseCeiling: true, globalSignal: true, precision,
    });
    assert.equal(data.kept, null, `${id}: every subset vertex is kept`);
    gate(id, 'courses', cast(data.data), readArray(root, pre.courses), accept);
    if (pre.noiseCeiling) gate(id, 'noise ceiling', cast(data.noiseCeiling), readArray(root, pre.noiseCeiling), accept);
    const anatomy = path.join(inputs, dataset.id, 'surf', dataset.hemisphere);
    const white = samsrf.readFreeSurferSurface(fs.readFileSync(`${anatomy}.white`));
    const area = samsrf.readFreeSurferCurv(fs.readFileSync(`${anatomy}.area`));
    gate(id, 'area', cast(area), readArray(root, pre.area), exact);
    const count = data.totalVertices;
    const vertices = readArray(root, pre.vertices);
    gate(id, 'vertices', cast(Float64Array.from({ length: 3 * count }, (_, i) => white.vertices[(i % count) * 3 + Math.floor(i / count)])), vertices, exact);
    const template = samsrf.readBensonTemplate(fs.readFileSync(path.join(inputs, dataset.id, `${dataset.hemisphere}_benson.gii`)), dataset.hemisphere);
    const recordedTemplate = byId.get(`${pre.id}_template`);
    const templateRows = recordedTemplate.maps.shape[0];
    const expectedTemplate = readArray(root, recordedTemplate.maps);
    for (let row = 0; row < templateRows; row++) {
      // compare.mjs's Benson limit: x0 and y0 within 3 x 2^-23, absolute and relative.
      const limit = row === 1 || row === 2 ? 3 * 2 ** -23 : 0;
      gate(id, `template ${template.values[row]}`, cast(template.data.subarray(row * count, (row + 1) * count)), Float64Array.from({ length: count }, (_, v) => expectedTemplate[v * templateRows + row]),
        (a, e) => same(a, e) || Math.abs(a - e) <= limit * (1 + Math.abs(e)));
    }
    const recordedRows = Float64Array.from({ length: templateRows * count }, (_, i) => expectedTemplate[(i % count) * templateRows + Math.floor(i / count)]);
    const roi = Uint32Array.from(readArray(root, pre.roi), (v) => v - 1);
    const seed = Uint32Array.from(readArray(root, pre.seedVertices), (v) => v - 1);
    const fitCases = cases.filter((item) => item.kind === 'pipeline' && item.preprocessing === pre.id);
    for (const item of fitCases) {
      const model = item.mapReplayModel;
      const cf = item.analysis === 'cf';
      if (cf && item.globalSignal) {
        gate(`${host}/${item.id}`, 'global signal', cast(data.globalSignal), readArray(root, item.globalSignal), accept);
      }
      const unsupported = precision === 'single' && cf && model.Fit_pRF === 1;
      const spec = {
        kind: cf ? 'cf' : 'rc', model: JSON.stringify(model), roi, totalVertices: count,
        data: { volumes: data.volumes, vertices: Uint32Array.from({ length: count }, (_, i) => i), courses: data.data },
        noiseCeiling: data.noiseCeiling ?? undefined, globalSignal: data.globalSignal ?? undefined,
      };
      if (cf) {
        // The reader's x0 and y0 are gated above; a 1-ULP coordinate moves a hull
        // centroid, so the fit runs on the template MATLAB used.
        spec.seed = { vertices: seed, template: { values: template.values, data: recordedRows } };
        spec.area = area;
        spec.surface = { vertices: white.vertices, faces: white.faces };
      } else {
        const { dims, data: dense } = revcorApertures(dataset, pre.average);
        gate(`${host}/${item.id}`, 'apertures', dense, readArray(root, item.apertures), exact);
        const file = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? reference, 'samsrf-revcor-aps-')), 'apertures.mat');
        fs.writeFileSync(file, apertureMat(dims, dense));
        const apertures = samsrf.readAperturesFile(file);
        spec.apertures = apertures.serialize();
        apertures.free();
        fs.rmSync(path.dirname(file), { recursive: true });
      }
      if (unsupported) {
        assert.throws(() => samsrf.createJob(spec), /Data_Precision=single with Fit_pRF=1/, `${item.id}: single CF Gaussian must be refused`);
        continue;
      }
      pipelines++;
      const job = samsrf.createJob(spec);
      let maps;
      try {
        ({ maps } = samsrf.runJob(job, 3));
      } finally {
        job.free();
      }
      assert.deepEqual(maps.values, item.values, `${item.id}: map names`);
      const rows = item.maps.shape[0];
      const expected = readArray(root, item.maps);
      const gaussian = cf ? model.Fit_pRF === 1 : typeof model.Prf_Function === 'string';
      const chaotic = gaussian && (precision === 'single' || model.Smoothing === 0);
      maps.values.forEach((name, row) => {
        const actual = maps.data.subarray(row * count, (row + 1) * count);
        const recorded = Float64Array.from({ length: count }, (_, v) => expected[v * rows + row]);
        let accept;
        if (chaotic && !['Fwhm', 'Vx', 'Noise Ceiling'].includes(name)) {
          // MATLAB's own hosts disagree here; only fit versus no fit is compared.
          accept = (a, e) => Number.isNaN(a) === Number.isNaN(e) && (a === 0) === (e === 0);
        } else if (precision === 'double') {
          accept = close;
        } else if (cf ? ['R^2', 'Beta', 'Suppression'].includes(name) : name === 'Beta') {
          accept = (a, e) => same(a, e) || Math.abs(a - e) <= 32 * UNIT * (cf ? 1 : Math.abs(e));
        } else if (name === 'R^2' && host === INTEL) {
          accept = (a, e) => ulps(a, e) <= 16;
        } else {
          accept = exact;
        }
        gate(`${host}/${item.id}`, name, actual, recorded, accept);
      });
    }
  }
  assert.equal(pipelines, 90 - 12, `${host}: every supported pipeline must run`);
}
const failed = reports.filter((item) => item.failures.length);
if (reportFile) fs.writeFileSync(reportFile, `${JSON.stringify({ gates: reports.length, failed: failed.length, results: reports }, null, 2)}\n`);
assert.equal(failed.length, 0, `${failed.length} reverse-correlation gates failed`);
console.log(`All ${reports.length} reverse-correlation gates passed on both hosts.`);
