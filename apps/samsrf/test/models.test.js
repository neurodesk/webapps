import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, buildModel, changeScalingFactor, fineFit, hrfModel, hrfValue, parseModel, presetsFor, setFineFit, withInputNames } from "../src/models.js";

test("the 2D Gaussian example preset is SamSrf's Example_2D_Gaussian_pRF.json", () => {
  const model = withInputNames(buildModel("example-gaussian"), "prf", { apertures: { name: "aps_Bars.mat" } });
  assert.deepEqual(Object.keys(model), ["Name", "Prf_Function", "Param_Names", "Scaled_Param", "Only_Positive", "Scaling_Factor", "TR", "Hrf", "Aperture_File", "Polar_Search_Space", "Param1", "Param2", "Param3"]);
  assert.equal(model.Prf_Function, "@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)");
  assert.equal(model.Scaling_Factor, 9.5);
  assert.equal(model.Aperture_File, "aps_Bars");
  assert.deepEqual([model.Param1.length, model.Param1[0], model.Param1.at(-1)], [36, 0, 350]);
  assert.deepEqual([model.Param2.length, model.Param2[0], model.Param2.at(-1)], [30, 0.5, 15]);
  assert.deepEqual([model.Param3.length, model.Param3[0], model.Param3.at(-1)], [24, 0.5, 12]);
});

test("standard presets scale their search grids by the stimulus radius, as Models/*.m do", () => {
  const unit = buildModel("gaussian", { scalingFactor: 1, tr: 1 });
  const scaled = buildModel("gaussian", { scalingFactor: 10, tr: 1 });
  assert.equal(unit.Param2.length, 29, "2.^(-5:0.2:0.6) has 29 steps");
  assert.equal(unit.Param3.length, 34, "2.^(-5.6:0.2:1) has 34 steps");
  assert.equal(scaled.Param2[0], Number((2 ** -5 * 10).toPrecision(12)));
  assert.deepEqual(scaled.Param1, unit.Param1, "polar angles do not scale");
  assert.deepEqual(buildModel("tuning-circular", { scalingFactor: 10 }).Param2, buildModel("tuning-circular", { scalingFactor: 1 }).Param2);
  assert.equal(buildModel("tuning-circular", { scalingFactor: 10 }).Scaling_Factor, 1);
});

test("every preset belongs to one analysis and the forward models have a grid per parameter", () => {
  assert.deepEqual(presetsFor("cf").map(({ id }) => id), ["example-cf"]);
  for (const preset of presetsFor("prf")) {
    const model = buildModel(preset.id);
    model.Param_Names.forEach((_, index) => assert.ok(model[`Param${index + 1}`].length > 0, `${preset.id} Param${index + 1}`));
    assert.equal(model.Scaled_Param.length, model.Param_Names.length, preset.id);
    if (preset.hookeJeeves) assert.equal(preset.hookeJeeves.length, model.Param_Names.length, preset.id);
  }
  assert.equal(Object.keys(PRESETS).length, 12);
});

test("connective field models name the seed and template files", () => {
  const model = withInputNames(buildModel("example-cf"), "cf", { seed: { name: "lh.V1_seed.label" }, template: { name: "lh_benson.gii" } });
  assert.deepEqual(model, { Name: "CF_Rcp", SeedRoi: "lh.V1_seed", Template: "lh_benson" });
});

test("legacy exports persist in saved model JSON and invalid conventions are rejected", () => {
  for (const preset of Object.values(PRESETS)) {
    const model = buildModel(preset.id, { exportConvention: "samsrfx-10.003" });
    assert.equal(model.Export_Convention, "samsrfx-10.003");
    assert.deepEqual(parseModel(JSON.stringify(model), preset.analysis), model);
    assert.throws(() => parseModel(JSON.stringify({ ...model, Export_Convention: "unknown" }), preset.analysis), /export convention/);
    assert.throws(() => parseModel(JSON.stringify({ ...model, Export_Convention: ["samsrfx-10.003"] }), preset.analysis), /export convention/);
  }
});

test("HRF settings round-trip, including concurrent fitting that JSON cannot write as Infinity", () => {
  for (const value of ["0", "[]", "1", "Inf"]) assert.equal(hrfValue(hrfModel(value)), value);
  assert.equal(JSON.parse(JSON.stringify({ Hrf: hrfModel("Inf") })).Hrf, "Inf");
  assert.equal(buildModel("sumnorm").Hrf, "Inf");
});

