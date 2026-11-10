// DOM-independent app config: example optics, output names, the NIfTI geometry of a
// micrometre-calibrated stack and run provenance. Unit-tested under Node (test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import { createNiftiFromVolume } from "@neurodesk/webapp-components/file-io";
import { imagejDescription, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";

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
 * flipped in the affine to show the stack as ImageJ does. The qform says the same: the flip
 * diag(1, -1, 1) is qfac -1 (pixdim[0]) times a half turn about x, quaternion (b, c, d) = (1, 0, 0).
 */
export function niftiGeometry(dims, spacingUm) {
  const [nz, ny, nx] = dims;
  const mm = { x: spacingUm.x / 1000, y: spacingUm.y / 1000, z: spacingUm.z / 1000 };
  return {
    dims: [3, nx, ny, nz, 1, 1, 1, 1],
    pixDims: [-1, mm.x, mm.y, mm.z, 0, 0, 0, 0],
    quatern: [1, 0, 0],
    qoffset: [0, (ny - 1) * mm.y, 0],
    affine: [
      [mm.x, 0, 0, 0],
      [0, -mm.y, 0, (ny - 1) * mm.y],
      [0, 0, mm.z, 0],
      [0, 0, 0, 1],
    ],
  };
}

/** NIfTI-1 header offsets of quatern_b and of qoffset_x (each followed by the next two). */
const QUATERN = 256;
const QOFFSET = 268;
const SROW = 280;

/**
 * A float32 NIfTI of a micrometre-calibrated `[z][y][x]` stack, whose qform and sform give the
 * same voxel-to-world matrix (`niftiGeometry`).
 * @returns {ArrayBuffer}
 */
export function stackNifti(data, dims, spacingUm) {
  const geometry = niftiGeometry(dims, spacingUm);
  const buffer = createNiftiFromVolume({ hdr: geometry, img: data instanceof Float32Array ? data : Float32Array.from(data) });
  const view = new DataView(buffer);
  geometry.quatern.forEach((value, i) => view.setFloat32(QUATERN + 4 * i, value, true));
  geometry.qoffset.forEach((value, i) => view.setFloat32(QOFFSET + 4 * i, value, true));
  return buffer;
}

/**
 * Sets the voxel size of a NIfTI-1 file in place: pixdim 1-3 in the header's own unit and the
 * sform's columns rescaled to it, keeping their direction and the origin. The qform takes its
 * scale from pixdim, so it follows. Returns the buffer.
 * @param {ArrayBuffer} buffer
 */
export function setNiftiSpacing(buffer, spacingUm) {
  const view = new DataView(buffer);
  const littleEndian = view.getInt32(0, true) === 348;
  const factor = NIFTI_UNIT_UM[view.getUint8(123) & 7] ?? 1000;
  ["x", "y", "z"].forEach((axis, column) => {
    const size = spacingUm[axis] / factor;
    view.setFloat32(80 + 4 * column, size, littleEndian);
    const at = [0, 1, 2].map((row) => SROW + 16 * row + 4 * column);
    const norm = Math.hypot(...at.map((offset) => view.getFloat32(offset, littleEndian)));
    if (norm > 0) for (const offset of at) view.setFloat32(offset, (view.getFloat32(offset, littleEndian) * size) / norm, littleEndian);
  });
  return buffer;
}

/** A float32 ImageJ TIFF z stack calibrated in micrometres, which Fiji and tifffile open as such. */
export function stackTiff(data, dims, spacingUm) {
  const [nz, ny, nx] = dims;
  let min = Infinity;
  let max = -Infinity;
  for (const value of data) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const description = imagejDescription({ slices: nz, spacing: spacingUm.z, unit: "micron", min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 });
  return writeTiffStack({ width: nx, height: ny, data, description, pixelSize: { x: spacingUm.x, y: spacingUm.y } });
}

/** X and y voxel sizes further apart than this (relative) are not square. */
const SQUARE_TOLERANCE = 0.01;

/**
 * Refuses pixels that are not square: the form, the PSF and the module take one lateral size.
 */
export function checkSquarePixels(spacingUm, name) {
  const { x, y } = spacingUm;
  if (x > 0 && y > 0 && Math.abs(x - y) > SQUARE_TOLERANCE * Math.max(x, y)) {
    throw new Error(`${name} has ${Number(x.toPrecision(4))} × ${Number(y.toPrecision(4))} µm pixels; this app needs square pixels. Resample x and y to one size first (Fiji: Image › Scale).`);
  }
}

/**
 * Checks a measured PSF's voxel size against the image's on all three axes: throws when an axis
 * differs by more than 5 %, and returns a warning when the PSF file records no voxel size.
 * @returns {string | null}
 */
export function checkPsfSpacing(psfSpacingUm, imageSpacingUm, name) {
  const axes = ["x", "y", "z"];
  const differs = axes.filter((axis) => psfSpacingUm[axis] > 0 && Math.abs(psfSpacingUm[axis] - imageSpacingUm[axis]) > 0.05 * imageSpacingUm[axis]);
  const describe = (spacing) => axes.map((axis) => (spacing[axis] ? Number(spacing[axis].toPrecision(4)) : "?")).join(" × ");
  if (differs.length) throw new Error(`The measured PSF's voxel size (${describe(psfSpacingUm)} µm) differs from the image's along ${differs.join(", ")}; resample it to ${describe(imageSpacingUm)} µm first.`);
  const missing = axes.filter((axis) => !(psfSpacingUm[axis] > 0));
  if (missing.length) return `${name} records no voxel size along ${missing.join(", ")}; it is taken to be on the image's ${describe(imageSpacingUm)} µm grid.`;
  return null;
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
