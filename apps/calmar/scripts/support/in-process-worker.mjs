// Runs the real inference worker inside the test process and exposes it
// through a `Worker`-shaped class, so the real CalmarPipeline executor can
// drive it over the real message protocol.
//
// Messages are delivered in order, one at a time, as a browser worker
// would. They are passed by reference (no structured clone, no transfer).

import { register } from 'node:module';

register('./worker-loader-hooks.mjs', import.meta.url);

const workerScope = {
  postMessage(message) {
    transcript.push(message);
    activeWorker?.onmessage?.({ data: message });
  }
};
const transcript = [];
let activeWorker = null;
let queue = Promise.resolve();

globalThis.self = workerScope;
globalThis.__calmarOrt = { create: null };

await import('../../web/js/inference-worker.js');

export class InProcessWorker {
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.onmessage = null;
    this.onerror = null;
    InProcessWorker.created.push(this);
    activeWorker = this;
  }

  postMessage(message) {
    queue = queue.then(() => workerScope.onmessage({ data: message }));
  }

  terminate() {
    if (activeWorker === this) activeWorker = null;
  }
}
InProcessWorker.created = [];

// Resolves once every message posted so far has been handled.
export async function workerIdle() {
  let seen;
  do {
    seen = queue;
    await seen;
  } while (seen !== queue);
}

// Every message the worker has posted, oldest first.
export function workerTranscript() {
  return transcript;
}

export const ortStub = globalThis.__calmarOrt;
