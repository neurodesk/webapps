// Isolated worker thread for one brainchomp-lib CPU WebAssembly run.
// Terminating the worker releases the Emscripten pthread shared heap and keeps
// process-wide glue side effects (globalThis.Worker, process.exitCode) out of the host.
import { parentPort, workerData } from 'node:worker_threads';

const { moduleUrl, mode, args, input, outputs, threads } = workerData;
if (threads) {
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: threads });
}

const log = (line) => parentPort.postMessage({ type: 'log', line: String(line) });
const { default: createModule } = await import(moduleUrl);

let settle;
const exited = new Promise((resolve) => {
  settle = resolve;
});

const module = await createModule({
  noInitialRun: true,
  thisProgram: 'brainchomp',
  print: log,
  printErr: log,
  onExit: settle,
});

const started = performance.now();
if (mode === 'help') {
  try {
    module.callMain(['--help']);
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
  parentPort.postMessage({ type: 'done', code, files: {}, elapsedMs });
} else {
  module.FS.writeFile('/in.nii', input);
  const cpuArgs = threads ? ['-cpu', String(threads)] : ['-backend', 'cpu'];
  try {
    module.callMain([...args, ...cpuArgs, '-o', '/out.nii', '/in.nii']);
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
      if (module.FS.analyzePath(path).exists) {
        files[path] = module.FS.readFile(path);
      }
    }
  }
  parentPort.postMessage(
    { type: 'done', code, files, elapsedMs },
    Object.values(files).map((bytes) => bytes.buffer),
  );
}
