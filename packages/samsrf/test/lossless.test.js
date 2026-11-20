import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as samsrf from '../src/node.js';
import { matFile } from './fixtures.js';

/** Float64Array whose elements have exactly these bit patterns. */
const fromBits = (bits) => new Float64Array(BigUint64Array.from(bits).buffer);
const bitsOf = (values) => Array.from(new BigUint64Array(values.buffer, values.byteOffset, values.length));

// Values whose bits a decimal or Number round trip can lose: NaN payloads and signs, signed zeros,
// a signalling NaN, infinities, the smallest subnormal and the largest finite double.
const AWKWARD = [
  0xfff8000000000000n, 0x7ff8000000000000n, 0x7ff8000000000001n, 0xfff0000000000001n,
  0x8000000000000000n, 0x0000000000000000n, 0x7ff0000000000000n, 0xfff0000000000000n,
  0x0000000000000001n, 0x7fefffffffffffffn,
];

function merged() {
  const vertices = 5;
  return {
    maps: { values: ['R^2', 'x0'], vertices, data: fromBits(AWKWARD) },
    raw: { values: ['Beta'], vertices, data: fromBits([0x8000000000000000n, 0x3ff0000000000000n, 0x7ff8000000000002n, 0n, 0xbff0000000000000n]) },
    analysed: Uint32Array.of(0, 3, 4),
    imaginary: fromBits([...AWKWARD].reverse()),
    arithmeticReference: 'matlab-amd',
  };
}

test('a lossless file round-trips every bit: NaN payloads and signs, signed zeros, raw rows, imaginary parts', () => {
  const original = merged();
  const bytes = samsrf.writeLossless(original, { precision: 'double' });
  const read = samsrf.readLossless(bytes);
  assert.equal(read.precision, 'double');
  assert.equal(read.arithmeticReference, 'matlab-amd');
  assert.deepEqual(read.maps.values, original.maps.values);
  assert.equal(read.maps.vertices, 5);
  assert.deepEqual(bitsOf(read.maps.data), AWKWARD);
  assert.deepEqual(bitsOf(read.imaginary), [...AWKWARD].reverse());
  assert.deepEqual(read.raw.values, ['Beta']);
  assert.deepEqual(bitsOf(read.raw.data), bitsOf(original.raw.data));
  assert.deepEqual(Array.from(read.analysed), [0, 3, 4]);
  assert.deepEqual(samsrf.writeLossless(read, { precision: read.precision }), bytes, 'writing what was read gives the same bytes');
});

test('a Node Buffer inside a larger allocation reads as its own bytes', () => {
  const original = merged();
  const file = samsrf.writeLossless(original, { precision: 'double' });
  const pool = Buffer.alloc(file.length + 4096, 0xff);
  pool.set(file, 1024);
  const read = samsrf.readLossless(pool.subarray(1024, 1024 + file.length));
  assert.deepEqual(bitsOf(read.maps.data), bitsOf(original.maps.data));
  assert.deepEqual(bitsOf(read.imaginary), bitsOf(original.imaginary));
  assert.deepEqual([...read.analysed], [...original.analysed]);
});

test('a subject HRF kernel is refused when the fit or the TR cannot give one', () => {
  const model = { Hrf: 'hrf_subject', TR: 1 };
  const kernel = samsrf.subjectHrfKernel(model, [5.5, 15.5, 5, 2]);
  assert.ok(kernel.length > 0);
  assert.deepEqual(samsrf.subjectHrfKernel(model, [5.5, 15.5, 5, 2].values()), kernel);
  assert.throws(() => samsrf.subjectHrfKernel(model, [5.5, 15.5, NaN, 2]), /fP holds a value that is not finite/);
  assert.throws(() => samsrf.subjectHrfKernel({ ...model, TR: 0 }, [5.5, 15.5, 5, 2]), /TR must be a positive number/);
  assert.deepEqual(samsrf.subjectHrfKernel({ ...model, TR: [model.TR] }, [5.5, 15.5, 5, 2]), kernel);
  assert.throws(() => samsrf.subjectHrfKernel(model, [5.5, 15.5, 5, null]), /fP holds a value that is not finite/);
  assert.throws(() => samsrf.subjectHrfKernel(model, '5652'), /fP holds a value that is not finite/);
});

test('the layout is the documented one: magic, version, padded JSON header, then the sections', () => {
  const bytes = samsrf.writeLossless({
    maps: { values: ['R^2'], vertices: 2, data: Float64Array.of(-0, 0.5) },
    raw: null,
    analysed: null,
    imaginary: null,
    arithmeticReference: 'current',
  }, { precision: 'single' });
  const header = '{"format":"samsrf-lossless-maps","version":1,"precision":"single","arithmeticReference":"current","vertices":2,"values":["R^2"],"imaginary":false,"raw":[],"analysed":null}';
  const padded = header.padEnd(Math.ceil((16 + header.length) / 8) * 8 - 16, ' ');
  const expected = Buffer.alloc(16 + padded.length + 16);
  expected.write('SAMSRFLX', 0, 'latin1');
  expected.writeUInt32LE(1, 8);
  expected.writeUInt32LE(padded.length, 12);
  expected.write(padded, 16, 'utf8');
  expected.writeDoubleLE(-0, 16 + padded.length);
  expected.writeDoubleLE(0.5, 24 + padded.length);
  assert.deepEqual(Buffer.from(bytes), expected);
});

