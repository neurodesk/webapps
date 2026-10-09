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

/**
 * `initialize()` must settle: a WASM load failure used to leave every caller waiting forever.
 * A fake Worker stands in for js/qsm-worker-pure.js; tests drive its replies by hand.
 */
describe('QsmPipelineController initialization', () => {
  let workers;
  let savedWorker;

  class FakeWorker {
    constructor() {
      this.posted = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(msg) { this.posted.push(msg); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage({ data }); }
  }

  function makeExecutor(opts = {}) {
    return new QsmPipelineController({ updateOutput: () => {}, setProgress: () => {}, ...opts });
  }

  beforeEach(() => {
    workers = [];
    savedWorker = global.Worker;
    global.Worker = FakeWorker;
  });

  afterEach(() => {
    global.Worker = savedWorker;
    jest.useRealTimers();
  });

  test('resolves every concurrent caller once the worker reports initialized', async () => {
    const ex = makeExecutor();
    const a = ex.initialize();
    const b = ex.initialize();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted.filter(m => m.type === 'init')).toHaveLength(1);

    workers[0].reply({ type: 'initialized' });

    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
    expect(ex.isReady()).toBe(true);
    expect(ex.workerInitializing).toBe(false);
    await expect(ex.initialize()).resolves.toBeUndefined();
  });

  test('rejects on the worker error message, and a retry starts a fresh worker', async () => {
    const ex = makeExecutor();
    const onPipelineError = jest.fn();
    ex.onPipelineError = onPipelineError;
    const first = ex.initialize();
    const waiting = ex.initialize();

    workers[0].reply({ type: 'error', message: 'WASM load failed: boom' });

    await expect(first).rejects.toThrow('WASM load failed: boom');
    await expect(waiting).rejects.toThrow('WASM load failed: boom');
    expect(workers[0].terminated).toBe(true);
    expect(ex.workerSession).toBeNull();
    expect(ex.workerInitializing).toBe(false);
    // An init failure is not a pipeline failure; callers report it.
    expect(onPipelineError).not.toHaveBeenCalled();

    const retry = ex.initialize();
    expect(workers).toHaveLength(2);
    workers[1].reply({ type: 'initialized' });
    await expect(retry).resolves.toBeUndefined();
  });

  test('rejects on worker.onerror, including an ErrorEvent with no message', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ex = makeExecutor();
    const p = ex.initialize();

    workers[0].onerror({});

    await expect(p).rejects.toThrow(/Worker error: the worker script failed to load/);
    expect(ex.workerSession).toBeNull();
    expect(ex.workerInitializing).toBe(false);
    spy.mockRestore();
  });

  test('rejects after the timeout if the worker never replies', async () => {
    jest.useFakeTimers();
    const progress = [];
    const ex = makeExecutor({ initTimeoutMs: 5000, setProgress: (v, t) => progress.push(t) });
    const p = ex.initialize();
    const assertion = expect(p).rejects.toThrow(/did not load within 5 s/);

    jest.advanceTimersByTime(5000);

    await assertion;
    expect(workers[0].terminated).toBe(true);
    expect(ex.workerInitializing).toBe(false);
    expect(progress).toContain('Failed');
  });

  test('a successful init clears the timeout', async () => {
    jest.useFakeTimers();
    const ex = makeExecutor({ initTimeoutMs: 5000 });
    const p = ex.initialize();
    workers[0].reply({ type: 'initialized' });
    await p;

    jest.advanceTimersByTime(10000);

    expect(workers[0].terminated).toBe(false);
    expect(ex.isReady()).toBe(true);
  });

  test('cancel during init rejects the waiters instead of leaving them hanging', async () => {
    const ex = makeExecutor();
    const p = ex.initialize();
    ex.pipelineRunning = true;

    ex.cancel();

    await expect(p).rejects.toThrow('Cancelled');
    expect(ex.workerInitializing).toBe(false);
  });

  test('worker errors after init still go to the pipeline error path', async () => {
    const ex = makeExecutor();
    const onPipelineError = jest.fn();
    ex.onPipelineError = onPipelineError;
    const p = ex.initialize();
    workers[0].reply({ type: 'initialized' });
    await p;

    workers[0].reply({ type: 'error', message: 'unwrap failed' });

    expect(onPipelineError).toHaveBeenCalledWith('unwrap failed');
  });

  test('run() reports an init failure and returns false', async () => {
    const out = [];
    const ex = makeExecutor({ updateOutput: (m) => out.push(m) });
    const onPipelineError = jest.fn();
    ex.onPipelineError = onPipelineError;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const started = ex.run({ pipelineSettings: {} });
    workers[0].reply({ type: 'error', message: 'WASM load failed: boom' });

    await expect(started).resolves.toBe(false);
    expect(out).toContain('Error: WASM load failed: boom');
    expect(onPipelineError).toHaveBeenCalledWith('WASM load failed: boom');
    expect(ex.isRunning()).toBe(false);
    spy.mockRestore();
  });
});

describe('QsmPipelineController job start', () => {
  /** A worker stub that clones each message the way postMessage does, transfers included. */
  function makeStartedExecutor() {
    const onPipelineError = jest.fn();
    const ex = new QsmPipelineController({ updateOutput: () => {}, setProgress: () => {}, onPipelineError });
    const posted = [];
    ex.workerSession = { send: (msg, transfer) => posted.push(structuredClone(msg, { transfer })) };
    ex.initialize = async () => {};
    return { ex, posted, onPipelineError };
  }

  test.each([
    ['runSWI', 'runSWI'],
    ['runT2starR2star', 'runT2starR2star'],
    ['run', 'run'],
  ])('%s posts a %s message and marks the executor running', async (method, type) => {
    const { ex, posted } = makeStartedExecutor();
    const magnitude = new ArrayBuffer(16);
    const prepared = new Float64Array([1, 2]);

    await expect(ex[method]({ magnitudeBuffers: [magnitude], preparedMagnitude: prepared }, [magnitude]))
      .resolves.toBe(true);

    expect(ex.isRunning()).toBe(true);
    expect(posted[0].type).toBe(type);
    // Transferred buffers move to the worker; untransferred typed arrays are copied as-is.
    expect(magnitude.byteLength).toBe(0);
    expect(posted[0].data.magnitudeBuffers[0].byteLength).toBe(16);
    expect(posted[0].data.preparedMagnitude.constructor.name).toBe('Float64Array');
    expect(prepared.length).toBe(2);
  });

  test('a worker that fails to start reports an error and is not left running', async () => {
    const { ex, posted, onPipelineError } = makeStartedExecutor();
    ex.initialize = async () => { throw new Error('WASM init failed'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ex.runSWI({})).resolves.toBe(false);

    expect(ex.isRunning()).toBe(false);
    expect(posted).toHaveLength(0);
    expect(onPipelineError).toHaveBeenCalledWith('WASM init failed');
    spy.mockRestore();
  });
});
