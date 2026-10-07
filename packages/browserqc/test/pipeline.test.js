import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { qcCommand } from '../src/node.js';
import { AIR_TEMPLATE, MODELS, checkAirTemplate, finishReport, parseModel, qcTissues, segmentForQc } from '../src/pipeline.js';

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the model catalog is the web app\'s, which upstream BrowserQC owns', async () => {
  assert.deepEqual(MODELS, await json('../../../apps/browserqc/src/models.json'));
});

test('the air template pin is the BrowserQC asset manifest\'s', async () => {
  const manifest = await json('../../../models/browserqc.manifest.json');
  const asset = manifest.assets.find((entry) => entry.filename === AIR_TEMPLATE.name);
  assert.equal(AIR_TEMPLATE.url, `${manifest.base_url}${asset.filename}`);
  assert.equal(AIR_TEMPLATE.sha256, asset.sha256);
  await assert.rejects(checkAirTemplate(new TextEncoder().encode('other bytes')), /has SHA-256 [0-9a-f]{64}, not the pinned/);
});

test('only catalog models parse, not inherited object keys', () => {
  assert.equal(parseModel('16chan18cls'), '16chan18cls');
  for (const value of ['mindgrab', 'toString', '__proto__', undefined, 3]) assert.throws(() => parseModel(value), /Choose a supported/);
});

function recordingSegmenter() {
  const calls = [];
  const buffer = (name) => new TextEncoder().encode(name).buffer;
  return {
    calls,
    segment: async (input, options) => {
      calls.push(['segment', input, options]);
      return { image: buffer(`${options.model}-image`), mask: options.mask ? buffer('mask') : undefined, backend: 'cpu', elapsedMs: 2 };
    },
    segmentTissues: async (input, options) => {
      calls.push(['segmentTissues', input, options]);
      return { tissues: { csf: buffer('csf'), gm: buffer('gm'), wm: buffer('wm'), brain: buffer('brain') }, backend: 'cpu', elapsedMs: 3 };
    },
  };
}

const text = (buffer) => new TextDecoder().decode(buffer);

test('PVE runs the MindGrab mask, then MindMap tissue fractions, both uncompressed', async () => {
  const segmenter = recordingSegmenter();
  const input = new Uint8Array([1, 2]);
  const result = await segmentForQc(segmenter, input, 'mindmap-pve', { backend: 'cpu' });
  assert.deepEqual(segmenter.calls.map(([call, given, options]) => [call, given === input, options]), [
    ['segment', true, { backend: 'cpu', gzipOutput: false, model: 'mindgrab', mask: true }],
    ['segmentTissues', true, { backend: 'cpu', gzipOutput: false, model: 'mindmap' }],
  ]);
  assert.equal(result.kind, 'pve');
  assert.deepEqual(Object.keys(result.tissues), ['csf', 'gm', 'wm']);
  assert.equal(text(result.mask), 'mask');
  assert.equal(result.elapsedMs, 5);
  const tissues = qcTissues(result, 'mindmap-pve');
  assert.deepEqual(tissues.pve.map(text), ['csf', 'gm', 'wm']);
  assert.equal(text(tissues.mask), 'mask');
});

test('a label model runs the MindGrab mask, then the model, with its CSF and WM labels for niimath', async () => {
  const segmenter = recordingSegmenter();
  const result = await segmentForQc(segmenter, new Uint8Array([1]), 'mindsnap');
  assert.deepEqual(segmenter.calls.map(([call, , options]) => [call, options.model]), [['segment', 'mindgrab'], ['segment', 'mindsnap']]);
  assert.equal(result.kind, 'labels');
  assert.equal(text(result.image), 'mindsnap-image');
  const tissues = qcTissues(result, 'mindsnap');
  assert.deepEqual([tissues.csf, tissues.wm], [MODELS.mindsnap.csf, MODELS.mindsnap.wm]);
  assert.equal(text(tissues.seg), 'mindsnap-image');
});

test('a mask model that returns no mask stops the pipeline', async () => {
  const segmenter = recordingSegmenter();
  segmenter.segment = async () => ({ image: new ArrayBuffer(1), backend: 'cpu', elapsedMs: 1 });
  await assert.rejects(segmentForQc(segmenter, new Uint8Array([1]), 'mindmap-pve'), /Brain extraction returned no mask/);
});

test('the report gains the segmentation label and, when given, the sidecar', () => {
  const report = finishReport({ cjv: 1, provenance: { software: 'niimath --qc' } }, { model: '16chan18cls', bids: { EchoTime: 0.003 } });
  assert.deepEqual(report, {
    cjv: 1,
    provenance: { software: 'niimath --qc', segmentation: 'brainchop 16chan18cls (Subcortical + GWM, 16ch)' },
    bids_meta: { EchoTime: 0.003 },
  });
  assert.equal('bids_meta' in finishReport({ provenance: {} }, { model: 'mindmap-pve', bids: null }), false);
});

// @niivue/niimath 1.4.20260928's qc() stages the input as __nimi_<name> and each operand as
// __nimx<n>_<name>, naming bytes input.nii or input.nii.gz by their gzip magic.
test('the niimath command stages files as the web app\'s niimath wrapper does', () => {
  const gz = new Uint8Array([0x1f, 0x8b, 8]);
  const nii = new Uint8Array([92, 1]);
  const air = new Uint8Array([0x1f, 0x8b, 9]);
  const pve = qcCommand(gz, { pve: [nii, nii, nii], mask: nii }, air);
  assert.deepEqual(pve.args, ['--qc', '__nimi_input.nii.gz', '--pve', '__nimx0_input.nii', '__nimx1_input.nii', '__nimx2_input.nii', '--mask', '__nimx3_input.nii', '--air', '__nimx4_avg152T1.nii.gz', '--json', 'qc.json']);
  assert.equal(pve.inputs['__nimi_input.nii.gz'], gz);
  assert.equal(pve.inputs['__nimx4_avg152T1.nii.gz'], air);
  const labels = qcCommand(nii, { seg: nii, csf: [3, 4], wm: [1, 5], mask: nii }, air);
  assert.deepEqual(labels.args, ['--qc', '__nimi_input.nii', '--seg', '__nimx0_input.nii', '--csf', '3,4', '--wm', '1,5', '--mask', '__nimx1_input.nii', '--air', '__nimx2_avg152T1.nii.gz', '--json', 'qc.json']);
});
