import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAnalysisRunner } from '../web/js/app/browser-analysis.js';

function fixture() {
    const workers = [];
    const runner = createBrowserAnalysisRunner({ createWorker: () => {
        const worker = { sent: [], terminated: false, terminate() { this.terminated = true; }, postMessage(message) { this.sent.push(message); } };
        workers.push(worker);
        return worker;
    } });
    return { runner, workers };
}
const spec = { tool: 'sct', command: 'process_segmentation', cord: 'cord', options: {} };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('worker receives unchanged mask bytes and returns original artifact bytes', async () => {
    const { runner, workers } = fixture();
    const running = runner.run({ spec, files: { cord: new File([new Uint8Array([0, 1, 255])], 'uploaded.nii.gz') } });
    await turn();
    assert.deepEqual(workers[0].sent[0].inputs[0], { role: 'cord', name: 'cord.nii.gz', bytes: new Uint8Array([0, 1, 255]) });
    const outputs = [{ name: 'morphometry.csv', bytes: new Uint8Array([2, 3]), contentType: 'text/csv' }];
    workers[0].onmessage({ data: { type: 'result', outputs } });
    assert.equal(await running, outputs);
    assert.equal(workers[0].terminated, true);
});

test('cancellation during mask reading terminates the worker and prevents late submission', async () => {
    const { runner, workers } = fixture();
    let resolve;
    const bytes = new Promise(done => { resolve = done; });
    const running = runner.run({ spec, files: { cord: { name: 'mask.nii', arrayBuffer: () => bytes } } });
    runner.cancel();
    await assert.rejects(running, error => error.name === 'AbortError');
    resolve(new ArrayBuffer(2));
    await turn();
    assert.equal(workers[0].terminated, true);
    assert.deepEqual(workers[0].sent, []);
    const retry = runner.run({ spec, files: { cord: new File(['mask'], 'mask.nii') } });
    await turn();
    workers[0].onmessage({ data: { type: 'result', outputs: ['stale'] } });
    workers[1].onmessage({ data: { type: 'result', outputs: [] } });
    assert.deepEqual(await retry, []);
});

test('worker failure rejects the run and releases it for retry', async () => {
    const { runner, workers } = fixture();
    const running = runner.run({ spec, files: { cord: new File(['mask'], 'mask.nii') } });
    workers[0].onerror({ message: 'Runtime unavailable' });
    await assert.rejects(running, /Runtime unavailable/);
    assert.equal(workers[0].terminated, true);
    const retry = runner.run({ spec, files: { cord: new File(['mask'], 'mask.nii') } });
    workers[1].onmessage({ data: { type: 'result', outputs: [] } });
    await retry;
});
