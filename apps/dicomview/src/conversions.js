// One owner for every series conversion: its lifetime is not the view that asked for it.
// Selecting another series leaves a conversion running; what ends one is cancel(uid) (the
// footer × while it is what the status bar shows), the signal given to convertAll (the ×
// on Convert all) or clear() (a new input).
//
// Entry = { uid, series, state: 'pending' | 'done' | 'failed', promise, controller, chosen,
//           outputs, error }
//   One entry per series uid. pending holds the controller that aborts it; done holds the
//   outputs; failed holds the error until the next request retries. chosen marks a series
//   the user asked for: it goes ahead of the queue and cancelling Convert all leaves it.
//
// Runs go through one queue: load(series) (a saved copy, fast) runs at once, convert(series)
// (dcm2niix) one at a time in queue order, with requested series ahead of batch ones.
// save(series, outputs) runs after a conversion and never fails a request.

export class ConversionStore {
  #entries = new Map();
  #queue = [];
  #running = 0;
  #concurrency;
  #io;
  #onChange;

  constructor({ load = async () => null, convert, save = async () => {}, concurrency = 1, onChange = () => {} }) {
    this.#io = { load, convert, save };
    this.#concurrency = concurrency;
    this.#onChange = onChange;
  }

  get(uid) {
    return this.#entries.get(uid);
  }

  entries() {
    return [...this.#entries.values()];
  }

  // The outputs of the series, from a done entry, a pending one, or a new run. The series
  // the user chose goes ahead of queued batch work.
  request(series, { priority = true } = {}) {
    const existing = this.#entries.get(series.uid);
    if (existing?.state === 'done') return Promise.resolve(existing.outputs);
    if (existing?.state === 'pending') {
      if (priority) this.#promote(existing);
      return existing.promise;
    }
    return this.#start(series, priority).promise;
  }

  // Converts every series not yet done, one after another. Resolves with how many were
  // converted, how many failed and how many were already done; rejects only when cancelled.
  async convertAll(seriesList, { signal, onProgress = () => {} } = {}) {
    const todo = seriesList.filter((series) => this.#entries.get(series.uid)?.state !== 'done');
    const batch = new Set(todo.map((series) => series.uid));
    const abort = () => {
      for (const uid of batch) {
        const entry = this.#entries.get(uid);
        if (entry?.state === 'pending' && !entry.chosen) entry.controller.abort(signal.reason);
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    const counts = { converted: 0, failed: 0, skipped: seriesList.length - todo.length };
    try {
      let done = 0;
      for (const series of todo) {
        signal?.throwIfAborted();
        onProgress(done, todo.length, series);
        try {
          await Promise.race([this.request(series, { priority: false }), untilAborted(signal)]);
          counts.converted += 1;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          counts.failed += 1;
          console.warn(`Converting ${series.uid} failed: ${error.message}`);
        }
        done += 1;
      }
      onProgress(done, todo.length, null);
      return counts;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  cancel(uid, reason) {
    const entry = this.#entries.get(uid);
    if (entry?.state === 'pending') entry.controller.abort(reason);
  }

  // Drops every entry; pending ones are aborted.
  clear(reason) {
    for (const entry of this.#entries.values()) {
      if (entry.state === 'pending') entry.controller.abort(reason);
    }
    this.#entries.clear();
    this.#queue = [];
    this.#onChange();
  }

  // Drops done entries so the next request converts again; pending ones keep running.
  forget() {
    for (const [uid, entry] of this.#entries) {
      if (entry.state === 'done') this.#entries.delete(uid);
    }
    this.#onChange();
  }

  #promote(entry) {
    entry.chosen = true;
    const at = this.#queue.indexOf(entry);
    if (at > 0) {
      this.#queue.splice(at, 1);
      this.#queue.unshift(entry);
    }
  }

  #start(series, priority) {
    const controller = new AbortController();
    const entry = { uid: series.uid, state: 'pending', controller, outputs: null, error: null, promise: null, series, chosen: priority, release: null };
    entry.promise = this.#run(entry);
    this.#entries.set(series.uid, entry);
    this.#onChange();
    return entry;
  }

  async #run(entry) {
    const { signal } = entry.controller;
    const { series } = entry;
    try {
      let outputs = await this.#io.load(series, signal);
      signal.throwIfAborted();
      if (!outputs) {
        await this.#turn(entry);
        try {
          signal.throwIfAborted();
          outputs = await this.#io.convert(series, signal);
          signal.throwIfAborted();
        } finally {
          this.#release();
        }
        await this.#io.save(series, outputs).catch((error) => console.warn(`Saving ${series.uid} failed: ${error.message}`));
        signal.throwIfAborted();
      }
      this.#settle(entry, { state: 'done', outputs });
      return outputs;
    } catch (error) {
      this.#settle(entry, { state: 'failed', error });
      throw error;
    }
  }

  #settle(entry, change) {
    if (this.#entries.get(entry.uid) !== entry) return;
    Object.assign(entry, change);
    this.#onChange();
  }

  // Waits for a free dcm2niix slot. An entry aborted while it waits leaves the queue.
  #turn(entry) {
    if (this.#running < this.#concurrency && !this.#queue.length) {
      this.#running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      entry.release = resolve;
      if (entry.chosen) this.#queue.unshift(entry);
      else this.#queue.push(entry);
      entry.controller.signal.addEventListener('abort', () => {
        const at = this.#queue.indexOf(entry);
        if (at >= 0) this.#queue.splice(at, 1);
        reject(entry.controller.signal.reason);
      }, { once: true });
    });
  }

  #release() {
    const next = this.#queue.shift();
    if (next) next.release();
    else this.#running -= 1;
  }
}

function untilAborted(signal) {
  if (!signal) return new Promise(() => {});
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
