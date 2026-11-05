// DOM-independent app config: example optics, output names, the NIfTI geometry of a
// micrometre-calibrated stack and run provenance. Unit-tested under Node (test/config.test.js).
import automation from "../automation.json" with { type: "json" };

export const APP = Object.freeze({
  id: "deconvolution",
  title: automation.title,
});

/** The form's starting values: an oil objective, widefield, green emission. */
export const DEFAULT_OPTICS = Object.freeze({
  modality: "widefield",
  na: 1.4,
  immersionIndex: 1.518,
  sampleIndex: 1.47,
  emissionNm: 520,
  excitationNm: 488,
  depthUm: 0,
});

/** Acquisition settings of each example, from its own metadata (the CZI of the confocal stack). */
export const EXAMPLE_OPTICS = Object.freeze({
  "hela-phalloidin-confocal": Object.freeze({
    modality: "confocal",
    na: 1.4,
    immersionIndex: 1.518,
    sampleIndex: 1.47,
    emissionNm: 525,
    excitationNm: 488,
    depthUm: 0,
  }),
});

/** The name stem of an input file, without .tif/.tiff/.ome.tif/.nii/.nii.gz. */
export function stem(name) {
  return name.replace(/(\.ome)?\.tiff?$/i, "").replace(/\.nii(\.gz)?$/i, "");
}

export function outputNames(inputName) {
  const base = stem(inputName);
  return {
    tiff: `${base}_deconvolved.tif`,
    nifti: `${base}_deconvolved.nii.gz`,
    psfTiff: `${base}_psf.tif`,
    psfNifti: `${base}_psf.nii.gz`,
    previewNifti: `${base}.nii.gz`,
  };
}

/** Micrometres per unit of NIfTI `xyzt_units` (bits 0-2): metre, millimetre, micrometre. */
const NIFTI_UNIT_UM = Object.freeze({ 0: 1000, 1: 1e6, 2: 1000, 3: 1 });

/** The voxel size `{ x, y, z }` in micrometres of a parsed NIfTI header. */
export function niftiSpacingUm(header) {
  const factor = NIFTI_UNIT_UM[header.xyztUnits & 7] ?? 1000;
  const [x, y, z] = header.voxelSize.map((value) => Math.abs(value) * factor);
  return { x, y, z };
}

/**
 * NIfTI-1 header fields for a stack calibrated in micrometres: the shared writer stores
 * millimetres, so the spacing is divided by 1000. TIFF rows run top to bottom, so the y axis is
 * flipped in the affine to show the stack as ImageJ does.
 */
export function niftiGeometry(dims, spacingUm) {
  const [nz, ny, nx] = dims;
  const mm = { x: spacingUm.x / 1000, y: spacingUm.y / 1000, z: spacingUm.z / 1000 };
  return {
    dims: [3, nx, ny, nz, 1, 1, 1, 1],
    pixDims: [1, mm.x, mm.y, mm.z, 0, 0, 0, 0],
    affine: [
      [mm.x, 0, 0, 0],
      [0, -mm.y, 0, (ny - 1) * mm.y],
      [0, 0, mm.z, 0],
      [0, 0, 0, 1],
    ],
  };
}

/** Is every axis's voxel size a positive number of micrometres? */
export function spacingComplete(spacingUm) {
  return ["x", "y", "z"].every((axis) => Number.isFinite(spacingUm?.[axis]) && spacingUm[axis] > 0);
}

/** The provenance record of one run. */
export function provenance({ input, dims, spacingUm, optics, psf, settings, seconds }) {
  return {
    app: APP.id,
    input,
    dimensions: { x: dims[2], y: dims[1], z: dims[0] },
    voxelSizeUm: spacingUm,
    psf: psf.source === "measured"
      ? { source: "measured", file: psf.file, dimensions: psf.dims, background: psf.background }
      : { source: "Gibson-Lanni", modality: optics.modality, numericalAperture: optics.na, immersionIndex: optics.ni, sampleIndex: optics.ns, emissionNm: optics.emissionUm * 1000, excitationNm: optics.excitationUm ? optics.excitationUm * 1000 : null, depthUm: optics.depthUm, dimensions: psf.dims },
    method: settings.method === "rltv" ? "Richardson-Lucy with total variation (Dey et al. 2006)" : "Richardson-Lucy (scikit-image richardson_lucy, clip=False)",
    iterations: settings.iterations,
    tvWeight: settings.tvWeight,
    boundary: "zero outside the image (scipy.signal.convolve mode='same')",
    ...(seconds === undefined ? {} : { seconds }),
  };
}
