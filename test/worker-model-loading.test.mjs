import test from 'node:test';
import assert from 'node:assert/strict';
import { inferenceWorker } from '../test-utils/inference-worker-harness.mjs';

const bytes = new Uint8Array([1, 2, 3]);
const hash = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
const model = { url: 'https://example.org/model', bytes: 3, sha256: hash };

for (const app of ['synthsr', 'synthseg']) {
  test(`${app} actual worker loads verified bytes and reports progress`, async () => {
    const calls = [];
    let stored;
    const worker = await inferenceWorker(app, { caches: { async open(name) {
      calls.push(name);
      return {
        async match(key) { calls.push(key); return stored?.clone(); },
        async put(key, response) { calls.push(key); stored = response; },
      };
    } } });
    await worker.run(model);
    assert.deepEqual(new Uint8Array(worker.context.loadedModel.bytes), bytes);
    assert.equal(worker.context.loadedModel.hash, hash);
    assert.equal(worker.messages.at(-1).type, 'result');
    assert.deepEqual(calls, [`neurodesk-${app}-v1`, model.url, model.url]);
    const progress = worker.messages.find(message => message.type === 'progress');
    assert.equal(progress.value, 0.25);
    assert.match(progress.message, /Loading model · .* MB/);
    worker.context.fetch = async url => {
      if (url === model.url) throw Error('offline');
      return new Response(bytes);
    };
    await worker.run(model);
    assert.equal(worker.messages.at(-1).type, 'result');
  });

  test(`${app} actual worker publishes no result on invalid remote bytes`, async () => {
    let published = false;
    const worker = await inferenceWorker(app, {
      fetch: async () => new Response(new Uint8Array([9, 9, 9])),
      caches: { async open() { return { match: async () => null, put: async () => { published = true; } }; } },
    });
    await worker.run(model);
    assert.equal(worker.messages.at(-1).type, 'error');
    assert.equal(worker.messages.some(message => message.type === 'result'), false);
    assert.equal(published, false);
  });
}

test('SynthSR local model retains actual digest and validates size before reading', async () => {
  const worker = await inferenceWorker('synthsr');
  await worker.run({ bytes: 3, file: { size: 3, arrayBuffer: async () => bytes.buffer } });
  assert.equal(worker.context.loadedModel.hash, hash);
  let read = false;
  await worker.run({ bytes: 3, file: { size: 2, arrayBuffer: async () => { read = true; } } });
  assert.equal(read, false);
  assert.match(worker.messages.at(-1).message, /different size/);
});

test('SynthSR unpinned remote model reports its actual digest', async () => {
  const worker = await inferenceWorker('synthsr');
  await worker.run({ url: model.url, bytes: 3 });
  assert.equal(worker.context.loadedModel.hash, hash);
});

test('SynthSeg missing checksum fails before cache publication', async () => {
  let opened = false;
  const worker = await inferenceWorker('synthseg', { caches: { async open() { opened = true; } } });
  await worker.run({ url: model.url, bytes: 3 });
  assert.equal(opened, false);
  assert.equal(worker.messages.at(-1).type, 'error');
});

for (const app of ['synthsr', 'synthseg']) {
  test(`${app} actual worker replaces corrupt cached model`, async () => {
    let deleted = false;
    let published = false;
    const worker = await inferenceWorker(app, { caches: { async open() { return {
      match: async () => new Response(new Uint8Array([9, 9, 9])),
      delete: async () => { deleted = true; },
      put: async () => { published = true; },
    }; } } });
    await worker.run(model);
    assert.equal(worker.messages.at(-1).type, 'result');
    assert.equal(deleted, true);
    assert.equal(published, true);
    assert.equal(worker.context.loadedModel.hash, hash);
  });
}

test('SynthSR local checksum rejection preserves actionable error', async () => {
  const worker = await inferenceWorker('synthsr');
  await worker.run({ ...model, sha256: '0'.repeat(64), file: { size: 3, arrayBuffer: async () => bytes.buffer } });
  assert.match(worker.messages.at(-1).message, /Choose the exported synthsr-v2.onnx file/);
  assert.equal(worker.messages.some(message => message.type === 'result'), false);
});
