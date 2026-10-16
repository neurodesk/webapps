// dicompare in a Pyodide worker, started only when the protocol is first summarised.
// The worker script is bundled from the dicompare app, so the standalone build needs no
// request to dicompare.neurodesk.org; Pyodide itself comes from its CDN, or from the
// offline bundle's /_offline/python/ in the desktop app.
import { DicompareController } from '../../dicompare/public/embed/DicompareController.js';
import workerUrl from '../../dicompare/public/embed/dicompare-worker.js?url';
import schemaIndex from '../../dicompare/public/schemas/index.json';

// The dicompare schema library, bundled as assets; only a schema's name is inlined.
const schemaUrls = import.meta.glob(['../../dicompare/public/schemas/*.json', '!**/index.json', '!**/doi-mapping*.json'], { query: '?url', import: 'default', eager: true });
const schemaNames = import.meta.glob(['../../dicompare/public/schemas/*.json', '!**/index.json', '!**/doi-mapping*.json'], { import: 'name', eager: true });
export const SCHEMAS = schemaIndex.map((path) => {
  const key = `../../dicompare/public/schemas/${path.split('/').pop()}`;
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
  }

  // Acquisitions of these files, as dicompare groups them. onProgress(fraction, message).
  async summarize(files, { signal, onProgress }) {
    const report = (scale, offset) => (progress) => onProgress(offset + scale * (progress.percentage ?? 0) / 100, progress.currentOperation);
    return abortable((async () => {
      await this.retainDicomFiles(files);
      await this.ensureInitialized(report(0.5, 0));
      const result = await this._sendRequest({
        type: 'analyzeFiles',
        payload: {
          fileNames: this.dicomFiles.map(file => file.name),
          fileContents: this.dicomFiles.map(file => file.data),
        },
      }, report(0.5, 0.5));
      const acquisitions = result.acquisitions ?? result;
      this.acquisitions = Array.isArray(acquisitions)
        ? acquisitions
        : Object.entries(acquisitions).map(([name, data]) => ({ ...data, protocolName: name }));
      return this.acquisitions;
    })(), signal, () => this.terminate());
  }

  // Each summarised acquisition checked against one acquisition of the schema.
  async check(schema, schemaAcquisitionIndex, { signal }) {
    const schemaContent = JSON.stringify(schema);
    return abortable((async () => {
      const results = [];
      for (const acquisition of this.acquisitions) {
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