test('single-precision results keep their float32 values exactly', () => {
  const values = Float64Array.from([1 / 3, -2.5e-30, 1e38, Number.NaN, -0], Math.fround);
  const read = samsrf.readLossless(samsrf.writeLossless({ maps: { values: ['x0'], vertices: 5, data: values }, raw: null, analysed: null, imaginary: null, arithmeticReference: 'current' }, { precision: 'single' }));
  assert.equal(read.precision, 'single');
  assert.deepEqual(bitsOf(read.maps.data), bitsOf(values));
  assert.ok(read.maps.data.every((value) => Object.is(Math.fround(value), value)));
});

test('a SamSrf-convention CSS job round-trips its complex Srf.Data and the analysed vertices', () => {
  // As api.test.js's CSS fit: a bar sweep with a blank frame slightly below zero gives negative predictions.
  const [height, width, volumes] = [2, 4, 16];
  const movie = new Array(height * width * volumes).fill(0);
  for (let t = 0; t < volumes; t++) {
    const bar = t % (width + 1);
    for (let y = 0; y < height; y++) {
      if (bar < width) movie[y + height * (bar + width * t)] = 1;
      else for (let x = 0; x < width; x++) movie[y + height * (x + width * t)] = -0.1;
    }
  }
  const apertures = samsrf.readApertures(matFile({ ApFrm: { dims: [height, width, volumes], data: movie } }), 'mat');
  const bytes = apertures.serialize();
  apertures.free();
  const courses = new Float64Array(2 * volumes);
  for (let t = 0; t < volumes; t++) {
    courses[t] = Math.sin(t * 1.3) + (t % 5 === 1 ? 1 : 0);
    courses[volumes + t] = Math.cos(t * 0.7) + (t % 5 === 3 ? 0.8 : 0);
  }
  const model = {
    Name: 'css', Prf_Function: '@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)', Param_Names: ['x0', 'y0', 'Sigma'],
    Scaled_Param: [1, 1, 1], Only_Positive: [0, 0, 1], Scaling_Factor: 1, TR: 1, Hrf: 1, Aperture_File: 'aps',
    Param1: [-0.5, 0, 0.5], Param2: [0], Param3: [0.25, 0.5], Fine_Fit_Threshold: 0, Compressive_Nonlinearity: true, Css_Convention: 'samsrf',
  };
  const job = samsrf.createJob({ kind: 'prf', model: JSON.stringify(model), apertures: bytes, hrf: 'none', data: { volumes, vertices: Uint32Array.of(0, 1), courses }, totalVertices: 3 });
  let result;
  try {
    result = samsrf.runJob(job);
  } finally {
    job.free();
  }
  assert.ok(result.imaginary, 'the fit is complex');
  const read = samsrf.readLossless(samsrf.writeLossless(result, { precision: 'double' }));
  assert.deepEqual(read.maps.values, result.maps.values);
  assert.deepEqual(bitsOf(read.maps.data), bitsOf(result.maps.data));
  assert.deepEqual(bitsOf(read.imaginary), bitsOf(result.imaginary));
  assert.equal(read.raw, null);
  assert.deepEqual(Array.from(read.analysed), Array.from(result.analysed));
});

test('the writer and the reader refuse anything but the documented layout', () => {
  const good = samsrf.writeLossless(merged(), { precision: 'double' });
  assert.throws(() => samsrf.writeLossless(merged(), { precision: 'half' }), /precision must be/);
  assert.throws(() => samsrf.writeLossless({ ...merged(), imaginary: new Float64Array(3) }), /precision must be/);
  assert.throws(() => samsrf.writeLossless({ ...merged(), imaginary: new Float64Array(3) }, { precision: 'double' }), /imaginary must be/);
  assert.throws(() => samsrf.writeLossless({ ...merged(), maps: { ...merged().maps, data: Array.from(AWKWARD, Number) } }, { precision: 'double' }), /maps.data must be a Float64Array/);
  assert.throws(() => samsrf.writeLossless({ ...merged(), analysed: [0] }, { precision: 'double' }), /analysed must be/);
  assert.throws(() => samsrf.readLossless(good.subarray(0, good.length - 1)), /file length does not match/);
  assert.throws(() => samsrf.readLossless(Uint8Array.from([...good, 0])), /file length does not match/);
  const magic = good.slice();
  magic[0] = 0x58;
  assert.throws(() => samsrf.readLossless(magic), /not a SamSrf lossless file/);
  const version = good.slice();
  version[8] = 2;
  assert.throws(() => samsrf.readLossless(version), /unsupported version 2/);
  const header = good.slice();
  header[12] += 1;
  assert.throws(() => samsrf.readLossless(header), /header length is invalid/);
});

test('losslessName names the file beside the GIfTI maps', () => {
  assert.equal(samsrf.losslessName('lh_pRF_Gaussian'), 'lh_pRF_Gaussian_lossless.bin');
});
