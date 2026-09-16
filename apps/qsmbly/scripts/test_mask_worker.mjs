import assert from 'node:assert/strict';
import test from 'node:test';
import { MaskController } from '../js/controllers/MaskController.js';
import { WorkerSession } from '../../../packages/components/src/worker/WorkerSession.js';

for (const operation of ['biasCorrection', 'voxelQuality']) {
  for (const fails of [false, true]) {
    test(`${operation} uses the session channel and releases its response listener (${fails ? 'failure' : 'success'})`, async () => {
      const nativeWorker = {
        postMessage(message, transfer) {
          structuredClone(message, { transfer });
          assert.equal(message.type, operation);
          queueMicrotask(() => this.onmessage({ data: {
            type: operation,
            ...(fails ? { error: 'Scientific kernel failed' } : { result: new Float64Array([1, 2]).buffer }),
          } }));
        },
      };
      const session = new WorkerSession({ createWorker: () => nativeWorker });
      const controller = new MaskController({
        getWorker: () => session,
        initializeWorker: async () => session.start(),
        setProgress() {},
      });
      const header = new ArrayBuffer(352);
      const view = new DataView(header);
      for (const offset of [42, 44, 46]) view.setInt16(offset, 1, true);
      controller.magnitudeFileBytes = header;
      const input = new Float64Array([1]);
      controller.readNiftiData = async () => input;
      controller.readNiftiHeader = async () => header;
      const promise = operation === 'biasCorrection'
        ? controller.applyBiasCorrection(input)
        : controller.computeVoxelQualityMap([{ file: {} }], [], [4]);
      if (fails) await assert.rejects(promise, /Scientific kernel failed/);
      else assert.deepEqual(Array.from(await promise), [1, 2]);
      assert.equal(session.listeners.size, 0);
      assert.deepEqual(Array.from(input), [1]);
    });
  }
}
