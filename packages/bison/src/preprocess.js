// BISON preprocessing in the order of validation/native/run_native.sh, with browser tools in place
// of the MINC ones: ANTs DenoiseImage for mincnlm, niimath -n4 for nu_correct, the volume_pol port,
// antsRegistration for bestlinreg_s2 and nlfit_s, and hmc --apply for mincresample and itk_resample.
// docs/preprocessing.md gives the mapping of every step and option.
//
// Pure: the tools are injected, so the browser worker and the command line run the same steps.
//   drivers.createRegistration() -> { run(argv, inputs) }            @neurodesk/hmc-registration
//   drivers.createDenoiser()     -> { denoise({ image, mask }) }     @neurodesk/ants-denoise
//   Both may add memoryBytes() and dispose() (node-workers.js): each stage ends its instance.
//   drivers.niimath(args, { inputs, outputs }) -> { outputs }        @niivue/niimath
// Hooks: onProgress(message), onLog(line), checkpoint(name, bytes) with every intermediate file.
import { createFloat32Nifti, decodeNiftiBuffer, extractNiftiHeader, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { AV_FLAIR, MODE_ASSETS, TEMPLATE_MASK, TEMPLATE_T1, sha256Hex } from './assets.js';
import {
  DEFAULT_SEED,
  affineArguments,
  applyTransforms,
  flairToT1,
  niftiName,
  nonlinearArguments,
  rigidArguments,
  runRegistration,
  templateToFlair,
  templateToT1,
  templateToT1Linear,
} from './register.js';
import { applyVolumePol, fitVolumePol } from './volume-pol.js';

// One kernel instance aborts on its 27th run (#537); load a new one well before.
export const REGISTRATION_RUNS_PER_INSTANCE = 20;

// N4 in place of nu_correct -iter 200 -distance 50 (defaults -fwhm 0.15, shrink 4, 200 bins, Wiener
// noise 0.01): N4's own four-level schedule, 50 iterations each with no early stop, from 200 mm knots
// to 25 mm. One level at nu_correct's 50 mm and -stop 0.001 stops early and leaves a field that
// brightens deep grey matter 7 % against N3 (docs/preprocessing.md#n4). -weight, not -mask: the field
// is fitted inside the mask and divides every voxel, and the result is not rescaled, as nu_correct does.
export const N4_OPTIONS = Object.freeze(['-shrink', '4', '-iter', '50x50x50x50', '-convergence', '0', '-bspline', '200', '-bins', '200', '-fwhm', '0.15', '-wiener', '0.01']);

export function n4Arguments({ input, weight, output }) {
  return [input, '-n4', '-weight', weight, ...N4_OPTIONS, output, '-odt', 'float'];
}

function hooksOf({ onProgress = () => {}, onLog = () => {}, checkpoint = async () => {} } = {}) {
  return { onProgress, onLog, checkpoint };
}

// Times each step; the result's timings hold seconds per step.
async function timed(timings, name, work) {
  const start = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = (performance.now() - start) / 1000;
  }
}

/** Float32 voxels, the header bytes and the parsed header of NIfTI bytes, gzipped or not. */
export async function readVolume(bytes, name = 'image') {
  const buffer = await decodeNiftiBuffer(bytes);
  const { data, header } = readNiftiImageData(buffer);
  const frames = header.dims.slice(4, Math.max(4, header.dims[0] + 1)).reduce((product, size) => product * Math.max(1, size), 1);
  if (header.dims[0] < 3 || frames !== 1) throw new Error(`The ${name} must be a single 3D volume.`);
  return { data, header, headerBytes: extractNiftiHeader(buffer) };
}

export function binaryMask(data) {
  return Uint8Array.from(data, (value) => (value > 0.5 ? 1 : 0));
}

function sameGrid(volume, reference, name) {
  if (volume.data.length !== reference.data.length) throw new Error(`${name} is not on the expected grid.`);
  return volume;
}

/**
 * A registration instance that is replaced after `limit` runs (#537) or after an abort.
 * run() has the instance's signature. dispose() ends the instance, where the driver can (a worker
 * thread), so its heap is freed; peakHeapBytes() is the largest heap an instance reported.
 */
