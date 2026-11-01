// SPDX-License-Identifier: Apache-2.0
// SyN-SDC (sdcflows 2.17.1 init_syn_preprocessing_wf + init_syn_sdc_wf, as fMRIPrep wires them)
// for one DWI series, for the web app and the command line alike. The hosts inject their
// runtimes, as packages/brain2print does:
//
//   runtime.spawn()          a @neurodesk/hmc-registration kernel worker (antsRegistration,
//                            antsApplyTransforms, ImageMath Laplacian), as @neurodesk/hmc's pool drives it
//   runtime.workers          kernel workers to run at once (2 lets epi2anat and the MNI affine overlap)
//   runtime.denoise(bytes, { signal })   ANTs DenoiseImage -n Gaussian -s 1 (@neurodesk/ants-denoise)
//   runtime.n4(bytes, { signal })        N4 with the EPI-reference settings (@neurodesk/n4)
//   runtime.mindgrab(bytes, { signal })  a MindGrab ('mindgrab') brain mask; needed without uploaded masks
//   runtime.fieldFit         the API of loadFieldFit (@neurodesk/sdc/field-fit)
//   runtime.gzip(bytes)      gzip for the outputs
//
// The changes from sdcflows are the plan's (docs/architecture/dwi-sdc-plan.md): the EPI
// reference is the mean of the b0 volumes, MindGrab replaces BrainExtraction (Q52, Q61), the
// T1w-to-MNI transform is an affine registration in the kernel (Q59), the SyN grid is 1.2 mm
// (Q68), every antsRegistration runs --float 1 with a fixed --random-seed (Q53), and the whole
// series is unwarped once with the Jacobian factor (Q63).
import { parseBval } from '@neurodesk/webapp-components/file-io/gradients';
import { meanVolumes } from '@neurodesk/webapp-components/volume/mean';
import { createRegistrationPool } from '@neurodesk/hmc/pool';
import { acquisition } from './acquisition.js';
import { flipVolume, OBLIQUE_THRESHOLD_DEG, obliquity, positiveCosines, restrictDeformation, samplingReference, synParameters } from './grid.js';
import { copyGeometry, displacementNifti, gridHeader, readImage, writeLike } from './nifti.js';
import { advancedClip, dilateBall, int16RoundTrip, normalizeLaplacian } from './numerics.js';
import { dwiSidecar, fieldSidecar, outputNames, sidecarText } from './outputs.js';
import { unwarpSeries } from './unwarp.js';

export { acquisition, DIRECTIONS } from './acquisition.js';
export { outputNames } from './outputs.js';

/** The SyN grid of plan Q68 (decided on #462): 1.2 mm. */
export const SYN_GRID_MM = 1.2;
/** A volume with b below this (s/mm²) is a b0, as in the reference's mean_b0.py and the DWI apps. */
export const B0_THRESHOLD = 50;
/** The seed of the reference runs (plan section 6.1). */
export const DEFAULT_SEED = 1234;
/** sdcflows' prior threshold: average distortion above 3 mm (init_syn_preprocessing_wf atlas_threshold). */
export const ATLAS_THRESHOLD = 3;
/** sdcflows data/sd_syn.json: per level [gradient step, update field variance, total field variance in mm]. */
const SYN_TRANSFORM_PARAMETERS = [[0.8, 6.0, 10.0], [0.8, 2.0, 0.5]];

/** The pinned prior files (models/sdc.manifest.json, sdc/prior/ on the dataset). */
export const PRIOR_FILES = Object.freeze({
  atlas: 'fmap_atlas.nii.gz',
  atlasToTemplate: 'fmap_atlas_2_MNI152NLin2009cAsym_affine.mat',
  template: 'tpl-MNI152NLin2009cAsym_res-01_T1w.nii.gz',
  templateMask: 'tpl-MNI152NLin2009cAsym_res-01_desc-brain_mask.nii.gz',
});

/** The error a cancelled run rejects with when the signal gives no reason. */
export function cancelled() {
  return new DOMException('Susceptibility distortion correction cancelled.', 'AbortError');
}

