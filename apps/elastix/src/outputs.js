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
    transform: `${stem}_transform.h5`,
    transformOmeZarr: `${stem}_transform.ome.zarr.ozx`,
  };
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
