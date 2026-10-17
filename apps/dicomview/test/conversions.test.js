import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversionStore } from '../src/conversions.js';

const tick = () => new Promise((resolve) => setTimeout(resolve));
const series = (uid) => ({ uid, files: [] });
const aborted = { name: 'AbortError' };

// A convert whose runs the test finishes by hand, in the order it likes.
function manualConvert() {
  const runs = [];
  const convert = (entry, signal) => new Promise((resolve, reject) => {
    const run = { uid: entry.uid, resolve: () => resolve([{ image: { name: `${entry.uid}.nii` }, sidecar: null }]), reject };
    runs.push(run);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { runs, convert, started: () => runs.map((run) => run.uid) };
}

test('a conversion outlives the selection that started it and is run once', async () => {
  const { runs, convert, started } = manualConvert();
  const store = new ConversionStore({ convert });
  const first = store.request(series('A'));
  const again = store.request(series('A'));
  await tick();
  assert.deepEqual(started(), ['A']);
  assert.equal(store.get('A').state, 'pending');
  runs[0].resolve();
  assert.equal((await first)[0].image.name, 'A.nii');
  assert.equal(await again, await first);
  assert.equal(store.get('A').state, 'done');
  assert.equal(await store.request(series('A')), await first, 'a done series is served from memory');
  assert.deepEqual(started(), ['A']);
});

test('one dcm2niix run at a time; the series the user chooses goes ahead of the queue', async () => {
  const { runs, convert, started } = manualConvert();
  const store = new ConversionStore({ convert });
  const batch = store.convertAll([series('A'), series('B'), series('C')]);
  await tick();
  assert.deepEqual(started(), ['A']);
  const chosen = store.request(series('C'));
  runs[0].resolve();
  await tick();
  assert.deepEqual(started(), ['A', 'C'], 'C jumped ahead of B');
  runs[1].resolve();
  await chosen;
  await tick();
  assert.deepEqual(started(), ['A', 'C', 'B']);
  runs[2].resolve();
  assert.deepEqual(await batch, { converted: 3, failed: 0, skipped: 0 });
});

test('cancelling one series ends only that run, and the next request retries it', async () => {
  const { runs, convert, started } = manualConvert();
  const store = new ConversionStore({ convert });
  const a = store.request(series('A'));
  const b = store.request(series('B'));
  await tick();
  store.cancel('A', new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(a, aborted);
  assert.equal(store.get('A').state, 'failed');
  await tick();
  assert.deepEqual(started(), ['A', 'B'], 'B took the freed slot');
  runs[1].resolve();
  assert.equal((await b)[0].image.name, 'B.nii');
  const retry = store.request(series('A'));
  await tick();
  assert.deepEqual(started(), ['A', 'B', 'A']);
  runs[2].resolve();
  await retry;
});

test('cancelling Convert all stops the queue and keeps what finished; a chosen series is not stopped', async () => {
  const { runs, convert, started } = manualConvert();
  const store = new ConversionStore({ convert });
  const progress = [];
  const controller = new AbortController();
  const batch = store.convertAll([series('A'), series('B'), series('C'), series('D')], {
    signal: controller.signal,
    onProgress: (done, total) => progress.push([done, total]),
  });
  await tick();
  runs[0].resolve();
  await tick();
  const chosen = store.request(series('D'));
  await tick();
  assert.deepEqual(started(), ['A', 'B']);
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(batch, aborted);
  assert.equal(store.get('A').state, 'done');
  assert.equal(store.get('B').state, 'failed');
  assert.equal(store.get('C'), undefined, 'never started');
  await tick();
  assert.deepEqual(started(), ['A', 'B', 'D'], 'the chosen series went on after the batch stopped');
  runs[2].resolve();
  await chosen;
  assert.deepEqual(progress, [[0, 4], [1, 4]]);
});

test('a saved series is loaded without a run and runs are saved; a failed save is not a failed conversion', async () => {
  const saved = new Map([['A', [{ image: { name: 'saved.nii' }, sidecar: null }]]]);
  const { runs, convert, started } = manualConvert();
  const store = new ConversionStore({
    load: async (entry) => saved.get(entry.uid) ?? null,
    convert,
    save: async (entry) => { if (entry.uid === 'C') throw new Error('quota'); saved.set(entry.uid, 'written'); },
  });
  assert.equal((await store.request(series('A')))[0].image.name, 'saved.nii');
  assert.deepEqual(started(), []);
  const b = store.request(series('B'));
  const c = store.request(series('C'));
  await tick();
  runs[0].resolve();
  await b;
  assert.equal(saved.get('B'), 'written');
  await tick();
  runs[1].resolve();
  assert.equal((await c)[0].image.name, 'C.nii');
  assert.equal(store.get('C').state, 'done');
});

test('a failed conversion is retried on the next request and counted by Convert all', async () => {
  const { runs, convert } = manualConvert();
  const store = new ConversionStore({ convert });
  const batch = store.convertAll([series('A'), series('B')]);
  await tick();
  runs[0].reject(new Error('no pixels'));
  await tick();
  runs[1].resolve();
  assert.deepEqual(await batch, { converted: 1, failed: 1, skipped: 0 });
  assert.equal(store.get('A').state, 'failed');
  const retry = store.request(series('A'));
  await tick();
  runs[2].resolve();
  await retry;
  assert.deepEqual(await store.convertAll([series('A'), series('B')]), { converted: 0, failed: 0, skipped: 2 });
});

test('clear aborts every pending run; forget drops done ones and leaves pending ones running', async () => {
  const { runs, convert } = manualConvert();
  const changes = [];
  const store = new ConversionStore({ convert, onChange: () => changes.push(store.entries().map((entry) => `${entry.uid}:${entry.state}`)) });
  const a = store.request(series('A'));
  await tick();
  runs[0].resolve();
  await a;
  const b = store.request(series('B'));
  await tick();
  store.forget();
  assert.equal(store.get('A'), undefined);
  assert.equal(store.get('B').state, 'pending');
  store.clear(new DOMException('Replaced', 'AbortError'));
  await assert.rejects(b, aborted);
  assert.deepEqual(store.entries(), []);
  assert.deepEqual(changes.at(-1), []);
  assert.ok(changes.some((snapshot) => snapshot.includes('A:done')));
});

test('a series chosen while its saved copy is still being looked up goes ahead of the queue', async () => {
  const { runs, convert, started } = manualConvert();
  let finishLookup;
  const store = new ConversionStore({
    load: (entry) => (entry.uid === 'C' ? new Promise((resolve) => { finishLookup = () => resolve(null); }) : Promise.resolve(null)),
    convert,
  });
  const batch = store.convertAll([series('A'), series('B'), series('C')]);
  await tick();
  const chosen = store.request(series('C'));
  await tick();
  assert.deepEqual(started(), ['A']);
  finishLookup();
  runs[0].resolve();
  await tick();
  await tick();
  assert.deepEqual(started(), ['A', 'C'], 'C was queued ahead of B once its lookup ended');
  runs[1].resolve();
  await chosen;
  await tick();
  runs[2].resolve();
  await batch;
});
