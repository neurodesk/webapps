#!/usr/bin/env node
// The web app's SynthStrip worker path on ONNX Runtime Web's WebAssembly backend, under Node:
// the same graph, pipeline, session options and output writer as apps/brain-extraction/src/synthstrip.js.
//
//   node validation/web-reference.mjs INPUT.nii[.gz] OUTPUT_DIR [--cache-dir DIR]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { readVolume } from '@neurodesk/synthsr';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { SYNTHSTRIP_MODEL } from '@neurodesk/synthstrip/model';
import { downloadModels } from '../src/node.js';
import { outputNames, writeOutputs } from '../src/outputs.js';

const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export async function webReference({ input, output, cacheDir }) {
  ort.env.wasm.numThreads = Math.min(4, availableParallelism());
  const { directory } = await downloadModels({ cacheDir });
  const model = await readFile(join(directory, SYNTHSTRIP_MODEL.filename));
  const result = await runSynthstrip({
    volume: readVolume(arrayBuffer(await readFile(input))),
    loadModel: async () => ({ bytes: model, hash: SYNTHSTRIP_MODEL.sha256 }),
    createSession: (bytes) => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
    Tensor: ort.Tensor,
  });
  const names = outputNames(basename(input), 'synthstrip');
  const files = writeOutputs(result);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, names.brain), new Uint8Array(files.brain));
  await writeFile(join(output, names.mask), new Uint8Array(files.mask));
  return { output, files: [names.brain, names.mask], threads: ort.env.wasm.numThreads };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'cache-dir': { type: 'string' } } });
  if (positionals.length !== 2) throw new Error('Usage: web-reference.mjs INPUT OUTPUT_DIR [--cache-dir DIR]');
  const [input, output] = positionals;
  console.log(JSON.stringify(await webReference({ input, output, cacheDir: values['cache-dir'] })));
}
