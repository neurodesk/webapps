// SamSrf analyses and model presets. A model is the JSON object SamSrf reads
// (Models/Json/*.json); presets reproduce the three example JSON files and the
// standard models at commit 41ed1e96 (horizontal tuning follows the GUI .mod).

/** @typedef {'prf' | 'rc' | 'cf'} Analysis */

export const ANALYSES = Object.freeze({
  prf: { label: "pRF forward model", runLabel: "Fit pRF model", outcome: "pRF maps ready" },
  rc: { label: "Reverse-correlation pRF", runLabel: "Run reverse correlation", outcome: "Reverse-correlation maps ready" },
  cf: { label: "Connective fields", runLabel: "Map connective fields", outcome: "Connective field maps ready" },
});

/** Hrf values SamSrf accepts. JSON has no Infinity, so concurrent fitting travels as the string "Inf". */
export const HRF_OPTIONS = Object.freeze([
  { value: "0", label: "SPM canonical", model: 0 },
  { value: "[]", label: "de Haas canonical", model: [] },
  { value: "1", label: "None", model: 1 },
  { value: "Inf", label: "Fitted with the pRF", model: "Inf" },
]);

export function hrfValue(hrf) {
  if (Array.isArray(hrf)) {
    if (hrf.length === 0) return "[]";
    if (hrf.length === 1 && (hrf[0] === 0 || hrf[0] === 1)) return String(hrf[0]);
    return "custom";
  }
  return HRF_OPTIONS.some(option => option.value === String(hrf)) ? String(hrf) : "custom";
}

export function hrfModel(value) {
  const option = HRF_OPTIONS.find((candidate) => candidate.value === value);
  if (!option) throw new Error(`Unknown HRF setting ${value}.`);
  return structuredClone(option.model);
}

// MATLAB's a:step:b.
function colon(start, step, end) {
  const count = Math.floor((end - start) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, index) => round(start + index * step));
}

// MATLAB's 2.^(a:step:b) * scale.
function powers(start, step, end, scale) {
  return colon(start, step, end).map((exponent) => round(2 ** exponent * scale));
}

function round(value) {
  return Number(value.toPrecision(12));
}

function forward({ name, prf, params, scaled, positive, polar = true, grid, hookeJeeves, hrf = 0, fixedScalingFactor }) {
  return {
    analysis: "prf",
    hookeJeeves,
    fixedScalingFactor,
    build: ({ scalingFactor, tr }) => {
      scalingFactor = fixedScalingFactor ?? scalingFactor;
      const model = {
        Name: name,
        Prf_Function: prf,
        Param_Names: params,
        Scaled_Param: scaled,
        Only_Positive: positive,
        Scaling_Factor: scalingFactor,
        TR: tr,
        Hrf: structuredClone(hrf),
        Aperture_File: "",
        Polar_Search_Space: polar,
      };
      grid(scalingFactor).forEach((values, index) => {
        model[`Param${index + 1}`] = values;
      });
      return model;
    },
  };
}

