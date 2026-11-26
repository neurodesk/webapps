import test from 'node:test';
import assert from 'node:assert/strict';
import { runAbortable } from '../src/automation/abort.js';

test('abort releases the owned worker and rejects a pending operation without exposing its late output', async () => {
  const controller = new AbortController();
  let finish;
  let releaseCancel;
  let cancelled = 0;
  const operation = runAbortable(
    controller.signal,
    () => new Promise(resolve => { finish = resolve; }),
    () => {
      cancelled++;
      return new Promise(resolve => { releaseCancel = resolve; });
    },
  );
  await Promise.resolve();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  finish('stale output');
  await Promise.resolve();
  releaseCancel();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(cancelled, 1);
});

test('already aborted requests never launch work and completed tasks are not cancelled later', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  assert.equal(await runAbortable(controller.signal, async () => 42, () => { cancelled++; }), 42);
  controller.abort();
  await assert.rejects(runAbortable(controller.signal, () => assert.fail('must not start'), () => { cancelled++; }), { name: 'AbortError' });
  assert.equal(cancelled, 0);
});

test('missing signal runs the task directly without invoking cancel', async () => {
  let cancelled = 0;
  assert.equal(await runAbortable(undefined, async () => 'result', () => { cancelled++; }), 'result');
  assert.equal(cancelled, 0);
});

test('abort still rejects with signal.reason when cancel throws or rejects', async () => {
  for (const cancel of [() => { throw new Error('sync cleanup failed'); }, () => Promise.reject(new Error('async cleanup failed'))]) {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const operation = runAbortable(controller.signal, () => new Promise(() => {}), cancel);
    await Promise.resolve();
    controller.abort(reason);
    await assert.rejects(operation, error => error === reason);
  }
});

test('task rejection surfaces its own error and detaches the abort listener', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  await assert.rejects(
    runAbortable(controller.signal, () => Promise.reject(new Error('boom')), () => { cancelled++; }),
    { message: 'boom' },
  );
  controller.abort();
  await Promise.resolve();
  assert.equal(cancelled, 0);
});
