/**
 * Cancelling is a hard `worker.terminate()`, so a job waiting on a worker message never gets a
 * reply. These cover the registry that lets such a job settle instead of hanging the UI.
 */

import { jest } from '@jest/globals';
import { QsmPipelineController } from './QsmPipelineController.js';

function makeExecutor() {
  const ex = new QsmPipelineController({ updateOutput: () => {}, setProgress: () => {} });
  ex.workerSession = { terminate: () => { ex.workerSession.terminated = true; }, terminated: false };
  ex.pipelineRunning = true;
  return ex;
}

describe('QsmPipelineController cancellation', () => {
  test('completed jobs release cancellation without affecting a later job', () => {
    const ex = makeExecutor();
    const cancelled = jest.fn();
    const finish = ex.beginCancellableJob(cancelled);
    expect(ex.isRunning()).toBe(true);
    finish();
    expect(ex.isRunning()).toBe(false);
    const nextCancelled = jest.fn();
    ex.beginCancellableJob(nextCancelled);
    finish();
    expect(ex.isRunning()).toBe(true);
    ex.cancel();
    expect(cancelled).not.toHaveBeenCalled();
    expect(nextCancelled).toHaveBeenCalledTimes(1);
  });

  test('cancel runs registered handlers and terminates the worker', () => {
    const ex = makeExecutor();
    const worker = ex.workerSession;
    let called = 0;
    ex.onCancel(() => called++);

    ex.cancel();

    expect(called).toBe(1);
    expect(worker.terminated).toBe(true);
    expect(ex.workerSession).toBeNull();
    expect(ex.pipelineRunning).toBe(false);
    expect(ex.cancelHandlers.size).toBe(0);
  });

  test('a settled job unregisters, so a later cancel does not touch it', () => {
    const ex = makeExecutor();
    let called = 0;
    const unregister = ex.onCancel(() => called++);

    unregister();
    ex.cancel();

    expect(called).toBe(0);
  });

  test('one failing handler does not stop the others or the terminate', () => {
    const ex = makeExecutor();
    const worker = ex.workerSession;
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let second = 0;
    ex.onCancel(() => { throw new Error('boom'); });
    ex.onCancel(() => second++);

    ex.cancel();

    expect(second).toBe(1);
    expect(worker.terminated).toBe(true);
    spy.mockRestore();
  });

  test('cancel is inert when nothing is running', () => {
    const ex = makeExecutor();
    ex.pipelineRunning = false;
    const worker = ex.workerSession;
    let called = 0;
    ex.onCancel(() => called++);

    ex.cancel();

    expect(called).toBe(0);
    expect(worker.terminated).toBe(false);
  });
});
