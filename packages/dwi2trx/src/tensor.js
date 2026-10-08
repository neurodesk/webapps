// DWI2TRX's tensor fit, shared by the web app's tensor worker and the dwi2trx command line.
//
// Both drive the dtifit-enabled niimath build vendored in apps/dwi2trx/vendor/niimath through a
// `run(args, { inputs, outputs })` function that stages `inputs` (name -> bytes), runs one niimath
// argv and returns `{ outputs }` (name -> bytes): runNiimath from
// @neurodesk/runtime-support/node/niimath in Node, a cached module in the browser worker.
import { decodeNiftiBuffer, parseNiftiHeader, sameVoxelGrid } from '@neurodesk/webapp-components/file-io/nifti';
import { b0Index } from './gradients.js';

/** Every map dtifit writes, in its own naming: dti_<MAP>.nii.gz. */
export const TENSOR_MAPS = Object.freeze(['FA', 'MD', 'L1', 'L2', 'L3', 'V1', 'V2', 'V3', 'S0', 'MO', 'tensor']);

/** The MindGrab call both runtimes make for the brain mask, on the b0 volume. */
export const MASK_OPTIONS = Object.freeze({ model: 'mindgrab', mask: true });

/** A map's download name: dwi.nii.gz gives dwi_FA.nii.gz. */
export function mapFileName(niftiName, map) {
  return `${niftiName.replace(/\.nii(\.gz)?$/i, '') || 'dwi'}_${map}.nii.gz`;
}

const header = async (bytes) => parseNiftiHeader(await decodeNiftiBuffer(bytes));

/** The first b0 volume of the DWI (see b0Index) as a .nii.gz, the input MindGrab masks. */
export async function extractB0(run, { dwi, bvalText }) {
  const args = ['dwi.nii.gz', '-crop', String(b0Index(bvalText)), '1', 'b0.nii.gz'];
  const { outputs } = await run(args, { inputs: { 'dwi.nii.gz': dwi }, outputs: ['b0.nii.gz'] });
  return outputs['b0.nii.gz'];
}

/**
 * Fits the diffusion tensor with niimath --dtifit and returns every map in TENSOR_MAPS as .nii.gz
 * bytes. Without `mask` the fit is unmasked; a mask must lie on the DWI's voxel grid and goes to
 * dtifit unchanged (no dilation: the FA is noisy at the scalp).
 */
export async function fitTensor(run, { dwi, bval, bvec, mask }) {
  const args = ['--dtifit', '-k', 'dwi', '-r', 'dwi.bvec', '-b', 'dwi.bval', '-o', 'dti'];
  const inputs = { 'dwi.nii.gz': dwi, 'dwi.bval': bval, 'dwi.bvec': bvec };
  if (mask) {
    if (!sameVoxelGrid(await header(dwi), await header(mask))) throw new Error('The brain mask is not on the diffusion image\'s voxel grid.');
    inputs['mask.nii.gz'] = mask;
    args.splice(args.length - 2, 0, '-m', 'mask');
  }
  const names = TENSOR_MAPS.map((map) => `dti_${map}.nii.gz`);
  const { outputs } = await run(args, { inputs, outputs: names });
  return Object.fromEntries(TENSOR_MAPS.map((map, i) => [map, outputs[names[i]]]));
}