export function registrationSession(createRegistration, limit = REGISTRATION_RUNS_PER_INSTANCE) {
  let instance = null;
  let runs = 0;
  let peak = null;
  const end = async () => {
    const ended = instance;
    instance = null;
    const heap = ended?.memoryBytes?.() ?? null;
    if (heap !== null) peak = Math.max(peak ?? 0, heap);
    await ended?.dispose?.();
  };
  return {
    async run(argv, inputs) {
      if (!instance || runs >= limit) {
        await end();
        instance = await createRegistration();
        runs = 0;
      }
      runs++;
      try {
        return await instance.run(argv, inputs);
      } catch (error) {
        if (error?.aborted) await end();
        throw error;
      }
    },
    dispose: end,
    peakHeapBytes: () => {
      const live = instance?.memoryBytes?.() ?? null;
      return live === null ? peak : Math.max(peak ?? 0, live);
    },
  };
}

/** ANTs DenoiseImage with the DenoiseImage defaults (Gaussian, patch 1, search 2, shrink 1), masked. */
export async function denoise({ image, mask, drivers, memory = {}, name = 'denoise' }) {
  const denoiser = await drivers.createDenoiser();
  try {
    return new Uint8Array(await denoiser.denoise({ image, mask }));
  } finally {
    const heap = denoiser.memoryBytes?.() ?? null;
    if (heap !== null) memory[name] = heap;
    await denoiser.dispose?.();
  }
}

/**
 * Runs work(session) on a new registrationSession and ends it afterwards, so a worker driver frees
 * the heap before the next stage. memory[name] is the stage's peak heap in bytes, when reported.
 */
export async function withSession(drivers, memory, name, work) {
  const session = registrationSession(() => drivers.createRegistration());
  try {
    return await work(session);
  } finally {
    await session.dispose();
    const heap = session.peakHeapBytes();
    if (heap !== null) memory[name] = heap;
  }
}

/** niimath -n4 with N4_OPTIONS; returns gzipped float32 NIfTI. */
export async function biasCorrect({ image, weight, drivers, onLog }) {
  const args = n4Arguments({ input: 'input.nii', weight: 'weight.nii', output: 'n4.nii.gz' });
  const { outputs, log } = await drivers.niimath(args, {
    inputs: { 'input.nii': new Uint8Array(await decodeNiftiBuffer(image)), 'weight.nii': new Uint8Array(await decodeNiftiBuffer(weight)) },
    outputs: ['n4.nii.gz'],
  });
  if (onLog) for (const line of log ?? []) onLog(line);
  return outputs['n4.nii.gz'];
}

/**
 * volume_pol --order 1 --noclamp with --source_mask and --target_mask: fit inside the masks, apply
 * to every voxel. Returns the float32 image and its NIfTI bytes on the source header.
 */
export async function normalise({ image, sourceMask, target, targetMask }) {
  const source = await readVolume(image, 'image to normalise');
  if (sourceMask.length !== source.data.length) throw new Error('The source mask is not on the image grid.');
  const fit = fitVolumePol({ source: source.data, sourceMask, target: target.data, targetMask, order: 1 });
  const data = applyVolumePol(source.data, fit.coefficients);
  return { ...fit, data, nifti: new Uint8Array(createFloat32Nifti(data, source.headerBytes)) };
}

const text = (value) => new TextEncoder().encode(`${value}\n`);

async function templateVolumes(assets) {
  const t1Bytes = assets.get(TEMPLATE_T1);
  const maskBytes = assets.get(TEMPLATE_MASK);
  if (!t1Bytes || !maskBytes) throw new Error('The ICBM 2009c template and mask are required.');
  const t1 = await readVolume(t1Bytes, 'template');
  const mask = sameGrid(await readVolume(maskBytes, 'template mask'), t1, 'The template mask');
  return { t1Bytes, maskBytes, t1, mask: binaryMask(mask.data) };
}

/**
 * The T1 steps: affine to the template, linear mask, denoise, N4, volume_pol, affine + SyN of the
 * normalised T1, and the classification mask.
 */