const PRESET_LIST = [
  ["example-gaussian", "2D Gaussian (SamSrf example)", forward({
    name: "pRF_Gaussian",
    prf: "@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)",
    params: ["x0", "y0", "Sigma"],
    scaled: [1, 1, 1],
    positive: [0, 0, 1],
    hookeJeeves: [0.01, 0.01, 0.01],
    grid: () => [colon(0, 10, 350), colon(0.5, 0.5, 15), colon(0.5, 0.5, 12)],
  })],
  ["gaussian", "2D Gaussian", forward({
    name: "pRF_Gaussian",
    prf: "@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)",
    params: ["x0", "y0", "Sigma"],
    scaled: [1, 1, 1],
    positive: [0, 0, 1],
    hookeJeeves: [0.01, 0.01, 0.01],
    grid: (sf) => [colon(0, 10, 350), powers(-5, 0.2, 0.6, sf), powers(-5.6, 0.2, 1, sf)],
  })],
  ["dog", "Difference of Gaussians", forward({
    name: "pRF_DoG",
    prf: "@(P,ApWidth)prf_dog_rf(P(1),P(2),P(3),P(4),P(5),ApWidth)",
    params: ["x0", "y0", "Centre", "Surround", "Delta"],
    scaled: [1, 1, 1, 1, 0],
    positive: [0, 0, 1, 1, 1],
    hookeJeeves: [0.01, 0.01, 0.01, 0.01, 0.02],
    grid: (sf) => [colon(0, 15, 345), powers(-5, 0.4, 0.6, sf), powers(-5, 1, 1, sf), powers(-3, 1, 2, sf), colon(0, 0.5, 1)],
  })],
  ["oriented", "Oriented 2D multivariate", forward({
    name: "pRF_Multivariate",
    prf: "@(P,ApWidth)prf_multivariate_rf(P(1),P(2),P(3),P(4),atan2(P(2),P(1))/pi*180+P(5),ApWidth)",
    params: ["x0", "y0", "Sigma1", "Sigma2", "Theta"],
    scaled: [1, 1, 1, 1, 0],
    positive: [0, 0, 1, 1, 0],
    grid: (sf) => [colon(0, 10, 350), powers(-5, 0.2, 0.6, sf), powers(-5, 1, 1, sf), powers(-5, 1, 1, sf), colon(-90, 15, 90)],
  })],
  ["radial", "Radial 2D multivariate", forward({
    name: "pRF_Radial",
    prf: "@(P,ApWidth)prf_multivariate_rf(P(1),P(2),P(3),P(4),atan2(P(2),P(1))/pi*180,ApWidth)",
    params: ["x0", "y0", "Sigma1", "Sigma2"],
    scaled: [1, 1, 1, 1],
    positive: [0, 0, 1, 1],
    hookeJeeves: [0.01, 0.01, 0.01, 0.01],
    grid: (sf) => [colon(0, 10, 350), powers(-5, 0.2, 0.6, sf), powers(-5, 1, 1, sf), powers(-5, 1, 1, sf)],
  })],
  ["sumnorm", "Summed normalisation", forward({
    name: "pRF_SumNorm",
    prf: "@(P,ApWidth)prf_sumnorm_rf(P(1),P(2),P(3),P(4),ApWidth)",
    params: ["x0", "y0", "Sigma", "Kappa"],
    scaled: [1, 1, 1, 0],
    positive: [0, 0, 1, 0],
    hrf: "Inf",
    grid: (sf) => [colon(0, 15, 345), powers(-5, 0.5, 1, sf), powers(-5.5, 0.5, 1, sf), colon(-10, 1, 10)],
  })],
  ["tuning-circular", "Circular tuning curve", forward({
    fixedScalingFactor: 1,
    name: "pTC_cir",
    prf: "@(P,ApWidth)prf_gaussian_rf(cosd(P(1))/2,sind(P(1))/2,P(2),ApWidth)",
    params: ["Mu", "Sigma"],
    scaled: [0, 0],
    positive: [0, 1],
    polar: false,
    hookeJeeves: [5, 0.01],
    // Its stimulus space is fixed: the grid ignores the scaling factor, as in SamSrf.
    grid: () => [colon(-179, 1, 180), powers(-5.6, 0.1, 0, 1)],
  })],
  ["tuning-horizontal", "Horizontal tuning curve", forward({
    name: "pTC_hor",
    prf: "@(P,ApWidth)prf_gaussian_rf(P(1),0,P(2),ApWidth)",
    params: ["Mu", "Sigma"],
    scaled: [0, 1],
    positive: [0, 1],
    polar: false,
    hookeJeeves: [0.01, 0.01],
    grid: (sf) => [colon(-1.05, 0.05, 1.05), powers(-5.6, 0.1, 1, sf)],
  })],
  ["tuning-vertical", "Vertical tuning curve", forward({
    name: "pTC_ver",
    prf: "@(P,ApWidth)prf_gaussian_rf(0,P(1),P(2),ApWidth)",
    params: ["Mu", "Sigma"],
    scaled: [1, 1],
    positive: [0, 1],
    polar: false,
    hookeJeeves: [0.01, 0.01],
    grid: (sf) => [colon(-1.05, 0.05, 1.05).map((mu) => round(mu * sf)), powers(-5.6, 0.1, 1, sf)],
  })],
  ["example-revcor", "Reverse correlation (SamSrf example)", {
    analysis: "rc",
    build: ({ scalingFactor, tr }) => ({ Name: "pRF", Scaling_Factor: scalingFactor, TR: tr, Hrf: 0, Aperture_File: "" }),
  }],
  ["revcor-fit", "Reverse correlation with 2D Gaussian fit", {
    analysis: "rc",
    build: ({ scalingFactor, tr }) => ({
      Name: "pRF",
      Scaling_Factor: scalingFactor,
      TR: tr,
      Hrf: 0,
      Aperture_File: "",
      Prf_Function: "@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)",
      Param_Names: ["x0", "y0", "Sigma"],
      Scaled_Param: [1, 1, 1],
      SeedPar_Function: "@(V)[V(2:3);V(4)/(2*sqrt(2*log(2)))]",
      R2_Threshold: 0.1,
    }),
  }],
  ["example-cf", "Reverse-correlation connective fields (SamSrf example)", {
    analysis: "cf",
    build: () => ({ Name: "CF_Rcp", SeedRoi: "", Template: "" }),
  }],
];

