import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParameterObject, chainParameterFiles, PRESETS, presetSettings, sortParameterFiles, stageNames } from "../src/parameter-maps.js";

test("presets chain elastix's default maps from translation onwards", () => {
  assert.deepEqual(PRESETS.rigid, ["translation", "rigid"]);
  assert.deepEqual(PRESETS.affine, ["translation", "rigid", "affine"]);
  assert.deepEqual(PRESETS.bspline, ["translation", "rigid", "affine", "bspline"]);
});

test("preset settings are validated", () => {
  assert.equal(presetSettings({ method: "affine", resolutions: "4", gridSpacing: "2.5" }).numberOfResolutions, 4);
  assert.throws(() => presetSettings({ method: "demons" }), /Unknown registration method/);
  assert.throws(() => presetSettings({ resolutions: 0 }), /1 to 6/);
  assert.throws(() => presetSettings({ resolutions: 2.5 }), /1 to 6/);
  assert.throws(() => presetSettings({ gridSpacing: 0 }), /positive/);
});

test("every stage's default map gets the resolutions and grid spacing, on one worker", async () => {
  const calls = [];
  const worker = { id: "worker" };
  const defaultParameterMap = async (stage, options) => {
    calls.push([stage, options]);
    return { parameterMap: { Transform: [`${stage}-transform`] }, webWorker: worker };
  };
  const { parameterObject, webWorker } = await buildParameterObject(
    { method: "bspline", resolutions: 2, gridSpacing: 4 },
    { defaultParameterMap, webWorker: null },
  );
  assert.deepEqual(calls.map(([stage]) => stage), ["translation", "rigid", "affine", "bspline"]);
  assert.deepEqual(calls[0][1], { numberOfResolutions: 2, finalGridSpacing: 4, webWorker: null });
  assert.ok(calls.slice(1).every(([, options]) => options.webWorker === worker));
  assert.equal(webWorker, worker);
  assert.deepEqual(stageNames(parameterObject), ["translation-transform", "rigid-transform", "affine-transform", "bspline-transform"]);
});

test("written TransformParameters files chain to their predecessors", () => {
  const optimized = [{ Transform: ["TranslationTransform"] }, { Transform: ["EulerTransform"] }, { Transform: ["AffineTransform"], InitialTransformParameterFileName: ["NoInitialTransform"] }];
  const { maps, names } = chainParameterFiles(optimized, "t1");
  assert.deepEqual(names, ["t1_TransformParameters.0.toml", "t1_TransformParameters.1.toml", "t1_TransformParameters.2.toml"]);
  assert.deepEqual(maps.map((map) => map.InitialTransformParameterFileName[0]), ["NoInitialTransform", names[0], names[1]]);
  assert.equal(optimized[2].InitialTransformParameterFileName[0], "NoInitialTransform", "the optimized maps are not modified");
});

test("parameter files run in numeric name order", () => {
  const files = ["TransformParameters.10.txt", "TransformParameters.2.txt", "TransformParameters.1.txt"].map((name) => ({ name }));
  assert.deepEqual(sortParameterFiles(files).map(({ name }) => name), ["TransformParameters.1.txt", "TransformParameters.2.txt", "TransformParameters.10.txt"]);
});