/** A Python float's repr for the argv numbers nipype renders (6.0, not 6). */
const pyFloat = (value) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** sdcflows data/affine.json (epi2anat and the Q59 affine), as nipype renders it, plus --float 1 and the seed. */
export function affineArguments({ fixed, moving, output, seed, fixedMask = null, movingMask = null }) {
  const masks = (moving) => (fixedMask ? ['--masks', `[${fixedMask},${moving ?? 'NULL'}]`] : []);
  return [
    '--collapse-output-transforms', '1', '--dimensionality', '3', '--float', '1', '--random-seed', String(seed),
    '--initial-moving-transform', `[${fixed},${moving},1]`,
    '--initialize-transforms-per-stage', '0', '--interpolation', 'Linear', '--output', `[${output}]`,
    '--transform', 'Rigid[2.0]', '--metric', `Mattes[${fixed},${moving},1,32,Regular,1]`,
    '--convergence', '[1000x0,1e-06,10]', '--smoothing-sigmas', '6.0x0.0mm', '--shrink-factors', '4x1',
    '--use-histogram-matching', '1', ...masks(null),
    '--transform', 'Affine[1.0]', '--metric', `Mattes[${fixed},${moving},1,32,Random,0.4]`,
    '--convergence', '[250x100,1e-07,5]', '--smoothing-sigmas', '2.0x1.0vox', '--shrink-factors', '2x1',
    '--use-histogram-matching', '1', ...masks(movingMask),
    '--winsorize-image-intensities', '[0.001,0.998]', '--write-composite-transform', '0',
  ];
}

/** sdcflows data/sd_syn.json as nipype renders it for these images, plus --float 1 and the seed. */
export function synArguments({ seed, restrict, parameters }) {
  const deformation = restrict.map(pyFloat).join('x');
  const [first, second] = parameters.map((level) => `SyN[${level.map(pyFloat).join(',')}]`);
  return [
    '--collapse-output-transforms', '1', '--dimensionality', '3', '--float', '1', '--random-seed', String(seed),
    '--initialize-transforms-per-stage', '0', '--interpolation', 'Linear', '--output', 'fmap_syn',
    '--transform', first,
    '--metric', 'Mattes[anat_ref.nii,epi_clip.nii,0.9,48,Random,0.8]',
    '--metric', 'Mattes[anat_lap.nii,epi_lap.nii,0.1,48,Random,0.8]',
    '--convergence', '[200x100,1e-06,5]', '--smoothing-sigmas', '2.0x0.0vox', '--shrink-factors', '1x1',
    '--use-histogram-matching', '1', '--restrict-deformation', deformation, '--masks', '[anat_mask.nii,NULL]',
    '--transform', second,
    '--metric', 'Mattes[anat_ref.nii,epi_clip.nii,0.8,48]',
    '--metric', 'Mattes[anat_lap.nii,epi_lap.nii,0.2,48]',
    '--convergence', '[10,1e-08,2]', '--smoothing-sigmas', '0.0vox', '--shrink-factors', '1',
    '--use-histogram-matching', '1', '--restrict-deformation', deformation, '--masks', '[sd_prior.nii,epi_umask.nii]',
    '--winsorize-image-intensities', '[0.001,0.998]', '--write-composite-transform', '0',
  ];
}

/** niworkflows FixHeaderApplyTransforms' argv (nipype defaults: --default-value 0 --float 0). */
function applyArguments({ input, reference, output, interpolation, transforms, outputType = null }) {
  return [
    'antsApplyTransforms',
    ...(outputType ? ['-u', outputType] : []),
    '--default-value', '0', '--float', '0', '--input', input, '--interpolation', interpolation,
    '--output', output, '--reference-image', reference,
    ...transforms.flatMap((transform) => ['--transform', transform]),
  ];
}

const gzipped = (bytes) => bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
const niftiName = (stem, bytes) => `${stem}${gzipped(bytes) ? '.nii.gz' : '.nii'}`;
const binary = (values, threshold = 0) => Uint8Array.from(values, (value) => (value > threshold ? 1 : 0));

function sameGrid(a, b, what) {
  const close = a.affine.every((row, i) => row.every((value, j) => Math.abs(value - b.affine[i][j]) < 1e-4));
  if (a.dims.some((n, i) => n !== b.dims[i]) || !close) throw new Error(`${what} is not on the grid of its image.`);
}

