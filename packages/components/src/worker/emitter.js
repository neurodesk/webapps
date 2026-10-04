import { collectTransferables } from '../inference/workerProtocol.js';

export function createWorkerEmitter(scope = globalThis) {
  if (!scope || typeof scope.postMessage !== 'function') throw new Error('createWorkerEmitter requires a worker scope');

  const emit = (type, data = {}, { transfer = true } = {}) => {
    const message = { type, ...data };
    scope.postMessage(message, transfer ? collectTransferables(data) : []);
  };

  return Object.freeze({
    emit,
    progress: (value, text) => emit('progress', { value, text }, { transfer: false }),
    // `details` may name a console channel and level, e.g. { channel: 'analysis', level: 'warning' }.
    log: (message, details = {}) => emit('log', { ...details, message }, { transfer: false }),
    error: (message) => emit('error', { message }, { transfer: false }),
    initialized: (data = {}) => emit('initialized', data, { transfer: false }),
    complete: (data = {}) => emit('complete', data, { transfer: false }),
    stepComplete: (step) => emit('step-complete', { step }, { transfer: false }),
    volumeInfo: (info) => emit('volume-info', info, { transfer: false }),
    stageData: (stage, data, description, extras = {}) => emit('stageData', {
      stage,
      niftiData: data,
      description,
      ...extras,
    }),
  });
}