test("choosing Hooke-Jeeves adds the preset's step sizes and Nelder-Mead removes them", () => {
  const model = buildModel("dog");
  const hooke = setFineFit(model, "hooke-jeeves", PRESETS.dog);
  assert.deepEqual(hooke.Hooke_Jeeves_Steps, [0.01, 0.01, 0.01, 0.01, 0.02]);
  assert.equal(fineFit(hooke), "hooke-jeeves");
  assert.equal("Hooke_Jeeves_Steps" in setFineFit(hooke, "nelder-mead"), false);
  assert.deepEqual(setFineFit(buildModel("oriented"), "hooke-jeeves", PRESETS.oriented).Hooke_Jeeves_Steps, [0.01, 0.01, 0.01, 0.01, 0.01]);
});

test("the JSON view rejects models SamSrf would reject, with the missing field named", () => {
  assert.throws(() => parseModel("{", "prf"), /not valid/);
  assert.throws(() => parseModel("[]", "prf"), /must be an object/);
  const model = buildModel("gaussian");
  delete model.Param3;
  assert.throws(() => parseModel(JSON.stringify(model), "prf"), /Param3/);
  assert.throws(() => parseModel(JSON.stringify({ Name: "pRF" }), "rc"), /Scaling_Factor/);
  assert.deepEqual(parseModel(JSON.stringify(buildModel("example-cf")), "cf"), buildModel("example-cf"));
});


test("editing a custom model's radius preserves its grids and optimizer steps", () => {
  const custom = { ...buildModel("dog"), Param1: [0, 90], Param2: [1, 3], Hooke_Jeeves_Steps: [1, 2, 3, 4, 5] };
  assert.deepEqual(changeScalingFactor(custom, 12), { ...custom, Scaling_Factor: 12 });
  const preset = buildModel("gaussian");
  const changed = changeScalingFactor(preset, 12, "gaussian");
  assert.deepEqual(changed.Param2, buildModel("gaussian", { scalingFactor: 12 }).Param2);
  assert.equal(changeScalingFactor(buildModel("tuning-circular"), 12, "tuning-circular").Scaling_Factor, 1);
});

test("horizontal tuning keeps the MATLAB GUI's unscaled Mu grid", () => {
  const model = buildModel("tuning-horizontal", { scalingFactor: 10 });
  assert.equal(model.Param1[0], -1.05);
  assert.equal(model.Param1.at(-1), 1.05);
});

test("a custom HRF kernel is not displayed as the de Haas preset", () => {
  assert.equal(hrfValue([0]), "0");
  assert.equal(hrfValue([1]), "1");
  assert.equal(hrfValue([0, 0.5, 1]), "custom");
});

test("forward precision and CSS conventions survive JSON and radius edits", () => {
  const model = buildModel("gaussian", { dataPrecision: "single", cssConvention: "samsrf" });
  const changed = changeScalingFactor({ ...model, Compressive_Nonlinearity: true }, 12, "gaussian");
  assert.equal(changed.Data_Precision, "single");
  assert.equal(changed.Css_Convention, "samsrf");
  assert.deepEqual(parseModel(JSON.stringify(changed), "prf"), changed);
  assert.throws(() => parseModel(JSON.stringify({ ...model, Data_Precision: "unknown" }), "prf"), /Data_Precision/);
  assert.throws(() => parseModel(JSON.stringify({ ...model, Css_Convention: "unknown" }), "prf"), /Css_Convention/);
});

test("reverse correlation takes single precision except for CF Gaussian fits", () => {
  const cf = buildModel("example-cf", { dataPrecision: "single" });
  assert.equal(cf.Data_Precision, "single");
  assert.deepEqual(parseModel(JSON.stringify(cf), "cf"), cf);
  assert.deepEqual(parseModel(JSON.stringify({ ...cf, Fit_pRF: -1 }), "cf"), { ...cf, Fit_pRF: -1 });
  assert.throws(() => parseModel(JSON.stringify({ ...cf, Fit_pRF: 1 }), "cf"), /Gaussian fits need double precision/);
  const rc = buildModel("revcor-fit", { dataPrecision: "single" });
  assert.equal(rc.Data_Precision, "single");
  assert.deepEqual(parseModel(JSON.stringify(rc), "rc"), rc);
});
