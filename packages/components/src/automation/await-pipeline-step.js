const activeExecutors = new WeakSet();

/** Await a worker callback, not the command-dispatch promise returned by PipelineExecutor. */
export async function awaitPipelineStep(executor, { step, terminal = 'step', completionCallback = 'onComplete', errorCallback = 'onError' }, action, signal) {
  signal.throwIfAborted();
  if (!['step', 'complete'].includes(terminal)) throw new Error(`Unknown pipeline terminal callback: ${terminal}`);
  if (activeExecutors.has(executor)) throw new Error('The pipeline already has a pending automation step.');
  activeExecutors.add(executor);
  const previous = Object.fromEntries(['onStepComplete', completionCallback, errorCallback].map(name => [name, executor[name]]));
  /** @type {(value?: unknown) => void} */
  let resolveCompletion = () => {};
  /** @type {(reason?: unknown) => void} */
  let rejectCompletion = () => {};
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const invoke = (name, value, completes) => {
    try {
      Promise.resolve(previous[name]?.call(executor, value)).then(
        () => { if (completes) resolveCompletion(); },
        rejectCompletion,
      );
    } catch (error) {
      rejectCompletion(error);
    }
  };
  executor.onStepComplete = completed => invoke('onStepComplete', completed, terminal === 'step' && completed === step);
  executor[completionCallback] = data => invoke(completionCallback, data, terminal === 'complete');
  executor[errorCallback] = error => {
    rejectCompletion(error instanceof Error ? error : new Error(String(error)));
    invoke(errorCallback, error, false);
  };
  const cancel = () => {
    rejectCompletion(signal.reason);
    try {
      Promise.resolve(executor.cancel()).catch(rejectCompletion);
    } catch (error) {
      rejectCompletion(error);
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await Promise.all([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action();
    }), completion]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', cancel);
    Object.assign(executor, previous);
    activeExecutors.delete(executor);
  }
}