export async function preprocessT1({ t1, assets, drivers, seed = DEFAULT_SEED, timings = {}, memory = {}, ...options }) {
  const { onProgress, onLog, checkpoint } = hooksOf(options);
  const template = await templateVolumes(assets);
  const raw = await readVolume(t1, 'T1');
  const t1Name = niftiName('t1', t1);
  const templateName = niftiName('template', template.t1Bytes);

  onProgress('Registering T1 to the template (affine)');
  const { affine, linearMaskBytes } = await withSession(drivers, memory, 't1_linear', async (linear) => {
    const affine = await timed(timings, 't1_affine', async () => {
      const argv = affineArguments({ fixed: templateName, moving: t1Name, output: 'lin_', seed });
      const outputs = await runRegistration(linear, argv, { [templateName]: template.t1Bytes, [t1Name]: t1 }, ['lin_0GenericAffine.mat'], onLog);
      return outputs['lin_0GenericAffine.mat'];
    });
    const linearMaskBytes = await timed(timings, 't1_mask_lin', () => applyTransforms(linear, {
      fixed: t1, moving: template.maskBytes, interpolation: 'NearestNeighbor',
      transforms: templateToT1Linear({ affine: 'lin.mat' }), files: { 'lin.mat': affine }, onLog,
    }));
    return { affine, linearMaskBytes };
  });
  await checkpoint('T1toTemplate0GenericAffine.mat', affine);
  await checkpoint('T1_Mask.nii', linearMaskBytes);
  const linearMask = binaryMask(sameGrid(await readVolume(linearMaskBytes, 'linear mask'), raw, 'The linear mask').data);

  onProgress('Denoising T1');
  const denoised = await timed(timings, 't1_denoise', () => denoise({ image: t1, mask: linearMaskBytes, drivers, memory, name: 't1_denoise' }));
  await checkpoint('T1_NLM.nii', denoised);

  onProgress('Correcting T1 intensity non-uniformity');
  const corrected = await timed(timings, 't1_n4', () => biasCorrect({ image: denoised, weight: linearMaskBytes, drivers, onLog }));
  await checkpoint('T1_N4.nii.gz', corrected);

  onProgress('Normalising T1 intensities');
  const vp = await timed(timings, 't1_volume_pol', () => normalise({ image: corrected, sourceMask: linearMask, target: template.t1, targetMask: template.mask }));
  sameGrid(vp, raw, 'T1_VP');
  await checkpoint('T1_norm', text(vp.expression));
  await checkpoint('T1_VP.nii', vp.nifti);

  onProgress('Registering T1 to the template (affine + SyN)');
  const { transforms, maskNlBytes } = await withSession(drivers, memory, 't1_nonlinear', async (nonlinear) => {
    const transforms = await timed(timings, 't1_nonlinear', async () => {
      const argv = nonlinearArguments({ fixed: templateName, moving: 't1_vp.nii', initial: 'lin.mat', output: 'nl_', seed });
      const inputs = { [templateName]: template.t1Bytes, 't1_vp.nii': vp.nifti, 'lin.mat': affine };
      const outputs = await runRegistration(nonlinear, argv, inputs, ['nl_0GenericAffine.mat', 'nl_1Warp.nii.gz', 'nl_1InverseWarp.nii.gz'], onLog);
      return { affine: outputs['nl_0GenericAffine.mat'], warp: outputs['nl_1Warp.nii.gz'], inverseWarp: outputs['nl_1InverseWarp.nii.gz'] };
    });
    const maskNlBytes = await timed(timings, 'mask_nl', () => warpTemplateImage(nonlinear, { grid: vp.nifti, image: template.maskBytes, transforms, interpolation: 'NearestNeighbor', onLog }));
    return { transforms, maskNlBytes };
  });
  await checkpoint('T1toTemplate_pp0GenericAffine.mat', transforms.affine);
  await checkpoint('T1toTemplate_pp1Warp.nii.gz', transforms.warp);
  await checkpoint('T1toTemplate_pp1InverseWarp.nii.gz', transforms.inverseWarp);
  await checkpoint('Mask_nl.nii', maskNlBytes);
  const mask = binaryMask(sameGrid(await readVolume(maskNlBytes, 'classification mask'), raw, 'The classification mask').data);

  return { raw, affine, linearMask, linearMaskBytes, vp, transforms, mask, maskBytes: maskNlBytes, timings, memory };
}

