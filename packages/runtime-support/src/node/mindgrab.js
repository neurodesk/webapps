// Runs @brainchop/mindgrab's threaded CPU modules under Node.
//
// The published wrapper only runs in a browser: its CPU path refuses unless the
// page is cross-origin isolated. The CPU modules themselves are Emscripten
// pthread builds whose glue already runs on Node's worker_threads, with the
// model weights compiled into the .wasm. This driver calls them the way the
// wrapper's run() does (write /in.nii, callMain with the wrapper's argv, wait
// for exit, read the outputs), one run per worker thread. Option names,
// validation and results follow segment() and segmentTissues(), so code written
// against the wrapper can take either. The caller passes the package it pins,
// so a command line runs the same modules as its web app.

import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { gunzipSync, gzipSync } from 'node:zlib';

const TISSUE_OUTPUTS = ['/out_wm.nii', '/out_csf.nii', '/out_brain.nii'];

// One run holds 2.6-3.9 GB and a thread per core, so runs in this process queue.
let previousRun = Promise.resolve();

/**
 * @param {string | URL} packageJsonUrl the pinned package, e.g. `import.meta.resolve('@brainchop/mindgrab/package.json')`
 */
export async function loadMindgrabCpu(packageJsonUrl) {
  const { version } = JSON.parse(await readFile(new URL(packageJsonUrl), 'utf8'));
  const { MODELS, BrainchopError } = await import(new URL('dist/index.js', packageJsonUrl).href);

  const reject = (model, option, why) => {
    throw new BrainchopError('unsupported-option', `${model} does not support \`${option}\`: ${why}`);
  };

  // The wrapper's buildArgs(), which it does not export.
  function buildArgs(options) {
    const model = Object.hasOwn(MODELS, options.model) ? MODELS[options.model] : undefined;
    if (!model) {
      throw new BrainchopError('unsupported-option', `unknown model '${options.model}'; expected one of ${Object.keys(MODELS).join(', ')}`);
    }
    const args = [];
    if (options.ct) args.push('--ct');
    if (options.comply) args.push('--comply');
    if (options.legacyCleanup) {
      if (options.model !== 'mindmap') reject(options.model, 'legacyCleanup', 'this compatibility option is only for MindMap');
      args.push('--legacy-cleanup');
    }
    if (options.saveConform) {
      if (!model.capabilities.saveConform) reject(options.model, 'saveConform', 'its output is the input image with non-brain voxels floored, so it is inherently in the input space');
      args.push('--save-conform');
    }
    if (options.borderMm !== undefined && !model.capabilities.border) reject(options.model, 'borderMm', 'a mask border is only meaningful for a mask model');
    if (options.mask && !model.capabilities.mask) reject(options.model, 'mask', 'a brain mask is only meaningful for a mask model');
    let maskPath;
    if (options.mask || options.borderMm !== undefined) {
      maskPath = '/mask.nii';
      args.push('--mask', maskPath);
    }
    if (options.borderMm !== undefined) {
      if (!Number.isFinite(options.borderMm) || options.borderMm < 0) {
        throw new BrainchopError('unsupported-option', `borderMm must be a non-negative number, got ${options.borderMm}`);
      }
      args.push('--border', String(options.borderMm));
    }
    return { args, maskPath };
  }

  function run({ model, args, input, primaryOutput, extraOutputs, onLog }) {
    const log = [];
    const worker = new Worker(new URL('./mindgrab-worker.js', import.meta.url), {
      workerData: {
        moduleUrl: new URL(`dist/brainchop-${model}.js`, packageJsonUrl).href,
        model,
        args,
        input,
        outputs: [primaryOutput, ...extraOutputs],
      },
    });
    return new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (message.type === 'log') {
          log.push(message.line);
          onLog?.(message.line);
          return;
        }
        void worker.terminate();
        const { code, files, elapsedMs } = message;
        if (code !== 0) {
          reject(new BrainchopError('inference-failed', `the ${model} module exited with status ${code}`, log));
        } else if (!files[primaryOutput]) {
          reject(new BrainchopError('inference-failed', `the ${model} module exited cleanly but wrote no output`, log));
        } else {
          resolve({ image: files[primaryOutput], extras: new Map(Object.entries(files)), elapsedMs });
        }
      });
      worker.on('error', error => reject(new BrainchopError('inference-failed', `the ${model} module failed: ${error.message}`, log)));
      worker.on('exit', code => reject(new BrainchopError('inference-failed', `the ${model} worker stopped with ${code} before finishing`, log)));
    });
  }

  async function segmentInternal(input, options, tissueMode) {
    const raw = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (raw.byteLength === 0) throw new BrainchopError('bad-input', 'the input is empty');
    if (options.device || options.glContext || (options.backend && !['auto', 'cpu'].includes(options.backend))) {
      throw new BrainchopError('unsupported-option', 'the Node driver runs only the cpu backend');
    }
    const { args, maskPath } = buildArgs(options);
    if (tissueMode) {
      if ((options.model !== 'mindmap' && options.model !== '16chan18cls') || options.mask || options.borderMm || options.legacyCleanup) {
        reject(options.model, 'tissue fractions', 'requires an 18-class model without mask or categorical cleanup options');
      }
      args.push('--pve');
    }
    const compressed = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    const wantGzip = options.gzipOutput ?? compressed;
    const turn = previousRun.then(() => run({
      model: options.model,
      args,
      input: compressed ? gunzipSync(raw) : raw,
      primaryOutput: tissueMode ? '/out_gm.nii' : '/out.nii',
      extraOutputs: tissueMode ? TISSUE_OUTPUTS : maskPath ? [maskPath] : [],
      onLog: options.onLog,
    }));
    previousRun = turn.catch(() => {});
    const result = await turn;
    const pack = data => (wantGzip ? gzipSync(data) : data).slice().buffer;
    const segmented = { image: pack(result.image), elapsedMs: result.elapsedMs, backend: 'cpu', ranInWorker: false };
    const mask = maskPath ? result.extras.get(maskPath) : undefined;
    if (mask) segmented.mask = pack(mask);
    if (tissueMode) {
      const [wm, csf, brain] = TISSUE_OUTPUTS.map(path => result.extras.get(path));
      if (!wm || !csf || !brain) throw new BrainchopError('inference-failed', 'missing WM/CSF/brain output');
      segmented.tissues = { gm: segmented.image, wm: pack(wm), csf: pack(csf), brain: pack(brain) };
    }
    return segmented;
  }

  return {
    version,
    MODELS,
    segment: (input, options) => segmentInternal(input, options, false),
    async segmentTissues(input, options) {
      const { tissues, elapsedMs, backend, ranInWorker } = await segmentInternal(input, options, true);
      return { tissues, elapsedMs, backend, ranInWorker };
    },
  };
}
