// One shard of a samsrf command-line analysis on its own WebAssembly instance (src/cli.js runSharded).
import { parentPort, workerData } from 'node:worker_threads';
import { createJob } from './node.js';

const { spec, start, end } = workerData;
const job = createJob(spec);
try {
  const partial = job.run(start, end, (done) => parentPort.postMessage({ type: 'progress', done }));
  parentPort.postMessage({ type: 'partial', partial }, [partial.buffer]);
} finally {
  job.free();
}
