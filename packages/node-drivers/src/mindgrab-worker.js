// One MindGrab CPU run, isolated in its own worker thread. Ending the thread
// frees the module's 2.6-3.9 GB shared heap at once (otherwise it waits for the
// host's garbage collector), and keeps the glue's process-wide side effects
// (globalThis.Worker, process.exitCode) out of the host.

import { parentPort, workerData } from 'node:worker_threads';

const { moduleUrl, model, args, input, outputs } = workerData;
const log = line => parentPort.postMessage({ type: 'log', line });
const { default: createModule } = await import(moduleUrl);
let settle;
const exited = new Promise(resolve => {
  settle = resolve;
});
const module = await createModule({
  noInitialRun: true,
  thisProgram: `brainchop-${model}`,
  print: log,
  printErr: log,
  onExit: settle,
});
module.FS.writeFile('/in.nii', input);
const started = performance.now();
try {
  module.callMain([...args, '-backend', 'cpu', '-o', '/out.nii', '/in.nii']);
} catch (error) {
  if (typeof error?.status === 'number') {
    settle(error.status);
  } else {
    log(`threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    settle(-1);
  }
}
const code = await exited;
const elapsedMs = performance.now() - started;
const files = {};
if (code === 0) {
  for (const path of outputs) {
    if (module.FS.analyzePath(path).exists) files[path] = module.FS.readFile(path);
  }
}
parentPort.postMessage({ type: 'done', code, files, elapsedMs }, Object.values(files).map(bytes => bytes.buffer));
