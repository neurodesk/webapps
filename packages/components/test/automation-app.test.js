import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { registerAppAutomation, createNiivueAdapter } from '../src/automation/index.js';
import { prepareImageInput } from '../src/automation/files.js';

const contract = () => ({ schemaVersion: 2, app: 'test', appVersion: '0.1.20260928', defaultOperation: 'run', operations: {
  run: { mode: 'batch', inputs: { image: { source: 'files', type: 'neuro:volume', formats: ['nifti'], minimum: 1, maximum: 1 } },
    parameters: { threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.5 } },
    artifacts: { labels: { type: 'neuro:label-map', mediaType: 'application/x-nifti', minimum: 1, maximum: 1 } }, engines: ['browser'] },
} });
const result = () => ({ artifacts: [{ role: 'labels', file: new File(['labels'], 'labels.nii') }], provenance: { engine: 'test' } });
function fixture(t, operation, custom = contract(), options = {}) {
  const dom = new JSDOM('<body></body>', { url: 'https://example.test/test/' });
  t.after(() => dom.window.close());
  const downloads = [];
  const registration = registerAppAutomation({ app: 'test', contract: custom, operations: { run: operation },
    document: dom.window.document, target: dom.window, download: file => downloads.push(file), ...options });
  const transfer = dom.window.document.getElementById('neurodesk-input-transfer');
  const dispatch = registration.dispatch;
  return { registration, dispatch, downloads, async upload(role = 'image', files = [new File(['input'], 'input.nii')]) {
    Object.defineProperty(transfer, 'files', { configurable: true, value: files });
    await dispatch('adopt', { role });
  } };
}
async function completed(dispatch) {
  for (let index = 0; index < 100; index++) {
    const state = await dispatch('snapshot');
    if (['succeeded', 'failed', 'cancelled'].includes(state.state)) return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Operation did not settle');
}

test('dispatch waits for actual operation, hashes original files and downloads explicit artifacts', async t => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const f = fixture(t, async ({ inputs, parameters }) => {
    assert.equal(inputs.image[0].name, 'input.nii');
    assert.deepEqual(parameters, { threshold: 0.5 });
    await gate;
    return result();
  });
  await f.upload();
  const started = await f.dispatch('start');
  assert.equal((await f.dispatch('snapshot')).state, 'running');
  await assert.rejects(f.dispatch('start'), /already running/);
  resolve();
  const { report } = await completed(f.dispatch);
  assert.equal(report.runId, started.runId);
  assert.equal(report.inputs.image[0].sha256, createHash('sha256').update('input').digest('hex'));
  assert.equal(report.artifacts.labels.role, 'labels');
  await f.dispatch('download', { artifactId: 'labels' });
  await f.dispatch('download', { artifactId: 'report' });
  assert.deepEqual(f.downloads.map(file => file.name), ['labels.nii', 'report.json']);
  assert.deepEqual(JSON.parse(await f.downloads[1].text()), report);
});

test('cancel during callback or artifact hashing cannot publish a stale report', async t => {
  let release;
  const file = new File(['result'], 'labels.nii');
  file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => ({ artifacts: [{ role: 'labels', file }] }));
  await f.upload();
  await f.dispatch('start');
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.dispatch('cancel')).cancelled, true);
  release(new TextEncoder().encode('result').buffer);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.dispatch('snapshot')).state, 'cancelled');
  await assert.rejects(f.dispatch('download', { artifactId: 'labels' }), /unavailable/);
});

test('failed callbacks, missing artifacts and duplicate filenames fail explicitly', async t => {
  for (const callback of [async () => { throw new Error('worker failed'); }, async () => ({ artifacts: [] }), async () => ({ artifacts: [{ role: 'labels', file: new File([], 'labels.nii') }] })]) {
    const f = fixture(t, callback);
    await f.upload();
    await f.dispatch('start');
    const state = await completed(f.dispatch);
    assert.equal(state.state, 'failed');
    assert.ok(state.error.message);
    assert.equal(state.report, undefined);
  }
});

test('validates names, parameters and registration before scientific work', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return result(); });
  await assert.rejects(f.dispatch('start', { parameters: { threshold: 2 } }), /maximum/);
  await assert.rejects(f.dispatch('start', { parameters: { surprise: true } }), error => {
    assert.equal(error.issues[0].code, 'unrecognized_keys');
    assert.deepEqual(error.issues[0].keys, ['surprise']);
    assert.deepEqual(error.issues[0].path, []);
    return true;
  });
  await assert.rejects(f.dispatch('start', { inputs: { surprise: [] } }), /Unknown input/);
  await assert.rejects(f.dispatch('anything'), /Unknown automation/);
  assert.equal(calls, 0);
  const invalid = contract();
  invalid.operations.run.inputs.image.formats.push('dicom');
  const missingConverter = fixture(t, async () => result(), invalid);
  await assert.rejects(missingConverter.registration.ready, /without a converter/);
});

