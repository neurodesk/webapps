// dicompare in a Pyodide worker, started only when the protocol is first summarised.
// scripts/stage-dicompare.mjs copies dicompare's embedding kit into src/vendor, so the
// standalone build needs no request to dicompare.neurodesk.org; Pyodide itself comes from
// its CDN, or from the offline bundle's /_offline/python/ in the desktop app.
import { DicompareController } from './vendor/dicompare/DicompareController.js';
import workerUrl from './vendor/dicompare/dicompare-worker.js?url';
import schemaIndex from './vendor/dicompare/schemas/index.json';
import { headerBuffer } from './dicom-index.js';

const BATCH = 32;

// The dicompare schema library, bundled as assets; only a schema's name is inlined.
const schemaUrls = import.meta.glob(['./vendor/dicompare/schemas/*.json', '!**/index.json'], { query: '?url', import: 'default', eager: true });
const schemaNames = import.meta.glob(['./vendor/dicompare/schemas/*.json', '!**/index.json'], { import: 'name', eager: true });
export const SCHEMAS = schemaIndex.map((path) => {
  const key = `./vendor/dicompare/schemas/${path.split('/').pop()}`;
  return { id: path.split('/').pop().replace(/\.json$/, ''), name: schemaNames[key], url: schemaUrls[key] };
});

function abortable(promise, signal, onAbort) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// The controller's runValidation checks one fixed schema; here the summary and each
// schema check are separate steps on the same worker.
export class ProtocolSession extends DicompareController {
  constructor(log) {
    super({ schemaUrl: 'chosen-per-check', workerUrl, updateOutput: log });
    this.lifetime = 0;
    this.startup = null;
  }

  // The controller's start-up awaits the script fetch and then creates a worker, even if
  // terminate() ran meanwhile, and two start-ups both assign this.worker. Here callers
  // share one start-up, and one that outlived a terminate() creates nothing.
  _createWorker() {
    if (this.worker) return Promise.resolve();
    if (!this.startup) {
      const { lifetime } = this;
      const startup = (async () => {
        const response = await fetch(this.workerUrl);
        if (!response.ok) throw new Error(`Failed to load dicompare worker from ${this.workerUrl}`);
        const script = await response.text();
        if (lifetime !== this.lifetime) throw new DOMException('Cancelled', 'AbortError');
        this._workerBlobUrl = URL.createObjectURL(new Blob([script], { type: 'application/javascript' }));
        this.worker = new Worker(this._workerBlobUrl);
        this.worker.onmessage = this._handleMessage.bind(this);
        this.worker.onerror = (error) => console.error('[DicompareController] Worker error:', error);
      })();
      this.startup = startup;
      startup.catch(() => {}).finally(() => {
        if (this.startup === startup) this.startup = null;
      });
    }
    return this.startup;
  }

  terminate() {
    this.lifetime += 1;
    this.startup = null;
    super.terminate();
  }

  // The controller's requests copy every buffer into the worker; these move them.
  _sendRequest(request, onProgress, transfer = []) {
    const id = `req_${++this.requestId}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...request, id }, transfer);
    });
  }

  // Acquisitions of these files (dicom-index records), as dicompare groups them.
  // onProgress(fraction, message). Only each file's header, up to its pixel data, is read
  // and sent. The bytes stay local to one run, so a cancelled run cannot leak into the next.
  async summarize(records, { signal, onProgress }) {
    const report = (scale, offset) => (progress) => onProgress(offset + scale * (progress.percentage ?? 0) / 100, progress.currentOperation);
    return abortable((async () => {
      const contents = [];
      for (let start = 0; start < records.length; start += BATCH) {
        contents.push(...await Promise.all(records.slice(start, start + BATCH).map(headerBuffer)));
        signal.throwIfAborted();
      }
      await this.ensureInitialized(report(0.5, 0));
      signal.throwIfAborted();
      const result = await this._sendRequest({
        type: 'analyzeFiles',
        payload: { fileNames: records.map((record) => record.path), fileContents: contents },
      }, report(0.5, 0.5), contents);
      const acquisitions = result.acquisitions ?? result;
      return Array.isArray(acquisitions)
        ? acquisitions
        : Object.entries(acquisitions).map(([name, data]) => ({ ...data, protocolName: name }));
    })(), signal, () => this.terminate());
  }

  // Each acquisition checked against one acquisition of the schema. A cancelled run ended
  // the worker, so the check starts a new one.
  async check(acquisitions, schema, schemaAcquisitionIndex, { signal }) {
    const schemaContent = JSON.stringify(schema);
    return abortable((async () => {
      await this.ensureInitialized();
      const results = [];
      for (const acquisition of acquisitions) {
        signal.throwIfAborted();
        const acquisitionName = acquisition.protocolName || 'Acquisition';
        try {
          const checks = await this._sendRequest({
            type: 'validateAcquisition',
            payload: { acquisition, schemaContent, acquisitionIndex: schemaAcquisitionIndex },
          });
          results.push({ acquisitionName, results: Array.isArray(checks) ? checks : [] });
        } catch (error) {
          results.push({ acquisitionName, results: [], error: error.message });
        }
      }
      return results;
    })(), signal, () => this.terminate());
  }
}
