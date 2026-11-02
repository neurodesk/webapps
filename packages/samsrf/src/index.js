// SamSrf's readers, models, HRFs, pRF functions and preprocessing on one WebAssembly
// module, for browsers and Node. README.md documents every export.
import wasmInit, * as core from '../wasm/samsrf_wasm.js';

export { Apertures, Run } from '../wasm/samsrf_wasm.js';

export function init(input) {
  return wasmInit(input === undefined ? undefined : { module_or_path: input });
}

export function initSync({ module }) {
  return core.initSync({ module });
}

export function version() {
  return core.version();
}

export function readGifti(bytes) {
  return core.readGifti(bytes);
}

export function readGiftiRun(bytes) {
  return core.readGiftiRun(bytes);
}

export function readGiftiSurface(bytes) {
  return core.readGiftiSurface(bytes);
}

export function readFreeSurferSurface(bytes) {
  return core.readFreeSurferSurface(bytes);
}

export function readFreeSurferCurv(bytes) {
  return core.readFreeSurferCurv(bytes);
}

export function readFreeSurferLabel(bytes) {
  return core.readFreeSurferLabel(bytes);
}

export function readAnatomy({ white, pial, inflated, sphere, curv, area, thickness }) {
  return core.readAnatomy(white, pial, inflated, sphere, curv, area, thickness ?? undefined);
}

export function readMat(bytes) {
  return core.readMat(bytes);
}

export function readOldSchoolHrf(bytes) {
  return core.readOldSchoolHrf(bytes);
}

export function readApertures(bytes, format) {
  return core.readApertures(bytes, format);
}

export function parseModel(kind, json) {
  return JSON.parse(core.parseModel(kind, json));
}

function matrix(arg, index) {
  if (typeof arg === 'number') {
    return { rows: 1, cols: 1, data: [arg] };
  }
  if (Array.isArray(arg) || ArrayBuffer.isView(arg)) {
    return { rows: arg.length, cols: 1, data: arg };
  }
  const { rows, cols, data } = arg ?? {};
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || data?.length !== rows * cols) {
    throw new Error(`expression argument ${index + 1} must be a number, an array or { rows, cols, data } with rows * cols values`);
  }
  return arg;
}

export function evaluateExpression(source, args) {
  const matrices = args.map(matrix);
  const data = new Float64Array(matrices.reduce((total, { data }) => total + data.length, 0));
  let offset = 0;
  for (const { data: values } of matrices) {
    data.set(values, offset);
    offset += values.length;
  }
  const rows = Uint32Array.from(matrices, ({ rows }) => rows);
  const cols = Uint32Array.from(matrices, ({ cols }) => cols);
  return core.evaluateExpression(source, rows, cols, data);
}

export function prfProfile(source, params, xy) {
  const values = Float64Array.from(params);
  if (typeof xy === 'number') {
    return core.prfProfileGrid(source, values, xy);
  }
  return core.prfProfileXy(source, values, xy);
}

export function predictTimecourse(rfp, apertures) {
  return core.predictTimecourse(rfp, apertures);
}

export function pearson(x, y) {
  return core.pearson(Float64Array.from(x), Float64Array.from(y));
}

export function errfun({ prfFunction, apertures, xy, hrf, params, observed, downsampling = 1, cssNonlinearity = false }) {
  const source = typeof prfFunction === 'string' ? prfFunction : prfFunction?.source;
  const fit = hrf != null && !ArrayBuffer.isView(hrf) && !Array.isArray(hrf);
  const kernel = fit ? undefined : Float64Array.from(hrf);
  return core.errfun(source, apertures, xy, kernel, fit ? hrf.fit : undefined, Float64Array.from(params), observed, downsampling, cssNonlinearity);
}

export const hrf = {
  doublegamma(tr, p = []) {
    return core.hrfDoublegamma(tr, Float64Array.from(p));
  },
  spmCanonical(tr) {
    return core.hrfSpmCanonical(tr);
  },
  deHaas(tr) {
    return core.hrfDeHaas(tr);
  },
  oldSchool(tr, fp) {
    return core.hrfOldSchool(tr, Float64Array.from(fp));
  },
  convolve(y, kernel, downsampling = 1) {
    return core.hrfConvolve(y, kernel, downsampling);
  },
  resolve(spec, tr) {
    const values = spec.values === undefined ? undefined : Float64Array.from(spec.values);
    return core.hrfResolve(spec.type, values, spec.file, tr);
  },
};