/** A template-space image on the T1 grid through the full (affine + SyN) transform. */
export function warpTemplateImage(session, { grid, image, transforms, interpolation = 'BSpline[2]', onLog }) {
  return applyTransforms(session, {
    fixed: grid, moving: image, interpolation,
    transforms: templateToT1({ affine: 'nl.mat', inverseWarp: 'nl_inverse.nii.gz' }),
    files: { 'nl.mat': transforms.affine, 'nl_inverse.nii.gz': transforms.inverseWarp },
    onLog,
  });
}

/**
 * Template-space images (priors, Av_T1, Av_FLAIR) on the T1 grid with BSpline[2], as itk_resample
 * does. Identical inputs are resampled once. Returns name -> Float32Array.
 */
export async function warpTemplateImages({ drivers, grid, images, transforms, timings = {}, memory = {}, ...options }) {
  const { onProgress, onLog, checkpoint } = hooksOf(options);
  return withSession(drivers, memory, 'warp', async (session) => {
    const byDigest = new Map();
    const result = new Map();
    for (const [name, bytes] of images) {
      const digest = await sha256Hex(bytes);
      if (!byDigest.has(digest)) {
        onProgress(`Resampling ${name} to the T1`);
        const resampled = await timed(timings, `warp_${name}`, () => warpTemplateImage(session, { grid, image: bytes, transforms, onLog }));
        byDigest.set(digest, (await readVolume(resampled, name)).data);
        await checkpoint(`${name}.nii`, resampled);
      }
      result.set(name, byDigest.get(digest));
    }
    return result;
  });
}

/**
 * The FLAIR steps: rigid to the T1, FLAIR mask through the linear transforms, denoise, N4,
 * volume_pol to Av_FLAIR, and FLAIR_VP on the T1 grid (linear interpolation).
 */
export async function preprocessFlair({ flair, t1, t1Affine, assets, drivers, seed = DEFAULT_SEED, timings = {}, memory = {}, ...options }) {
  const { onProgress, onLog, checkpoint } = hooksOf(options);
  const template = await templateVolumes(assets);
  const avFlairBytes = assets.get(AV_FLAIR);
  if (!avFlairBytes) throw new Error('Av_FLAIR is required for the T1 + FLAIR mode.');
  const avFlair = sameGrid(await readVolume(avFlairBytes, 'Av_FLAIR'), template.t1, 'Av_FLAIR');
  const raw = await readVolume(flair, 'FLAIR');
  const t1Raw = await readVolume(t1, 'T1');
  const t1Name = niftiName('t1', t1);
  const flairName = niftiName('flair', flair);

  onProgress('Registering FLAIR to T1 (rigid)');
  const { rigid, maskBytes } = await withSession(drivers, memory, 'flair_linear', async (session) => {
    const rigid = await timed(timings, 'flair_rigid', async () => {
      const argv = rigidArguments({ fixed: t1Name, moving: flairName, output: 'rigid_', seed });
      const outputs = await runRegistration(session, argv, { [t1Name]: t1, [flairName]: flair }, ['rigid_0GenericAffine.mat'], onLog);
      return outputs['rigid_0GenericAffine.mat'];
    });
    const maskBytes = await timed(timings, 'flair_mask_lin', () => applyTransforms(session, {
      fixed: flair, moving: template.maskBytes, interpolation: 'NearestNeighbor',
      transforms: templateToFlair({ t1Affine: 'lin.mat', rigid: 'rigid.mat' }), files: { 'lin.mat': t1Affine, 'rigid.mat': rigid }, onLog,
    }));
    return { rigid, maskBytes };
  });
  await checkpoint('FLAIRtoT10GenericAffine.mat', rigid);
  await checkpoint('FLAIR_Mask.nii', maskBytes);
  const mask = binaryMask(sameGrid(await readVolume(maskBytes, 'FLAIR mask'), raw, 'The FLAIR mask').data);

  onProgress('Denoising FLAIR');
  const denoised = await timed(timings, 'flair_denoise', () => denoise({ image: flair, mask: maskBytes, drivers, memory, name: 'flair_denoise' }));
  await checkpoint('FLAIR_NLM.nii', denoised);

  onProgress('Correcting FLAIR intensity non-uniformity');
  const corrected = await timed(timings, 'flair_n4', () => biasCorrect({ image: denoised, weight: maskBytes, drivers, onLog }));
  await checkpoint('FLAIR_N4.nii.gz', corrected);

  onProgress('Normalising FLAIR intensities');
  const vp = await timed(timings, 'flair_volume_pol', () => normalise({ image: corrected, sourceMask: mask, target: avFlair, targetMask: template.mask }));
  await checkpoint('FLAIR_norm', text(vp.expression));
  await checkpoint('FLAIR_VP.nii', vp.nifti);

  const crBytes = await withSession(drivers, memory, 'flair_resample', (session) => timed(timings, 'flair_resample', () => applyTransforms(session, {
    fixed: t1, moving: vp.nifti, interpolation: 'Linear',
    transforms: flairToT1({ rigid: 'rigid.mat' }), files: { 'rigid.mat': rigid }, onLog,
  })));
  await checkpoint('FLAIR_CR.nii', crBytes);
  const cr = sameGrid(await readVolume(crBytes, 'FLAIR on the T1 grid'), t1Raw, 'FLAIR_CR');
  return { rigid, mask, maskBytes, vp, flair: cr.data, timings, memory };
}

