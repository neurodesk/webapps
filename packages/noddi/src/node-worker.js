// One fitting worker thread of the noddi command line: the web app's worker handler on the
// package's own noddi.wasm.
import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { fitWorkerHandler } from './fit-worker.js';

const handle = fitWorkerHandler(
  () => readFile(new URL('./noddi.wasm', import.meta.url)),
  (message, transfer) => parentPort.postMessage(message, transfer),
);

parentPort.on('message', (message) => handle(message));
