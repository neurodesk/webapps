// DOM-independent app and model configuration. Kept pure so it can be unit-tested
// under Node without a browser (see test/config.test.js).
import manifest from "../../../models/dermvit.manifest.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

export const APP = Object.freeze({
  id: "dermvit",
  title: "DermViT",
  version: packageJson.version,
});

const primaryAsset = manifest.assets[0];

export const MODEL = Object.freeze({
  name: manifest.model.name,
  architecture: manifest.model.architecture,
  repository: manifest.repository,
  revision: manifest.revision,
  license: manifest.license,
  input: manifest.model.input,
  output: manifest.model.output,
  imageSize: manifest.model.image_size,
  mean: Object.freeze([...manifest.model.mean]),
  std: Object.freeze([...manifest.model.std]),
  classes: Object.freeze(manifest.model.classes.map((entry) => Object.freeze({ ...entry }))),
  filename: primaryAsset.filename,
  url: manifest.base_url + primaryAsset.filename,
  bytes: primaryAsset.bytes,
  sha256: primaryAsset.sha256,
});

export const MAX_DECODED_BYTES = 64 * 1024 * 1024;
export const OCCLUSION_GRID = 5;
export const SALIENCY_EXPORT_MAX_SIDE = 512;
export const SALIENCY_EXPORT_OPACITY = 0.6;
export const VALID_BACKENDS = Object.freeze(["auto", "webgpu", "wasm"]);

export function computeBoundedDimensions(width, height, maxSide = SALIENCY_EXPORT_MAX_SIDE) {
  if (!width || !height || width <= 0 || height <= 0) {
    throw new Error("Image dimensions must be positive.");
  }
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width, height };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function readSettings(raw = {}) {
  const backend = VALID_BACKENDS.includes(raw.backend) ? raw.backend : "auto";
  return {
    backend,
    colorConstancy: Boolean(raw.colorConstancy),
    computeSaliency: Boolean(raw.computeSaliency),
  };
}

export function buildProvenance({
  file,
  width,
  height,
  format,
  alphaComposited = false,
  settings,
  result,
  seconds,
}) {
  return {
    app: APP.id,
    version: APP.version,
    researchOnly: true,
    disclaimer: "Research and educational use only — uncalibrated softmax scores; not validated for clinical diagnosis or triage.",
    method: "HAM10000 7-class ViT dermoscopic lesion classification",
    model: {
      name: MODEL.name,
      architecture: MODEL.architecture,
      repository: MODEL.repository,
      revision: MODEL.revision,
      filename: MODEL.filename,
      bytes: MODEL.bytes,
      sha256: MODEL.sha256,
      imageSize: MODEL.imageSize,
    },
    input: {
      name: file.name,
      bytes: file.size,
      format,
      width,
      height,
    },
    parameters: {
      requestedBackend: settings.backend,
      colorConstancy: settings.colorConstancy,
      computeSaliency: settings.computeSaliency,
      occlusionGrid: settings.computeSaliency ? OCCLUSION_GRID : null,
    },
    runtime: {
      backend: result.backend,
      threads: result.threads,
      ortVersion: result.ortVersion,
      inferenceSeconds: Number(result.inferenceSeconds.toFixed(3)),
      totalSeconds: Number(seconds.toFixed(3)),
    },
    preprocessing: {
      colorSpace: "srgb",
      alphaPolicy: "reject-empty-composite-white",
      alphaComposited: Boolean(alphaComposited),
      resize: `${MODEL.imageSize}x${MODEL.imageSize} Pillow antialiased bilinear (resample=2)`,
      mean: [...MODEL.mean],
      std: [...MODEL.std],
      colorConstancyGains: result.colorConstancyGains,
    },
    prediction: {
      scoreType: "uncalibrated-softmax",
      topClass: result.summary.top.code,
      topLabel: result.summary.top.label,
      topSoftmaxScore: Number(result.summary.top.probability.toFixed(6)),
      margin: Number(result.summary.margin.toFixed(6)),
      entropyBits: Number(result.summary.entropyBits.toFixed(6)),
      normalizedEntropy: Number(result.summary.normalizedEntropy.toFixed(6)),
      classes: result.summary.ranked.map((item) => ({
        rank: item.rank,
        index: item.index,
        code: item.code,
        label: item.label,
        softmaxScore: Number(item.probability.toFixed(6)),
        logit: Number(item.logit.toFixed(6)),
      })),
    },
    saliency: result.saliency
      ? {
          method: "Zeiler & Fergus (2014) occlusion sensitivity",
          metric: "relative-top-class-softmax-drop",
          grid: result.saliency.grid,
          targetClass: result.saliency.topClassCode,
          maxSoftmaxDrop: Number(result.saliency.maxDrop.toFixed(6)),
          exportWidth: result.saliency.exportWidth,
          exportHeight: result.saliency.exportHeight,
          exportOpacity: result.saliency.exportOpacity,
        }
      : null,
  };
}
