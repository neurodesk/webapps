import assert from 'node:assert/strict';
import test from 'node:test';
import { readImageFiles, readImageSeries, runDcm2niix } from '../src/dcm2niix-client/index.ts';

function file(name, text = '') {
  return new File([text], name);
}

async function withFakeWorker(outputs, run) {
  const calls = [];
  const OriginalWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    }

    postMessage(message) {
      calls.push({ cmd: message.cmd, inputs: message.fileList.map((entry) => entry.file.name) });
      queueMicrotask(() => this.onmessage?.({ data: { convertedFiles: outputs, exitCode: 0 } }));
    }

    terminate() {}
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.Worker = OriginalWorker;
  }
}

test('readImageSeries pairs converted images with their sidecars by stem, without anonymisation', async () => {
  const outputs = [
    file('t1_mprage_2.nii.gz'),
    file('t1_mprage_2.json', JSON.stringify({ PatientName: 'Doe^Jane', SeriesNumber: 2 })),
    file('flair_3.nii'),
    file('dwi_4.nii'),
    file('dwi_4.json', '{not json'),
    file('dwi_4.bval'),
    file('localizer_1.json', JSON.stringify({ SeriesNumber: 1 })),
  ];
  const { result, calls } = await withFakeWorker(outputs, () => readImageSeries([file('IM0001'), file('IM0002.dcm')]));
  assert.deepEqual(
    result.map(({ image, sidecar }) => [image.name, sidecar]),
    [
      ['t1_mprage_2.nii.gz', { PatientName: 'Doe^Jane', SeriesNumber: 2 }],
      ['flair_3.nii', null],
      ['dwi_4.nii', null],
    ],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].inputs, ['IM0001', 'IM0002.dcm']);
  assert.deepEqual(calls[0].cmd, ['-b', 'y', '-ba', 'n']);
});

test('readImageSeries keeps dcm2niix sidecar anonymisation when asked to', async () => {
  const outputs = [file('t1_2.nii'), file('t1_2.json', JSON.stringify({ SeriesNumber: 2 }))];
  const { result, calls } = await withFakeWorker(outputs, () => readImageSeries([file('IM0001')], { anonymizeSidecar: true }));
  assert.deepEqual(result.map(({ image, sidecar }) => [image.name, sidecar]), [['t1_2.nii', { SeriesNumber: 2 }]]);
  assert.deepEqual(calls[0].cmd, [], 'no -ba n: dcm2niix drops PatientName, PatientBirthDate and the other identifiers');
});

test('readImageSeries pairs direct volumes with supplied sidecars and ignores stray JSON', async () => {
  const { result, calls } = await withFakeWorker([], () => readImageSeries([
    file('sub-01_T1w.json', JSON.stringify({ RepetitionTime: 2.3 })),
    file('sub-01_T1w.nii.gz'),
    file('sub-01_FLAIR.nii'),
    file('sub-01_dwi.json', JSON.stringify({ EchoTime: 0.08 })),
    file('sub-01_bold.json', '[1, 2]'),
    file('sub-01_bold.nii'),
  ]));
  assert.deepEqual(
    result.map(({ image, sidecar }) => [image.name, sidecar]),
    [
      ['sub-01_T1w.nii.gz', { RepetitionTime: 2.3 }],
      ['sub-01_FLAIR.nii', null],
      ['sub-01_bold.nii', null],
    ],
  );
  assert.equal(calls.length, 0);
});

test('readImageSeries lists direct volumes before converted series and refuses a conversion without images', async () => {
  const { result } = await withFakeWorker([file('scan_5.nii'), file('scan_5.json', '{}')], () => readImageSeries([file('direct.nii'), file('IM0001')]));
  assert.deepEqual(result.map(({ image, sidecar }) => [image.name, sidecar]), [['direct.nii', null], ['scan_5.nii', {}]]);
  await assert.rejects(
    withFakeWorker([file('scan_5.json', '{}')], () => readImageSeries([file('IM0001')])),
    /No images produced/,
  );
});

test('readImageFiles keeps dcm2niix anonymisation and its niftiOnly contract', async () => {
  const outputs = [file('scan_5.nii'), file('scan_5.json', '{}')];
  const filtered = await withFakeWorker(outputs, () => readImageFiles([file('direct.nii.gz'), file('notes.json'), file('IM0001')]));
  assert.deepEqual(filtered.result.map((image) => image.name), ['direct.nii.gz', 'scan_5.nii']);
  assert.deepEqual(filtered.calls[0].cmd, []);
  assert.deepEqual(filtered.calls[0].inputs, ['IM0001']);
  const unfiltered = await withFakeWorker(outputs, () => readImageFiles([file('IM0001')], { niftiOnly: false }));
  assert.deepEqual(unfiltered.result.map((image) => image.name), ['scan_5.nii', 'scan_5.json']);
});

test('runDcm2niix keeps default anonymisation and requires an explicit sidecar opt-in', async () => {
  const outputs = [file('scan_5.nii'), file('scan_5.json', '{}')];
  for (const options of [{}, { anonymizeSidecar: true }]) {
    const converted = await withFakeWorker(outputs, () => runDcm2niix([file('IM0001')], { ...options, niftiOnly: false }));
    assert.deepEqual(converted.result.map((image) => image.name), ['scan_5.nii', 'scan_5.json']);
    assert.deepEqual(converted.calls[0].cmd, []);
  }
  const retained = await withFakeWorker(outputs, () => runDcm2niix([file('IM0001')], { niftiOnly: false, anonymizeSidecar: false }));
  assert.deepEqual(retained.result.map((image) => image.name), ['scan_5.nii', 'scan_5.json']);
  assert.deepEqual(retained.calls[0].cmd, ['-b', 'y', '-ba', 'n']);
});

test('readImageSeries honours an aborted signal before starting dcm2niix', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  const { calls } = await withFakeWorker([], async () => {
    await assert.rejects(readImageSeries([file('IM0001')], { signal: controller.signal }), /stopped/);
  });
  assert.equal(calls.length, 0);
});