test('retained registered viewer supports public crosshair, explicit tabs and truthful regions', async t => {
  const f = fixture(t, async () => result());
  let position = [0.5, 0.5, 0.5];
  let tab = 'image';
  f.registration.registerViewer('main', createNiivueAdapter({ getCrosshairPos: () => position, setCrosshairPos: value => { position = value; } }, {
    tabs: { list: () => [{ id: 'image', active: tab === 'image' }, { id: 'labels', active: tab === 'labels' }], select: id => { tab = id; } },
    regions: { list: () => [{ id: 17, label: 'Hippocampus' }] },
  }));
  await f.upload();
  await f.dispatch('start');
  assert.equal((await completed(f.dispatch)).state, 'succeeded');
  const moved = await f.dispatch('viewers.crosshair', { viewerId: 'main', position: { frame: 'mm', value: [0.1, 0.2, 0.3] } });
  assert.deepEqual(moved.position, { frame: 'mm', value: [0.1, 0.2, 0.3] });
  await assert.rejects(f.dispatch('viewers.crosshair', { viewerId: 'main', position: { frame: 'fraction', value: [1, 2, 3] } }), /millimetre/);
  await f.dispatch('viewers.tab', { viewerId: 'main', tabId: 'labels' });
  assert.equal(tab, 'labels');
  assert.deepEqual(await f.dispatch('viewers.regions', { viewerId: 'main' }), [{ id: 17, label: 'Hippocampus' }]);
  f.registration.registerViewer('other', { state: () => ({}) });
  await assert.rejects(f.dispatch('viewers.regions', { viewerId: 'other' }), /does not expose/);
});

function nifti(name, sample) {
  const buffer = new ArrayBuffer(354);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  for (const offset of [42, 44, 46]) view.setInt16(offset, 1, true);
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  view.setFloat32(108, 352, true);
  new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
  view.setInt16(352, sample, true);
  return new File([buffer], name);
}

test('DICOM selection reports actual candidates, preserves sidecars and hashes uncompressed data', async () => {
  const signal = new AbortController().signal;
  const a = nifti('first.nii', 7);
  const b = nifti('second.nii', 8);
  const sidecar = new File(['{"Modality":"MR","PatientName":"not exposed"}'], 'second.json');
  const gradients = new File(['0 1000'], 'second.bval');
  const input = { minimum: 1, maximum: 1 };
  const files = [new File(['dicom'], 'slice.dcm')];
  const convertDicom = async (_files, options) => { assert.equal(options.niftiOnly, false); return [a, b, sidecar, gradients]; };
  let candidates;
  await assert.rejects(prepareImageInput(files, input, { convertDicom, signal }), error => {
    assert.equal(error.code, 'SERIES_SELECTION_REQUIRED');
    candidates = error.candidates;
    assert.deepEqual(candidates[1].dimensions, [1, 1, 1]);
    assert.deepEqual(candidates[1].metadata, { Modality: 'MR' });
    return true;
  });
  const chosen = await prepareImageInput(files, input, { convertDicom, selection: candidates[1].sha256, signal });
  assert.equal(chosen.files[0], b);
  assert.deepEqual(chosen.details.sidecars, [sidecar, gradients]);
  const compressed = new File([await new Response(b.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()], 'second.nii.gz');
  const again = await prepareImageInput(files, input, { convertDicom: async () => [compressed], selection: candidates[1].sha256, signal });
  assert.equal(again.details.conversion.selected[0], candidates[1].sha256);
});

test('DICOM staging separates repeated basenames without changing original provenance', async t => {
  const spec = contract();
  spec.operations.run.inputs.image.formats.push('dicom');
  const originals = ['first slice', 'second slice'].map(bytes => new File([bytes], 'image.dcm', { type: 'application/dicom', lastModified: 42 }));
  Object.defineProperty(originals[0], 'webkitRelativePath', { value: 'series-a/image.dcm' });
  originals[1]._webkitRelativePath = 'series-b/image.dcm';
  const f = fixture(t, async () => result(), spec, {
    async convertDicom(files) {
      const paths = files.map(file => file.webkitRelativePath || file._webkitRelativePath || file.name);
      assert.equal(new Set(paths).size, 2);
      assert.equal(new Set(files.map(file => file.name)).size, 2);
      assert.deepEqual(await Promise.all(files.map(file => file.text())), ['first slice', 'second slice']);
      assert.ok(files.every(file => file.type === 'application/dicom' && file.lastModified === 42));
      return [nifti('converted.nii', 7)];
    },
  });
  await f.upload('image', originals);
  await f.dispatch('start');
  const state = await completed(f.dispatch);
  assert.equal(state.state, 'succeeded', JSON.stringify(state.error));
  assert.deepEqual(state.report.inputs.image, await Promise.all(originals.map(async file => ({
    filename: 'image.dcm', bytes: file.size, sha256: createHash('sha256').update(await file.text()).digest('hex'),
  }))));
  assert.equal(originals[0].webkitRelativePath, 'series-a/image.dcm');
  assert.equal(originals[1]._webkitRelativePath, 'series-b/image.dcm');
});

test('optional URL inputs and camelCase artifact roles preserve the contract shape', async t => {
  const spec = contract();
  spec.operations.run.inputs.atlas = { source: 'url', type: 'neuro:volume', formats: ['nifti'], minimum: 0, maximum: 1 };
  spec.operations.run.artifacts = { labelMap: spec.operations.run.artifacts.labels };
  const f = fixture(t, async ({ inputs, progress }) => {
    assert.deepEqual(inputs.atlas, []);
    progress({ state: 'succeeded', runId: 'incorrect', report: {}, message: 'Computing', value: 0.5 });
    return { artifacts: [{ role: 'labelMap', file: new File(['labels'], 'labels.nii') }] };
  }, spec);
  await f.upload();
  const start = await f.dispatch('start');
  const state = await completed(f.dispatch);
  assert.equal(state.runId, start.runId);
  assert.equal(state.state, 'succeeded');
  assert.deepEqual(state.report.inputs.atlas, []);
  assert.equal(state.report.artifacts.labelMap.role, 'labelMap');
});
