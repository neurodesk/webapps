// Pure helpers for the downloads: names, plain byte copies, and the ITK-Wasm
// transform clean-up the HDF5 writer needs. No DOM or pipeline imports.

/** The moving image's name without its format extensions: t1.nii.gz, t1.ome.zarr.ozx and t1.ome.tif give t1. */
export function outputStem(name) {
  return name
    .replace(/(\.(gz|zst|ozx))+$/i, "")
    .replace(/\.[^./]+$/, "")
    .replace(/(\.(ome|zarr|iwi))+$/i, "") || "image";
}

export function outputNames(movingName) {
  const stem = outputStem(movingName);
  return {
    stem,
    nifti: `${stem}_registered.nii.gz`,
    omeZarr: `${stem}_registered.ome.zarr.ozx`,
    omeTiff: `${stem}_registered.ome.tif`,
    transform: `${stem}_transform.h5`,
    transformOmeZarr: `${stem}_transform.ome.zarr.ozx`,
  };
}

/** fiff 0.8.2 writes spacing and units, but no origin or direction. */
export function omeTiffIssue(image, spatialUnits, tiffMetadata) {
  const dimension = image.imageType.dimension;
  const axes = ["x", "y", ...(dimension === 3 ? ["z"] : [])];
  if (tiffMetadata?.hasPlanePositions) {
    return "OME-TIFF cannot preserve source plane positions. Use NIfTI or OME-Zarr.";
  }
  if (tiffMetadata && axes.some((axis) => !(tiffMetadata.physicalSizes[axis] > 0 && Number.isFinite(tiffMetadata.physicalSizes[axis])))) {
    return "OME-TIFF needs known physical pixel sizes. Use NIfTI or OME-Zarr.";
  }
  if (Array.from(image.origin).some((value) => value !== 0)) {
    return "OME-TIFF cannot preserve this origin. Use NIfTI or OME-Zarr.";
  }
  if (Array.from(image.direction).some((value, index) => value !== (index % (dimension + 1) === 0 ? 1 : 0))) {
    return "OME-TIFF cannot preserve this direction. Use NIfTI or OME-Zarr.";
  }
  if (axes.some((axis) => !TIFF_UNITS.has(spatialUnits?.[axis]))) {
    return "OME-TIFF needs known spatial units. Use NIfTI or OME-Zarr.";
  }
  return null;
}

const TIFF_UNITS = new Set(["meter", "centimeter", "millimeter", "micrometer", "nanometer", "picometer", "angstrom"]);

const UNIT_ALIASES = { m: "meter", cm: "centimeter", mm: "millimeter", um: "micrometer", "µm": "micrometer", "μm": "micrometer", nm: "nanometer", pm: "picometer", "Å": "angstrom" };

export function normalizeSpatialUnits(units) {
  return units && Object.fromEntries(Object.entries(units).map(([axis, unit]) => [axis, UNIT_ALIASES[unit] ?? unit]));
}

/**
 * A copy in a plain ArrayBuffer of exactly the view's bytes. ITK-Wasm can
 * return views onto a SharedArrayBuffer, which Blob and File reject, or onto
 * a larger buffer whose other bytes must not leak into a download.
 */
export function plainBytes(view) {
  const source = ArrayBuffer.isView(view) ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(view);
  return new Uint8Array(source);
}

/**
 * Whether the ITK HDF5 writer can take this transform list. The pinned
 * @itk-wasm/transform-io 1.1.0 runs out of bounds writing a BSpline transform
 * (it crashed the web app's tab on the B-spline preset), so a run with a
 * B-spline stage offers its transform as TransformParameters files and the
 * OME-Zarr displacement field only.
 */
export function hdf5Writable(transforms) {
  return !transforms.some((transform) => transform.transformType.transformParameterization === "BSpline");
}

function typedOrEmpty(transform, value, count) {
  if (count > 0 || ArrayBuffer.isView(value)) return value;
  return transform.transformType.parametersValueType === "float32" ? new Float32Array(0) : new Float64Array(0);
}

/**
 * A zero-length parameter field (the Translation stage has no fixed
 * parameters) comes back from ITK-Wasm as its data:application/vnd.itk.address
 * placeholder string, and the transform writers then fail on its byteLength.
 * Give each such field an empty typed array of the transform's value type.
 */
export function withTypedParameterArrays(transforms) {
  return transforms.map((transform) => {
    if (transform.transformType.transformParameterization === "Composite") return transform;
    const parameters = typedOrEmpty(transform, transform.parameters, transform.numberOfParameters);
    const fixedParameters = typedOrEmpty(transform, transform.fixedParameters, transform.numberOfFixedParameters);
    if (parameters === transform.parameters && fixedParameters === transform.fixedParameters) return transform;
    return { ...transform, parameters, fixedParameters };
  });
}
