// The SyN-SDC pipeline on the web app's browser runtimes (src/syn/browser.js): the registration,
// DenoiseImage and N4 kernels in module workers and MindGrab's published wrapper in its worker,
// held to its CPU backend so the result does not depend on the machine's GPU.
import { brainMask } from '@neurodesk/runtime-support/mindgrab';
import registrationWorker from '@neurodesk/hmc-registration/worker?worker&url';
import denoiseWorker from '@neurodesk/ants-denoise/worker?worker&url';
import { correctSusceptibility } from '../../src/syn/pipeline.js';
import { browserRuntime } from '../../src/syn/browser.js';
import n4Worker from '../../src/syn/n4-worker.js?worker&url';
import fieldFit from '../../src/sdc-field-fit.wasm?url';

const input = async (name) => new Uint8Array(await (await fetch(`/input/${name}`)).arrayBuffer());
const text = async (name) => new TextDecoder().decode(await input(name));

globalThis.runCase = async ({ id, dwi, t1w }) => {
  const runtime = await browserRuntime({
    registrationWorker,
    denoiseWorker,
    n4Worker,
    n4Kernel: { module: new URL('/n4/n4-bias.mjs', location.href).href, wasm: new URL('/n4/n4-bias.wasm', location.href).href },
    fieldFit,
    mindgrab: async (bytes, { signal } = {}) => (await brainMask(bytes, { assetPath: '/brainchop/', backend: 'cpu', signal })).mask,
  });
  const stem = dwi.replace(/\.nii\.gz$/, '');
  const result = await correctSusceptibility({
    dwi: await input(dwi),
    bval: await text(`${stem}.bval`),
    bvec: await text(`${stem}.bvec`),
    sidecar: JSON.parse(await text(`${stem}.json`)),
    fileName: dwi,
    t1w: await input(t1w),
    epiMask: null,
    t1wMask: null,
    prior: null,
    runtime,
  });
  for (const [name, bytes] of Object.entries(result.files)) {
    const response = await fetch(`/result/${id}/${name}`, { method: 'POST', body: bytes });
    if (!response.ok) throw new Error(`Could not post ${name}`);
  }
  return { files: Object.keys(result.files) };
};