/**
 * Estimates the susceptibility field of one DWI series with SyN-SDC and unwarps the series.
 *
 * @param {object} options
 * @param {Uint8Array} options.dwi the 4D NIfTI (gzipped or not)
 * @param {string} options.bval the bval text
 * @param {string} options.bvec the bvec text, passed through unchanged
 * @param {object | null} [options.sidecar] the DWI JSON sidecar
 * @param {string} options.fileName the DWI file name, for the output names
 * @param {Uint8Array} options.t1w the T1w NIfTI
 * @param {Uint8Array | null} [options.epiMask] a brain mask on the DWI grid (else MindGrab of the mean b0)
 * @param {Uint8Array | null} [options.t1wMask] a brain mask on the T1w grid (else MindGrab of the T1w)
 * @param {string} [options.phaseEncodingDirection] overrides the sidecar's
 * @param {number} [options.totalReadoutTime] overrides the sidecar's, in seconds
 * @param {Record<string, Uint8Array> | null} options.prior the PRIOR_FILES, or null for "no prior"
 * @param {number} [options.seed] the antsRegistration --random-seed
 * @param {object} options.runtime see the header of this module
 * @param {AbortSignal} [options.signal]
 * @param {(event: { stage: string, done?: number, total?: number }) => void} [options.onProgress]
 * @returns {Promise<{ files: Record<string, Uint8Array>, names: object, field: Float32Array, provenance: object }>}
 */
