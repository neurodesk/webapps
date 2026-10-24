// Runs the whole BISON pipeline in Node on one subject and compares the labels with the native
// MINC reference. Writes the downloads to <out>/outputs, every intermediate file to
// <out>/checkpoints, and report.json (steps with seconds and peak RSS, Dice per class).
//
//   node validation/pipeline-reference.mjs --t1 T1w.nii.gz [--flair FLAIR.nii.gz] --out DIR \
//     [--native REF_MASKED_DIR] [--asset-dir DIR] [--threads N]
//
// Peak RSS comes from /proc/self/status, read by a worker thread every 100 ms, because the
// WebAssembly tools block the main thread. Linux only.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { segment } from '../src/node.js';
import { labelAgreement, nativeOutput } from './agreement.mjs';

const { values } = parseArgs({
  options: {
    t1: { type: 'string' },
    flair: { type: 'string' },
    out: { type: 'string' },
    native: { type: 'string' },
    'asset-dir': { type: 'string' },
    threads: { type: 'string' },
  },
});
if (!values.t1 || !values.out) throw new Error('Give --t1 and --out.');

const MAX_STEPS = 256;
const shared = new SharedArrayBuffer(4 * (MAX_STEPS + 1));
const peaks = new Int32Array(shared);
const sampler = new Worker(`
  const { workerData } = require('node:worker_threads');
  const { readFileSync } = require('node:fs');
  const peaks = new Int32Array(workerData);
  setInterval(() => {
    const kb = Number(/VmRSS:\\s+(\\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]);
    const step = Atomics.load(peaks, 0);
    if (kb > Atomics.load(peaks, step + 1)) Atomics.store(peaks, step + 1, kb);
  }, 100);
`, { eval: true, workerData: shared });
sampler.unref();

const started = performance.now();
const steps = [];
function beginStep(name) {
  const now = (performance.now() - started) / 1000;
  if (steps.length) steps.at(-1).seconds = now - steps.at(-1).start;
  steps.push({ name, start: now });
  Atomics.store(peaks, 0, steps.length - 1);
  console.log(`[${now.toFixed(1)} s] ${name}`);
}

const outputs = join(values.out, 'outputs');
const checkpoints = join(values.out, 'checkpoints');
beginStep('Loading assets and checking inputs');
const result = await segment({
  t1: values.t1,
  flair: values.flair ?? null,
  output: outputs,
  assetDir: values['asset-dir'],
  threads: values.threads,
  onProgress: (message) => {
    if (!message.startsWith('Loading ')) beginStep(message);
  },
  checkpoint: async (name, bytes) => {
    const path = join(checkpoints, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
});
beginStep('done');
steps.pop();
await new Promise((done) => setTimeout(done, 150));
const report = {
  mode: result.mode,
  t1: values.t1,
  flair: values.flair ?? null,
  totalSeconds: (performance.now() - started) / 1000,
  steps: steps.map((step, k) => ({ name: step.name, seconds: step.seconds, peakRssMb: peaks[k + 1] / 1024 })),
  peakRssMb: Math.max(...peaks.slice(1, steps.length + 1)) / 1024,
  timings: result.timings,
  memoryMb: Object.fromEntries(Object.entries(result.memory ?? {}).map(([name, bytes]) => [name, bytes / 2 ** 20])),
  volumePol: result.volumePol,
  volumes: result.volumes,
};

if (values.native) {
  const file = (suffix) => join(outputs, result.files.find((name) => name.endsWith(suffix)));
  const labels = await readNifti(await readFile(file('_bison-labels.nii.gz')), Uint8Array);
  const mask = await readNifti(await readFile(file('_bison-mask.nii.gz')), Uint8Array);
  const nativeLabels = await nativeOutput(values.native, result.mode, '_bison-labels.nii.gz');
  const nativeMask = await nativeOutput(values.native, result.mode, '_bison-mask.nii.gz');
  report.agreement = labelAgreement({
    labels: labels.data,
    mask: mask.data,
    nativeLabels: nativeLabels.data,
    nativeMask: nativeMask.data,
    affine: labels.header.affine,
    mode: result.mode,
  });
}
await writeFile(join(values.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
