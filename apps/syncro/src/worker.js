// SYNcro in the browser: the Rust core (exes/syncro, WebAssembly) decides every step, exactly as the native
// command does; this worker owns the files and runs each tool command on its browser driver
// (@neurodesk/pipeline-drivers), one at a time.
import { createRegistration } from '@neurodesk/registration';
import { loadGreedy } from '@neurodesk/greedy';
import { Files } from '@neurodesk/pipeline-drivers/files';
import { createHost } from '@neurodesk/pipeline-drivers/host';
import { antsDrivers, greedyDriver, mindgrabDriver, niimathDriver, synthsrDriver } from '@neurodesk/pipeline-drivers/drivers';
import { readVolume, writeVolume } from '@neurodesk/synthsr';
import initCore, { runSyncro } from '@neurodesk/syncro/core';

const sha = async (buffer) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
  (value) => value.toString(16).padStart(2, '0'),
).join('');
const progress = (stage, value, message) => self.postMessage({ type: 'progress', stage, value, message });
const log = (message) => self.postMessage({ type: 'log', message });
const asBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// A fresh worker per neural network releases ORT's WebAssembly arena between stages.
function infer(job, onProgress) {
  return new Promise((resolve, reject) => {
    const child = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      child.terminate();
      error ? reject(error) : resolve(result);
    };
    child.onerror = (event) => finish(new Error(event.message || 'Inference worker failed.'));
    child.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.value, data.message);
      else if (data.type === 'log') self.postMessage(data);
      else if (data.type === 'error') finish(new Error(data.message));
      else if (data.type === 'result') finish(null, data.result);
    };
    child.postMessage(job);
  });
}

// Each runtime starts when its first command needs it.
function once(load) {
  let promise;
  return () => (promise ??= load());
}

function drivers(job, threads, runtime) {
  const greedy = once(() => {
    log(`Starting ${threads} Greedy CPU workers`);
    return loadGreedy(job.greedyURL, threads);
  });
  // The drivers call the Greedy exports by name; each call waits for the module.
  const greedyApi = new Proxy({}, { get: (_, name) => async (...args) => (await greedy())[name](...args) });
  const niimath = once(async () => (await import(/* @vite-ignore */ job.niimathURL)).default);
  const kernel = once(async () => {
    const { default: createModule } = await import(/* @vite-ignore */ job.registrationURL);
    return createRegistration({ createModule, onLog: log });
  });
  return {
    niimath: niimathDriver(async (options) => (await niimath())(options)),
    'greedy-rs': greedyDriver(greedyApi),
    synthsr: synthsrDriver(async (bytes, { ct }) => {
      const result = await infer(
        { stage: 'synthsr', buffer: asBuffer(bytes), ct, backend: job.synthsrBackend ?? 'webgpu', modelBase: job.modelBase },
        (value, message) => progress('synthsr', value, message),
      );
      runtime.synthsr = result.provenance;
      return new Uint8Array(result.buffer);
    }),
    'brainchop-mindgrab': mindgrabDriver({
      async segment(bytes) {
        const result = await infer(
          { stage: 'mindgrab', volume: readVolume(asBuffer(bytes)), assetPath: job.mindgrabAssetPath, brainBackend: job.mindgrabBackend ?? 'auto' },
          (value, message) => progress('mindgrab', value, message),
        );
        runtime.mindgrab = result.provenance;
        return { image: writeVolume(result.brain, 'MindGrab brain'), mask: writeVolume(result.mask, 'MindGrab mask') };
      },
    }),
    ...antsDrivers(kernel),
  };
}

self.onmessage = async ({ data: job }) => {
  try {
    if (!self.crossOriginIsolated) throw new Error('Reload this page to enable isolated WebAssembly processing.');
    const templateResponse = await fetch(job.templateURL);
    if (!templateResponse.ok) throw new Error('Could not load the MNI template.');
    const template = new Uint8Array(await templateResponse.arrayBuffer());
    // Some static servers mark .nii.gz as Content-Encoding: gzip, so fetch
    // returns the decompressed NIfTI. Both representations are independently pinned.
    const templateHash = await sha(template);
    const templateRepresentations = {
      '32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212': 3219212,
      '18576c0190c0f6496f3d4a6bf40cfd6e9cddb4b6eaa8517bb0af2b88ff67c0c5': 14442416,
    };
    if (templateRepresentations[templateHash] !== template.byteLength) throw new Error('MNI template checksum mismatch.');
    const files = new Files();
    const templatePath = template[0] === 0x1f && template[1] === 0x8b ? 'template/MNI152_T1_1mm_brain.nii.gz' : 'template/MNI152_T1_1mm_brain.nii';
    files.put(templatePath, template);
    const place = (file) => {
      if (!file) return undefined;
      files.put(`in/${file.name}`, file);
      return `in/${file.name}`;
    };
    const threads = Math.min(8, navigator.hardwareConcurrency || 1);
    const runtime = {};
    const host = createHost(files, drivers(job, threads, runtime), { onLog: log, onStep: (argv) => log(`$ ${argv.join(' ')}`) });
    await initCore();
    const provenance = JSON.parse(await runSyncro(host, {
      input: place(job.input),
      lesion: place(job.lesion),
      pathological: place(job.pathological),
      template: templatePath,
      out: '',
      work: 'work',
      ct: job.ct,
      normalization: job.normalization,
      threads,
      keepSynth: job.keepSynth,
      software: { host: 'browser' },
    }, (stage) => progress(stage, 0)));
    // The browser runtimes' own provenance, in the shape the web app has always written.
    provenance.stages = {
      synthsr: runtime.synthsr,
      mindgrab: runtime.mindgrab,
      registration: job.normalization === 'ants'
        ? { engine: 'ANTs 2.6.2', method: 'SyN', seed: 42, precision: 'float', threads: 1 }
        : { engine: 'Greedy', method: 'affine + NMI stationary velocity field', threads },
    };
    const outputs = {};
    for (const name of provenance.outputs) outputs[name] = (await files.bytes(name)).slice();
    outputs['commands.sh'] = (await files.bytes('work/commands.sh')).slice();
    outputs['provenance.json'] = new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}\n`);
    progress('complete', 1, 'Normalization complete');
    self.postMessage({ type: 'result', outputs, provenance }, Object.values(outputs).map((bytes) => bytes.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
