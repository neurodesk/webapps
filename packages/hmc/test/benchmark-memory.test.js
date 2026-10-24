import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleProcessMemory } from '../validation/benchmark-memory.mjs';

test('RSS includes preparation peaks, the prepared baseline and correction completion', () => {
  let bytes = 10;
  let time = 0;
  let tick;
  let cancelled = false;
  const sampling = sampleProcessMemory(123, {
    readRss: (pid) => { assert.equal(pid, 123); return bytes; },
    now: () => time,
    schedule: (callback, interval) => {
      assert.equal(interval, 100);
      tick = callback;
      return 7;
    },
    cancel: (timer) => { assert.equal(timer, 7); cancelled = true; },
  });
  bytes = 500;
  time = 100;
  tick(); // Input decoding peak, before the ready message.
  bytes = 20;
  time = 200;
  const preparedBytes = sampling.sample();
  bytes = 300;
  time = 300;
  tick(); // Correction work.
  bytes = 30;
  time = 350;
  const memory = sampling.stop();
  assert.equal(memory.baselineBytes, 10);
  assert.equal(preparedBytes, 20);
  assert.equal(memory.peakBytes, 500);
  assert.deepEqual(memory.samples.at(-1), { elapsedMs: 350, bytes: 30 });
  assert.equal(cancelled, true);
  tick(); // An already queued timer callback must not extend a stopped receipt.
  assert.deepEqual(sampling.stop(), memory);
});
