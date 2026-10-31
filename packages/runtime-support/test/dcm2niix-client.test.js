import assert from 'node:assert/strict';
import test from 'node:test';
import { readDiffusionSeries, readImageFiles, readImageSeries, runDcm2niix } from '../src/dcm2niix-client/index.ts';

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
      queueMicrotask(() => this.onmessage?.({ data: { type: 'result', convertedFiles: outputs, exitCode: 0, log: ['done'] } }));
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
  assert.deepEqual(calls[0].cmd, ['-f', '%p_%t_%s', '-ba', 'n']);
});

test('readImageSeries keeps dcm2niix sidecar anonymisation when asked to', async () => {
  const outputs = [file('t1_2.nii'), file('t1_2.json', JSON.stringify({ SeriesNumber: 2 }))];
  const { result, calls } = await withFakeWorker(outputs, () => readImageSeries([file('IM0001')], { anonymizeSidecar: true }));
  assert.deepEqual(result.map(({ image, sidecar }) => [image.name, sidecar]), [['t1_2.nii', { SeriesNumber: 2 }]]);
  assert.deepEqual(calls[0].cmd, ['-f', '%p_%t_%s'], 'no -ba n: dcm2niix drops PatientName, PatientBirthDate and the other identifiers');
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
    /No images produced\. Choose NIfTI files or a complete DICOM series\. \(dcm2niix: done\)/,
  );
});

test('readImageFiles keeps dcm2niix anonymisation and its niftiOnly contract', async () => {
  const outputs = [file('scan_5.nii'), file('scan_5.json', '{}')];
  const filtered = await withFakeWorker(outputs, () => readImageFiles([file('direct.nii.gz'), file('notes.json'), file('IM0001')]));
  assert.deepEqual(filtered.result.map((image) => image.name), ['direct.nii.gz', 'scan_5.nii']);
  assert.deepEqual(filtered.calls[0].cmd, ['-f', '%p_%t_%s']);
  assert.deepEqual(filtered.calls[0].inputs, ['IM0001']);
  const unfiltered = await withFakeWorker(outputs, () => readImageFiles([file('IM0001')], { niftiOnly: false }));
  assert.deepEqual(unfiltered.result.map((image) => image.name), ['scan_5.nii', 'scan_5.json']);
});

test('readImageSeries honours an aborted signal before starting dcm2niix', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  const { calls } = await withFakeWorker([], async () => {
    await assert.rejects(readImageSeries([file('IM0001')], { signal: controller.signal }), /stopped/);
  });
  assert.equal(calls.length, 0);
});

test('readDiffusionSeries pairs converted DWI with its bval, bvec and sidecar by stem', async () => {
  const outputs = [
    file('t1_2.nii'),
    file('dwi_4.nii'),
    file('dwi_4.json', JSON.stringify({ PhaseEncodingDirection: 'j-' })),
    file('dwi_4.bval', '0 1000'),
    file('dwi_4.bvec', '0 1\n0 0\n0 0'),
  ];
  const { result } = await withFakeWorker(outputs, () => readDiffusionSeries([file('IM0001')]));
  assert.deepEqual(
    result.map(({ image, bval, bvec, sidecar }) => [image.name, bval?.name ?? null, bvec?.name ?? null, sidecar]),
    [
      ['t1_2.nii', null, null, null],
      ['dwi_4.nii', 'dwi_4.bval', 'dwi_4.bvec', { PhaseEncodingDirection: 'j-' }],
    ],
  );
});

test('readDiffusionSeries pairs one direct volume with differently named gradients', async () => {
  const { result, calls } = await withFakeWorker([], () => readDiffusionSeries([
    file('data.nii.gz'),
    file('bvals.bval'),
    file('bvecs.bvec'),
  ]));
  assert.deepEqual(
    result.map(({ image, bval, bvec }) => [image.name, bval?.name, bvec?.name]),
    [['data.nii.gz', 'bvals.bval', 'bvecs.bvec']],
  );
  assert.equal(calls.length, 0);
});

test('readDiffusionSeries takes FSL bvals and bvecs files, with or without a stem', async () => {
  for (const [bval, bvec] of [['bvals', 'bvecs'], ['dwi.bvals', 'dwi.bvecs']]) {
    const { result, calls } = await withFakeWorker([], () => readDiffusionSeries([
      file('data.nii.gz'),
      file(bval),
      file(bvec),
    ]));
    assert.deepEqual(result.map(({ bval: b, bvec: v }) => [b?.name, v?.name]), [[bval, bvec]]);
    assert.equal(calls.length, 0, `${bval} must not go to dcm2niix`);
  }
});

test('readDiffusionSeries pairs a single optional gradient file independently', async () => {
  for (const name of ['bvals', 'bvecs', 'grad.bval', 'grad.bvec']) {
    const gradient = file(name, '0 1000');
    const { result, calls } = await withFakeWorker([], () => readDiffusionSeries([
      file('data.nii.gz'),
      gradient,
    ]));
    const [series] = result;
    const isBval = /bval/.test(name);
    assert.equal(series.bval, isBval ? gradient : null);
    assert.equal(series.bvec, isBval ? null : gradient);
    assert.equal(calls.length, 0);
  }
});

test('readDiffusionSeries leaves gradients unpaired when several volumes make the match ambiguous', async () => {
  const { result } = await withFakeWorker([], () => readDiffusionSeries([
    file('a.nii'),
    file('b.nii'),
    file('grad.bval'),
    file('grad.bvec'),
  ]));
  assert.deepEqual(result.map(({ bval, bvec }) => [bval, bvec]), [[null, null], [null, null]]);
});

test('a stalled worker times out at the caller deadline and is terminated', async () => {
  const OriginalWorker = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class {
    terminate() { terminated = true; }
  };
  try {
    await assert.rejects(readImageFiles([file('IM0001')], { timeoutMs: 10 }), /timed out after 10 ms/);
    assert.equal(terminated, true);
    terminated = false;
    await assert.rejects(runDcm2niix([file('IM0001')], { timeoutMs: 10 }), /timed out after 10 ms/);
    assert.equal(terminated, true);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test('runDcm2niix names outputs without the input folder unless the caller sets -f', async () => {
  const outputs = [file('t1_2.nii')];
  const named = await withFakeWorker(outputs, () => runDcm2niix([file('IM0001')], { args: ['-ba', 'n'] }));
  assert.deepEqual(named.calls[0].cmd, ['-f', '%p_%t_%s', '-ba', 'n']);
  assert.deepEqual(named.result.map((image) => image.name), ['t1_2.nii']);
});

test('runDcm2niix has a default deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const OriginalWorker = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class { terminate() { terminated = true; } };
  try {
    const pending = assert.rejects(runDcm2niix([file('IM0001')]), /timed out after 120000 ms/);
    t.mock.timers.tick(120_000);
    await pending;
    assert.equal(terminated, true);
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});

test('readDiffusionSeries pairs one converted series with loose FSL gradients and drops non-object sidecars', async () => {
  const outputs = [file('dwi_4.nii'), file('dwi_4.json', '[1, 2]')];
  const bvals = file('bvals', '0 1000');
  const bvecs = file('bvecs', '0 1\n0 0\n0 0');
  const { result } = await withFakeWorker(outputs, () => readDiffusionSeries([file('IM0001'), bvals, bvecs]));
  assert.deepEqual(result.map(({ image, sidecar, bval, bvec }) => [image.name, sidecar, bval, bvec]), [['dwi_4.nii', null, bvals, bvecs]]);
});