const PREPROCESS_DEFAULTS = { normalise: 'zscore', combine: 'average', noiseCeiling: true, globalSignal: false };

export class RunAccumulator {
  #inner;

  constructor(totalVertices, keep = null, options = {}) {
    const { normalise, combine, noiseCeiling, globalSignal } = { ...PREPROCESS_DEFAULTS, ...options };
    this.#inner = new core.RunAccumulator(totalVertices, keep ?? undefined, normalise, combine, noiseCeiling, globalSignal);
  }

  pushRun(run) {
    this.#inner.pushRun(run);
  }

  finish() {
    return this.#inner.finish();
  }

  free() {
    this.#inner.free();
  }
}

export function detrend(x) {
  return core.detrend(Float64Array.from(x));
}

export function zscore(x) {
  return core.zscore(Float64Array.from(x));
}

export function noiseCeiling(odd, even) {
  return core.noiseCeiling(odd, even);
}

export function removeNoise({ volumes, vertices, data }, covariates, nCovariates) {
  return core.removeNoise(volumes, vertices, data, covariates, nCovariates);
}

export function exportGiis({ values, vertices, data }, prefix, selection = null) {
  return core.exportGiis(values, vertices, data, prefix, selection ?? undefined);
}

export function writeGiftiMap(values) {
  return core.writeGiftiMap(values);
}

export function polarAndEccentricity({ values, vertices, data }) {
  return core.polarAndEccentricity(values, vertices, data);
}

const ANALYSES = ['prf', 'rc', 'cf'];

function check(condition, message) {
  if (!condition) {
    throw new Error(`createJob: ${message}`);
  }
}

function isUint32(value) {
  return value instanceof Uint32Array;
}

function isFloat64(value) {
  return value instanceof Float64Array;
}

function validateJobSpec(spec) {
  const { kind, model, apertures, hrf: hrfInput, data, noiseCeiling: ceiling, seed, surface, totalVertices } = spec ?? {};
  check(ANALYSES.includes(kind), `kind must be one of ${ANALYSES.join(', ')}`);
  check(typeof model === 'string', 'model must be the model JSON text');
  parseModel(kind, model);
  check(Number.isInteger(totalVertices) && totalVertices > 0, 'totalVertices must be a positive integer');
  if (apertures !== undefined) {
    check(apertures instanceof Uint8Array, 'apertures must be the bytes of Apertures.serialize()');
    core.Apertures.deserialize(apertures).free();
  }
  if (hrfInput !== undefined) {
    check(isFloat64(hrfInput) || hrfInput === 'fit' || hrfInput === 'none', "hrf must be a Float64Array kernel, 'fit' or 'none'");
  }
  const { volumes, vertices, courses } = data ?? {};
  check(Number.isInteger(volumes) && volumes > 0, 'data.volumes must be a positive integer');
  check(isUint32(vertices), 'data.vertices must be a Uint32Array');
  check(isFloat64(courses) && courses.length === volumes * vertices.length, 'data.courses must be a Float64Array of volumes x vertices values');
  check(vertices.every((vertex) => vertex < totalVertices), 'data.vertices must be below totalVertices');
  if (ceiling !== undefined) {
    check(isFloat64(ceiling) && ceiling.length === vertices.length, 'noiseCeiling must be a Float64Array with one value per vertex');
  }
  if (seed !== undefined) {
    const values = seed.template?.values;
    check(isUint32(seed.vertices), 'seed.vertices must be a Uint32Array');
    check(Array.isArray(values) && isFloat64(seed.template.data), 'seed.template must be { values: string[], data: Float64Array }');
    check(seed.template.data.length === values.length * totalVertices, 'seed.template.data must hold values.length x totalVertices values');
  }
  if (surface !== undefined) {
    check(isFloat64(surface.vertices) && surface.vertices.length === 3 * totalVertices, 'surface.vertices must be a Float64Array of 3 x totalVertices values');
    check(isUint32(surface.faces) && surface.faces.length % 3 === 0, 'surface.faces must be a Uint32Array of vertex triples');
  }
}

export function createJob(spec) {
  validateJobSpec(spec);
  throw new Error('createJob is not implemented yet (phase 2)');
}

export function mergePartials(partials) {
  if (!Array.isArray(partials) || !partials.every((partial) => partial instanceof Uint8Array)) {
    throw new Error('mergePartials: partials must be an array of the Uint8Arrays Job.run returns');
  }
  throw new Error('mergePartials is not implemented yet (phase 2)');
}
