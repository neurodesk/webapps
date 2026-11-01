// SPDX-License-Identifier: Apache-2.0
// BIDS-derivative names and sidecars of the SyN-SDC outputs (plan section 5), through the DWI
// apps' shared module: `<source entities>_desc-sdc_dwi.*` for the corrected series and the
// sdcflows names for the field, its coefficients, the displacement field and the EPI mask.
import {
  derivativeSidecar,
  maskName,
  outputNames as stepNames,
  sourceStem,
} from '@neurodesk/webapp-components/file-io/bids-derivatives';

export { sidecarText } from '@neurodesk/webapp-components/file-io/bids-derivatives';

export const DESCRIPTION = 'Susceptibility distortion correction: sdcflows 2.17.1 SyN-SDC (fieldmap-less), one cubic resampling with the Jacobian factor; b0 volumes kept';

/** The derivative names of one corrected DWI series; a path keeps only its file name. */
export function outputNames(fileName) {
  const base = String(fileName).replace(/^.*\//, '');
  const source = sourceStem(base);
  return {
    ...stepNames(base, 'sdc', { defaultSuffix: 'dwi' }),
    field: `${source}_desc-preproc_fieldmap.nii.gz`,
    fieldSidecar: `${source}_desc-preproc_fieldmap.json`,
    coefficients: `${source}_desc-coeff_fieldmap.nii.gz`,
    coefficientsSidecar: `${source}_desc-coeff_fieldmap.json`,
    displacement: `${source}_from-orig_to-sdc_mode-image_xfm.nii.gz`,
    mask: maskName(source),
  };
}

/**
 * The corrected series' sidecar: the input's fields, the PE direction and readout time the run
 * used (an option overrides the input's), and a provenance block. No time or host.
 */
export function dwiSidecar(sidecar, provenance) {
  return {
    ...derivativeSidecar(sidecar, DESCRIPTION),
    PhaseEncodingDirection: provenance.PhaseEncodingDirection,
    TotalReadoutTime: provenance.TotalReadoutTime,
    SusceptibilityDistortionCorrection: provenance,
  };
}

/** The field map's sidecar, as sdcflows writes it: Hz, and what it was estimated from. */
export function fieldSidecar(sourceName, provenance, { coefficients = false } = {}) {
  return {
    Units: 'Hz',
    Description: coefficients
      ? 'Cubic B-spline coefficients (16 x 16 x 10 mm control spacing) of the susceptibility field in Hz, on the grid of this image'
      : 'Susceptibility field in Hz on the DWI grid, estimated with SyN-SDC',
    RawSources: [String(sourceName).replace(/^.*\//, '')],
    PhaseEncodingDirection: provenance.PhaseEncodingDirection,
    TotalReadoutTime: provenance.TotalReadoutTime,
  };
}
