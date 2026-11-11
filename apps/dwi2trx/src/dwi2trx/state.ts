/**
 * Single source of truth for wizard + pipeline state — flat, no classes, no
 * setters.
 */

export type Step = 1 | 2 | 3

export type InputSource = 'sample' | 'nifti' | 'dicom'

/** A validated diffusion input: a NIfTI + matching bval/bvec (+ optional json). */
export interface DwiInput {
  nifti: File
  bval: File
  bvec: File
  json?: File
  /** Gradient directions = bval entries = NIfTI 4D volume count (all cross-checked). */
  directions: number
  source: InputSource
}

/** Tensor-fit outputs (Stage 2): FA (3D) + V1 (4D 3-vector), as `.nii.gz` Files. */
export interface TensorMaps {
  fa: File
  v1: File
}

export const state: {
  /** Active workflow result (1 input · 2 maps · 3 streamlines). */
  step: Step
  input?: DwiInput
  maps?: TensorMaps
  tracts?: File // Stage 3 output: the tracked streamlines serialized to TRX
  /** The 3D preview shows every Nth streamline of `tracts`; set with it. */
  tractStride?: number
} = { step: 1 }
