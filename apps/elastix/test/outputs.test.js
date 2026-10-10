import { test } from "node:test";
import assert from "node:assert/strict";
import { outputNames, outputStem, plainBytes, withTypedParameterArrays } from "../src/outputs.js";

test("output names drop every format extension of the moving image", () => {
  for (const name of ["t1.nii.gz", "t1.nii", "t1.ome.zarr.ozx", "t1.ome.tif", "t1.zarr", "t1.nrrd", "t1.iwi.cbor"]) assert.equal(outputStem(name), "t1");
  assert.equal(outputStem(".nii.gz"), "image");
  assert.deepEqual(outputNames("t1_brain.nii.gz"), {
    stem: "t1_brain",
    nifti: "t1_brain_registered.nii.gz",
    omeZarr: "t1_brain_registered.ome.zarr.ozx",
    transform: "t1_brain_transform.h5",
    transformOmeZarr: "t1_brain_transform.ome.zarr.ozx",
  });
});

test("download bytes are a plain copy of exactly the view", () => {
  const shared = new SharedArrayBuffer(8);
  new Uint8Array(shared).set([1, 2, 3, 4, 5, 6, 7, 8]);
  const bytes = plainBytes(new Uint8Array(shared, 2, 3));
  assert.ok(bytes.buffer instanceof ArrayBuffer);
  assert.deepEqual(Array.from(bytes), [3, 4, 5]);
  const copied = plainBytes(new Uint8Array([9, 8]).buffer);
  assert.deepEqual(Array.from(copied), [9, 8]);
});

test("zero-count parameter placeholders become empty typed arrays", () => {
  const address = "data:application/vnd.itk.address,0:0";
  const translation = {
    transformType: { transformParameterization: "Translation", parametersValueType: "float64" },
    numberOfParameters: 3,
    numberOfFixedParameters: 0,
    parameters: new Float64Array([1, 2, 3]),
    fixedParameters: address,
  };
  const composite = { transformType: { transformParameterization: "Composite" }, parameters: address, fixedParameters: address };
  const [compositeOut, translationOut] = withTypedParameterArrays([composite, translation]);
  assert.equal(compositeOut, composite);
  assert.ok(translationOut.fixedParameters instanceof Float64Array);
  assert.equal(translationOut.fixedParameters.length, 0);
  assert.equal(translationOut.parameters, translation.parameters);
  assert.equal(translation.fixedParameters, address, "the input transform is not modified");
  const float = withTypedParameterArrays([{ ...translation, transformType: { ...translation.transformType, parametersValueType: "float32" } }])[0];
  assert.ok(float.fixedParameters instanceof Float32Array);
  const complete = { ...translation, numberOfFixedParameters: 1, fixedParameters: new Float64Array([0]) };
  assert.equal(withTypedParameterArrays([complete])[0], complete, "a transform without placeholders is returned as is");
});
