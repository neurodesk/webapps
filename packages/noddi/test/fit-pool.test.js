import assert from 'node:assert/strict';
import test from 'node:test';
import { fitVolume } from '../src/fit-pool.js';

const input = { buffer: new ArrayBuffer(0), data: Float32Array.of(1000, 300), dims: [1, 1, 1], voxels: 1, bvals: [0, 1000], bvecs: [[0, 1], [0, 0], [0, 0]], table: { dtiVolumes: [0, 1] } };
const options = { input, mask: Uint8Array.of(1), tensorFit: 'niimath-dtifit', noddi: false, spawn: () => { throw new Error('A tensor-only niimath fit needs no chunk workers.'); }, workers: 1 };

test('the selected niimath tensor is returned without starting chunk workers', async () => {
  const tensor = { FA: Float32Array.of(0.8) };
  const stages = [];
  const result = await fitVolume({ ...options, dtifit: async () => tensor, onStage: (stage) => stages.push(stage) });
  assert.deepEqual(result, { tensor, noddi: null });
  assert.deepEqual(stages, ['dtifit']);
});

test('an aborted fit never reaches a runner, and cancellation during dtifit prevents later delivery', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Fitting cancelled', 'AbortError');
  let release;
  const pending = fitVolume({ ...options, signal: controller.signal, dtifit: (_input, signal) => {
    assert.equal(signal, controller.signal);
    return new Promise((resolve) => { release = resolve; });
  } });
  controller.abort(reason);
  release({ FA: Float32Array.of(0.8) });
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(fitVolume({ ...options, signal: controller.signal, dtifit: () => { throw new Error('An aborted fit must not run.'); } }), (error) => error === reason);
});

for (const method of ['amico', 'dmipy']) {
  test(`${method}: cancellation ignores already-queued worker messages`, async () => {
    const controller = new AbortController();
    const reason = new DOMException('Fitting cancelled', 'AbortError');
    const sent = [];
    const progress = [];
    let terminated = false;
    const worker = {
      postMessage(message) { sent.push(message); },
      terminate() { terminated = true; },
    };
    const pending = fitVolume({
      input, mask: Uint8Array.of(1), noddi: true, method, tensorFit: 'wls',
      workers: 1, spawn: () => worker, signal: controller.signal,
      onProgress: (fraction) => progress.push(fraction),
    });
    assert.equal(sent[0].method, method);
    const rejected = assert.rejects(pending, (error) => error === reason);
    controller.abort(reason);
    // A host may have queued delivery before terminate() discarded its worker.
    worker.onmessage({ data: { type: 'ready' } });
    worker.onmessage({ data: { type: 'done', id: 0, noddi: { ICVF: Float32Array.of(0.5) } } });
    await rejected;
    assert.equal(terminated, true);
    assert.deepEqual(progress, []);
    assert.deepEqual(sent.map((message) => message.type), ['init']);
  });
}
