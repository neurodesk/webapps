// Parity with the FreeSurfer 8.1.0 goldens, through the same gate as exes/synthseg/tests/parity.rs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runSynthseg, loadSynthseg } from '../src/index.js';
import manifest from '../model.manifest.json' with { type: 'json' };
import gates from '../validation/gates.json' with { type: 'json' };

const repo = new URL('../../../', import.meta.url);
const modelPath = fileURLToPath(new URL('exes/synthseg/models/synthseg-2.0.onnx', repo));
const fixtures = new URL('exes/synthseg/test/fixtures/', repo);
const references = process.env.SYNTHSEG_REFERENCE_DIR?.replace(/^~/, process.env.HOME);

/** Minimal int32 NIfTI-1 reader: enough for the label maps this package writes and reads back. */
function readLabels(bytes) {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  assert.equal(view.getInt16(70, true), 8, 'label maps must be int32');
  const dims = [1, 2, 3].map((a) => view.getInt16(40 + 2 * a, true));
  const affine = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => view.getFloat32(280 + 16 * r + 4 * c, true)));
  const offset = view.getFloat32(108, true);
  const data = new Int32Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < data.length; i++) data[i] = view.getInt32(offset + 4 * i, true);
  return { dims, affine, data, codes: raw.subarray(252, 256), units: raw[123] };
}

function gate(actual, reference, limit) {
  const a = readLabels(actual), b = readLabels(reference);
  assert.deepEqual(a.dims, b.dims, 'shape');
  const affine = Math.max(...a.affine.flat().map((v, i) => Math.abs(v - b.affine.flat()[i])));
  assert.ok(affine <= gates.maxAffineErrorMm, `affine differs by ${affine}`);
  assert.deepEqual([...a.codes], [...b.codes], 'qform/sform codes');
  assert.equal(a.units, b.units, 'xyzt_units');
  let mismatched = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) mismatched++;
  const fraction = mismatched / a.data.length;
  assert.ok(fraction <= limit, `mismatched ${mismatched} of ${a.data.length} (${fraction})`);
  return { mismatched, total: a.data.length, fraction };
}

let ort, modelBytes, wasm;
const loadModel = async () => ({ bytes: modelBytes, hash: manifest.assets[0].sha256 });

/** onnxruntime-node wrapped in the session contract runSynthseg expects. ORT output is NCDHW. */
async function createSession(bytes) {
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'] });
  return {
    async run(feeds) {
      const tensor = new ort.Tensor('float32', await feeds.input.getData(), feeds.input.dims);
      const outputs = await session.run({ [session.inputNames[0]]: tensor });
      const output = outputs[session.outputNames[0]];
      return { output: { dims: output.dims, type: 'float32', getData: async () => output.data, dispose() {} } };
    },
    // Leaked on purpose: releasing makes onnxruntime-node 1.29 abort at process exit (~1 run in 5, macOS).
    release() {},
  };
}

async function segment(input, options) {
  const started = performance.now();
  const file = await readFile(input);
  const { buffer, provenance } = await runSynthseg({
    buffer: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    options, loadModel, createSession, wasm,
  });
  return { bytes: new Uint8Array(buffer), provenance, seconds: (performance.now() - started) / 1000 };
}

before(async () => {
  wasm = await loadSynthseg(await readFile(new URL('../src/synthseg.wasm', import.meta.url)));
  if (!existsSync(modelPath)) return;
  ort = (await import('onnxruntime-node')).default;
  modelBytes = await readFile(modelPath);
});

// Runs without the model: catches wasm/ABI drift in CI.
test('wasm preprocessing reports the fixture geometry', async () => {
  const seg = new wasm.Segmenter(await readFile(new URL('small.nii.gz', fixtures)));
  const golden = readLabels(await readFile(new URL('small_default.nii.gz', fixtures)));
  assert.deepEqual(seg.geometry.outputShape, golden.dims);
  const affine = Math.max(...seg.geometry.outputAffine.flat().map((v, i) => Math.abs(v - golden.affine.flat()[i])));
  assert.ok(affine <= gates.maxAffineErrorMm, `affine differs by ${affine}`);
  seg.free();
});

for (const fast of [true, false]) {
  test(`fixture parity (${fast ? 'fast' : 'default'})`, { timeout: 30 * 60_000, skip: existsSync(modelPath) ? false : `missing ${modelPath}` }, async () => {
    const golden = new URL(fast ? 'small_fast.nii.gz' : 'small_default.nii.gz', fixtures);
    const { bytes, provenance, seconds } = await segment(new URL('small.nii.gz', fixtures), { fast });
    const diff = gate(bytes, await readFile(golden), gates.maxMismatchFraction.fixture);
    assert.equal(provenance.fast, fast);
    assert.deepEqual(provenance.paddedShape, [128, 128, 128]);
    console.log(`small ${fast ? 'fast' : 'default'}: ${seconds.toFixed(1)} s, ${diff.mismatched}/${diff.total} mismatched`);
  });
}

// Manual gate on the benchmark volumes: SYNTHSEG_REFERENCE_DIR=~/src/synthseg-references npm test
for (const stem of ['T1_head_2mm', 'T1_head']) {
  for (const fast of [true, false]) {
    test(`${stem} parity (${fast ? 'fast' : 'default'})`, { timeout: 4 * 60 * 60_000, skip: references && existsSync(modelPath) ? false : 'set SYNTHSEG_REFERENCE_DIR' }, async () => {
      const { bytes, seconds } = await segment(`${references}/${stem}.nii.gz`, { fast });
      const diff = gate(bytes, await readFile(`${references}/${stem}_${fast ? 'fast' : 'default'}.nii.gz`), gates.maxMismatchFraction.fullVolume);
      console.log(`${stem} ${fast ? 'fast' : 'default'}: ${seconds.toFixed(1)} s, ${diff.mismatched}/${diff.total} mismatched (${diff.fraction})`);
    });
  }
}
