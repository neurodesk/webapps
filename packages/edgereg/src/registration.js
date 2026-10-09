// EdgeReg's method, shared by the web app and the edgereg command line:
//
//   niimath MOVING -gz 0 [-robustfov] -allineate FIXED OUT -odt input
//
// niimath's affine registration (AFNI 3dAllineate's fast engine) reslices the moving image onto the
// fixed grid, uncompressed and in the moving image's datatype.

export const OUTPUT_DATA_TYPE = 'input';

export const registeredName = (movingName) => `${movingName.replace(/\.nii(\.gz)?$/i, '')}_registered.nii`;

/**
 * Chains the registration onto `image`, a `@niivue/niimath` image processor for the moving image.
 * The processor's Niimath instance must output OUTPUT_DATA_TYPE.
 */
export function registrationChain(image, fixed, { robustFov = false } = {}) {
  const source = image.gz(0);
  const cropped = robustFov ? source.robustfov() : source;
  return cropped.allineate(fixed);
}