export async function correctSusceptibility({
  dwi,
  bval,
  bvec,
  sidecar = null,
  fileName,
  t1w,
  epiMask = null,
  t1wMask = null,
  phaseEncodingDirection,
  totalReadoutTime,
  prior,
  seed = DEFAULT_SEED,
  runtime,
  signal,
  onProgress,
}) {
  signal?.throwIfAborted();
  if (!t1w) throw new Error('SyN-SDC needs a T1-weighted image of the same session; none was given.');
  if (prior === undefined) throw new Error('Give the prior files, or prior: null for "no prior".');
  if (prior) {
    for (const name of Object.values(PRIOR_FILES)) if (!prior[name]) throw new Error(`The prior file ${name} is missing.`);
  }
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) throw new Error('The seed must be a whole number from 1 to 2147483647.');
  const progress = (stage) => {
    signal?.throwIfAborted();
    onProgress?.({ stage });
  };

  const series = await readImage(dwi);
  const { dims, frames } = series;
  const voxels = dims[0] * dims[1] * dims[2];
  const acq = acquisition(sidecar, dims, { phaseEncodingDirection, totalReadoutTime });
  if (obliquity(series.affine) >= OBLIQUE_THRESHOLD_DEG) {
    throw new Error(`The DWI grid is oblique (${obliquity(series.affine).toFixed(2)}°). sdcflows deobliques it first; this port does not, so reslice the series to a plumb grid first.`);
  }
  const bvals = parseBval(bval);
  if (bvals.length !== frames) throw new Error(`The image has ${frames} volumes but the bval file lists ${bvals.length}.`);
  const b0 = bvals.flatMap((b, v) => (b < B0_THRESHOLD ? [v] : []));
  if (!b0.length) throw new Error(`The bval file lists no b0 volume (b < ${B0_THRESHOLD} s/mm²).`);

  const anat = await readImage(t1w);
  if (anat.frames !== 1) throw new Error('The T1w must be a single 3D volume.');
  const pool = createRegistrationPool({ spawn: runtime.spawn, workers: runtime.workers ?? 1, signal, kernel: runtime.kernel });
  const ants = async (argv, inputs, outputs) => {
    const result = await pool.run({ argv, inputs });
    for (const name of outputs) if (!result.outputs[name]) throw new Error(`${argv[0]} wrote no ${name}.`);
    return result.outputs;
  };

  try {
    // The EPI reference (niworkflows init_epi_reference_wf on the 3D mean b0).
    progress('reference');
    const mean = meanVolumes(series.data, voxels, b0);
    const meanBytes = writeLike(series, mean, dims);
    const clipAvg = writeLike(series, advancedClip(mean, dims, { pMin: 35, pMax: 99.98 }), dims);
    const n4 = await readImage(await runtime.n4(clipAvg, { signal }), Float64Array);
    const epiRef = writeLike(series, advancedClip(int16RoundTrip(n4.data), dims, { pMin: 2, pMax: 100 }), dims);
    const epi = await readImage(epiRef);

    // Brain masks: uploaded, or MindGrab of the mean b0 and of the T1w (Q52, Q61).
    progress('masks');
    const epiMaskBytes = epiMask ?? new Uint8Array(await runtime.mindgrab(meanBytes, { signal }));
    const anatMaskBytes = t1wMask ?? new Uint8Array(await runtime.mindgrab(t1w, { signal }));
    const epiMaskImage = await readImage(epiMaskBytes);
    const anatMaskImage = await readImage(anatMaskBytes);
    sameGrid(epiMaskImage, series, 'The DWI brain mask');
    sameGrid(anatMaskImage, anat, 'The T1w brain mask');

    // The anatomical reference: masked, clipped and denoised T1w.
    progress('anatomical');
    const anatMask = binary(anatMaskImage.data, 0.5);
    const masked = Float32Array.from(anat.data, (value, i) => value * anatMask[i]);
    const clipAnat = writeLike(anat, advancedClip(masked, anat.dims, { pMin: 0, pMax: 99.8 }), anat.dims);
    const anatRef = copyGeometry(await runtime.denoise(clipAnat, { signal }), anat);
    const anatDil = writeLike(anatMaskImage, dilateBall(anatMaskImage.data, anat.dims), anat.dims);
    const epiDil = writeLike(epiMaskImage, dilateBall(epiMaskImage.data, dims), dims);

    // epi2anat and, with the prior, the T1w-to-MNI affine of Q59 (two kernels at once).
    progress('affine');
    const epi2anat = ants(
      affineArguments({ fixed: 'anat.nii', moving: 'epi.nii', output: 'epi2anat', seed, fixedMask: 'anat_dil.nii', movingMask: 'epi_dil.nii' }),
      { 'anat.nii': anatRef, 'epi.nii': epiRef, 'anat_dil.nii': anatDil, 'epi_dil.nii': epiDil },
      ['epi2anat0GenericAffine.mat'],
    );
    let anat2std = null;
    if (prior) {
      const template = await readImage(prior[PRIOR_FILES.template]);
      const templateMask = await readImage(prior[PRIOR_FILES.templateMask]);
      const t1wBrain = writeLike(anat, Float32Array.from(anat.data, (value, i) => value * (anatMaskImage.data[i] > 0 ? 1 : 0)), anat.dims);
      const templateBrain = writeLike(template, Float32Array.from(template.data, (value, i) => value * (templateMask.data[i] > 0 ? 1 : 0)), template.dims);
      anat2std = ants(
        affineArguments({ fixed: 'template.nii', moving: 't1w.nii', output: 'anat2std', seed }),
        { 'template.nii': templateBrain, 't1w.nii': t1wBrain },
        ['anat2std0GenericAffine.mat'],
      );
    }
    const epi2anatMat = (await epi2anat)['epi2anat0GenericAffine.mat'];
    const anat2stdMat = anat2std ? (await anat2std)['anat2std0GenericAffine.mat'] : null;

    // The anatomical images on the SyN grid: the EPI field of view at 1.2 mm (Q68).
    progress('resample');
    const grid = samplingReference(dims, epi.affine, [SYN_GRID_MM, SYN_GRID_MM, SYN_GRID_MM]);
    const epiSformCode = new DataView(epi.header).getInt16(254, true);
    const samplingHeader = gridHeader(epi, grid.dims, grid.affine, epiSformCode === 1 || epiSformCode === 0 ? 2 : epiSformCode);
    const sampling = writeLike(samplingHeader, new Int16Array(grid.dims[0] * grid.dims[1] * grid.dims[2]), grid.dims);
    const toSyn = (input, interpolation, transforms, extra = {}) =>
      ants(applyArguments({ input, reference: 'sampling.nii', output: 'out.nii', interpolation, transforms }), { 'sampling.nii': sampling, 'epi2anat.mat': epi2anatMat, ...extra }, ['out.nii']).then(
        (outputs) => copyGeometry(outputs['out.nii'], samplingHeader),
      );
    const anatMaskName = niftiName('anat_mask', anatMaskBytes);
    const anatOnSyn = await toSyn('anat.nii', 'Linear', ['[epi2anat.mat,1]'], { 'anat.nii': anatRef });
    const anatMaskOnSyn = await readImage(await toSyn(anatMaskName, 'MultiLabel', ['[epi2anat.mat,1]'], { [anatMaskName]: anatMaskBytes }), Float64Array);
    const anatMaskSyn = writeLike(anatMaskOnSyn, Uint8Array.from(anatMaskOnSyn.data), grid.dims);
    let priorMask = anatMaskSyn;
    if (prior) {
      const warped = await readImage(
        await toSyn(PRIOR_FILES.atlas, 'Linear', ['[epi2anat.mat,1]', '[anat2std.mat,1]', 'atlas2std.mat'], {
          [PRIOR_FILES.atlas]: prior[PRIOR_FILES.atlas],
          'anat2std.mat': anat2stdMat,
          'atlas2std.mat': prior[PRIOR_FILES.atlasToTemplate],
        }),
        Float64Array,
      );
      priorMask = writeLike(warped, binary(warped.data, ATLAS_THRESHOLD), grid.dims);
    }

    // The SyN inputs (init_syn_sdc_wf).
    progress('laplacian');
    const epiClip = writeLike(epi, advancedClip(epi.data, dims, { pMin: 35, pMax: 99.9 }), dims);
    const anatMaskDil = writeLike(anatMaskOnSyn, dilateBall(anatMaskOnSyn.data, grid.dims), grid.dims);
    const epiMaskName = niftiName('epi_mask', epiMaskBytes);
    const amask = await readImage(
      (await ants(applyArguments({ input: 'anat_dil.nii', reference: epiMaskName, output: 'out.nii', interpolation: 'MultiLabel', transforms: ['identity'] }), { 'anat_dil.nii': anatMaskDil, [epiMaskName]: epiMaskBytes }, ['out.nii']))['out.nii'],
      Float64Array,
    );
    const union = writeLike(epiMaskImage, Uint8Array.from(epiMaskImage.data, (value, i) => (value + amask.data[i] > 0 ? 1 : 0)), dims);
    const laplacian = async (bytes, like) => {
      const out = (await ants(['ImageMath', '3', 'lap.nii', 'Laplacian', 'in.nii', '1.5', '1'], { 'in.nii': bytes }, ['lap.nii']))['lap.nii'];
      const image = await readImage(copyGeometry(out, like), Float64Array);
      return writeLike(image, normalizeLaplacian(image.data), image.dims);
    };
    const anatLap = await laplacian(anatOnSyn, samplingHeader);
    const epiLap = await laplacian(epiClip, epi);

    progress('syn');
    const anatRefImage = await readImage(anatOnSyn);
    const restrict = restrictDeformation(epi.affine, anatRefImage.affine, acq.phaseEncodingDirection);
    const parameters = synParameters(epi.affine, anatRefImage.affine, acq.phaseEncodingDirection, SYN_TRANSFORM_PARAMETERS);
    const synArgv = synArguments({ seed, restrict, parameters });
    const syn = await ants(
      synArgv,
      { 'anat_ref.nii': anatOnSyn, 'epi_clip.nii': epiClip, 'anat_lap.nii': anatLap, 'epi_lap.nii': epiLap, 'anat_mask.nii': anatMaskSyn, 'sd_prior.nii': priorMask, 'epi_umask.nii': union },
      ['fmap_syn0Warp.nii.gz'],
    );

    // The field in Hz, its B-spline fit on the EPI grid, and the unwarped series.
    progress('field');
    const warp = await readImage(syn['fmap_syn0Warp.nii.gz']);
    const synVoxels = grid.dims[0] * grid.dims[1] * grid.dims[2];
    if (warp.data.length !== synVoxels * 3) throw new Error('The SyN warp is not a 3-component field on the SyN grid.');
    const vectors = new Float32Array(synVoxels * 3);
    for (let i = 0; i < synVoxels; i++) for (let c = 0; c < 3; c++) vectors[3 * i + c] = warp.data[c * synVoxels + i];
    const epiGrid = { shape: dims, affine: epi.affine };
    const readout = { readout: acq.totalReadoutTime, phaseEncodingDirection: acq.phaseEncodingDirection };
    const hz = runtime.fieldFit.displacementToField(vectors, epiGrid, readout);
    const hzOnSyn = writeLike(gridHeader(epi, grid.dims, grid.affine, 2), hz, grid.dims);
    const zoomed = await ants(
      applyArguments({ input: 'field.nii', reference: 'epi.nii', output: 'out.nii', interpolation: 'BSpline', transforms: ['identity'], outputType: 'float' }),
      { 'field.nii': hzOnSyn, 'epi.nii': epiRef },
      ['out.nii'],
    );
    const fieldOnEpi = await readImage(copyGeometry(zoomed['out.nii'], epi));
    const fit = runtime.fieldFit.approximate(fieldOnEpi.data, epiGrid);
    const positive = positiveCosines(dims, epi.affine);
    const fmapPositive = runtime.fieldFit.evaluate(fit.coefficients, fit.grid, { shape: dims, affine: positive.affine });
    const field = flipVolume(fmapPositive, dims, positive.flips);
    progress('unwarp');
    const corrected = unwarpSeries({
      data: series.data,
      dims,
      frames,
      affine: series.affine,
      field: fmapPositive,
      phaseEncodingDirection: acq.phaseEncodingDirection,
      totalReadoutTime: acq.totalReadoutTime,
      onVolume: (volume) => {
        signal?.throwIfAborted();
        onProgress?.({ stage: 'unwarp', done: volume + 1, total: frames });
      },
    });

    progress('write');
    const names = outputNames(fileName);
    const provenance = {
      Method: 'SyN-SDC (sdcflows 2.17.1 fieldmap-less), ported to WebAssembly and JavaScript',
      PhaseEncodingDirection: acq.phaseEncodingDirection,
      TotalReadoutTime: acq.totalReadoutTime,
      TotalReadoutTimeSource: acq.source.totalReadoutTime,
      PhaseEncodingDirectionSource: acq.source.phaseEncodingDirection,
      SynGridMm: SYN_GRID_MM,
      Seed: seed,
      Prior: prior ? 'sdcflows fmap_atlas through an affine T1w-to-MNI152NLin2009cAsym registration (threshold 3 mm)' : 'none (the T1w mask takes its place)',
      DwiMask: epiMask ? 'uploaded' : 'MindGrab (mindgrab) of the mean b0',
      T1wMask: t1wMask ? 'uploaded' : 'MindGrab (mindgrab) of the T1w',
      Registration: 'ANTs antsRegistration 52bc0ab --float 1, WebAssembly (@neurodesk/hmc-registration)',
      Resampling: 'SciPy-equivalent cubic spline along the phase-encoding axis with the Jacobian factor, float32',
      RestrictDeformation: restrict,
      SynArguments: synArgv.join(' '),
    };
    const encoder = new TextEncoder();
    const gzip = async (bytes) => new Uint8Array(await runtime.gzip(bytes));
    const coefficientHeader = gridHeader(epi, fit.grid.shape, fit.grid.affine, 2);
    const displacement = runtime.fieldFit.fieldToDisplacement(field, epiGrid, readout);
    const files = {
      [names.image]: await gzip(writeLike(series, corrected, [...dims, frames])),
      [names.bval]: encoder.encode(bval),
      [names.bvec]: encoder.encode(bvec),
      [names.sidecar]: encoder.encode(sidecarText(dwiSidecar(sidecar, provenance))),
      [names.field]: await gzip(writeLike(epi, field, dims)),
      [names.fieldSidecar]: encoder.encode(sidecarText(fieldSidecar(fileName, provenance))),
      [names.coefficients]: await gzip(writeLike(coefficientHeader, fit.coefficients, fit.grid.shape)),
      [names.coefficientsSidecar]: encoder.encode(sidecarText(fieldSidecar(fileName, provenance, { coefficients: true }))),
      [names.displacement]: await gzip(displacementNifti(epi, dims, displacement)),
      [names.mask]: await gzip(writeLike(epiMaskImage, binary(epiMaskImage.data), dims)),
    };
    signal?.throwIfAborted();
    return {
      files,
      names,
      field,
      provenance,
      intermediate: { epi2anat: epi2anatMat, anat2std: anat2stdMat, fieldBeforeFit: fieldOnEpi.data, hzOnSyn: hz, meanB0: meanBytes, epiMask: epiMaskBytes, t1wMask: anatMaskBytes },
    };
  } finally {
    await pool.close();
  }
}
