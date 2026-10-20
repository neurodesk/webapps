// One fitting Web Worker: @neurodesk/noddi's shared handler on the served WebAssembly module.
import { fitWorkerHandler } from "@neurodesk/noddi/fit-worker";
import wasmUrl from "@neurodesk/noddi/wasm?url";

const handle = fitWorkerHandler(
  () => fetch(wasmUrl),
  (message, transfer) => self.postMessage(message, transfer),
);

self.onmessage = ({ data }) => handle(data);
