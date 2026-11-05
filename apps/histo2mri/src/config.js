// DOM-independent app config and input rules, unit-tested in Node (test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import { DEFAULTS } from "./core/register.js";

export const APP = Object.freeze({
  id: "histo2mri",
  title: automation.title,
  version: "0.0.20261105",
});

const NIFTI = /\.nii(\.gz)?$/i;
const RASTER = /\.(tiff?|png|jpe?g)$/i;

/** Splits chosen or dropped files into the MRI (NIfTI) and the histology sections (TIFF, PNG, JPEG). */
export function classifyFiles(files) {
  const mri = files.filter((file) => NIFTI.test(file.name));
  const sections = files.filter((file) => RASTER.test(file.name));
  const other = files.filter((file) => !NIFTI.test(file.name) && !RASTER.test(file.name));
  if (mri.length > 1) throw new Error("Choose one MRI volume (NIfTI).");
  if (other.length) throw new Error(`${other[0].name} is not a NIfTI MRI or a TIFF, PNG or JPEG section.`);
  return { mri: mri[0] ?? null, sections: sections.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}

/** A section file's output names, from its name without the extension. */
export function outputNames(name) {
  const base = name.replace(/\.ome\.tiff?$/i, "").replace(/\.(tiff?|png|jpe?g)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return {
    warped: `${base}_warped_rgba.nii.gz`,
    plane: `${base}_mri_plane.nii.gz`,
    section: `${base}_section.nii.gz`,
    affine: `${base}_affine.mat`,
    warp: `${base}_warp.nii.gz`,
    report: `${base}_registration.json`,
  };
}

const finite = (value) => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));

/**
 * The run settings from the form or automation parameters, checked against the MRI's size.
 * `dims` are the MRI's three dimensions.
 */
export function runSettings(values, dims, sectionCount = 1) {
  const axis = Number(values.axis ?? 2);
  if (![0, 1, 2].includes(axis)) throw new Error("The slice axis must be i, j or k.");
  const index = Number(values.index);
  if (!finite(values.index) || index < 0 || index > dims[axis] - 1) throw new Error(`Slice must be between 0 and ${dims[axis] - 1}.`);
  const step = finite(values.step) ? Number(values.step) : 1;
  const last = index + (sectionCount - 1) * step;
  if (last < 0 || last > dims[axis] - 1) throw new Error(`With ${sectionCount} sections ${step} slices apart the last section is outside the MRI.`);
  const tilt = [Number(values.tiltA ?? 0), Number(values.tiltB ?? 0)];
  if (tilt.some((value) => !Number.isFinite(value) || Math.abs(value) > 30)) throw new Error("Tilts are degrees between −30 and 30.");
  const pixelSize = finite(values.pixelSize) ? Number(values.pixelSize) : null;
  if (pixelSize !== null && !(pixelSize > 0)) throw new Error("The section pixel size must be positive (µm).");
  const searchOffset = Number(values.searchOffset ?? DEFAULTS.searchOffset);
  const searchTilt = Number(values.searchTilt ?? DEFAULTS.searchTilt);
  if (!(searchOffset >= 0 && searchOffset <= 10) || !(searchTilt >= 0 && searchTilt <= 10)) throw new Error("Search ranges are 0–10 slices and 0–10°.");
  const contrast = values.contrast ?? DEFAULTS.contrast;
  if (!["auto", "haematoxylin", "eosin", "dab"].includes(contrast)) throw new Error(`Unknown contrast ${contrast}.`);
  const orientation = values.orientation ?? DEFAULTS.orientation;
  if (orientation !== "auto" && !/^[0-7]$/.test(String(orientation))) throw new Error(`Unknown orientation ${orientation}.`);
  return {
    plane: { axis, index, step, tilt },
    options: {
      contrast,
      orientation: orientation === "auto" ? "auto" : Number(orientation),
      pixelSize,
      refinePlane: values.refinePlane !== false,
      searchOffset,
      searchTilt,
      deformable: values.deformable !== false,
    },
  };
}
