// DOM-independent app config: re-exports shared deconvolution formatting from @neurodesk/deconvolution/format.
import automation from "../automation.json" with { type: "json" };

export {
  DEFAULT_OPTICS,
  EXAMPLE_OPTICS,
  checkPsfSpacing,
  checkSquarePixels,
  createFloat32Nifti2,
  deconvolvedNifti,
  niftiGeometry,
  niftiSpacingUm,
  outputNames,
  provenance,
  setNiftiSpacing,
  spacingComplete,
  stackNifti,
  stackTiff,
  stem,
} from "@neurodesk/deconvolution/format";

export const APP = Object.freeze({
  id: "deconvolution",
  title: automation.title,
});
