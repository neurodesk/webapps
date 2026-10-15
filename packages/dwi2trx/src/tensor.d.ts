/** A map dtifit writes, in its own naming: dti_<MAP>.nii.gz. */
export type TensorMap = 'FA' | 'MD' | 'L1' | 'L2' | 'L3' | 'V1' | 'V2' | 'V3' | 'S0' | 'MO' | 'tensor';

/**
 * Stages `inputs` (name -> bytes), runs one niimath argv and returns the named `outputs`.
 * `Bytes` is what the runtime's file system hands back.
 */
export type NiimathRun<Bytes extends Uint8Array = Uint8Array> = (
  args: string[],
  files: { inputs: Record<string, Uint8Array>; outputs: string[] },
) => Promise<{ outputs: Record<string, Bytes> }>;

export const TENSOR_MAPS: readonly TensorMap[];
export const MASK_OPTIONS: Readonly<{ model: 'mindgrab'; mask: true }>;

export function mapFileName(niftiName: string, map: string): string;
export function assertMaskOnGrid(dwi: Uint8Array, mask: Uint8Array): Promise<void>;
export function extractB0<Bytes extends Uint8Array>(run: NiimathRun<Bytes>, options: { dwi: Uint8Array; bvalText: string }): Promise<Bytes>;
export function fitTensor<Bytes extends Uint8Array>(
  run: NiimathRun<Bytes>,
  options: { dwi: Uint8Array; bval: Uint8Array; bvec: Uint8Array; mask?: Uint8Array },
): Promise<Record<TensorMap, Bytes>>;