/**
 * Everything the classifier needs for `modes` ('t1', 't1-flair'), on the T1 grid:
 * { header, mask, t1, avT1, priors: { [mode]: Float32Array[] }, flair?, avFlair?, volumePol, timings }.
 * `assets` maps manifest filenames to verified bytes (assets.js).
 */
export async function preprocess({ t1, flair = null, modes, assets, drivers, seed = DEFAULT_SEED, ...options }) {
  const hooks = hooksOf(options);
  const withFlair = modes.includes('t1-flair');
  if (withFlair && !flair) throw new Error('The T1 + FLAIR mode needs a FLAIR image.');
  const timings = {};
  const memory = {};
  const t1Steps = await preprocessT1({ t1, assets, drivers, seed, timings, memory, ...hooks });

  const images = [['av_t1', assets.get(TEMPLATE_T1)]];
  if (withFlair) images.push(['av_flair', assets.get(AV_FLAIR)]);
  for (const mode of modes) {
    MODE_ASSETS[mode].priors.forEach((filename, k) => {
      const bytes = assets.get(filename);
      if (!bytes) throw new Error(`${filename} is required for the ${mode} mode.`);
      images.push([`${mode}/sp_${k + 1}`, bytes]);
    });
  }
  const warped = await warpTemplateImages({ drivers, grid: t1Steps.vp.nifti, images, transforms: t1Steps.transforms, timings, memory, ...hooks });

  const result = {
    header: t1Steps.raw.headerBytes,
    mask: t1Steps.mask,
    t1: t1Steps.vp.data,
    avT1: warped.get('av_t1'),
    priors: Object.fromEntries(modes.map((mode) => [mode, MODE_ASSETS[mode].priors.map((_, k) => warped.get(`${mode}/sp_${k + 1}`))])),
    volumePol: { t1: { coefficients: t1Steps.vp.coefficients, expression: t1Steps.vp.expression } },
    timings,
    memory,
  };
  if (withFlair) {
    const flairSteps = await preprocessFlair({ flair, t1, t1Affine: t1Steps.affine, assets, drivers, seed, timings, memory, ...hooks });
    result.flair = flairSteps.flair;
    result.avFlair = warped.get('av_flair');
    result.volumePol.flair = { coefficients: flairSteps.vp.coefficients, expression: flairSteps.vp.expression };
  }
  return result;
}
