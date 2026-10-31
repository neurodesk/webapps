// Greedy's transforms for BISON's registrations (docs/preprocessing.md#greedy), and the hmc
// --apply argv that resamples through them in place of mincresample and itk_resample. --apply runs
// in @neurodesk/hmc-registration; callers load a new instance for each group of runs, so each
// group's heap is freed when it ends.
//
// Transform direction: a Greedy transform maps fixed points to moving points. The template is the
// fixed image of the T1 affine, the T1 the fixed image of the FLAIR rigid and T1_VP the fixed image
// of the nonlinear warp, so the T1 affine maps template to T1, the rigid T1 to FLAIR, and the warp
// T1_VP to the template's affine frame.
//
// Transform order: hmc's --apply applies the LAST listed transform first to an output point
// (ITK composite queue in command-line order). antsApplyTransforms is the other way round: its
// parser stores options with push_front, so there the FIRST listed transform acts first. The lists
// below are written for hmc. docs/preprocessing.md has the derivation and the check.

import { writeMatTransform } from '@neurodesk/hmc-registration';

// bestlinreg_s2 T1_VP + nlfit_s -level 2 on Greedy: a stationary-velocity warp of the whole head with
// neighbourhood cross-correlation (radius 2) down to 1 mm. Masking the metric to the brain, or
// stopping at 2 mm as nlfit_s does, left the brain edge short and failed sub-HML0774's CSF gate
// (docs/preprocessing.md#nonlinear-step).
export const GREEDY_NONLINEAR = Object.freeze({ metric: 'NCC 2x2x2', iterations: '100x70x50' });

const LPS = [-1, -1, 1];

function greedyMatrixRows(text) {
  const rows = text.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  if (rows.length !== 4 || rows.some((row) => row.length !== 4 || !row.every(Number.isFinite))) throw new Error('A Greedy matrix has four rows of four numbers.');
  return rows;
}

/**
 * Greedy's matrix text (RAS, fixed point to moving point) as an ITK .mat: the same map in LPS, with
 * the fixed image as fixed, as antsRegistration writes `<prefix>0GenericAffine.mat`. The centre is
 * the origin, so the offset is the translation.
 */
export function greedyMatrixToMat(text) {
  const rows = greedyMatrixRows(text);
  const flip = (r, c) => LPS[r] * rows[r][c] * (c < 3 ? LPS[c] : 1);
  const matrix = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => flip(r, c)));
  const translation = [0, 1, 2].map((r) => flip(r, 3));
  return writeMatTransform({ transform: 'AffineTransform_double_3_3', parameters: [...matrix, ...translation], fixed: [0, 0, 0] });
}

/** The inverse of Greedy's RAS matrix text, in the same text form: a `-it` start for the reverse direction. */
export function invertGreedyMatrix(text) {
  const rows = greedyMatrixRows(text);
  const linear = rows.slice(0, 3).map((row) => row.slice(0, 3));
  const [[a, b, c], [d, e, f], [g, h, i]] = linear;
  const cofactors = [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ];
  const determinant = a * cofactors[0][0] + b * cofactors[1][0] + c * cofactors[2][0];
  if (!determinant) throw new Error('A Greedy matrix must be invertible.');
  const inverse = cofactors.map((row) => row.map((value) => value / determinant));
  const translation = inverse.map((row) => -row.reduce((sum, value, k) => sum + value * rows[k][3], 0));
  return `${inverse.map((row, r) => [...row, translation[r]].join(' ')).join('\n')}\n0 0 0 1\n`;
}

const INTERPOLATIONS = ['Linear', 'NearestNeighbor', 'BSpline[2]'];

/** hmc --apply: resample `moving` onto the grid of `fixed`; the last transform acts first. */
export function applyArguments({ fixed, moving, output, interpolation, transforms, fill = 0 }) {
  if (!INTERPOLATIONS.includes(interpolation)) throw new Error(`Unsupported interpolation ${interpolation}.`);
  if (!Array.isArray(transforms) || transforms.length === 0) throw new Error('--apply needs at least one transform.');
  return ['--apply', fixed, moving, output, interpolation, String(fill), ...transforms];
}

/** Output point to template point, for template images on the T1 grid through the affine only. */
export function templateToT1Linear({ affine }) {
  return [`inverse:${affine}`];
}

/**
 * T1 point to template point through the full transform: Greedy's warp (fixed T1_VP, moving
 * template) first, then the inverse T1 affine, whose inverse is the warp's `-it` start.
 */
export function templateToT1({ affine, warp }) {
  return [`inverse:${affine}`, warp];
}

/** FLAIR point to template point: inverse rigid (FLAIR to T1) first, then the inverse T1 affine. */
export function templateToFlair({ t1Affine, rigid }) {
  return [`inverse:${t1Affine}`, `inverse:${rigid}`];
}

/** T1 point to FLAIR point, to bring FLAIR onto the T1 grid. */
export function flairToT1({ rigid }) {
  return [rigid];
}

// ANTs picks the reader by file name, so a gzipped input keeps .nii.gz.
export function niftiName(base, bytes) {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? `${base}.nii.gz` : `${base}.nii`;
}

function outputsOf(result, names, argv) {
  for (const name of names) {
    if (!result.outputs[name]) throw new Error(`${argv[0] === '--apply' ? '--apply' : 'antsRegistration'} wrote no ${name}.`);
  }
  return result.outputs;
}

/** Runs argv on a registration instance (sync in Node, a worker promise in a browser). */
export async function runRegistration(registration, argv, inputs, expected, onLog) {
  const result = await registration.run(argv, inputs);
  if (onLog) for (const line of result.log ?? []) onLog(line);
  return outputsOf(result, expected, argv);
}

/** Resamples one image with --apply and returns the float32 NIfTI bytes. */
export async function applyTransforms(registration, { fixed, moving, interpolation, transforms, files, onLog }) {
  const fixedName = niftiName('fixed', fixed);
  const movingName = niftiName('moving', moving);
  const argv = applyArguments({ fixed: fixedName, moving: movingName, output: 'resampled.nii', interpolation, transforms });
  const inputs = { [fixedName]: fixed, [movingName]: moving, ...files };
  const outputs = await runRegistration(registration, argv, inputs, ['resampled.nii'], onLog);
  return outputs['resampled.nii'];
}
