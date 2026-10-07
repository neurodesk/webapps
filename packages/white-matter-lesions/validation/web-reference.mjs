#!/usr/bin/env node
// The web app's worker path on ONNX Runtime Web's WebAssembly backend, under Node: the same
// SynthStrip graph, folds, pipeline and output writer, with the worker's session options.
//
//   node validation/web-reference.mjs INPUT.nii[.gz] OUTPUT_DIR [--folds 1|5] [--cache-dir DIR]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { readVolume } from '@neurodesk/synthsr';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { FLAMES_FOLDS, SYNTHSTRIP } from '../src/assets.js';
import { downloadModels, resolveFolds } from '../src/node.js';
import { runFolds } from '../src/pipeline.js';
import { lesionResults, outputNames } from '../src/results.js';

// worker.js's session options; its WebGPU attempt falls back to exactly this on a CPU.
const createSession = (bytes) => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function webReference({ input, output, folds = 1, cacheDir }) {
  ort.env.wasm.numThreads = Math.min(8, availableParallelism());
  const { directory } = await downloadModels({ cacheDir });
  const model = (asset) => readFile(join(directory, asset.filename));
  const volume = readVolume(arrayBuffer(await readFile(input)));
  const stripped = await runSynthstrip({
    volume,
    loadModel: async () => ({ bytes: await model(SYNTHSTRIP), hash: SYNTHSTRIP.sha256 }),
    createSession,
    Tensor: ort.Tensor,
  });
  const models = [];
  for (const fold of FLAMES_FOLDS.slice(0, resolveFolds(folds))) models.push(await model(fold));
  const { probability } = await runFolds({
    volume,
    brainMask: stripped.mask.data,
    models,
    createSession,
    Tensor: ort.Tensor,
  });
  const results = lesionResults(volume, probability);
  const names = outputNames(basename(input));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, names.mask), new Uint8Array(results.mask));
  await writeFile(join(output, names.probability), new Uint8Array(results.probability));
  await writeFile(join(output, names.table), results.tsv);
  return { output, files: [names.mask, names.probability, names.table], ...results.summary, threads: ort.env.wasm.numThreads };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { folds: { type: 'string' }, 'cache-dir': { type: 'string' } },
  });
  if (positionals.length !== 2) throw new Error('Usage: web-reference.mjs INPUT OUTPUT_DIR [--folds 1|5] [--cache-dir DIR]');
  const [input, output] = positionals;
  console.log(JSON.stringify(await webReference({ input, output, folds: values.folds, cacheDir: values['cache-dir'] })));
}