export const PRESETS = Object.freeze(Object.fromEntries(
  PRESET_LIST.map(([id, label, preset]) => [id, Object.freeze({ id, label, ...preset })]),
));

/** @param {Analysis} analysis */
export function presetsFor(analysis) {
  return Object.values(PRESETS).filter((preset) => preset.analysis === analysis);
}

export const DEFAULT_SETTINGS = Object.freeze({ scalingFactor: 9.5, tr: 1 });

/**
 * A fresh model for a preset. Settings are the controls that change the search
 * grid itself; everything else is edited on the returned object.
 */
export function buildModel(presetId, settings = DEFAULT_SETTINGS) {
  const preset = PRESETS[presetId];
  if (!preset) throw new Error(`Unknown model preset ${presetId}.`);
  return preset.build({ ...DEFAULT_SETTINGS, ...settings });
}

/** Imported or edited JSON owns its grids; only active presets regenerate theirs. */
export function changeScalingFactor(model, scalingFactor, presetId = null) {
  if (!presetId) return { ...model, Scaling_Factor: scalingFactor };
  const preset = buildModel(presetId, { scalingFactor, tr: model.TR });
  const grids = Object.entries(preset).filter(([key]) => /^Param\d+$/.test(key));
  return { ...model, Scaling_Factor: preset.Scaling_Factor, ...Object.fromEntries(grids) };
}

// Oriented and summed-normalisation models list fewer Hooke-Jeeves steps than parameters in
// SamSrf's Models/*.m, which SamSrf rejects; they fall back to 0.01 per parameter here.

/** The forward-model fine-fit algorithm: Hooke-Jeeves when the model names step sizes. */
export function fineFit(model) {
  return Array.isArray(model.Hooke_Jeeves_Steps) ? "hooke-jeeves" : "nelder-mead";
}

export function setFineFit(model, algorithm, preset) {
  const next = { ...model };
  if (algorithm === "hooke-jeeves") {
    next.Hooke_Jeeves_Steps = preset?.hookeJeeves ?? new Array(model.Param_Names?.length ?? 0).fill(0.01);
  } else {
    delete next.Hooke_Jeeves_Steps;
  }
  return next;
}

/** Name the input files in the model the way SamSrf's JSON does (file stems, no extension). */
export function withInputNames(model, analysis, { apertures, seed, template }) {
  const next = { ...model };
  const stem = (file) => file?.name.replace(/\.(nii\.gz|nii|mat|gif|gii|label)$/i, "") ?? "";
  if (analysis === "cf") {
    next.SeedRoi = stem(seed);
    next.Template = stem(template);
  } else {
    next.Aperture_File = stem(apertures);
  }
  return next;
}

/** Parse the advanced JSON view. Throws a message a person can act on. */
export function parseModel(text, analysis) {
  let model;
  try {
    model = JSON.parse(text);
  } catch (error) {
    throw new Error(`The model JSON is not valid: ${error.message}`);
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("The model JSON must be an object.");
  if (typeof model.Name !== "string" || !model.Name) throw new Error("The model needs a Name.");
  if (analysis === "prf") {
    for (const key of ["Prf_Function", "Param_Names", "Scaled_Param", "Only_Positive", "Scaling_Factor", "TR", "Hrf"]) {
      if (!(key in model)) throw new Error(`A forward-model pRF model needs ${key}.`);
    }
    model.Param_Names.forEach((_, index) => {
      if (!Array.isArray(model[`Param${index + 1}`])) throw new Error(`The model needs a Param${index + 1} search grid.`);
    });
  }
  if (analysis === "rc") {
    for (const key of ["Scaling_Factor", "TR", "Hrf"]) {
      if (!(key in model)) throw new Error(`A reverse-correlation pRF model needs ${key}.`);
    }
  }
  return model;
}
